import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { EXTENSION_TOKEN_FILE } from "../src/extension/paths.js";
import { FakeExtension } from "./fake-extension.js";
import {
  BROWSER_KEY,
  connect,
  resultJson,
  resultText,
  ScriptedPrompter,
  testConfig,
  tmpState,
} from "./helpers.js";

const CLIENT_KEY = "claude-a-key-0123456789abcdef0123456789abcdef";

let daemon: RunningDaemon;
let stateDir: string;
let token: string;
let ext: FakeExtension;
let client: Awaited<ReturnType<typeof connect>>;
let grantId: string;
const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: { grant_id: grantId, ...args } });

const state = async () =>
  (await (
    await fetch(`http://127.0.0.1:${daemon.controlPort}/state.json`)
  ).json()) as {
    extension?: { connected: boolean; version?: string; attachedTabs: number };
    grants: { server: string }[];
  };

const until = async (cond: () => Promise<boolean> | boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  stateDir = tmpState();
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
          clientKeys: { "claude-a": CLIENT_KEY },
        },
      },
      // No Chrome writes DevToolsActivePort here: the extension is the only way in.
      browser: { userDataDir: tmpState() },
    }),
    {
      stateDir,
      prompter: new ScriptedPrompter("allowed"),
      ephemeralPorts: true,
    },
  );
  token = readFileSync(join(stateDir, EXTENSION_TOKEN_FILE), "utf8").trim();
  client = await connect(daemon.mcpPort, "/browser/mcp", BROWSER_KEY);
  ({ grant_id: grantId } = resultJson<{ grant_id: string }>(
    await client.callTool({
      name: "request_control",
      arguments: { purpose: "Drive the fake Chrome. Nothing else." },
    }),
  ));
});

afterAll(async () => {
  ext?.close();
  await client?.close();
  await daemon?.stop();
});

describe("the extension's door", () => {
  it("is a pairing token in a 0600 file, made at first boot", () => {
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(
      (statSync(join(stateDir, EXTENSION_TOKEN_FILE)).mode & 0o777).toString(8),
    ).toBe("600");
  });

  it("refuses a socket without a chrome-extension:// Origin, before any hello", async () => {
    const page = new FakeExtension({ token, origin: "https://evil.example" });
    await expect(page.connect(daemon.controlPort)).rejects.toThrow(/403/);
  });

  it("refuses a raw HTTP request at the WebSocket path, and a socket at any other path", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.controlPort}/extension`);
    expect(res.status).toBe(404);
    const wrongPath = new FakeExtension({ token });
    await expect(wrongPath.connect(daemon.controlPort, "/")).rejects.toThrow(
      /403/,
    );
  });

  it("hangs up on a daemon that cannot prove the token, before proving anything itself", async () => {
    // A fake holding a DIFFERENT token is the extension's view of a rogue
    // listener: the daemon's proof does not verify, so the fake closes first
    // and never sends its own proof.
    const wrongToken = new FakeExtension({ token: "not-the-token" });
    await wrongToken.connect(daemon.controlPort);
    expect(wrongToken.outcome).toBe("daemon-failed-proof");
    expect((await state()).extension).toMatchObject({ connected: false });
  });

  it("refuses an extension whose proof is wrong, with 4003 and nothing connected", async () => {
    const liar = new FakeExtension({ token, lie: true });
    await liar.connect(daemon.controlPort);
    expect(liar.outcome).toEqual({ closed: 4003, reason: "bad token" });
    expect((await state()).extension).toMatchObject({ connected: false });
  });

  it("survives a malformed frame from a socket that never said hello", async () => {
    // A raw upgrade with the right Origin, then two bytes that are not a
    // valid frame (RSV1 set, unmasked). `ws` reports that as an error event,
    // and an unhandled one would take the daemon down.
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(daemon.controlPort, "127.0.0.1", () => {
        sock.write(
          `GET /extension HTTP/1.1\r\nHost: 127.0.0.1:${daemon.controlPort}\r\n` +
            "Origin: chrome-extension://fakefakefakefake\r\n" +
            "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`,
        );
      });
      sock.once("data", (d) => {
        expect(String(d)).toMatch(/^HTTP\/1.1 101/);
        sock.write(Buffer.from([0xf1, 0x00]));
        sock.on("close", () => resolve());
        sock.on("error", () => resolve());
      });
      sock.on("error", reject);
    });
    const res = await fetch(
      `http://127.0.0.1:${daemon.controlPort}/state.json`,
    );
    expect(res.status).toBe(200);
  });

  it("welcomes the right token and reports it on the status page", async () => {
    ext = new FakeExtension({ token, version: "0.1.0-fake" });
    await ext.connect(daemon.controlPort);
    expect(ext.outcome).toBe("ready");
    expect((await state()).extension).toMatchObject({
      connected: true,
      version: "0.1.0-fake",
      attachedTabs: 0,
    });
    const page = await (
      await fetch(`http://127.0.0.1:${daemon.controlPort}/`)
    ).text();
    expect(page).toContain("Chrome extension: connected (v0.1.0-fake)");
  });

  it("tells the browser server it is on the extension route", async () => {
    expect(
      resultJson<{ browser: { extension: boolean; via: string } }>(
        await client.callTool({ name: "get_control_status", arguments: {} }),
      ).browser,
    ).toEqual({ extension: true, via: "extension" });
  });
});

