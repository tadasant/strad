import { randomBytes } from "node:crypto";

import WebSocket from "ws";

import { proofFor } from "../src/browser/bridge.js";

/**
 * A stand-in for `hostd/extension/background.js`: the same protocol over the
 * same socket, against an in-memory Chrome. What it fakes is `chrome.tabs`
 * and `chrome.debugger`; what it keeps honest is every message the daemon's
 * bridge sends and expects back — the handshake included, both proofs — so
 * the bridge, the backend and the tools run on Linux against it.
 * `test/extension.test.ts` runs the real extension in a real Chromium for the
 * half this cannot say.
 */
export interface FakeTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
  text: string;
}

export class FakeExtension {
  readonly tabs = new Map<number, FakeTab>();
  readonly attached = new Set<number>();
  /** Every op the daemon asked for, in order. */
  readonly ops: string[] = [];
  /** The tabs the daemon asked to detach, in order. */
  readonly detaches: number[] = [];
  /** How the handshake ended, or how the socket ended. */
  outcome?:
    "ready" | "daemon-failed-proof" | { closed: number; reason: string };
  private ws?: WebSocket;
  private nextId = 100;
  /** A method → answer override, for a test that needs a particular reply. */
  answer?: (
    tabId: number,
    method: string,
    params: Record<string, unknown>,
  ) => unknown;

  constructor(
    private readonly opts: {
      token: string;
      origin?: string;
      version?: string;
      extensionId?: string;
      /** Send a wrong proof of our own, to see the daemon refuse it. */
      lie?: boolean;
    },
  ) {}

  addTab(title: string, url: string, text = ""): FakeTab {
    const tab = { id: this.nextId++, title, url, active: false, text };
    this.tabs.set(tab.id, tab);
    return tab;
  }

  /** Connect and wait for the daemon's verdict. */
  connect(controlPort: number, path = "/extension"): Promise<this> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${controlPort}${path}`, {
        origin: this.opts.origin ?? "chrome-extension://fakefakefakefake",
      });
      this.ws = ws;
      const nonce = randomBytes(32).toString("hex");
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            type: "hello",
            nonce,
            version: this.opts.version ?? "0.0.0-fake",
            extensionId: this.opts.extensionId ?? "fakefakefakefake",
          }),
        ),
      );
      ws.on("message", (d) => {
        const msg = JSON.parse(String(d)) as Record<string, unknown>;
        if (msg.type === "welcome") {
          // The daemon proves itself first, over OUR nonce — the real
          // extension hangs up on anything that cannot.
          if (msg.proof !== proofFor(this.opts.token, "daemon", nonce)) {
            this.outcome = "daemon-failed-proof";
            ws.close(4003, "daemon failed proof");
            return;
          }
          ws.send(
            JSON.stringify({
              type: "auth",
              proof: this.opts.lie
                ? "0".repeat(64)
                : proofFor(this.opts.token, "extension", String(msg.nonce)),
            }),
          );
        } else if (msg.type === "ready") {
          this.outcome = "ready";
          resolve(this);
        } else if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (msg.type === "call") {
          void this.handle(
            msg as { id: number; op: string } & Record<string, unknown>,
          );
        }
      });
      ws.on("close", (code, reason) => {
        if (this.outcome !== "daemon-failed-proof")
          this.outcome = { closed: code, reason: String(reason) };
        // Chrome detaches nothing on its own; the real extension does this.
        this.attached.clear();
        resolve(this);
      });
      ws.on("error", (err) => reject(err));
    });
  }

  /** Simulate the person closing the infobar's "Cancel", or the tab going away. */
  emit(event: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify({ type: "event", ...event }));
  }

  close(): void {
    this.ws?.close(1000, "fake done");
  }

  private reply(id: number, result: unknown): void {
    this.ws?.send(JSON.stringify({ type: "result", id, result }));
  }

  private fail(id: number, message: string): void {
    this.ws?.send(JSON.stringify({ type: "error", id, message }));
  }

  private async handle(
    msg: { id: number; op: string } & Record<string, unknown>,
  ): Promise<void> {
    this.ops.push(msg.op);
    const tabId = msg.tabId as number;
    const tab = this.tabs.get(tabId);
    switch (msg.op) {
      case "tabs":
        return this.reply(msg.id, {
          tabs: [...this.tabs.values()].map((t) => ({
            tabId: t.id,
            title: t.title,
            url: t.url,
            active: t.active,
            windowId: 1,
          })),
        });
      case "create": {
        const t = this.addTab("New tab", msg.url as string);
        t.active = !msg.background;
        return this.reply(msg.id, { tabId: t.id });
      }
      case "activate":
        if (!tab) return this.fail(msg.id, `No tab with id: ${tabId}.`);
        for (const t of this.tabs.values()) t.active = t.id === tabId;
        return this.reply(msg.id, {});
      case "close":
        if (!tab) return this.fail(msg.id, `No tab with id: ${tabId}.`);
        this.tabs.delete(tabId);
        this.attached.delete(tabId);
        return this.reply(msg.id, {});
      case "attach":
        if (!tab) return this.fail(msg.id, `No tab with given id ${tabId}.`);
        this.attached.add(tabId);
        return this.reply(msg.id, {});
      case "detach":
        this.detaches.push(tabId);
        this.attached.delete(tabId);
        return this.reply(msg.id, {});
      case "detachAll":
        this.attached.clear();
        return this.reply(msg.id, {});
      case "send": {
        if (!this.attached.has(tabId))
          return this.fail(msg.id, `not attached to tab ${tabId}`);
        if (!tab) return this.fail(msg.id, `No tab with given id ${tabId}.`);
        const method = msg.method as string;
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const custom = this.answer?.(tabId, method, params);
        if (custom !== undefined) return this.reply(msg.id, custom);
        return this.reply(msg.id, this.cdp(tab, method, params));
      }
      default:
        return this.fail(msg.id, `unknown op "${msg.op}"`);
    }
  }

  /** Enough of the DevTools protocol for the tools' own scripts. */
  private cdp(
    tab: FakeTab,
    method: string,
    params: Record<string, unknown>,
  ): unknown {
    if (method === "Page.navigate") {
      tab.url = params.url as string;
      tab.title = `Title of ${tab.url}`;
      return { frameId: "f1" };
    }
    if (method === "Page.captureScreenshot")
      return {
        data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
      };
    if (method.startsWith("Input.")) return {};
    if (method === "Runtime.evaluate") {
      const expr = params.expression as string;
      const value = (v: unknown) => ({ result: { value: v } });
      if (expr === "document.readyState") return value("complete");
      if (expr === "location.href") return value(tab.url);
      if (expr.includes("location.href") && expr.includes("document.title"))
        return value({ url: tab.url, title: tab.title });
      if (expr.includes("innerText")) return value(tab.text);
      if (expr.includes("outerHTML")) return value(`<html>${tab.text}</html>`);
      if (expr === "throw")
        return {
          result: {},
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "Error: page said no" },
          },
        };
      return value(`evaluated: ${expr.slice(0, 40)}`);
    }
    return {};
  }
}
