/**
 * One SSH connection to one pinned host, opened per tool call and closed after.
 *
 * PER CALL, NOT POOLED. These are break-glass tools: a handful of calls during
 * an incident, not a stream. A connection held open between calls would be a
 * standing authenticated session on a production root account inside a shared
 * container, and the handshake it saves is a few hundred milliseconds.
 *
 * BOUNDED, because this process is thirty-two other servers too. A command's
 * output and a file read are capped in memory as they arrive, not after, so
 * `cat` of a 4 GB log costs a fixed amount of this container's memory and comes
 * back marked as truncated.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type Socket } from "node:net";
import ssh2 from "ssh2";
import type {
  ClientChannel,
  ConnectConfig,
  FileEntryWithStats,
  ServerHostKeyAlgorithm,
  SFTPWrapper,
  Stats,
} from "ssh2";
import type { SshConfig } from "./config.js";
import { ConfigError, HostKeyMismatchError, InputError, SshUnreachableError } from "./errors.js";
import {
  isTailnetAddress,
  isTailnetName,
  socks5Connect,
  SocksProxyDownError,
  SocksReplyError,
  SocksTimeoutError,
} from "./tailnet.js";
import {
  blobType,
  describePins,
  fingerprintOf,
  hostKeyAlgorithms,
  matchesPin,
} from "./host-key.js";

const { Client } = ssh2;

/** Bytes kept from the START of each output stream. */
export const OUTPUT_HEAD_BYTES = 32 * 1024;
/** Bytes kept from the END of each output stream — where an error usually is. */
export const OUTPUT_TAIL_BYTES = 32 * 1024;
/**
 * The largest single file read or write, in bytes. Core accepts a 4 MB JSON
 * body, and a file travels as base64 (four bytes for every three), so 2 MiB is
 * the size that still fits with room for the rest of the request.
 */
export const MAX_TRANSFER_BYTES = 2 * 1024 * 1024;
/** The most directory entries one listing returns. */
export const MAX_DIRECTORY_ENTRIES = 1000;
/**
 * The longest any one command may run, output or not. The inactivity timeout
 * lets a chatty job finish; this is what stops `tail -f` from holding an
 * authenticated session on a production host open forever.
 */
export const MAX_EXEC_WALL_MS = 15 * 60 * 1000;

export interface PresentedHostKey {
  type: string | null;
  fingerprint: string;
}

export interface ExecResult {
  /** Null when the command was ended by a signal, or did not finish. */
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Total bytes the command wrote to each stream, kept or not. */
  stdoutBytes: number;
  stderrBytes: number;
  /** True when the middle of a stream was dropped to fit the cap. */
  truncated: boolean;
  /** True when the command was abandoned: quiet past its timeout, or past the ceiling. */
  timedOut: boolean;
  /** Which limit ended it, when one did. */
  timeout: "inactivity" | "ceiling" | null;
}

export interface DirectoryEntry {
  name: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number;
  permissions: string;
  modified: string;
}

export interface FileRead {
  /** The file's full size on the host. */
  size: number;
  offset: number;
  data: Buffer;
  /** True when bytes remain past `offset + data.length`. */
  truncated: boolean;
}

export interface SshSession {
  readonly hostKey: PresentedHostKey;
  exec(
    command: string,
    options: { cwd?: string; timeoutMs: number; maxWallMs?: number },
  ): Promise<ExecResult>;
  listDirectory(path: string): Promise<{ entries: DirectoryEntry[]; total: number }>;
  readFile(path: string, options: { offset: number; maxBytes: number }): Promise<FileRead>;
  writeFile(path: string, data: Buffer, options: { mode?: number }): Promise<void>;
  close(): void;
}

/** Opens a session. Injected in tests; production uses {@link connect}. */
export type Connector = (config: SshConfig) => Promise<SshSession>;

/** A connection that failed for a reason other than the host key, with what to check. */
export class SshConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshConnectError";
  }
}

function target(config: SshConfig): string {
  return `${config.username}@${config.host}:${config.port}`;
}

