import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  defaultUserDataDir,
  discoverBrowserWsUrl,
  parseActivePort,
} from "../src/browser/discover.js";
import { checkUrl } from "../src/browser/tools.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
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

describe("finding the owner's Chrome", () => {
  it("reads the port and the browser target's path out of DevToolsActivePort", () => {
    expect(parseActivePort("9222\n/devtools/browser/abc-123\n")).toBe(
      "ws://127.0.0.1:9222/devtools/browser/abc-123",
    );
    expect(parseActivePort("")).toBeUndefined();
    expect(parseActivePort("9222")).toBeUndefined();
    expect(parseActivePort("evil.example.com:80\n/devtools")).toBeUndefined();
  });

  it("defaults to the REAL profile's directory, not a scratch one", () => {
    expect(defaultUserDataDir("darwin")).toMatch(
      /Library\/Application Support\/Google\/Chrome$/,
    );
  });

  it("explains what the owner has to switch on when Chrome is not debuggable", async () => {
    const cfg = testConfig({
      browser: { userDataDir: mkdtempSync(join(tmpdir(), "no-chrome-")) },
    });
    await expect(discoverBrowserWsUrl(cfg)).rejects.toThrow(
      /chrome:\/\/inspect\/#remote-debugging/,
    );
  });

  it("opens only the web", () => {
    expect(checkUrl("https://example.com/x")).toBeUndefined();
    expect(checkUrl("file:///etc/passwd")).toMatch(/Refused/);
    expect(checkUrl("chrome://settings")).toMatch(/Refused/);
    expect(checkUrl("javascript:alert(1)")).toMatch(/Refused/);
    expect(checkUrl("example.com")).toMatch(/not an absolute URL/);
  });
});

const chrome = findChrome();
// A suite that skips in CI proves nothing there, so in CI a missing browser is a failure.
if (!chrome && process.env.CI) {
  it("has a Chrome to test against in CI", () => {
    throw new Error(
      "no Chrome/Chromium found; the CI job installs one — see .github/workflows/ci.yml",
    );
  });
}

const PAGE = `<!doctype html><title>Owner's page</title>
<h1 id="h">Signed in as owner</h1>
<a id="next" href="/two">Go to two</a>
<input id="q" placeholder="Search" value="old">
<button id="go" onclick="document.getElementById('out').textContent = 'clicked:' + document.getElementById('q').value">Go</button>
<p id="out"></p><script>document.cookie = "session=owner-cookie; path=/"</script>`;

