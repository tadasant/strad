import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { WebSocket } from "ws";

import { keysMatch } from "../mcp/auth.js";
import {
  assertRelayable,
  NO_TAB,
  type BrowserBackend,
  type RawTab,
} from "./backend.js";

/**
 * The daemon half of the Chrome extension bridge. The extension half is
 * `hostd/extension/background.js`; the two speak this protocol over ONE
 * WebSocket the extension opens to the control listener:
 *
 *   extension → daemon   {type:"hello", nonce, version, extensionId}
 *   daemon → extension   {type:"welcome", proof, nonce, daemon, version}
 *   extension → daemon   {type:"auth", proof}
 *   daemon → extension   {type:"ready"}               or the socket closes
 *   daemon → extension   {type:"call", id, op, ...}
 *   extension → daemon   {type:"result", id, result} | {type:"error", id, message}
 *   extension → daemon   {type:"event", event:"detached"|"tabRemoved", tabId, reason?}
 *   daemon → extension   {type:"ping"}      extension → daemon   {type:"pong"}
 *
 * Ops: `tabs`, `create`, `activate`, `close`, `attach`, `detach`,
 * `detachAll`, `send` (a DevTools command to an attached tab, never one in
 * the `WebAuthn` domain).
 *
 * `attach` succeeds on a tab carrying ANOTHER extension's frame (a password
 * manager's overlay), which `chrome.debugger` alone refuses: the extension
 * moves those frames out of the page for as long as it is attached and puts
 * them back on `detach`. A frame that arrives later makes Chrome drop the
 * attachment, which reaches this side as a `detached` event; the next
 * command re-attaches and moves it aside too.
 *
 * WHY THIS EXISTS. Chrome ignores `--remote-debugging-port` on the default
 * profile (136+) and its `chrome://inspect` toggle asks a person on every
 * connection (144+). `chrome.debugger` from an extension installed in that
 * profile is the one route to the owner's real, signed-in Chrome that shows
 * no per-connection prompt — which is also exactly why the pairing exists:
 * this door leads to every account the owner is logged in to, any process on
 * the machine can open a socket to loopback, and any process can BIND the
 * control port while the daemon is down and wait for the extension to dial
 * in. So the token never crosses the socket. Each side proves it holds the
 * token with an HMAC over a nonce the other side chose: the daemon proves
 * itself first, in `welcome`, and an extension that cannot verify that proof
 * hangs up before it has done anything; then the extension proves itself in
 * `auth`, and nothing is relayed before that. The listener already refuses a
 * non-`chrome-extension://` Origin and any proxied request.
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

const HANDSHAKE_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 15_000;
/** Nonces are hex, from 16 to 64 bytes: unguessable, and bounded so a hello cannot be a megabyte. */
const NONCE = /^[0-9a-f]{32,128}$/;

