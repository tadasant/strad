/**
 * A REAL SSH server on loopback, standing in for a Hatchbox web server.
 *
 * It is ssh2's own server half, so the handshake, the host-key exchange and the
 * publickey signature are the protocol, not a stub of it. `exec` runs the
 * command the client sent with the local `sh`, so the remote command this
 * server builds is EXECUTED — `pgrep`, `/proc/<pid>/environ` and all — against
 * a fake puma the test starts on this machine.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import type { Connection, ParsedKey } from "ssh2";

const { Server, utils } = ssh2;

export interface KeyPair {
  private: string;
  public: string;
}

export function keyPair(type: "ed25519" | "rsa" = "ed25519", passphrase?: string): KeyPair {
  const opts = type === "rsa" ? { bits: 2048 } : {};
  // ssh2's Ed25519 generator occasionally emits a key its own parser rejects;
  // mint until one parses (strad's ssh suite does the same).
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

function asParsed(key: string): ParsedKey {
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error) throw parsed;
  return Array.isArray(parsed) ? parsed[0]! : parsed;
}

export interface FakeHost {
  port: number;
  /** `ssh-keyscan`-style line for the host key. */
  keyscan: string;
  /** Methods the client attempted, in order. */
  authAttempts: string[];
  commands: string[];
  close(): Promise<void>;
}

export async function startFakeHost(options: {
  hostKey: KeyPair;
  authorized: KeyPair[];
  username?: string;
}): Promise<FakeHost> {
  const authAttempts: string[] = [];
  const commands: string[] = [];
  const allowed = options.authorized.map((k) => asParsed(k.public));
  const username = options.username ?? "deploy";
  const connections = new Set<Connection>();

  const server = new Server({ hostKeys: [options.hostKey.private] }, (client) => {
    connections.add(client);
    client.on("close", () => connections.delete(client));
    client.on("error", () => undefined);
    client.on("authentication", (ctx) => {
      authAttempts.push(ctx.method);
      if (ctx.method !== "publickey" || ctx.username !== username) return ctx.reject(["publickey"]);
      const match = allowed.find((k) => k.type === ctx.key.algo && k.getPublicSSH().equals(ctx.key.data));
      if (!match) return ctx.reject(["publickey"]);
      if (ctx.signature && ctx.blob && match.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
        return ctx.reject(["publickey"]);
      }
      ctx.accept();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          commands.push(info.command);
          const stream = acceptExec();
          const child = spawn("sh", ["-c", info.command]);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          child.on("close", (code) => {
            stream.exit(code ?? 0);
            stream.end();
          });
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    keyscan: `[127.0.0.1]:${port} ${options.hostKey.public.trim().split(/\s+/).slice(0, 2).join(" ")}`,
    authAttempts,
    commands,
    close: async () => {
      for (const c of connections) c.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A process whose title reads like a puma master for `app`, holding `env` and
 * nothing else. A real master retitles itself `puma 6.4.2 (<bind>) [<tag>]`;
 * this one sets the same title, so `/proc/<pid>/cmdline` — what `pgrep -f`
 * reads — carries it. `title` overrides it, for decoys.
 */
export async function startFakePuma(
  app: string,
  env: Record<string, string>,
  title = `puma 6.4.2 (unix:///home/deploy/${app}/shared/tmp/sockets/puma.sock) [${app}]`,
): Promise<ChildProcess> {
  // The script is padded so the original argv is longer than any title: Linux
  // node writes process.title over the argv area and cannot grow it.
  const script = `process.title = ${JSON.stringify(title)}; setInterval(() => {}, 1e9); /*${" ".repeat(200)}*/`;
  const child = spawn(process.execPath, ["-e", script], { env, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 400));
  return child;
}
