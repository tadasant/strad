/**
 * A REAL SSH server on loopback, for driving the client end to end.
 *
 * It is ssh2's own server half, so the handshake, the host-key exchange, the
 * publickey signature and the SFTP wire are the protocol, not a stub of it. What
 * is fake is behind it: `exec` runs the command with the local `sh`, and SFTP is
 * served out of a temporary directory standing in for the remote filesystem.
 *
 * It records every authentication attempt, which is how the tests prove that a
 * host-key refusal happens BEFORE the client offers a signature.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import type { Connection, ParsedKey, SFTPWrapper } from "ssh2";

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

export interface KeyPair {
  private: string;
  public: string;
}

export function keyPair(type: "ed25519" | "rsa" | "ecdsa" = "ed25519", passphrase?: string): KeyPair {
  const opts =
    type === "rsa"
      ? { bits: 2048 }
      : type === "ecdsa"
        ? { bits: 256 }
        : {};
  // ssh2's generator emits an Ed25519 key its own parser rejects ("Malformed
  // OpenSSH private key") about four times in a thousand, which across the
  // keys this suite mints is a flaky run every few dozen. Keys a human pastes
  // come from ssh-keygen, so this is a fixture problem: mint until it parses.
  for (let attempt = 0; attempt < 20; attempt++) {
    const kp = utils.generateKeyPairSync(
      type as "ed25519",
      (passphrase ? { ...opts, passphrase, cipher: "aes256-ctr" } : opts) as never,
    );
    if (!(utils.parseKey(kp.private, passphrase) instanceof Error)) {
      return { private: kp.private, public: kp.public };
    }
  }
  throw new Error(`could not mint a parseable ${type} key`);
}

export interface FakeHost {
  port: number;
  /** The `ssh-keyscan`-style line for each host key, as a human would paste it. */
  keyscan: string[];
  /** Methods the client attempted, in order. */
  authAttempts: string[];
  /** Commands the server was asked to run. */
  commands: string[];
  /** Where SFTP paths resolve. */
  root: string;
  close(): Promise<void>;
}

function asParsed(key: string): ParsedKey {
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error) throw parsed;
  return Array.isArray(parsed) ? parsed[0]! : parsed;
}

