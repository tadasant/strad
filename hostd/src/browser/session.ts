import type { Config } from "../config.js";
import type { Grant } from "../consent/grants.js";
import { CdpConnection } from "./cdp.js";
import { discoverBrowserWsUrl } from "./discover.js";

export interface TabInfo {
  tab_id: string;
  title: string;
  url: string;
  opened_by_you: boolean;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

/**
 * One grant's hold on the browser: a DevTools connection, the tabs it has
 * attached to, and the tabs it opened. It closes when the grant ends — the kill
 * button drops the socket, and Chrome detaches every session on it. The TABS
 * stay: a tab left in a state for the owner is half of what this is for.
 */
export class BrowserSession {
  private conn?: CdpConnection;
  private readonly sessions = new Map<string, string>();
  readonly opened = new Set<string>();

  constructor(private readonly config: Config) {}

  async connection(): Promise<CdpConnection> {
    if (this.conn && !this.conn.isClosed) return this.conn;
    this.sessions.clear();
    const conn = await CdpConnection.connect(
      await discoverBrowserWsUrl(this.config),
    );
    conn.on((e) => {
      if (
        e.method === "Target.detachedFromTarget" ||
        e.method === "Target.targetDestroyed"
      ) {
        const gone = e.params.targetId as string | undefined;
        if (gone) this.sessions.delete(gone);
      }
    });
    this.conn = conn;
    return conn;
  }

  async tabs(): Promise<TabInfo[]> {
    const conn = await this.connection();
    const { targetInfos } = await conn.send<{ targetInfos: TargetInfo[] }>(
      "Target.getTargets",
    );
    return targetInfos
      .filter((t) => t.type === "page" && !t.url.startsWith("devtools://"))
      .map((t) => ({
        tab_id: t.targetId,
        title: t.title,
        url: t.url,
        opened_by_you: this.opened.has(t.targetId),
      }));
  }

  /** The flat-session id for a tab, attaching on first use. */
  async attach(tabId: string): Promise<string> {
    const conn = await this.connection();
    const existing = this.sessions.get(tabId);
    if (existing) return existing;
    let sessionId: string;
    try {
      ({ sessionId } = await conn.send<{ sessionId: string }>(
        "Target.attachToTarget",
        {
          targetId: tabId,
          flatten: true,
        },
      ));
    } catch {
      throw new Error(`No tab "${tabId}". list_tabs shows the tabs there are.`);
    }
    this.sessions.set(tabId, sessionId);
    await conn.send("Page.enable", {}, sessionId);
    await conn.send("Runtime.enable", {}, sessionId);
    return sessionId;
  }

  async send<T = Record<string, unknown>>(
    tabId: string,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const sessionId = await this.attach(tabId);
    return (await this.connection()).send<T>(
      method,
      params,
      sessionId,
      timeoutMs,
    );
  }

  /** Evaluate in the page and return the value, or throw the page's own error. */
  async evaluate<T = unknown>(tabId: string, expression: string): Promise<T> {
    const res = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text,
      );
    }
    return res.result.value as T;
  }

  async waitForLoad(
    tabId: string,
    timeoutMs = 15_000,
  ): Promise<"complete" | "timeout"> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.evaluate<string>(
        tabId,
        "document.readyState",
      ).catch(() => "loading");
      if (state === "complete") return "complete";
      await new Promise((r) => setTimeout(r, 150));
    }
    return "timeout";
  }

  close(): void {
    this.conn?.close();
    this.conn = undefined;
    this.sessions.clear();
  }
}

/** Sessions by grant, each torn down by its grant's abort signal. */
export class BrowserSessions {
  private readonly byGrant = new Map<string, BrowserSession>();

  constructor(private readonly config: Config) {}

  for(grant: Grant): BrowserSession {
    let s = this.byGrant.get(grant.id);
    if (!s) {
      s = new BrowserSession(this.config);
      this.byGrant.set(grant.id, s);
      const session = s;
      grant.signal.addEventListener(
        "abort",
        () => {
          session.close();
          this.byGrant.delete(grant.id);
        },
        { once: true },
      );
    }
    return s;
  }

  closeAll(): void {
    for (const s of this.byGrant.values()) s.close();
    this.byGrant.clear();
  }
}