describe.skipIf(!chrome)(
  "the browser server, against a real running Chrome",
  () => {
    let daemon: RunningDaemon;
    let proc: ChildProcess;
    let site: Server;
    let origin: string;
    let grantId: string;
    let client: Awaited<ReturnType<typeof connect>>;
    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: { grant_id: grantId, ...args } });

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

      // A Chrome that is ALREADY RUNNING with a tab open, found the way the
      // owner's is: through DevToolsActivePort in its user-data directory.
      const userDataDir = mkdtempSync(join(tmpdir(), "hostd-chrome-"));
      proc = spawn(
        chrome!,
        [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
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

      daemon = await startDaemon(testConfig({ browser: { userDataDir } }), {
        stateDir: tmpState(),
        prompter: new ScriptedPrompter("allowed"),
        ephemeralPorts: true,
      });
      client = await connect(daemon.mcpPort, "/browser/mcp", BROWSER_KEY);
      ({ grant_id: grantId } = resultJson<{ grant_id: string }>(
        await client.callTool({
          name: "request_control",
          arguments: { purpose: "Drive the test page. Nothing else." },
        }),
      ));
    }, 40_000);

    afterAll(async () => {
      await client?.close();
      await daemon?.stop();
      proc?.kill("SIGKILL");
      site?.close();
    });

    it("ATTACHES to the tab that was already open rather than spawning a browser of its own", async () => {
      type Tabs = {
        tabs: {
          tab_id: string;
          url: string;
          title: string;
          opened_by_you: boolean;
        }[];
      };
      let tabs = resultJson<Tabs>(await call("list_tabs")).tabs;
      // Chrome was launched a moment ago; its tab may still be loading.
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
    });

    it("reads, types, clicks and evaluates in the owner's tab", async () => {
      const { tabs } = resultJson<{ tabs: { tab_id: string }[] }>(
        await call("list_tabs"),
      );
      const tab_id = tabs[0]!.tab_id;

      expect(
        resultJson<{ text: string }>(await call("read_page", { tab_id })).text,
      ).toContain("Signed in as owner");

      const { elements } = resultJson<{
        elements: { selector: string; tag: string; label: string }[];
      }>(await call("read_page", { tab_id, format: "elements" }));
      expect(elements).toEqual([
        expect.objectContaining({
          selector: "#next",
          tag: "a",
          label: "Go to two",
        }),
        expect.objectContaining({ selector: "#q", tag: "input" }),
        expect.objectContaining({
          selector: "#go",
          tag: "button",
          label: "Go",
        }),
      ]);

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
      ).toEqual({
        value: "clicked:hello world",
      });

      const missing = await call("click_element", {
        tab_id,
        selector: "#nope",
      });
      expect(missing.isError).toBe(true);
      expect(resultText(missing)).toMatch(/Nothing was clicked/);
    });

    it("opens a BACKGROUND tab that carries the profile's cookies, and follows a click's navigation", async () => {
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

      const { tabs } = resultJson<{
        tabs: { tab_id: string; opened_by_you: boolean }[];
      }>(await call("list_tabs"));
      expect(tabs.find((t) => t.tab_id === opened.tab_id)?.opened_by_you).toBe(
        true,
      );

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
    });

    it("screenshots a foreground tab as an image", async () => {
      // A tab in the background of its window is not painted, and Chrome lets the
      // capture hang; the tool turns that into an error naming the way out. What
      // is asserted here is the case that has an answer: a tab that is in front.
      const opened = resultJson<{ tab_id: string }>(
        await call("open_tab", { url: `${origin}/`, foreground: true }),
      );
      const shot = await call("take_screenshot", { tab_id: opened.tab_id });
      const image = (
        shot.content as { type: string; data?: string; mimeType?: string }[]
      )[0]!;
      expect(image).toMatchObject({ type: "image", mimeType: "image/jpeg" });
      expect(
        Buffer.from(image.data!, "base64").subarray(0, 2).toString("hex"),
      ).toBe("ffd8");
      await call("close_tab", { tab_id: opened.tab_id });
    });

    it("refuses file: and refuses to close a tab it did not open", async () => {
      const file = await call("open_tab", { url: "file:///etc/passwd" });
      expect(file.isError).toBe(true);

      const { tabs } = resultJson<{
        tabs: { tab_id: string; opened_by_you: boolean }[];
      }>(await call("list_tabs"));
      const theirs = tabs.find((t) => !t.opened_by_you)!;
      const mine = tabs.find((t) => t.opened_by_you)!;
      const refused = await call("close_tab", { tab_id: theirs.tab_id });
      expect(refused.isError).toBe(true);
      expect(resultText(refused)).toMatch(/not opened by this grant/);
      expect(
        resultJson(await call("close_tab", { tab_id: mine.tab_id })),
      ).toEqual({ closed: mine.tab_id });
    });

    it("a killed grant loses the browser, and the owner's tab is still there afterwards", async () => {
      daemon.core.deps.gate.grants.end(grantId, "killed");
      const after = await call("list_tabs");
      expect(after.isError).toBe(true);

      ({ grant_id: grantId } = resultJson<{ grant_id: string }>(
        await client.callTool({
          name: "request_control",
          arguments: { purpose: "Check the owner's tab survived the kill." },
        }),
      ));
      const { tabs } = resultJson<{ tabs: { title: string }[] }>(
        await call("list_tabs"),
      );
      expect(tabs.map((t) => t.title)).toContain("Owner's page");
    });
  },
);