export async function startFakeHost(options: {
  hostKeys: KeyPair[];
  /** Public keys allowed to log in. */
  authorized: KeyPair[];
  username?: string;
  /** Listen on this port rather than a free one — a host "coming back up" where it was. */
  port?: number;
  /** Present the host key, then never answer authentication: a host up but stalled in login. */
  stallAuth?: boolean;
  /** Accept the SFTP subsystem and then answer nothing, like a hung mount. */
  stallSftp?: boolean;
}): Promise<FakeHost> {
  const root = mkdtempSync(join(tmpdir(), "strad-ssh-fake-"));
  const authAttempts: string[] = [];
  const commands: string[] = [];
  const allowed = options.authorized.map((k) => asParsed(k.public));
  const username = options.username ?? "runner";
  const connections = new Set<Connection>();

  const server = new Server(
    { hostKeys: options.hostKeys.map((k) => k.private) },
    (client) => {
      connections.add(client);
      client.on("close", () => connections.delete(client));
      client.on("error", () => undefined);
      client.on("authentication", (ctx) => {
        authAttempts.push(ctx.method);
        if (options.stallAuth) return;
        if (ctx.method !== "publickey" || ctx.username !== username) {
          return ctx.reject(["publickey"]);
        }
        const match = allowed.find(
          (k) => k.type === ctx.key.algo && k.getPublicSSH().equals(ctx.key.data),
        );
        if (!match) return ctx.reject(["publickey"]);
        if (ctx.signature && ctx.blob) {
          if (match.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
            return ctx.reject(["publickey"]);
          }
        }
        ctx.accept();
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec, _reject, info) => {
            commands.push(info.command);
            const stream = acceptExec();
            const child = spawn("sh", ["-c", info.command], { cwd: root });
            child.stdout.pipe(stream, { end: false });
            child.stderr.pipe(stream.stderr, { end: false });
            stream.on("signal", () => child.kill("SIGKILL"));
            stream.on("close", () => child.kill("SIGKILL"));
            child.on("close", (code, signal) => {
              if (signal) stream.exit(signal.replace(/^SIG/, ""), false, "");
              else stream.exit(code ?? 0);
              stream.end();
            });
          });
          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp();
            if (!options.stallSftp) return serveSftp(sftp, root);
            // ssh2 answers OP_UNSUPPORTED for a request nobody listens for, so
            // a stall needs a listener that never replies.
            for (const ev of ["OPEN", "OPENDIR", "STAT", "LSTAT", "FSTAT", "REALPATH", "READ", "WRITE", "READDIR", "CLOSE"]) {
              sftp.on(ev, () => undefined);
            }
          });
        });
      });
    },
  );

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const keyscan = options.hostKeys.map((k) => `[127.0.0.1]:${port} ${k.public.trim().split(/\s+/).slice(0, 2).join(" ")}`);

  return {
    port,
    keyscan,
    authAttempts,
    commands,
    root,
    close: async () => {
      for (const c of connections) c.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Enough SFTP for stat, readdir, read and write, mapped onto `root`. */
function serveSftp(sftp: SFTPWrapper, root: string): void {
  const handles = new Map<number, { fd?: number; dir?: string[]; dirPath?: string; done?: boolean }>();
  let next = 0;
  const local = (p: string) => join(root, p.replace(/^\/+/, ""));
  const toHandle = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const fromHandle = (b: Buffer) => b.readUInt32BE(0);
  const attrsOf = (st: fs.Stats) => ({
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  });
  const statusFor = (err: NodeJS.ErrnoException) =>
    err.code === "ENOENT"
      ? STATUS_CODE.NO_SUCH_FILE
      : err.code === "EACCES"
        ? STATUS_CODE.PERMISSION_DENIED
        : STATUS_CODE.FAILURE;

  sftp.on("OPEN", (id, filename, flags, attrs) => {
    let mode = "r";
    if (flags & OPEN_MODE.WRITE) mode = flags & OPEN_MODE.TRUNC || flags & OPEN_MODE.CREAT ? "w" : "r+";
    if (flags & OPEN_MODE.APPEND) mode = "a";
    fs.open(local(filename), mode, attrs.mode ?? 0o644, (err, fd) => {
      if (err) return sftp.status(id, statusFor(err));
      const h = next++;
      handles.set(h, { fd });
      sftp.handle(id, toHandle(h));
    });
  });
  sftp.on("READ", (id, handle, offset, len) => {
    const h = handles.get(fromHandle(handle));
    if (h?.fd === undefined) return sftp.status(id, STATUS_CODE.FAILURE);
    const buf = Buffer.alloc(len);
    fs.read(h.fd, buf, 0, len, offset, (err, n) => {
      if (err) return sftp.status(id, statusFor(err));
      if (n === 0) return sftp.status(id, STATUS_CODE.EOF);
      sftp.data(id, buf.subarray(0, n));
    });
  });
  sftp.on("WRITE", (id, handle, offset, data) => {
    const h = handles.get(fromHandle(handle));
    if (h?.fd === undefined) return sftp.status(id, STATUS_CODE.FAILURE);
    fs.write(h.fd, data, 0, data.length, offset, (err) =>
      sftp.status(id, err ? statusFor(err) : STATUS_CODE.OK),
    );
  });
  sftp.on("FSTAT", (id, handle) => {
    const h = handles.get(fromHandle(handle));
    if (h?.fd === undefined) return sftp.status(id, STATUS_CODE.FAILURE);
    fs.fstat(h.fd, (err, st) => (err ? sftp.status(id, statusFor(err)) : sftp.attrs(id, attrsOf(st))));
  });
  sftp.on("FSETSTAT", (id) => sftp.status(id, STATUS_CODE.OK));
  sftp.on("CLOSE", (id, handle) => {
    const n = fromHandle(handle);
    const h = handles.get(n);
    handles.delete(n);
    if (h?.fd !== undefined) fs.close(h.fd, () => sftp.status(id, STATUS_CODE.OK));
    else sftp.status(id, STATUS_CODE.OK);
  });
  const stat = (id: number, path: string, fn: typeof fs.stat) =>
    fn(local(path), (err, st) => (err ? sftp.status(id, statusFor(err)) : sftp.attrs(id, attrsOf(st))));
  sftp.on("STAT", (id, path) => stat(id, path, fs.stat));
  sftp.on("LSTAT", (id, path) => stat(id, path, fs.lstat));
  sftp.on("OPENDIR", (id, path) => {
    fs.readdir(local(path), (err, names) => {
      if (err) return sftp.status(id, statusFor(err));
      const h = next++;
      handles.set(h, { dir: names, dirPath: local(path) });
      sftp.handle(id, toHandle(h));
    });
  });
  sftp.on("READDIR", (id, handle) => {
    const h = handles.get(fromHandle(handle));
    if (!h?.dir) return sftp.status(id, STATUS_CODE.FAILURE);
    if (h.done) return sftp.status(id, STATUS_CODE.EOF);
    h.done = true;
    sftp.name(
      id,
      h.dir.map((name) => {
        const st = fs.lstatSync(join(h.dirPath!, name));
        return { filename: name, longname: name, attrs: attrsOf(st) };
      }),
    );
  });
  sftp.on("REALPATH", (id, path) =>
    sftp.name(id, [{ filename: path, longname: path, attrs: {} as never }]),
  );
}
