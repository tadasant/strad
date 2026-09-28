import type { IncomingMessage } from "node:http";

import type { WebSocket } from "ws";

import { keysMatch } from "../mcp/auth.js";
import { NO_TAB, type BrowserBackend, type RawTab } from "./backend.js";

/**
 * The daemon half of the Chrome extension bridge. The extension half is
 * `hostd/extension/background.js`; the two speak this protocol over ONE
 * WebSocket the extension opens to the control listener:
 *
 *   extension → daemon   {type:"hello", token, version, extensionId}
 *   daemon → extension   {type:"welcome", daemon, version}   or the socket closes
 *   daemon → extension   {type:"call", id, op, ...}
 *   extension → daemon   {type:"result", id, result} | {type:"error", id, message}
 *   extension → daemon   {type:"event", event:"detached"|"tabRemoved", tabId, reason?}
 *   daemon → extension   {type:"ping"}      extension → daemon   {type:"pong"}
 *
 * Ops: `tabs`, `create`, `activate`, `close`, `attach`, `detach`,
 * `detachAll`, `send` (a DevTools command to an attached tab).
 *
 * WHY THIS EXISTS. Chrome ignores `--remote-debugging-port` on the default
 * profile (136+) and its `chrome://inspect` toggle asks a person on every
 * connection (144+). `chrome.debugger` from an extension installed in that
 * profile is the one route to the owner's real, signed-in Chrome that shows
 * no per-connection prompt — which is also exactly why the token exists: any
 * process on the machine can open a socket to loopback, and this door leads
 * to every account the owner is logged in to. The listener already refuses a
 * non-`chrome-extension://` Origin and any proxied request; the token is what
 * stops a local process from posing as the extension, and what stops a rogue
 * listener from posing as the daemon (the extension only sends it, and only
 * to the URL its own settings name).
 *
 * ONE extension, MANY grants. `chrome.debugger` attaches a tab once per
 * extension, so attachments are shared: each grant's backend holds the tabs
 * it used, the bridge counts holders, and the tab is detached when the last
 * holder lets go — or at once, for every tab, when the kill switch is thrown.
 */
export interface BridgeState {
  connected: boolean;
  version?: string;
  extensionId?: string;
  since?: number;
  attachedTabs: number;
}

interface Call {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const HELLO_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 15_000;

export class ExtensionBridge {
  private ws?: WebSocket;
  private info: { version?: string; extensionId?: string; since?: number } = {};
  private seq = 0;
  private readonly waiting = new Map<number, Call>();
  /** tabId → the backends holding an attachment to it. */
  private readonly holders = new Map<number, Set<object>>();
  private pinger?: NodeJS.Timeout;

  constructor(
    private readonly opts: {
      token: string;
      /** The kill switch: thrown, nothing new attaches. */
      disabled?: () => boolean;
      log?: (line: string) => void;
      pingMs?: number;
      version?: string;
    },
  ) {}

  get connected(): boolean {
    return this.ws !== undefined;
  }

  state(): BridgeState {
    return {
      connected: this.connected,
      ...this.info,
      attachedTabs: this.holders.size,
    };
  }

  /**
   * Take a socket the listener already vetted (loopback Host, no proxy
   * headers, a `chrome-extension://` Origin). The hello decides the rest.
   */
  accept(ws: WebSocket, req?: IncomingMessage): void {
    const log = this.opts.log ?? (() => {});
    const origin = req?.headers.origin ?? "";
    const timer = setTimeout(
      () => ws.close(4008, "no hello"),
      HELLO_TIMEOUT_MS,
    );
    ws.once("message", (data) => {
      clearTimeout(timer);
      let hello: {
        type?: string;
        token?: string;
        version?: string;
        extensionId?: string;
      };
      try {
        hello = JSON.parse(String(data));
      } catch {
        return ws.close(4002, "not JSON");
      }
      if (
        hello.type !== "hello" ||
        typeof hello.token !== "string" ||
        !keysMatch(hello.token, this.opts.token)
      ) {
        log(`[extension] refused a connection from ${origin}: bad token`);
        return ws.close(4003, "bad token");
      }
      if (this.ws) {
        // A second Chrome profile, or a reconnect that beat the old socket's
        // close. The newest wins; there is one owner and one live profile.
        log("[extension] replaced the previous connection");
        this.ws.close(4000, "replaced");
        this.drop(this.ws);
      }
      this.ws = ws;
      this.info = {
        version: hello.version,
        extensionId: hello.extensionId,
        since: Date.now(),
      };
      ws.on("message", (d) => this.onMessage(String(d)));
      ws.on("close", () => this.drop(ws));
      ws.on("error", () => this.drop(ws));
      ws.send(
        JSON.stringify({
          type: "welcome",
          daemon: "strad-hostd",
          version: this.opts.version ?? "",
        }),
      );
      this.pinger = setInterval(() => {
        if (ws.readyState === ws.OPEN)
          ws.send(JSON.stringify({ type: "ping" }));
      }, this.opts.pingMs ?? 20_000);
      this.pinger.unref();
      log(
        `[extension] connected: ${hello.extensionId ?? "?"} v${hello.version ?? "?"}`,
      );
    });
  }

