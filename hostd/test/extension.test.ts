import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { CdpConnection } from "../src/browser/cdp.js";
import { parseActivePort } from "../src/browser/discover.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { extensionDir } from "../src/extension/paths.js";
import { findChrome } from "./chrome.js";
import {
  BROWSER_KEY,
  connect,
  resultJson,
  resultText,
  ScriptedPrompter,
  testConfig,
  tmpState,
} from "./helpers.js";

/**
 * The REAL extension in a REAL Chromium, headless, loaded unpacked. What this
 * proves that `bridge.test.ts` cannot: the service worker connects out and
 * pairs, `chrome.debugger` attaches inside the profile, every tool works
 * through it, and the kill switch takes the debugger off every tab. What it
 * cannot prove: Google Chrome (this is Chromium: `--load-extension` is
 * honoured here and ignored by branded Chrome 137+), the force-install
 * profile, managed storage, and the infobar's absence — those need a Mac.
 */
const chrome = findChrome();
if (!chrome && process.env.CI) {
  it("has a Chrome to test against in CI", () => {
    throw new Error("no Chrome/Chromium found; the CI job installs one");
  });
}

const CLIENT_KEY = "claude-b-key-0123456789abcdef0123456789abcdef";

const PAGE = `<!doctype html><title>Owner's page</title>
<h1 id="h">Signed in as owner</h1>
<a id="next" href="/two">Go to two</a>
<input id="q" placeholder="Search" value="old">
<button id="go" onclick="document.getElementById('out').textContent = 'clicked:' + document.getElementById('q').value">Go</button>
<p id="out"></p><script>document.cookie = "session=owner-cookie; path=/"</script>`;

