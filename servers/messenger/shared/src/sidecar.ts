/**
 * The Go process that actually speaks Messenger, and the loopback client that
 * speaks to it.
 *
 * WHY A SEPARATE PROCESS. The Messenger protocol — the login, the Lightspeed
 * socket, the end-to-end encrypted chats Meta runs over the WhatsApp protocol,
 * the encrypted-history restore — is mautrix-meta's, in Go, under AGPL-3.0.
 * `servers/messenger/bridge` runs it headless and answers a small JSON API on
 * 127.0.0.1. This MIT tree talks to that API and never links a line of it, so
 * the AGPL stays on the program it covers (README.md has the reasoning).
 *
 * THE PROTOCOL. The child prints one JSON object per line on stdout: first
 * `{"event":"listening","addr":"127.0.0.1:N"}`, later `login_complete`, last
 * `stopped`; `{"event":"fatal"}` if it cannot start. Its stderr is its log,
 * which carries text Meta wrote, so it is passed through to the container's
 * stream (never shipped) and never parsed. Every request carries a bearer
 * token minted here at spawn, so another process in the container that finds
 * the port still cannot read a chat.
 */
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** Where the bundle Dockerfile installs the binary, relative to this file. */
export const DEFAULT_BINARY = fileURLToPath(
  new URL("../../bin/strad-messenger-bridge", import.meta.url),
);

export class BridgeError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
  }
}

export interface SidecarOptions {
  /** The executable, and arguments before none. Tests point this at node. */
  command: string;
  args?: string[];
  dataDir: string;
  bufferMaxAgeDays: number;
  proxy?: string;
  /** Called for each stdout event after `listening`. */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Called once, when the process exits for any reason. */
  onExit?: (code: number | null) => void;
  /** How long the child may take to listen. */
  startTimeoutMs?: number;
}

export interface Sidecar {
  request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
  /** Raw bytes, for attachments. */
  fetchBytes(path: string): Promise<{ data: Buffer; mimeType: string; fileName: string }>;
  stop(): Promise<void>;
}

/**
 * Only what the child needs: the loopback settings, the proxy, and PATH/HOME so
 * it can run. NOT the container's environment — the bundle's process.env holds
 * every other server's credentials, and this child has no use for them.
 */
function childEnv(options: SidecarOptions, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: options.dataDir,
    MESSENGER_BRIDGE_DATA_DIR: options.dataDir,
    MESSENGER_BRIDGE_TOKEN: token,
    MESSENGER_BRIDGE_LISTEN: "127.0.0.1:0",
    MESSENGER_BUFFER_MAX_AGE_DAYS: String(options.bufferMaxAgeDays),
  };
  if (options.proxy) env.MESSENGER_PROXY = options.proxy;
  return env;
}

/** The bridge percent-encodes file names: a header is latin1 on the wire. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function startSidecar(options: SidecarOptions): Promise<Sidecar> {
  const token = randomBytes(32).toString("hex");
  const child: ChildProcess = spawnChild(options.command, options.args ?? [], {
    env: childEnv(options, token),
    stdio: ["ignore", "pipe", "inherit"],
  });
  let exited = false;
  const exitPromise = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      exited = true;
      resolve(code);
      options.onExit?.(code);
    });
  });

  const addr = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new BridgeError("the Messenger bridge process did not start in time")),
      options.startTimeoutMs ?? 60_000,
    );
    const lines = createInterface({ input: child.stdout! });
    let listening = false;
    lines.on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!listening && event.event === "listening" && typeof event.addr === "string") {
        listening = true;
        clearTimeout(timer);
        resolve(event.addr);
      } else if (!listening && event.event === "fatal") {
        clearTimeout(timer);
        reject(new BridgeError(`the Messenger bridge process could not start: ${String(event.error)}`));
      } else if (listening) {
        options.onEvent?.(event);
      }
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(new BridgeError(`the Messenger bridge process could not be spawned: ${err.message}`));
    });
    void exitPromise.then((code) => {
      clearTimeout(timer);
      if (!listening) reject(new BridgeError(`the Messenger bridge process exited (${code}) before it started`));
    });
  }).catch(async (err: unknown) => {
    if (!exited) child.kill("SIGKILL");
    throw err;
  });

  const base = `http://${addr}`;
  const headers = { authorization: `Bearer ${token}` };

  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    if (exited) throw new BridgeError("the Messenger bridge process is not running; it restarts on its own — retry shortly");
    try {
      return await fetch(base + path, {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      throw new BridgeError(
        `the Messenger bridge process did not answer (${err instanceof Error ? err.message : String(err)}); retry shortly`,
      );
    }
  };

  const failure = async (res: Response): Promise<never> => {
    let message = `the Messenger bridge answered ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // keep the status line
    }
    throw new BridgeError(message, res.status);
  };

  return {
    async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
      const res = await send(method, path, body);
      if (!res.ok) return failure(res);
      return (await res.json()) as T;
    },
    async fetchBytes(path: string) {
      const res = await send("GET", path);
      if (!res.ok) return failure(res);
      return {
        data: Buffer.from(await res.arrayBuffer()),
        mimeType: res.headers.get("content-type") ?? "application/octet-stream",
        fileName: safeDecode(res.headers.get("x-file-name") ?? ""),
      };
    },
    async stop() {
      if (exited) return;
      child.kill("SIGTERM");
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000).unref());
      if ((await Promise.race([exitPromise, timeout])) === "timeout") {
        child.kill("SIGKILL");
        await exitPromise;
      }
    },
  };
}
