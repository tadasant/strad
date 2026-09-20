/**
 * A DevTools-protocol client: one WebSocket to the BROWSER target, flat sessions
 * for the tabs. Node's built-in WebSocket, so the daemon carries no browser
 * automation library — it attaches to a Chrome that is already running and has
 * no use for the half of Playwright that launches one.
 */
export type CdpEvent = {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
};

const CALL_TIMEOUT_MS = 15_000;

export class CdpConnection {
  private seq = 0;
  private readonly waiting = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (msg) => this.onMessage(String(msg.data)));
    ws.addEventListener("close", () =>
      this.fail(new Error("the DevTools connection closed")),
    );
    ws.addEventListener("error", () =>
      this.fail(new Error("the DevTools connection failed")),
    );
  }

  static connect(url: string, timeoutMs = 8000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      // Chrome's own "Allow remote debugging?" prompt holds the socket open
      // until the person answers it; an unanswered one must not hold a tool call.
      const timer = setTimeout(() => {
        ws.close();
        reject(
          new Error(
            'Chrome did not accept the DevTools connection in time. It may be showing its own "Allow remote debugging?" prompt, which someone at the machine has to accept',
          ),
        );
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("could not open the DevTools WebSocket"));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  on(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("the DevTools connection is closed"));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(
          new Error(`${method} did not answer within ${timeoutMs / 1000}s`),
        );
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: resolve as (v: Record<string, unknown>) => void,
        reject,
        timer,
      });
      this.ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  close(): void {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch {
      // Already closing.
    }
    this.fail(new Error("the DevTools connection was closed"));
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message: string };
    } & Partial<CdpEvent>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const event: CdpEvent = {
        method: msg.method,
        params: msg.params ?? {},
        sessionId: msg.sessionId,
      };
      for (const l of this.listeners) l(event);
    }
  }

  private fail(err: Error): void {
    this.closed = true;
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiting.clear();
  }
}