/**
 * The next move for a connection failure, as the error to throw.
 *
 * Three families, because each has a different next move: the network never
 * reached a server ({@link SshUnreachableError} — bring the host up, then
 * retry), the right machine answered and refused the key (fix
 * authorized_keys), or something answered and broke the handshake (a firewall
 * or sshd limit). Host-key mismatches are decided before this is called.
 */
function connectError(
  err: Error & { level?: string; code?: string },
  config: SshConfig,
  stage: { tcpConnected: boolean; presented: boolean } = { tcpConnected: false, presented: false },
): Error {
  const where = target(config);
  const unreachable = (reason: string) =>
    new SshUnreachableError(reason, where, config.unreachableHint);
  if (err.level === "client-authentication") {
    return new SshConnectError(
      `${where} rejected SSH_PRIVATE_KEY. The host key matched, so this is the ` +
        `right machine and it is up: the key's public half is not in ` +
        `~${config.username}/.ssh/authorized_keys there, or that account does not ` +
        `allow key login.`,
    );
  }
  switch (err.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return unreachable(
        `${config.host} did not resolve (${err.code}). If the name is right, its ` +
          `DNS record may be gone while the host is down; if not, SSH_HOST is wrong`,
      );
    case "ECONNREFUSED":
      return unreachable(
        `the machine refused port ${config.port}. Something is up at that address ` +
          `but nothing is listening there: sshd is down or the host is still ` +
          `starting — or SSH_PORT is wrong, if this never worked`,
      );
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EHOSTDOWN":
      return unreachable(
        `network error ${err.code}. The host is most likely powered off or spun ` +
          `down, or a firewall is dropping this source address`,
      );
    case "ECONNRESET":
      return new SshConnectError(
        `${where} reset the connection during the handshake. Something is up at ` +
          `that address but dropping this source: a firewall or fail2ban on the host.`,
      );
  }
  if (/timed out while waiting for handshake/i.test(err.message)) {
    if (stage.presented) {
      return new SshConnectError(
        `${where} answered with the pinned host key, but the login did not finish ` +
          `within ${config.connectTimeoutMs} ms. The host is up and slow — ` +
          `overloaded, or sshd is stuck on a reverse-DNS or PAM lookup. Retrying ` +
          `may work; raising SSH_TIMEOUT may too.`,
      );
    }
    if (stage.tcpConnected) {
      return new SshConnectError(
        `${where} accepted the TCP connection but sent no SSH greeting within ` +
          `${config.connectTimeoutMs} ms. The machine is up; its sshd is stuck or ` +
          `overloaded, or the port is not an SSH server.`,
      );
    }
    return unreachable(
      `no reply within ${config.connectTimeoutMs} ms. The host is most likely ` +
        `powered off or spun down, or a firewall is dropping this source address`,
    );
  }
  if (/connection lost before handshake/i.test(err.message)) {
    return new SshConnectError(
      `${where} accepted the TCP connection and closed it before any SSH greeting. ` +
        `The machine is up; sshd may be refusing new connections (MaxStartups), or ` +
        `a firewall or fail2ban on the host may be dropping this source address.`,
    );
  }
  return new SshConnectError(`SSH connection to ${where} failed: ${err.message}`);
}

/**
 * Connect, refusing any host key that is not pinned, and authenticate with the
 * configured key and nothing else.
 *
 * The verifier runs during key exchange, BEFORE user authentication — so a host
 * that presents the wrong key never receives a signature made with ours.
 */
export const connect: Connector = async (config) => {
  const route = await routeFor(config);
  const sock = route.kind === "tailnet" ? await dialTailnet(config, route.address) : undefined;
  return handshake(config, sock);
};

/** How a host is reached: straight out of the container, or through the bundle's tailnet. */
export type Route = { kind: "direct" } | { kind: "tailnet"; address: string };

type Lookup = (host: string) => Promise<Array<{ address: string }>>;
const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true });

/**
 * The route for this host, decided by where it RESOLVES. A MagicDNS name, a
 * Tailscale address, or a name whose first address is one goes through the
 * tailnet; everything else dials direct, exactly as it did before the tailnet
 * existed. A name that does not resolve is left to the direct dial, which
 * reports it as the unreachable error it always was.
 */
