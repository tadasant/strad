import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** A token a console has just minted, behind its own copy button, as GitHub's settings page shows one. */
const MINTED = "github_pat_TESTONLY_0123456789abcdefghijklmnop";
const TOKEN_PAGE = `<!doctype html><title>New token</title>
<p>Make sure to copy your token now. You won't be able to see it again.</p>
<code id="new-token">${MINTED}</code>
<button id="copy" aria-label="Copy token" onclick="navigator.clipboard.writeText(document.getElementById('new-token').textContent).then(() => { document.getElementById('status').textContent = 'Copied!' }, (e) => { document.getElementById('status').textContent = 'copy failed: ' + e.message })">Copy</button>
<p id="status"></p>`;

/**
 * Another extension in the same profile, standing in for the owner's password
 * manager: it puts chrome-extension:// frames of its own into `/overlay` pages.
 */
const FOREIGN = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "foreign-extension",
);

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
    /** Poll `cond`; on timeout, say what was awaited and what was last seen. */
    const until = async (
      cond: () => Promise<boolean>,
      what: string,
      seen: () => unknown = () => undefined,
      ms = 10_000,
    ) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      const last = seen();
      throw new Error(
        `condition not met in ${ms}ms: ${what}` +
          (last === undefined ? "" : `; last seen ${JSON.stringify(last)}`),
      );
    };

    beforeAll(async () => {
      site = createServer((req, res) => {
        if (req.url?.startsWith("/overlay")) {
          // GitHub's settings pages allow no eval; neither does this one.
          res.writeHead(200, {
            "content-type": "text/html",
            "content-security-policy": "script-src 'unsafe-inline'",
          });
          res.end(TOKEN_PAGE);
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          req.url === "/two"
            ? `<title>Two</title><p>page two, cookie: <span id=c></span></p><script>c.textContent=document.cookie</script>`
            : req.url === "/blank"
              ? "<title>blank</title>"
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
          `--load-extension=${extensionDir()},${FOREIGN}`,
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
      // A worker is only ruled out by naming ANOTHER manifest: one caught
      // while still starting has no extension bindings yet and answers "",
      // and the bridge's own worker answers that way on a cold Chromium.
      const ruledOut = new Set<string>();
      const answers: Record<string, string> = {};
      await until(
        async () => {
          const { targetInfos } = await cdp.send<{
            targetInfos: { targetId: string; type: string; url: string }[];
          }>("Target.getTargets");
          for (const t of targetInfos) {
            if (t.type !== "service_worker" || ruledOut.has(t.targetId))
              continue;
            // A component worker can exit between the listing and the
            // attach; that is a retry on the next poll, not a failure.
            let sessionId: string | undefined;
            try {
              ({ sessionId } = await cdp.send<{ sessionId: string }>(
                "Target.attachToTarget",
                { targetId: t.targetId, flatten: true },
              ));
              const r = await cdp.send<{ result: { value?: string } }>(
                "Runtime.evaluate",
                {
                  expression:
                    "typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().name : ''",
                  returnByValue: true,
                },
                sessionId,
              );
              answers[t.url] = r.result.value ?? "";
              if (r.result.value === "strad-hostd bridge") {
                worker = sessionId;
                return true;
              }
              if (r.result.value) ruledOut.add(t.targetId);
            } catch (err) {
              answers[t.url] = `probe failed: ${(err as Error).message}`;
            }
            if (sessionId)
              await cdp
                .send("Target.detachFromTarget", { sessionId })
                .catch(() => {});
          }
          return false;
        },
        "the bridge's service worker answers with its manifest",
        () => answers,
      );
      const bridgeStatus = () =>
        inWorker<{ state: string; detail: string } | null>(
          "(() => { try { return status } catch { return null } })()",
        );
      // Pair it the way the options page does: chrome.storage.local, which the
      // worker watches and reconnects on.
      await inWorker(
        `chrome.storage.local.set(${JSON.stringify({
          daemon: `ws://127.0.0.1:${daemon.controlPort}/extension`,
          token: token.trim(),
        })})`,
      );
      // The storage write is not enough on its own: connect() returns early
      // while another connect() is in flight, so a token that lands while
      // the worker's startup connect() is between reading storage and giving
      // up as "unpaired" is dropped until the 30s reconnect alarm. Calling
      // connect() on each poll is a no-op once a socket is opening or open.
      let lastSeen: unknown;
      await until(
        async () => {
          await inWorker("void connect()");
          const daemonSide = (await state()).extension;
          lastSeen = { daemon: daemonSide, bridge: await bridgeStatus() };
          return daemonSide?.connected === true;
        },
        "the daemon sees the extension connected",
        () => lastSeen,
      );

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
      await until(
        async () => (await attachedInChrome()) === 0,
        "chrome.debugger is off every tab",
      );
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
      await until(
        async () => closedWith !== undefined,
        "the extension hangs up on the rogue listener",
      );
      expect(closedWith).toBe(4003);
      expect(seen.map((m) => m.type)).toEqual(["hello"]);
      expect(JSON.stringify(seen)).not.toContain(token.trim());
      expect(await inWorker<string>("status.state")).toBe("error");
      rogue.close();
      // Back to the real daemon.
      await inWorker(
        `chrome.storage.local.set({ daemon: "ws://127.0.0.1:${daemon.controlPort}/extension" })`,
      );
      await until(
        async () => (await state()).extension?.connected === true,
        "the extension reconnects to the daemon",
      );
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

    describe("a page that carries another extension's frames", () => {
      let grant: string;
      let tab_id: string;
      const use = (name: string, args: Record<string, unknown> = {}) =>
        client.callTool({ name, arguments: { grant_id: grant, ...args } });

      /** The TEST's own session on a page, over the browser-wide DevTools socket the daemon is not given. */
      const pageSession = async (url: string): Promise<string> => {
        const { targetInfos } = await cdp.send<{
          targetInfos: { targetId: string; type: string; url: string }[];
        }>("Target.getTargets");
        const target = targetInfos.find(
          (t) => t.type === "page" && t.url === url,
        );
        if (!target) throw new Error(`no page target at ${url}`);
        const { sessionId } = await cdp.send<{ sessionId: string }>(
          "Target.attachToTarget",
          { targetId: target.targetId, flatten: true },
        );
        return sessionId;
      };
      const inPage = async <T>(
        sessionId: string,
        expression: string,
        userGesture = false,
      ): Promise<T> => {
        const r = await cdp.send<{
          result: { value: T };
          exceptionDetails?: { exception?: { description?: string } };
        }>(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true, userGesture },
          sessionId,
        );
        if (r.exceptionDetails)
          throw new Error(
            r.exceptionDetails.exception?.description ?? "page threw",
          );
        return r.result.value;
      };
      const foreignFrames = (sessionId: string) =>
        inPage<string | undefined>(
          sessionId,
          "document.documentElement.dataset.foreignFrames",
        );
      /**
       * Run `expression` with a user gesture in a fresh tab on ANOTHER origin
       * that alone is granted the clipboard, so the page under test gets no
       * clipboard permission from it.
       *
       * A target opens on its initial `about:blank` — an opaque origin, not a
       * secure context, so no `navigator.clipboard` — whose readyState is
       * already "complete". Wait for the READER's document, not any document.
       */
      const onReader = async <T>(expression: string): Promise<T> => {
        const reader = `http://localhost:${new URL(origin).port}/blank`;
        await cdp.send("Browser.grantPermissions", {
          origin: new URL(reader).origin,
          permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
        });
        const { targetId } = await cdp.send<{ targetId: string }>(
          "Target.createTarget",
          { url: reader },
        );
        try {
          const { sessionId } = await cdp.send<{ sessionId: string }>(
            "Target.attachToTarget",
            { targetId, flatten: true },
          );
          let seen: unknown;
          await until(
            async () => {
              seen = await inPage(
                sessionId,
                "({ href: location.href, readyState: document.readyState, secure: isSecureContext })",
              );
              const s = seen as {
                href: string;
                readyState: string;
                secure: boolean;
              };
              return (
                s.href === reader && s.readyState === "complete" && s.secure
              );
            },
            "the clipboard tab has loaded its own page",
            () => seen,
          );
          await cdp.send(
            "Emulation.setFocusEmulationEnabled",
            { enabled: true },
            sessionId,
          );
          return await inPage<T>(sessionId, expression, true);
        } finally {
          await cdp.send("Target.closeTarget", { targetId });
        }
      };
      const clipboard = () =>
        onReader<string>("navigator.clipboard.readText()");
      const setClipboard = (value: string) =>
        onReader<void>(
          `navigator.clipboard.writeText(${JSON.stringify(value)})`,
        );

      beforeAll(async () => {
        ({ grant_id: grant } = resultJson<{ grant_id: string }>(
          await client.callTool({
            name: "request_control",
            arguments: {
              purpose: "Copy a freshly minted token to the clipboard.",
            },
          }),
        ));
      });

      it("is a page Chrome refuses chrome.debugger on, as it stands", async () => {
        const url = `${origin}/overlay`;
        await cdp.send("Target.createTarget", { url });
        const s = await pageSession(url);
        await until(
          async () => (await foreignFrames(s)) === "2",
          "the foreign extension's frames are loaded in the page",
        );
        const tabs = await inWorker<{ id: number; url: string }[]>(
          "chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, url: t.url })))",
        );
        const id = tabs.find((t) => t.url === url)!.id;
        expect(
          await inWorker<string>(
            `chrome.debugger.attach({ tabId: ${id} }, "1.3").then(() => chrome.debugger.detach({ tabId: ${id} }).then(() => "attached"), (e) => e.message)`,
          ),
        ).toMatch(
          /Cannot access a chrome-extension:\/\/ URL of different extension/,
        );
      });

      it("reads, evaluates and clicks in it: the foreign frames are moved aside while attached", async () => {
        const { tabs } = resultJson<{
          tabs: { tab_id: string; url: string }[];
        }>(await use("list_tabs"));
        tab_id = tabs.find((t) => t.url === `${origin}/overlay`)!.tab_id;
        const s = await pageSession(`${origin}/overlay`);
        expect(await foreignFrames(s)).toBe("2");
        const read = await use("read_page", { tab_id });
        expect(read.isError ? resultText(read) : "").toBe("");
        expect(resultJson<{ text: string }>(read).text).toContain(
          "copy your token now",
        );
        // Both of them — the light-DOM frame and the closed shadow root's.
        expect(await foreignFrames(s)).toBe("0");
        expect(
          resultJson(
            await use("evaluate_script", {
              tab_id,
              expression: "document.title + ' ' + location.pathname",
            }),
          ),
        ).toEqual({ value: "New token /overlay" });
        expect(await attachedInChrome()).toBeGreaterThanOrEqual(1);
      });

      it("copies a minted token with the page's own button: to the clipboard, never into a result", async () => {
        await setClipboard("before");
        const s = await pageSession(`${origin}/overlay`);
        expect(await clipboard()).toBe("before");

        // click_element's click is a trusted mouse event, under focus
        // emulation: the page's own write goes through, as the owner's would.
        const clicked = await use("click_element", {
          tab_id,
          selector: "#copy",
        });
        expect(clicked.isError).toBeFalsy();
        expect(resultJson(clicked)).toEqual({
          clicked: "button",
          url: `${origin}/overlay`,
        });
        expect(JSON.stringify(clicked)).not.toContain(MINTED);
        await until(
          async () =>
            (await inPage<string>(
              s,
              "document.getElementById('status').textContent",
            )) === "Copied!",
          "the page says it copied",
        );
        expect(await clipboard()).toBe(MINTED);
      });

      it("refuses the WebAuthn domain outright, so no caller can answer a passkey prompt", async () => {
        const id = Number(tab_id);
        expect(
          await inWorker<string>(
            `perform({ op: "send", tabId: ${id}, method: "WebAuthn.enable", params: {} }).then(() => "relayed", (e) => e.message)`,
          ),
        ).toBe("WebAuthn.enable is never relayed");
        expect(
          await inWorker<string>(
            `perform({ op: "send", tabId: ${id}, method: "WebAuthn.addVirtualAuthenticator", params: { options: { protocol: "ctap2", transport: "internal" } } }).then(() => "relayed", (e) => e.message)`,
          ),
        ).toBe("WebAuthn.addVirtualAuthenticator is never relayed");
      });

      it("puts the frames back when the grant lets go", async () => {
        const s = await pageSession(`${origin}/overlay`);
        expect(await foreignFrames(s)).toBe("0");
        await use("end_control");
        await until(
          async () => (await foreignFrames(s)) === "2",
          "the foreign frames are back in the page",
          () => undefined,
        );
      });

      it("follows a frame that arrives after the attach: Chrome drops the debugger, the next call re-attaches", async () => {
        ({ grant_id: grant } = resultJson<{ grant_id: string }>(
          await client.callTool({
            name: "request_control",
            arguments: { purpose: "Read a page whose overlay comes late." },
          }),
        ));
        const url = `${origin}/overlay?late`;
        const late = resultJson<{ tab_id: string }>(
          await use("open_tab", { url }),
        );
        expect(
          resultJson(
            await use("evaluate_script", {
              tab_id: late.tab_id,
              expression: "location.search",
            }),
          ),
        ).toEqual({ value: "?late" });
        const s = await pageSession(url);
        expect(await attachedInChrome()).toBeGreaterThanOrEqual(1);
        // Now, with the bridge attached, the overlay arrives; Chrome detaches
        // the bridge on its own.
        await inPage(s, "document.documentElement.dataset.insertOverlay = '1'");
        await until(
          async () => (await foreignFrames(s)) === "2",
          "the late frames arrive",
        );
        expect(
          resultJson(
            await use("evaluate_script", {
              tab_id: late.tab_id,
              expression: "document.title",
            }),
          ),
        ).toEqual({ value: "New token" });
        expect(await foreignFrames(s)).toBe("0");
        await use("close_tab", { tab_id: late.tab_id });
        await use("end_control");
        const { targetInfos } = await cdp.send<{
          targetInfos: { targetId: string; url: string }[];
        }>("Target.getTargets");
        await cdp.send("Target.closeTarget", {
          targetId: targetInfos.find((t) => t.url === `${origin}/overlay`)!
            .targetId,
        });
      });
    });
  },
);