describe.skipIf(!chrome)(
  "the browser server through the real extension, in a real Chromium",
  () => {
    let daemon: RunningDaemon;
    let proc: ChildProcess;
    let site: Server;
    let origin: string;
    let cdp: CdpConnection;
    let worker: string;
    let grantId: string;
    let token: string;
    let client: Awaited<ReturnType<typeof connect>>;
    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: { grant_id: grantId, ...args } });

    /** Run an expression in the extension's service worker, via the test's own CDP socket. */
    const inWorker = async <T>(expression: string): Promise<T> => {
      const r = await cdp.send<{ result: { value: T } }>(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        worker,
      );
      return r.result.value;
    };
    const attachedInChrome = () =>
      inWorker<number>(
        "chrome.debugger.getTargets().then(ts => ts.filter(t => t.type === 'page' && t.attached).length)",
      );
    const state = async () =>
      (await (
        await fetch(`http://127.0.0.1:${daemon.controlPort}/state.json`)
      ).json()) as {
        extension?: { connected: boolean; attachedTabs: number };
      };
    const until = async (cond: () => Promise<boolean>, ms = 10_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("condition not met in time");
    };

    beforeAll(async () => {
      site = createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          req.url === "/two"
            ? `<title>Two</title><p>page two, cookie: <span id=c></span></p><script>c.textContent=document.cookie</script>`
            : PAGE,
        );
      });
      await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

      const stateDir = tmpState();
      daemon = await startDaemon(
        testConfig({
          capabilities: {
            shell: {
              enabled: true,
              key: "shell-key-0123456789abcdef0123456789abcdef",
            },
            browser: {
              enabled: true,
              key: BROWSER_KEY,
              displayName: "browser-use-test-mbp-headless",
              clientKeys: { "claude-b": CLIENT_KEY },
            },
          },
          // An EMPTY directory: DevToolsActivePort is not there, so the only
          // way this daemon reaches Chrome is through the extension.
          browser: { userDataDir: tmpState() },
        }),
        {
          stateDir,
          prompter: new ScriptedPrompter("allowed"),
          ephemeralPorts: true,
        },
      );
      token = readFileSync(join(stateDir, "extension-token"), "utf8");

      const userDataDir = mkdtempSync(join(tmpdir(), "hostd-ext-chrome-"));
      proc = spawn(
        chrome!,
        [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          `--load-extension=${extensionDir()}`,
          // The TEST's way in to the service worker, to pair it. The daemon
          // under test is given no such port.
          "--remote-debugging-port=0",
          `--user-data-dir=${userDataDir}`,
          `${origin}/`,
        ],
        { stdio: "ignore" },
      );
      const deadline = Date.now() + 20_000;
      while (
        !existsSync(join(userDataDir, "DevToolsActivePort")) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
      cdp = await CdpConnection.connect(
        parseActivePort(
          readFileSync(join(userDataDir, "DevToolsActivePort"), "utf8"),
        )!,
      );
      // Chromium ships component extensions with workers of their own, so the
      // bridge's is found by asking each worker which manifest it belongs to.
      const tried = new Set<string>();
      await until(async () => {
        const { targetInfos } = await cdp.send<{
          targetInfos: { targetId: string; type: string; url: string }[];
        }>("Target.getTargets");
        for (const t of targetInfos) {
          if (t.type !== "service_worker" || tried.has(t.targetId)) continue;
          tried.add(t.targetId);
          const { sessionId } = await cdp.send<{ sessionId: string }>(
            "Target.attachToTarget",
            { targetId: t.targetId, flatten: true },
          );
          const r = await cdp.send<{ result: { value?: string } }>(
            "Runtime.evaluate",
            {
              expression:
                "typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().name : ''",
              returnByValue: true,
            },
            sessionId,
          );
          if (r.result.value === "strad-hostd bridge") {
            worker = sessionId;
            return true;
          }
          await cdp.send("Target.detachFromTarget", { sessionId });
        }
        return false;
      });
      // Pair it the way the options page does: chrome.storage.local, which the
      // worker watches and reconnects on.
      await inWorker(
        `chrome.storage.local.set(${JSON.stringify({
          daemon: `ws://127.0.0.1:${daemon.controlPort}/extension`,
          token: token.trim(),
        })})`,
      );
      await until(async () => (await state()).extension?.connected === true);

      client = await connect(daemon.mcpPort, "/browser/mcp", BROWSER_KEY);
      ({ grant_id: grantId } = resultJson<{ grant_id: string }>(
        await client.callTool({
          name: "request_control",
          arguments: { purpose: "Drive the test page through the extension." },
        }),
      ));
    }, 60_000);

    afterAll(async () => {
      await client?.close();
      await daemon?.stop();
      cdp?.close();
      proc?.kill("SIGKILL");
      site?.close();
    });

    it("is on the extension route, with the extension paired and idle", async () => {
      expect(
        resultJson<{ browser: { via: string } }>(
          await client.callTool({ name: "get_control_status", arguments: {} }),
        ).browser.via,
      ).toBe("extension");
      expect(await inWorker<string>("status.state")).toBe("connected");
      expect(await attachedInChrome()).toBe(0);
    });

    it("attaches to the tab that was already open, in the profile, and reads it", async () => {
      type Tabs = {
        tabs: {
          tab_id: string;
          url: string;
          title: string;
          opened_by_you: boolean;
        }[];
      };
      let tabs = resultJson<Tabs>(await call("list_tabs")).tabs;
      for (let i = 0; i < 50 && tabs[0]?.title !== "Owner's page"; i++) {
        await new Promise((r) => setTimeout(r, 100));
        tabs = resultJson<Tabs>(await call("list_tabs")).tabs;
      }
      expect(tabs).toEqual([
        expect.objectContaining({
          url: `${origin}/`,
          title: "Owner's page",
          opened_by_you: false,
        }),
      ]);
      expect(tabs[0]!.tab_id).toMatch(/^\d+$/);
      const tab_id = tabs[0]!.tab_id;
      expect(
        resultJson<{ text: string }>(await call("read_page", { tab_id })).text,
      ).toContain("Signed in as owner");
      expect(await attachedInChrome()).toBe(1);
      expect((await state()).extension?.attachedTabs).toBe(1);
    });

    it("types, clicks and evaluates through chrome.debugger", async () => {
      const { tabs } = resultJson<{ tabs: { tab_id: string }[] }>(
        await call("list_tabs"),
      );
      const tab_id = tabs[0]!.tab_id;
      const { elements } = resultJson<{ elements: { selector: string }[] }>(
        await call("read_page", { tab_id, format: "elements" }),
      );
      expect(elements.map((e) => e.selector)).toEqual(["#next", "#q", "#go"]);
      expect(
        resultJson(
          await call("type_text", {
            tab_id,
            selector: "#q",
            text: "hello world",
          }),
        ),
      ).toEqual({ typed: 11, submitted: false });
      expect(
        resultJson(await call("click_element", { tab_id, selector: "#go" })),
      ).toMatchObject({ clicked: "button" });
      expect(
        resultJson(
          await call("evaluate_script", {
            tab_id,
            expression: "document.getElementById('out').textContent",
          }),
        ),
      ).toEqual({ value: "clicked:hello world" });
    });

    it("opens a background tab with the profile's cookies, follows a click, screenshots a foreground tab", async () => {
      const opened = resultJson<{
        tab_id: string;
        title: string;
        load: string;
      }>(await call("open_tab", { url: `${origin}/two` }));
      expect(opened).toMatchObject({ title: "Two", load: "complete" });
      expect(
        resultJson<{ text: string }>(
          await call("read_page", { tab_id: opened.tab_id }),
        ).text,
      ).toContain("cookie: session=owner-cookie");
      const nav = resultJson<{ url: string }>(
        await call("navigate_tab", {
          tab_id: opened.tab_id,
          url: `${origin}/`,
        }),
      );
      expect(nav.url).toBe(`${origin}/`);
      expect(
        resultJson<{ url: string }>(
          await call("click_element", {
            tab_id: opened.tab_id,
            selector: "#next",
          }),
        ).url,
      ).toBe(`${origin}/two`);

      const front = resultJson<{ tab_id: string }>(
        await call("open_tab", { url: `${origin}/`, foreground: true }),
      );
      const shot = await call("take_screenshot", { tab_id: front.tab_id });
      const image = (
        shot.content as { type: string; data?: string; mimeType?: string }[]
      )[0]!;
      expect(image).toMatchObject({ type: "image", mimeType: "image/jpeg" });
      expect(
        Buffer.from(image.data!, "base64").subarray(0, 2).toString("hex"),
      ).toBe("ffd8");
      expect(
        resultJson(await call("close_tab", { tab_id: front.tab_id })),
      ).toEqual({
        closed: front.tab_id,
      });
      expect(
        resultJson(await call("close_tab", { tab_id: opened.tab_id })),
      ).toEqual({
        closed: opened.tab_id,
      });
    });

    it("a second session on its own key shares the attachment; the kill switch detaches everything", async () => {
      const second = await connect(daemon.mcpPort, "/browser/mcp", CLIENT_KEY);
      const { grant_id: g2 } = resultJson<{ grant_id: string }>(
        await second.callTool({
          name: "request_control",
          arguments: { purpose: "Read the owner's tab as a second session." },
        }),
      );
      const { tabs } = resultJson<{ tabs: { tab_id: string }[] }>(
        await call("list_tabs"),
      );
      const tab_id = tabs[0]!.tab_id;
      expect(
        resultJson<{ text: string }>(
          await second.callTool({
            name: "read_page",
            arguments: { grant_id: g2, tab_id },
          }),
        ).text,
      ).toContain("Signed in as owner");
      expect(await attachedInChrome()).toBe(1);

      const theirs = resultJson<{ tab_id: string }>(
        await second.callTool({
          name: "open_tab",
          arguments: { grant_id: g2, url: `${origin}/two` },
        }),
      );
      const refused = await call("close_tab", { tab_id: theirs.tab_id });
      expect(refused.isError).toBe(true);
      expect(resultText(refused)).toMatch(/not opened by this grant/);

      daemon.core.deps.gate.disableAll("test");
      await until(async () => (await attachedInChrome()) === 0);
      expect((await state()).extension?.attachedTabs).toBe(0);
      expect((await call("list_tabs")).isError).toBe(true);
      daemon.core.deps.gate.enable();
      await second.close();

      // The owner's tab, and the second session's, are still there.
      ({ grant_id: grantId } = resultJson<{ grant_id: string }>(
        await client.callTool({
          name: "request_control",
          arguments: { purpose: "Check the tabs survived the kill." },
        }),
      ));
      const after = resultJson<{ tabs: { title: string }[] }>(
        await call("list_tabs"),
      );
      expect(after.tabs.map((t) => t.title).sort()).toEqual([
        "Owner's page",
        "Two",
      ]);
    });

    it("hands a rogue listener on the daemon's port nothing: no token, no proof, and hangs up", async () => {
      // What a local process gets by binding the port while the daemon is
      // down and waiting for the extension to dial in.
      const seen: Record<string, unknown>[] = [];
      let closedWith: number | undefined;
      const rogue = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await new Promise<void>((r) => rogue.once("listening", () => r()));
      rogue.on("connection", (sock) => {
        sock.on("message", (d) => {
          const msg = JSON.parse(String(d)) as Record<string, unknown>;
          seen.push(msg);
          if (msg.type === "hello")
            sock.send(
              JSON.stringify({
                type: "welcome",
                proof: "0".repeat(64),
                nonce: "00".repeat(32),
                daemon: "strad-hostd",
              }),
            );
        });
        sock.on("close", (code) => (closedWith = code));
      });
      const port = (rogue.address() as { port: number }).port;
      await inWorker(
        `chrome.storage.local.set({ daemon: "ws://127.0.0.1:${port}/extension" })`,
      );
      await until(async () => closedWith !== undefined);
      expect(closedWith).toBe(4003);
      expect(seen.map((m) => m.type)).toEqual(["hello"]);
      expect(JSON.stringify(seen)).not.toContain(token.trim());
      expect(await inWorker<string>("status.state")).toBe("error");
      rogue.close();
      // Back to the real daemon.
      await inWorker(
        `chrome.storage.local.set({ daemon: "ws://127.0.0.1:${daemon.controlPort}/extension" })`,
      );
      await until(async () => (await state()).extension?.connected === true);
    });

    it("serves the CRX and update manifest a policy-installed Chrome would fetch", async () => {
      const xml = await (
        await fetch(
          `http://127.0.0.1:${daemon.controlPort}/extension/update.xml`,
        )
      ).text();
      const codebase = /codebase='([^']+)'/.exec(xml)?.[1];
      expect(codebase).toBe(
        `http://127.0.0.1:${daemon.controlPort}/extension/strad-hostd.crx`,
      );
      const crx = Buffer.from(await (await fetch(codebase!)).arrayBuffer());
      expect(crx.subarray(0, 4).toString()).toBe("Cr24");
      expect(/appid='([a-p]{32})'/.test(xml)).toBe(true);
    });
  },
);
