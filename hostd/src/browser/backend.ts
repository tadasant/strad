import { CdpConnection } from "./cdp.js";

/** A tab as either backend reports it, before ownership is layered on. */
export interface RawTab {
  id: string;
  title: string;
  url: string;
}

/**
 * The two ways into the owner's Chrome, reduced to what the tools need: list,
 * open, focus and close tabs, and send a DevTools command to one. A
 * `BrowserSession` holds one of these per grant and never learns which.
 *
 * `devtools` is a WebSocket to the browser target, with a flat session per
 * tab. `extension` is a request to the bridge extension, which attaches
 * `chrome.debugger` to the tab inside the profile. The tab ids differ in
 * shape (a target id, a `chrome.tabs` number as a string) and are opaque to
 * the caller either way.
 */
export interface BrowserBackend {
  readonly kind: "devtools" | "extension";
  readonly isClosed: boolean;
  tabs(): Promise<RawTab[]>;
  createTab(url: string, background: boolean): Promise<string>;
  activateTab(id: string): Promise<void>;
  closeTab(id: string): Promise<void>;
  /** Send a command to a tab, attaching to it on first use. */
  send<T = Record<string, unknown>>(
    tabId: string,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  /** Let go of everything this backend attached. The tabs stay. */
  close(): void;
}

export const NO_TAB = (id: string): Error =>
  new Error(`No tab "${id}". list_tabs shows the tabs there are.`);

/**
 * DevTools domains neither backend sends, whatever a caller asks. `WebAuthn`
 * installs virtual authenticators and answers credential requests, which is
 * a passkey or security-key ceremony done without the owner — and that is
 * the owner's alone. No tool sends it; this keeps one from starting to. The
 * extension refuses the same domain on its side of the socket.
 */
const REFUSED_DOMAINS = ["WebAuthn."];

export function assertRelayable(method: string): void {
  if (REFUSED_DOMAINS.some((d) => method.startsWith(d)))
    throw new Error(`${method} is never sent to the owner's browser`);
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

/** The DevTools-protocol backend: `DevToolsActivePort` or `browser.cdpUrl`. */
export class CdpBackend implements BrowserBackend {
  readonly kind = "devtools";
  private readonly sessions = new Map<string, string>();

  private constructor(private readonly conn: CdpConnection) {
    conn.on((e) => {
      if (
        e.method === "Target.detachedFromTarget" ||
        e.method === "Target.targetDestroyed"
      ) {
        const gone = e.params.targetId as string | undefined;
        if (gone) this.sessions.delete(gone);
      }
    });
  }

  static async connect(wsUrl: string): Promise<CdpBackend> {
    return new CdpBackend(await CdpConnection.connect(wsUrl));
  }

  get isClosed(): boolean {
    return this.conn.isClosed;
  }

  async tabs(): Promise<RawTab[]> {
    const { targetInfos } = await this.conn.send<{
      targetInfos: TargetInfo[];
    }>("Target.getTargets");
    return targetInfos
      .filter((t) => t.type === "page" && !t.url.startsWith("devtools://"))
      .map((t) => ({ id: t.targetId, title: t.title, url: t.url }));
  }

  async createTab(url: string, background: boolean): Promise<string> {
    const { targetId } = await this.conn.send<{ targetId: string }>(
      "Target.createTarget",
      { url, background },
    );
    return targetId;
  }

  async activateTab(id: string): Promise<void> {
    await this.conn.send("Target.activateTarget", { targetId: id });
  }

  async closeTab(id: string): Promise<void> {
    await this.conn.send("Target.closeTarget", { targetId: id });
  }

  /** The flat-session id for a tab, attaching on first use. */
  private async attach(tabId: string): Promise<string> {
    const existing = this.sessions.get(tabId);
    if (existing) return existing;
    let sessionId: string;
    try {
      ({ sessionId } = await this.conn.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId: tabId, flatten: true },
      ));
    } catch {
      throw NO_TAB(tabId);
    }
    this.sessions.set(tabId, sessionId);
    await this.conn.send("Page.enable", {}, sessionId);
    await this.conn.send("Runtime.enable", {}, sessionId);
    return sessionId;
  }

  async send<T = Record<string, unknown>>(
    tabId: string,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    assertRelayable(method);
    const sessionId = await this.attach(tabId);
    return this.conn.send<T>(method, params, sessionId, timeoutMs);
  }

  close(): void {
    // Chrome detaches every flat session when the socket goes.
    this.conn.close();
    this.sessions.clear();
  }
}