  private drop(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = undefined;
    this.info = {};
    clearInterval(this.pinger);
    const err = new Error("the Chrome extension disconnected");
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiting.clear();
    // The extension detaches everything itself when its socket closes.
    this.holders.clear();
    this.opts.log?.("[extension] disconnected");
  }

  private onMessage(raw: string): void {
    let msg: {
      type?: string;
      id?: number;
      result?: unknown;
      message?: string;
      event?: string;
      tabId?: number;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "result" || msg.type === "error") {
      if (typeof msg.id !== "number") return;
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.type === "error") w.reject(new Error(msg.message ?? "error"));
      else w.resolve(msg.result ?? {});
      return;
    }
    if (msg.type === "event") {
      if (
        (msg.event === "detached" || msg.event === "tabRemoved") &&
        typeof msg.tabId === "number"
      ) {
        this.holders.delete(msg.tabId);
      }
      return;
    }
  }

  call<T = Record<string, unknown>>(
    op: string,
    fields: Record<string, unknown> = {},
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<T> {
    const ws = this.ws;
    if (!ws)
      return Promise.reject(new Error("the Chrome extension is not connected"));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${op} did not answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      ws.send(JSON.stringify({ type: "call", id, op, ...fields }));
    });
  }

  /** Attach for a holder; the first holder attaches, the rest share. */
  async attach(holder: object, tabId: number): Promise<void> {
    if (this.opts.disabled?.())
      throw new Error("remote control of this machine is switched off");
    let set = this.holders.get(tabId);
    if (!set) {
      try {
        await this.call("attach", { tabId });
      } catch (err) {
        if (/no tab|invalid tab|not found/i.test((err as Error).message))
          throw NO_TAB(String(tabId));
        throw err;
      }
      set = this.holders.get(tabId) ?? new Set();
      this.holders.set(tabId, set);
    }
    set.add(holder);
  }

  /** A holder is done: detach every tab nobody else holds. */
  release(holder: object): void {
    for (const [tabId, set] of [...this.holders]) {
      if (!set.delete(holder)) continue;
      if (set.size === 0) {
        this.holders.delete(tabId);
        this.call("detach", { tabId }).catch(() => {});
      }
    }
  }

  /** The kill switch: every attachment ends now, whoever held it. */
  async detachAll(): Promise<void> {
    const had = this.holders.size;
    this.holders.clear();
    if (had > 0 && this.ws) await this.call("detachAll").catch(() => {});
  }

  backend(): ExtensionBackend {
    return new ExtensionBackend(this);
  }

  close(): void {
    const ws = this.ws;
    if (ws) {
      ws.close(1001, "daemon stopping");
      this.drop(ws);
    }
  }
}

/** Tab ids cross the wire as `chrome.tabs` numbers and reach tools as strings. */
function tabNumber(id: string): number {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 0) throw NO_TAB(id);
  return n;
}

/** One grant's view of the extension: what it attached, released together. */
export class ExtensionBackend implements BrowserBackend {
  readonly kind = "extension";
  private closed = false;

  constructor(private readonly bridge: ExtensionBridge) {}

  get isClosed(): boolean {
    return this.closed || !this.bridge.connected;
  }

  async tabs(): Promise<RawTab[]> {
    const { tabs } = await this.bridge.call<{
      tabs: { tabId: number; title: string; url: string }[];
    }>("tabs");
    return tabs
      .filter(
        (t) =>
          !t.url.startsWith("devtools://") &&
          !t.url.startsWith("chrome-extension://"),
      )
      .map((t) => ({ id: String(t.tabId), title: t.title, url: t.url }));
  }

  async createTab(url: string, background: boolean): Promise<string> {
    const { tabId } = await this.bridge.call<{ tabId: number }>("create", {
      url,
      background,
    });
    return String(tabId);
  }

  async activateTab(id: string): Promise<void> {
    await this.bridge.call("activate", { tabId: tabNumber(id) });
  }

  async closeTab(id: string): Promise<void> {
    await this.bridge.call("close", { tabId: tabNumber(id) });
  }

  async send<T = Record<string, unknown>>(
    tabId: string,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const n = tabNumber(tabId);
    await this.bridge.attach(this, n);
    return this.bridge.call<T>("send", { tabId: n, method, params }, timeoutMs);
  }

  close(): void {
    this.closed = true;
    this.bridge.release(this);
  }
}
