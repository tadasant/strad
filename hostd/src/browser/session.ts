import type { Config } from "../config.js";
import type { Grant } from "../consent/grants.js";
import { CdpBackend, type BrowserBackend } from "./backend.js";
import type { ExtensionBridge } from "./bridge.js";
import { discoverBrowserWsUrl } from "./discover.js";

export interface TabInfo {
  tab_id: string;
  title: string;
  url: string;
  opened_by_you: boolean;
}

/** How long a fresh tab may sit on its initial about:blank before that counts as loaded. */
export const BLANK_GRACE_MS = 5_000;

export const EXTENSION_ABSENT =
  "The strad-hostd Chrome extension is not connected, so the daemon fell back to DevTools. " +
  "On that machine, `strad-hostd extension` says how to install and pair it; the status page says whether it is connected.";

/**
 * One grant's hold on the browser: a backend, the tabs it has attached to,
 * and the tabs it opened. It closes when the grant ends — the kill button
 * drops the DevTools socket, or releases the extension's attachments — and
 * the TABS stay: a tab left in a state for the owner is half of what this is
 * for.
 *
 * The backend is chosen on first use, and the extension wins when it is
 * connected: it is the route that needs no one at the screen. Otherwise
 * `DevToolsActivePort` or `browser.cdpUrl`, as before.
 */
export class BrowserSession {
  private be?: BrowserBackend;
  readonly opened = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly bridge?: ExtensionBridge,
  ) {}

  async backend(): Promise<BrowserBackend> {
    if (this.be && !this.be.isClosed) return this.be;
    this.be?.close();
    if (this.bridge?.connected) {
      this.be = this.bridge.backend();
      return this.be;
    }
    let url: string;
    try {
      url = await discoverBrowserWsUrl(this.config);
    } catch (err) {
      throw new Error(
        this.bridge
          ? `${EXTENSION_ABSENT} ${(err as Error).message}`
          : (err as Error).message,
      );
    }
    this.be = await CdpBackend.connect(url);
    return this.be;
  }

  async tabs(): Promise<TabInfo[]> {
    const tabs = await (await this.backend()).tabs();
    return tabs.map((t) => ({
      tab_id: t.id,
      title: t.title,
      url: t.url,
      opened_by_you: this.opened.has(t.id),
    }));
  }

  /** Open a tab and remember that this grant owns it. */
  async openTab(url: string, foreground: boolean): Promise<string> {
    const id = await (await this.backend()).createTab(url, !foreground);
    this.opened.add(id);
    return id;
  }

  async activateTab(tabId: string): Promise<void> {
    await (await this.backend()).activateTab(tabId);
  }

  async closeTab(tabId: string): Promise<void> {
    await (await this.backend()).closeTab(tabId);
    this.opened.delete(tabId);
  }

  async send<T = Record<string, unknown>>(
    tabId: string,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    return (await this.backend()).send<T>(tabId, method, params, timeoutMs);
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

  /**
   * Wait for the tab's document to finish loading. `pastBlank`: a tab just
   * created starts on an `about:blank` document that already reads
   * "complete", so "complete" means nothing until that document is gone —
   * without it a fresh tab answers before its page has even committed, with
   * an empty title.
   */
  async waitForLoad(
    tabId: string,
    timeoutMs = 15_000,
    pastBlank = false,
  ): Promise<"complete" | "timeout"> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.evaluate<string>(
        tabId,
        pastBlank
          ? "location.href === 'about:blank' ? 'blank' : document.readyState"
          : "document.readyState",
      ).catch(() => "loading");
      if (state === "complete") return "complete";
      // A URL that never commits a document — a download, a 204, a blocked
      // navigation — leaves the tab on about:blank for good, and that blank
      // page IS loaded. Waiting the whole timeout for it would only delay
      // the same answer.
      if (state === "blank" && Date.now() - started >= BLANK_GRACE_MS)
        return "complete";
      await new Promise((r) => setTimeout(r, 150));
    }
    return "timeout";
  }

  close(): void {
    this.be?.close();
    this.be = undefined;
  }
}

/** Sessions by grant, each torn down by its grant's abort signal. */
export class BrowserSessions {
  private readonly byGrant = new Map<string, BrowserSession>();

  constructor(
    private readonly config: Config,
    private readonly bridge?: ExtensionBridge,
  ) {}

  for(grant: Grant): BrowserSession {
    let s = this.byGrant.get(grant.id);
    if (!s) {
      s = new BrowserSession(this.config, this.bridge);
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