export async function routeFor(
  config: Pick<SshConfig, "host"> & Partial<Pick<SshConfig, "connectTimeoutMs">>,
  lookup: Lookup = defaultLookup,
): Promise<Route> {
  const host = config.host;
  if (isTailnetName(host)) return { kind: "tailnet", address: host.replace(/\.$/, "") };
  if (isIP(host)) return isTailnetAddress(host) ? { kind: "tailnet", address: host } : { kind: "direct" };
  let addresses: Array<{ address: string }>;
  try {
    // Bounded: ssh2's own lookup ran inside its ready timeout, and this one
    // runs before it. A resolver that never answers falls back to the direct
    // dial, which reports the name as it always did.
    const timeoutMs = config.connectTimeoutMs ?? 15_000;
    let timer: NodeJS.Timeout | undefined;
    addresses = await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("lookup timed out")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch {
    return { kind: "direct" };
  }
  const first = addresses[0]?.address;
  return first && isTailnetAddress(first) ? { kind: "tailnet", address: first } : { kind: "direct" };
}

/**
 * A TCP stream to the host through tailscaled's SOCKS5 listener, or the error
 * that says which of three things is wrong: this container has no tailnet at
 * all (configuration — a human), the sidecar is not up (the container — retry,
 * then an operator), or the tailnet could not reach the host (the host is off,
 * or the tailnet policy does not let strad's node reach that port).
 */
export async function dialTailnet(
  config: Pick<SshConfig, "host" | "port" | "username" | "connectTimeoutMs" | "unreachableHint" | "tailnetProxy">,
  address: string,
  dial?: Parameters<typeof socks5Connect>[4],
): Promise<Socket> {
  const where = `${config.username}@${config.host}:${config.port}`;
  const via = address === config.host ? "" : ` (${address})`;
  if (!config.tailnetProxy) {
    throw new ConfigError(
      `${config.host}${via} is a Tailscale tailnet address, and this container has ` +
        `no tailnet egress, so it cannot be reached from here. The bundle that ` +
        `serves this slug needs a \`tailnet:\` block in the strad config ` +
        `(docs/operate/tailnet), which a human enables. Nothing was sent and the ` +
        `private key was not used.`,
    );
  }
  try {
    return await socks5Connect(config.tailnetProxy, address, config.port, config.connectTimeoutMs, dial);
  } catch (err) {
    if (err instanceof SocksProxyDownError) {
      throw new SshConnectError(
        `${where}${via} is on the tailnet, and strad's tailnet sidecar in this ` +
          `container is not accepting connections (${err.code ?? "closed"}): it is ` +
          `starting, restarting, or failed to join. The bundle's /healthz \`tailnet\` ` +
          `field says which. Retry in a minute; if it persists, an operator reads ` +
          `the bundle log. Nothing was sent and the private key was not used.`,
      );
    }
    if (err instanceof SocksReplyError || err instanceof SocksTimeoutError) {
      throw new SshUnreachableError(
        `the tailnet could not reach ${address}:${config.port} (${err.message}). The ` +
          `host is down or offline on the tailnet, or the tailnet policy does not ` +
          `let strad's node reach that port`,
        `${where}${via}`,
        config.unreachableHint,
      );
    }
    throw new SshConnectError(`SSH connection to ${where}${via} over the tailnet failed: ${(err as Error).message}`);
  }
}

function handshake(config: SshConfig, sock: Socket | undefined): Promise<SshSession> {
  return new Promise<SshSession>((resolve, reject) => {
    const client = new Client();
    let presented: Buffer | undefined;
    // Where the attempt got to, because a timeout means different things at
    // each stage: no TCP at all is a machine that is off; TCP but no SSH is a
    // live machine whose sshd is stuck; a host key is a live sshd whose login
    // stalled. Only the first is "bring it up".
    let tcpConnected = false;
    let settled = false;

    const algorithms = hostKeyAlgorithms(config.hostKeyPins);
    const options: ConnectConfig = {
      host: config.host,
      port: config.port,
      // A tailnet host arrives as an already-connected stream through the
      // sidecar; ssh2 speaks SSH over it exactly as over its own socket.
      ...(sock ? { sock } : {}),
      username: config.username,
      privateKey: config.privateKey,
      passphrase: config.passphrase,
      readyTimeout: config.connectTimeoutMs,
      // Key auth only: no agent, no password, no keyboard-interactive prompt
      // that nobody is there to answer.
      tryKeyboard: false,
      keepaliveInterval: 15_000,
      hostVerifier: (key: Buffer) => {
        presented = key;
        return matchesPin(config.hostKeyPins, key);
      },
      ...(algorithms
        ? { algorithms: { serverHostKey: algorithms as ServerHostKeyAlgorithm[] } }
        : {}),
    };

    client.once("connect", () => {
      tcpConnected = true;
    });
    client.once("ready", () => {
      settled = true;
      const key = presented!;
      resolve(
        sessionOver(client, { type: blobType(key), fingerprint: fingerprintOf(key) }, config),
      );
    });
    // ssh2 reports an `error` only for a socket that closes BEFORE the server's
    // banner. One that closes after it — sshd's MaxStartups or LoginGraceTime,
    // a firewall cutting the key exchange — emits `close` alone and clears the
    // ready timer, so without this the call would wait forever.
    client.on("close", () => {
      if (settled) return;
      settled = true;
      reject(
        new SshConnectError(
          `${target(config)} closed the connection during the handshake. sshd ` +
            `may be refusing new connections (MaxStartups), or a firewall or ` +
            `fail2ban on the host may be dropping this source address.`,
        ),
      );
    });
    // `on`, never `once`: ssh2 can emit a second error after the first (a
    // reset after a refused handshake, a socket error mid-command), and an
    // `error` event with no listener is an uncaught exception — which in the
    // bundle takes every other mount in the process down with this one. After
    // the connection is up, an in-flight exec or SFTP call sees the failure
    // through its own channel closing.
    client.on("error", (err: Error & { level?: string; code?: string }) => {
      if (settled) return;
      settled = true;
      client.end();
      if (presented && !matchesPin(config.hostKeyPins, presented)) {
        reject(
          new HostKeyMismatchError(
            { type: blobType(presented), fingerprint: fingerprintOf(presented) },
            describePins(config.hostKeyPins),
            `${config.host}:${config.port}`,
          ),
        );
        return;
      }
      if (/no matching host key/i.test(err.message) && algorithms) {
        reject(
          new ConfigError(
            `${config.host}:${config.port} has no host key of the pinned type(s) ` +
              `(${[...new Set(config.hostKeyPins.map((p) => (p.kind === "key" ? p.type : "")))].join(", ")}). ` +
              `Re-check SSH_HOST_KEY against \`ssh-keyscan -p ${config.port} ${config.host}\`.`,
          ),
        );
        return;
      }
      reject(connectError(err, config, { tcpConnected, presented: presented !== undefined }));
    });

    try {
      client.connect(options);
    } catch (err) {
      settled = true;
      reject(connectError(err as Error, config));
    }
  });
}

/** Keeps the first and last bytes of a stream, counting everything. */
class HeadTail {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  total = 0;

  constructor(
    private readonly headMax: number,
    private readonly tailMax: number,
  ) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headLen < this.headMax) {
      const take = Math.min(this.headMax - this.headLen, rest.length);
      this.head.push(rest.subarray(0, take));
      this.headLen += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailLen += rest.length;
    while (this.tailLen > this.tailMax) {
      const first = this.tail[0]!;
      const excess = this.tailLen - this.tailMax;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailLen -= first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailLen -= excess;
      }
    }
  }

  get truncated(): boolean {
    return this.total > this.headLen + this.tailLen;
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    if (!this.truncated) return head + tail;
    const omitted = this.total - this.headLen - this.tailLen;
    return `${head}\n[… ${omitted} bytes omitted …]\n${tail}`;
  }
}