describe("the browser server through the extension", () => {
  it("lists the profile's tabs by chrome.tabs id, none of them opened by this grant", async () => {
    ext.addTab("Inbox (3)", "https://mail.example/inbox", "You have mail");
    ext.addTab("DevTools", "devtools://devtools/bundled/x");
    const { tabs } = resultJson<{
      tabs: { tab_id: string; title: string; opened_by_you: boolean }[];
    }>(await call("list_tabs"));
    expect(tabs).toEqual([
      {
        tab_id: "100",
        title: "Inbox (3)",
        url: "https://mail.example/inbox",
        opened_by_you: false,
      },
    ]);
    expect(ext.attached.size).toBe(0);
  });

  it("attaches on first use, reads the page, and stays attached for the grant", async () => {
    const page = resultJson<{ text: string; title: string }>(
      await call("read_page", { tab_id: "100" }),
    );
    expect(page).toMatchObject({ title: "Inbox (3)", text: "You have mail" });
    expect([...ext.attached]).toEqual([100]);
    expect((await state()).extension?.attachedTabs).toBe(1);
  });

  it("opens a background tab it then owns, navigates it, and refuses to close the owner's", async () => {
    const opened = resultJson<{ tab_id: string; load: string; url: string }>(
      await call("open_tab", { url: "https://shop.example/cart" }),
    );
    // The new tab sits on about:blank for two evaluations first, as a real
    // one does: open_tab has to wait past it, not report the blank page.
    expect(opened).toMatchObject({
      load: "complete",
      url: "https://shop.example/cart",
    });
    expect(ext.tabs.get(Number(opened.tab_id))?.active).toBe(false);
    expect(ext.ops.filter((o) => o === "create")).toHaveLength(1);

    const { tabs } = resultJson<{
      tabs: { tab_id: string; opened_by_you: boolean }[];
    }>(await call("list_tabs"));
    expect(tabs.find((t) => t.tab_id === opened.tab_id)?.opened_by_you).toBe(
      true,
    );
    expect(tabs.find((t) => t.tab_id === "100")?.opened_by_you).toBe(false);

    const nav = resultJson<{ url: string }>(
      await call("navigate_tab", {
        tab_id: opened.tab_id,
        url: "https://shop.example/checkout",
      }),
    );
    expect(nav.url).toBe("https://shop.example/checkout");

    const refused = await call("close_tab", { tab_id: "100" });
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toMatch(/not opened by this grant/);

    expect(
      resultJson(await call("activate_tab", { tab_id: opened.tab_id })),
    ).toEqual({ activated: opened.tab_id });
    expect(ext.tabs.get(Number(opened.tab_id))?.active).toBe(true);
    expect(ext.ops).toContain("activate");

    expect(
      resultJson(await call("close_tab", { tab_id: opened.tab_id })),
    ).toEqual({ closed: opened.tab_id });
    expect(ext.tabs.has(Number(opened.tab_id))).toBe(false);
  });

  it("does not wait out the whole timeout on a URL that loads no page", async () => {
    const t0 = Date.now();
    const opened = resultJson<{ load: string; url: string }>(
      await call("open_tab", {
        url: "https://shop.example/download/report.csv",
      }),
    );
    expect(opened).toMatchObject({ load: "complete", url: "about:blank" });
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it("surfaces a page's own exception, a missing tab, and a screenshot as an image", async () => {
    const thrown = await call("evaluate_script", {
      tab_id: "100",
      expression: "throw",
    });
    expect(thrown.isError).toBe(true);
    expect(resultText(thrown)).toMatch(/page said no/);

    const missing = await call("read_page", { tab_id: "999" });
    expect(missing.isError).toBe(true);
    expect(resultText(missing)).toMatch(/No tab "999"/);
    const nonsense = await call("read_page", { tab_id: "8F2C1A" });
    expect(resultText(nonsense)).toMatch(/No tab "8F2C1A"/);

    const shot = await call("take_screenshot", { tab_id: "100" });
    expect((shot.content as { type: string }[])[0]).toMatchObject({
      type: "image",
      mimeType: "image/jpeg",
    });
  });
});

describe("a click in a background tab", () => {
  const sent =
    (into: string[]) =>
    (_t: number, method: string, params: Record<string, unknown>) => {
      into.push(
        method === "Emulation.setFocusEmulationEnabled"
          ? `${method}:${params.enabled}`
          : method === "Input.dispatchMouseEvent"
            ? `${method}:${params.type}`
            : method,
      );
      return undefined;
    };

  it("wraps the mouse input in focus emulation, and switches it off again", async () => {
    const methods: string[] = [];
    ext.answer = (t, method, params) => {
      sent(methods)(t, method, params);
      if (
        method === "Runtime.evaluate" &&
        String(params.expression).includes("visibilityState")
      )
        return {
          result: { value: { x: 5, y: 5, tag: "button", hidden: false } },
        };
      return undefined;
    };
    try {
      const res = await call("click_element", {
        tab_id: "100",
        selector: "#go",
      });
      expect(res.isError).toBeFalsy();
      const relevant = methods.filter((m) => !m.startsWith("Runtime."));
      expect(relevant).toEqual([
        "Emulation.setFocusEmulationEnabled:true",
        "Input.dispatchMouseEvent:mouseMoved",
        "Input.dispatchMouseEvent:mousePressed",
        "Input.dispatchMouseEvent:mouseReleased",
        "Emulation.setFocusEmulationEnabled:false",
      ]);
    } finally {
      ext.answer = undefined;
    }
  });

  it("refuses at once, sending no input, when the page still reads hidden under emulation", async () => {
    const methods: string[] = [];
    ext.answer = (t, method, params) => {
      sent(methods)(t, method, params);
      if (method === "Emulation.setFocusEmulationEnabled") return undefined;
      if (
        method === "Runtime.evaluate" &&
        String(params.expression).includes("visibilityState")
      )
        return {
          result: { value: { x: 5, y: 5, tag: "button", hidden: true } },
        };
      return undefined;
    };
    try {
      const res = await call("click_element", {
        tab_id: "100",
        selector: "#go",
      });
      expect(res.isError).toBe(true);
      expect(resultText(res)).toMatch(/tab is hidden.*Nothing was clicked/s);
      expect(methods.some((m) => m.startsWith("Input."))).toBe(false);
      // Emulation is still switched off on the way out.
      expect(methods.at(-1)).toBe("Emulation.setFocusEmulationEnabled:false");
    } finally {
      ext.answer = undefined;
    }
  });
});

describe("several grants, one extension", () => {
  let second: Awaited<ReturnType<typeof connect>>;
  let secondGrant: string;

  it("a second session on its OWN client key gets its own grant, named for it on the status page", async () => {
    second = await connect(daemon.mcpPort, "/browser/mcp", CLIENT_KEY);
    ({ grant_id: secondGrant } = resultJson<{ grant_id: string }>(
      await second.callTool({
        name: "request_control",
        arguments: { purpose: "Read the inbox as the second session." },
      }),
    ));
    expect(secondGrant).not.toBe(grantId);
    const servers = (await state()).grants.map((g) => g.server).sort();
    expect(servers).toEqual([
      "browser-use-test-mbp-headless",
      "browser-use-test-mbp-headless (claude-a)",
    ]);
  });

  it("shares one attachment to a tab both grants use, and keeps it until the LAST lets go", async () => {
    const before = ext.ops.filter((o) => o === "attach").length;
    expect(
      resultJson<{ text: string }>(
        await second.callTool({
          name: "read_page",
          arguments: { grant_id: secondGrant, tab_id: "100" },
        }),
      ).text,
    ).toBe("You have mail");
    expect(ext.ops.filter((o) => o === "attach").length).toBe(before);
    expect(ext.attached.has(100)).toBe(true);

    // The first grant ends; the second still holds the tab, and only the
    // tab the first grant alone had touched (the one it opened) is released.
    daemon.core.deps.gate.grants.end(grantId, "ended");
    await new Promise((r) => setTimeout(r, 50));
    expect(ext.attached.has(100)).toBe(true);
    expect(ext.detaches).not.toContain(100);
    expect(ext.detaches.length).toBeGreaterThan(0);

    ({ grant_id: grantId } = resultJson<{ grant_id: string }>(
      await client.callTool({
        name: "request_control",
        arguments: { purpose: "Come back for the kill-switch check." },
      }),
    ));
  });

  it("cannot close a tab the OTHER grant opened", async () => {
    const theirs = resultJson<{ tab_id: string }>(
      await second.callTool({
        name: "open_tab",
        arguments: { grant_id: secondGrant, url: "https://theirs.example/" },
      }),
    );
    const refused = await call("close_tab", { tab_id: theirs.tab_id });
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toMatch(/not opened by this grant/);
    await second.callTool({
      name: "close_tab",
      arguments: { grant_id: secondGrant, tab_id: theirs.tab_id },
    });
  });

  it("the kill switch ends every grant AND detaches chrome.debugger from every tab", async () => {
    await call("read_page", { tab_id: "100" });
    expect(ext.attached.has(100)).toBe(true);
    daemon.core.deps.gate.disableAll("test");
    await until(() => ext.attached.size === 0);
    expect((await state()).grants).toEqual([]);
    expect((await state()).extension?.attachedTabs).toBe(0);
    const refused = await call("list_tabs");
    expect(refused.isError).toBe(true);
    daemon.core.deps.gate.enable();
    await second.close();
  });

  it("a person cancelling the attachment in Chrome is noticed, and the next call re-attaches", async () => {
    ({ grant_id: grantId } = resultJson<{ grant_id: string }>(
      await client.callTool({
        name: "request_control",
        arguments: { purpose: "Re-attach after the owner cancelled." },
      }),
    ));
    await call("read_page", { tab_id: "100" });
    const attaches = ext.ops.filter((o) => o === "attach").length;
    ext.attached.delete(100);
    ext.emit({ event: "detached", tabId: 100, reason: "canceled_by_user" });
    await until(async () => (await state()).extension?.attachedTabs === 0);
    await call("read_page", { tab_id: "100" });
    expect(ext.ops.filter((o) => o === "attach").length).toBe(attaches + 1);
  });

  it("a newer connection replaces the old one, and a dropped extension fails calls plainly", async () => {
    const newer = new FakeExtension({ token, version: "0.2.0-fake" });
    newer.addTab("Fresh", "https://fresh.example/");
    await newer.connect(daemon.controlPort);
    await until(() => ext.outcome !== "ready");
    expect(ext.outcome).toEqual({ closed: 4000, reason: "replaced" });
    expect((await state()).extension?.version).toBe("0.2.0-fake");
    const { tabs } = resultJson<{ tabs: { title: string }[] }>(
      await call("list_tabs"),
    );
    expect(tabs.map((t) => t.title)).toEqual(["Fresh"]);

    newer.close();
    await until(async () => !(await state()).extension?.connected);
    const gone = await call("list_tabs");
    expect(gone.isError).toBe(true);
    expect(resultText(gone)).toMatch(/extension is not connected/);
    ext = newer;
  });
});

describe("what neither route will send", () => {
  it("refuses the WebAuthn domain before it reaches the extension", async () => {
    const { ExtensionBridge } = await import("../src/browser/bridge.js");
    const { assertRelayable } = await import("../src/browser/backend.js");
    const bridge = new ExtensionBridge({ token: "t" });
    const be = bridge.backend();
    await expect(be.send("100", "WebAuthn.enable")).rejects.toThrow(
      /WebAuthn.enable is never sent/,
    );
    expect(() => assertRelayable("WebAuthn.addVirtualAuthenticator")).toThrow(
      /never sent/,
    );
    expect(() => assertRelayable("Runtime.evaluate")).not.toThrow();
    expect(() => assertRelayable("Input.dispatchMouseEvent")).not.toThrow();
  });
});
