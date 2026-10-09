import type { Duplex } from "node:stream";

/**
 * What `hello` answers: enough to say whether a computer-use server can work.
 */
export interface HelperHello {
  version: string;
  pid: number;
  executable: string;
  trusted: { accessibility: boolean; screen_recording: boolean };
}

/** A line the helper sends on its own, when the person at the machine acts. */
export type HelperEvent =
  | { event: "kill"; grant_id: string }
  | { event: "disable" }
  | { event: "owner_input"; grant_id: string };

export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The daemon's side of the JSON-lines protocol `strad-hostd-ax` speaks
 * (`ax/Sources/strad-hostd-ax/Transport.swift` is the other side).
 *
 * The transport is whatever `connect` returns — a Unix socket to the helper's
 * LaunchAgent, or the stdio of a helper spawned as a child — and it is
 * (re)opened lazily on the first call after it drops. A helper that is not
 * there is an error on the call that needed it, never a crashed daemon: the
 * shell and browser servers do not depend on it, and the banner is best-effort.
 */
export class HelperClient {
  private stream?: Duplex;
  private connecting?: Promise<Duplex>;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private buffer = "";
  private lastError?: string;

  constructor(
    private readonly opts: {
      connect: () => Promise<Duplex>;
      requestTimeoutMs: number;
      /** What error text calls it. */
      name?: string;
      onEvent?: (event: HelperEvent) => void;
      onConnect?: () => void;
      log?: (line: string) => void;
    },
  ) {}

  get connected(): boolean {
    return this.stream !== undefined;
  }

  /** Why the last connection attempt failed, for status text. */
  get error(): string | undefined {
    return this.lastError;
  }

  private async open(): Promise<Duplex> {
    if (this.stream) return this.stream;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let stream: Duplex;
      try {
        stream = await this.opts.connect();
      } catch (err) {
        this.lastError = (err as Error).message;
        throw err;
      } finally {
        this.connecting = undefined;
      }
      this.lastError = undefined;
      this.buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => this.receive(chunk));
      const drop = (why: string) => {
        if (this.stream !== stream) return;
        this.stream = undefined;
        this.lastError = why;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(
            new HelperError(
              "disconnected",
              `${this.opts.name ?? "the native helper"} ${why}`,
            ),
          );
          this.pending.delete(id);
        }
        this.opts.log?.(`helper ${why}`);
      };
      stream.on("close", () => drop("disconnected"));
      stream.on("error", (err: Error) => drop(`failed: ${err.message}`));
      this.stream = stream;
      this.opts.log?.("helper connected");
      this.opts.onConnect?.();
      return stream;
    })();
    return this.connecting;
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.opts.log?.(
          `helper sent a line that is not JSON: ${line.slice(0, 120)}`,
        );
        continue;
      }
      if (typeof msg.event === "string") {
        this.opts.onEvent?.(msg as unknown as HelperEvent);
        continue;
      }
      const id = typeof msg.id === "number" ? msg.id : undefined;
      const p = id !== undefined ? this.pending.get(id) : undefined;
      if (!p) continue;
      this.pending.delete(id!);
      clearTimeout(p.timer);
      if (msg.ok) {
        p.resolve(msg.result);
      } else {
        const e = (msg.error ?? {}) as { code?: string; message?: string };
        p.reject(
          new HelperError(e.code ?? "error", e.message ?? "the helper refused"),
        );
      }
    }
  }

  async call<T = unknown>(
    op: string,
    args: Record<string, unknown> = {},
    timeoutMs = this.opts.requestTimeoutMs,
  ): Promise<T> {
    const stream = await this.open();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new HelperError(
            "timeout",
            `${this.opts.name ?? "the native helper"} did not answer ${op} within ${Math.round(timeoutMs / 1000)}s`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      stream.write(JSON.stringify({ id, op, args }) + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(
            new HelperError("disconnected", `write failed: ${err.message}`),
          );
        }
      });
    });
  }

  hello(): Promise<HelperHello> {
    return this.call<HelperHello>("hello", {}, 5000);
  }

  close(): void {
    const s = this.stream;
    this.stream = undefined;
    s?.destroy();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new HelperError("closed", "the daemon is shutting down"));
      this.pending.delete(id);
    }
  }
}