function formatPermissions(mode: number): string {
  const perms = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
  const kind = (mode & 0o170000) === 0o040000 ? "d" : (mode & 0o170000) === 0o120000 ? "l" : "-";
  return `${kind}${perms[(mode >> 6) & 7]}${perms[(mode >> 3) & 7]}${perms[mode & 7]}`;
}

function entryType(mode: number): DirectoryEntry["type"] {
  switch (mode & 0o170000) {
    case 0o040000:
      return "directory";
    case 0o100000:
      return "file";
    case 0o120000:
      return "symlink";
    default:
      return "other";
  }
}

/** POSIX single-quoting, so a `cwd` is one word whatever it contains. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function sessionOver(
  client: InstanceType<typeof Client>,
  hostKey: PresentedHostKey,
  config: SshConfig,
): SshSession {
  /**
   * A deadline on one step. A connection that is alive but stuck — SFTP on a
   * hung NFS mount, a channel the server never opens — still answers
   * keepalives, so nothing else would ever end the call. On expiry the whole
   * connection is closed: the step it was waiting on cannot be cancelled alone.
   */
  const ms = config.commandTimeoutMs;

  /**
   * Set when the connection dies under a call — the host went down, a reset, a
   * keepalive that went unanswered — rather than because this end closed it.
   * ssh2 then closes every channel with no exit status, which on its own reads
   * like a command that finished, so the calls below check this first.
   */
  let closing = false;
  let lost = false;
  client.on("close", () => {
    if (!closing) lost = true;
  });
  const lostError = (what: string) =>
    new SshConnectError(
      `The connection to ${target(config)} was lost during ${what}. The host may ` +
        `have gone down or been restarted; anything already sent may or may not ` +
        `have taken effect. Call ssh_check_connection, and check the result before ` +
        `retrying.`,
    );

  const deadline = <T>(what: string, run: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        closing = true;
        client.end();
        reject(
          new SshConnectError(
            `${what} on ${target(config)} got no answer within ${ms} ms, so the ` +
              `connection was closed. The host may be overloaded, the path may be ` +
              `on a hung filesystem, or the host may have gone away — ` +
              `ssh_check_connection tells which.`,
          ),
        );
      }, ms);
      run().then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(lost ? lostError(what.toLowerCase()) : e);
        },
      );
    });

  let sftpPromise: Promise<SFTPWrapper> | undefined;
  const sftp = (): Promise<SFTPWrapper> =>
    (sftpPromise ??= new Promise((resolve, reject) =>
      client.sftp((err, s) => {
        if (err) return reject(err);
        // ssh2 drops its own `error` listener once SFTP is up, and a later
        // protocol error from the host would then be an uncaught exception in
        // the shared bundle. The call in flight still fails, through its
        // callback or the deadline.
        s.on("error", () => undefined);
        resolve(s);
      }),
    ));

  return {
    hostKey,

    exec(command, { cwd, timeoutMs, maxWallMs = MAX_EXEC_WALL_MS }) {
      const full = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
      return new Promise<ExecResult>((resolve, reject) => {
        let opened = false;
        const openTimer = setTimeout(() => {
          if (opened) return;
          opened = true;
          closing = true;
          client.end();
          reject(
            new SshConnectError(
              `${target(config)} did not open a channel for the command within ${ms} ms, so the connection was closed.`,
            ),
          );
        }, ms);
        client.exec(full, (err, stream: ClientChannel) => {
          if (opened) {
            // The open deadline already answered; release what arrived late.
            stream?.close();
            return;
          }
          opened = true;
          clearTimeout(openTimer);
          if (err) return reject(err);
          const out = new HeadTail(OUTPUT_HEAD_BYTES, OUTPUT_TAIL_BYTES);
          const errOut = new HeadTail(OUTPUT_HEAD_BYTES, OUTPUT_TAIL_BYTES);
          let exitCode: number | null = null;
          let signal: string | null = null;
          let timedOut = false;
          let timeout: ExecResult["timeout"] = null;
          let timer: NodeJS.Timeout | undefined;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            clearTimeout(ceiling);
            if (!timedOut && exitCode === null && signal === null) {
              // No exit status and not ended by this end: the connection died
              // under the command. Not a result — the command may still be
              // running, or may never have finished.
              reject(lost ? lostError("the command") : new SshConnectError(
                `${target(config)} closed the command's channel without an exit ` +
                  `status. It may or may not have run to completion.`,
              ));
              return;
            }
            resolve({
              exitCode,
              signal,
              stdout: out.text(),
              stderr: errOut.text(),
              stdoutBytes: out.total,
              stderrBytes: errOut.total,
              truncated: out.truncated || errOut.truncated,
              timedOut,
              timeout,
            });
          };

          // ACTIVITY timeout, as upstream: it restarts on every byte, so a long
          // job that keeps printing runs to completion and a hung one does not.
          const abandon = (why: "inactivity" | "ceiling") => {
            if (done || timedOut) return;
            timedOut = true;
            timeout = why;
            // Without a pty, closing the channel does not reliably end the
            // remote process; asking sshd to signal it is the best this end
            // can do, and older servers ignore the request.
            try {
              stream.signal("KILL");
            } catch {
              // ignored: the close below is what matters to this end
            }
            stream.close();
            // A dead connection may never confirm the close. The caller gets
            // its partial output regardless.
            setTimeout(finish, 5_000).unref();
          };
          const arm = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => abandon("inactivity"), timeoutMs);
          };
          const ceiling = setTimeout(() => abandon("ceiling"), maxWallMs);
          arm();

          stream.on("data", (d: Buffer) => {
            out.push(d);
            arm();
          });
          stream.stderr.on("data", (d: Buffer) => {
            errOut.push(d);
            arm();
          });
          stream.on("exit", (code: number | null, sig?: string) => {
            if (typeof code === "number") exitCode = code;
            if (sig) signal = sig;
          });
          stream.on("close", finish);
          stream.on("error", (e: Error) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            clearTimeout(ceiling);
            reject(e);
          });
        });
      });
    },

    listDirectory: (path) => deadline("Listing the directory", async () => {
      const s = await sftp();
      const list = await new Promise<FileEntryWithStats[]>((resolve, reject) =>
        s.readdir(path, (err, l) => (err ? reject(err) : resolve(l))),
      );
      const entries = list
        .map((item) => ({
          name: item.filename,
          type: entryType(item.attrs.mode),
          size: item.attrs.size,
          permissions: formatPermissions(item.attrs.mode),
          modified: new Date(item.attrs.mtime * 1000).toISOString(),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { entries: entries.slice(0, MAX_DIRECTORY_ENTRIES), total: entries.length };
    }),

    readFile: (path, { offset, maxBytes }) => deadline("Reading the file", async () => {
      const s = await sftp();
      const stats = await new Promise<Stats>((resolve, reject) =>
        s.stat(path, (err, st) => (err ? reject(err) : resolve(st))),
      );
      if (stats.isDirectory()) {
        throw new InputError(`${path} is a directory. Use ssh_list_directory for it.`);
      }
      if (!stats.isFile()) {
        throw new InputError(`${path} is not a regular file, so it has no fixed content to download.`);
      }
      const size = stats.size;
      if (offset >= size) return { size, offset, data: Buffer.alloc(0), truncated: false };
      const length = Math.min(maxBytes, size - offset);
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const rs = s.createReadStream(path, { start: offset, end: offset + length - 1 });
        rs.on("data", (c: Buffer) => chunks.push(c));
        rs.on("error", reject);
        rs.on("end", () => resolve());
        rs.on("close", () => resolve());
      });
      const data = Buffer.concat(chunks).subarray(0, length);
      return { size, offset, data, truncated: offset + data.length < size };
    }),

    writeFile: (path, data, { mode }) => deadline("Writing the file", async () => {
      const s = await sftp();
      await new Promise<void>((resolve, reject) =>
        s.writeFile(path, data, mode === undefined ? {} : { mode }, (err) =>
          err ? reject(err) : resolve(),
        ),
      );
    }),

    close() {
      closing = true;
      client.end();
    },
  };
}