/** What each side signs: its role, then the OTHER side's nonce. */
export function proofFor(
  token: string,
  role: "daemon" | "extension",
  nonce: string,
): string {
  return createHmac("sha256", token)
    .update(`strad-hostd ${role} ${nonce}`)
    .digest("hex");
}

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
   * headers, a `chrome-extension://` Origin). The handshake decides the rest.
   */
  accept(ws: WebSocket, req?: IncomingMessage): void {
    // First, before any frame is read: `ws` emits `error` for a malformed
    // frame, and an unhandled one is an uncaught exception that takes the
    // daemon down. Three bytes from any local process must not do that.
    ws.on("error", () => ws.terminate());
    const log = this.opts.log ?? (() => {});
    const origin = req?.headers.origin ?? "";
    const timer = setTimeout(
      () => ws.close(4008, "handshake timed out"),
      HANDSHAKE_TIMEOUT_MS,
    );
    const refuse = (code: number, reason: string) => {
      clearTimeout(timer);
      log(`[extension] refused a connection from ${origin}: ${reason}`);
      ws.close(code, reason);
    };
    const parse = (data: unknown): Record<string, unknown> | undefined => {
      try {
        const v: unknown = JSON.parse(String(data));
        return v && typeof v === "object"
          ? (v as Record<string, unknown>)
          : undefined;
      } catch {
        return undefined;
      }
    };

    ws.once("message", (data) => {
      const hello = parse(data);
      if (
        !hello ||
        hello.type !== "hello" ||
        typeof hello.nonce !== "string" ||
        !NONCE.test(hello.nonce)
      ) {
        return refuse(4002, "bad hello");
      }
      const ours = randomBytes(32).toString("hex");
      ws.send(
        JSON.stringify({
          type: "welcome",
          proof: proofFor(this.opts.token, "daemon", hello.nonce),
          nonce: ours,
          daemon: "strad-hostd",
          version: this.opts.version ?? "",
        }),
      );
      ws.once("message", (data) => {
        const auth = parse(data);
        if (
          !auth ||
          auth.type !== "auth" ||
          typeof auth.proof !== "string" ||
          !keysMatch(auth.proof, proofFor(this.opts.token, "extension", ours))
        ) {
          return refuse(4003, "bad token");
        }
        clearTimeout(timer);
        this.adopt(ws, {
          version:
            typeof hello.version === "string" ? hello.version : undefined,
          extensionId:
            typeof hello.extensionId === "string"
              ? hello.extensionId
              : undefined,
        });
      });
    });
  }

  private adopt(
    ws: WebSocket,
    info: { version?: string; extensionId?: string },
  ): void {
    const log = this.opts.log ?? (() => {});
    if (this.ws) {
      // A second Chrome profile, or a reconnect that beat the old socket's
      // close. The newest wins; there is one owner and one live profile.
      log("[extension] replaced the previous connection");
      const old = this.ws;
      this.drop(old);
      old.close(4000, "replaced");
    }
    this.ws = ws;
    this.info = { ...info, since: Date.now() };
    ws.on("message", (d) => this.onMessage(String(d)));
    ws.on("close", () => this.drop(ws));
    ws.on("error", () => this.drop(ws));
    ws.send(JSON.stringify({ type: "ready" }));
    this.pinger = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, this.opts.pingMs ?? 20_000);
    this.pinger.unref();
    log(
      `[extension] connected: ${info.extensionId ?? "?"} v${info.version ?? "?"}`,
    );
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

  /** The bridge thought a tab was attached and the extension says not: start over. */
  forget(tabId: number): void {
    this.holders.delete(tabId);
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

  /**
   * The kill switch: every attachment ends now, whoever held it. The count
   * on the status page drops once the extension has answered, so what the
   * owner reads is what Chrome has done.
   */
  async detachAll(): Promise<void> {
    if (this.holders.size === 0) return;
    if (this.ws) await this.call("detachAll").catch(() => {});
    this.holders.clear();
  }

  backend(): ExtensionBackend {
    return new ExtensionBackend(this);
  }

  close(): void {
    const ws = this.ws;
    if (ws) {
      this.drop(ws);
      ws.close(1001, "daemon stopping");
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
    assertRelayable(method);
    const n = tabNumber(tabId);
    const attached = async () => {
      await this.bridge.attach(this, n);
      // The grant ended while the attach was in flight: the holder just
      // recorded would never be released, and the tab would stay attached
      // for the daemon's lifetime.
      if (this.closed) {
        this.bridge.release(this);
        throw new Error("the grant ended");
      }
    };
    await attached();
    try {
      return await this.bridge.call<T>(
        "send",
        { tabId: n, method, params },
        timeoutMs,
      );
    } catch (err) {
      // The extension lost the attachment without saying so (a detach it did
      // itself, a Chrome-side drop): re-attach once rather than fail every
      // call for the rest of the grant.
      if (!/not attached/i.test((err as Error).message)) throw err;
      this.bridge.forget(n);
      await attached();
      return this.bridge.call<T>(
        "send",
        { tabId: n, method, params },
        timeoutMs,
      );
    }
  }

  close(): void {
    this.closed = true;
    this.bridge.release(this);
  }
}
