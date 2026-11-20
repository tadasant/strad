import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  custodyAfter,
  custodyRefusal,
  egressHits,
} from "../src/custody/enforce.js";
import { depositToken } from "../src/custody/deposit-wire.js";
import { needlesFor, shapeOf, Vault } from "../src/custody/vault.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { findChrome } from "./chrome.js";
import {
  BROWSER_KEY,
  connect,
  resultJson,
  resultText,
  ScriptedPrompter,
  SHELL_KEY,
  testConfig,
  tmpState,
} from "./helpers.js";

/**
 * Every value in this file is a fixture: fake-looking tokens generated for the
 * test, a fake strad that records what it was sent, a fake service-account
 * JSON. Nothing here touches a real credential or a real store.
 */
const CUSTODY_KEY = "custody-key-0123456789abcdef0123456789abcd";

describe("what a handle tells a caller", () => {
  it("names a shape, never a fragment", () => {
    expect(shapeOf("lin_api_ABCDEF0123456789abcdef0123456789")).toEqual({
      length: 40,
      kind: "token",
      prefix: "lin_api_",
    });
    expect(shapeOf("sk-ant-api03-xyz0123456789").prefix).toBe("sk-ant-");
    const sa = JSON.stringify({ type: "service_account", private_key: "k" });
    expect(shapeOf(sa)).toMatchObject({
      kind: "json",
      json_keys: ["type", "private_key"],
    });
    expect(shapeOf("-----BEGIN PRIVATE KEY-----\nAAA\n").kind).toBe("pem");
  });

  it("filters for every form a value could travel in, and its secret parts", () => {
    const token = "tok_0123456789abcdefABCDEF";
    const needles = needlesFor(token);
    expect(needles).toContain(token);
    expect(needles).toContain(Buffer.from(token).toString("base64"));
    const pemLine = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    const sa = JSON.stringify({
      type: "service_account",
      client_email: "robot@project.iam.gserviceaccount.com",
      private_key: `-----BEGIN PRIVATE KEY-----\n${pemLine}\n-----END PRIVATE KEY-----\n`,
    });
    const saNeedles = needlesFor(sa);
    expect(saNeedles).toContain(pemLine);
    // A non-secret field is not a needle: reading an email elsewhere is not a leak.
    expect(saNeedles).not.toContain("robot@project.iam.gserviceaccount.com");
  });
});

describe("the vault", () => {
  it("zeroes, expires, and is live while anything is held or tainted", () => {
    let now = 1_000;
    const vault = new Vault({ handleTtlMs: 60_000, now: () => now });
    expect(vault.live()).toBe(false);
    const { handle } = vault.hold("g1", "secret-value-0123456789", {
      source: "test",
    });
    expect(vault.live()).toBe(true);
    expect(vault.reveal(handle, "g2")).toBeUndefined();
    expect(vault.reveal(handle, "g1")).toBe("secret-value-0123456789");
    expect(vault.scan(["x secret-value-0123456789 y"])).toEqual([handle]);
    now += 60_000;
    expect(vault.live()).toBe(false);
    expect(vault.list("g1")).toEqual([
      expect.objectContaining({ handle, state: "expired" }),
    ]);
    expect(JSON.stringify(vault.list("g1"))).not.toContain("secret-value");

    vault.taint("tab-1", "g1");
    expect(vault.live()).toBe(true);
    vault.untaint("tab-1");
    expect(vault.live()).toBe(false);
  });

  it("keeps filtering a deposited value until its grant ends", () => {
    const vault = new Vault({ handleTtlMs: 60_000 });
    const { handle } = vault.hold("g1", "secret-value-0123456789", {
      source: "t",
    });
    vault.end(handle, "deposited", { path: "/p", version: "v1" });
    expect(vault.live()).toBe(false);
    expect(egressHits(vault, { text: "secret-value-0123456789" })).toEqual([
      handle,
    ]);
    // Still recorded as deposited: a watched hit withholds, it does not burn.
    expect(vault.list("g1")[0]?.state).toBe("deposited");
    vault.endGrant("g1");
    expect(vault.scan(["secret-value-0123456789"])).toEqual([]);
  });

  it("filters the credential-shaped part of a value captured with text around it", () => {
    expect(needlesFor("Your token: tok_0123456789abcdefXYZ")).toContain(
      "tok_0123456789abcdefXYZ",
    );
  });

  it("refuses a value too short to be a credential", () => {
    const vault = new Vault({ handleTtlMs: 60_000 });
    expect(() => vault.hold("g", "short", { source: "t" })).toThrow(
      /too short/,
    );
  });

  it("drops a grant's handles when it ends", () => {
    const vault = new Vault({ handleTtlMs: 60_000 });
    const { handle } = vault.hold("g1", "secret-value-0123456789", {
      source: "t",
    });
    vault.endGrant("g1");
    expect(vault.reveal(handle, "g1")).toBeUndefined();
    expect(vault.live()).toBe(false);
  });
});

describe("the hold", () => {
  const vault = new Vault({ handleTtlMs: 60_000 });
  vault.hold("g", "secret-value-0123456789", { source: "t" });
  vault.taint("TAB", "g");

  it("refuses shell and computer-use outright", () => {
    for (const cap of ["shell", "computer", "computer-headless"] as const)
      expect(custodyRefusal(vault, cap, "anything", {})).toMatch(/custody/);
  });

  it("refuses browser reads everywhere and everything but leaving on a tainted tab", () => {
    expect(
      custodyRefusal(vault, "browser", "read_page", { tab_id: "OTHER" }),
    ).toBeDefined();
    expect(
      custodyRefusal(vault, "browser", "click_element", { tab_id: "TAB" }),
    ).toBeDefined();
    expect(
      custodyRefusal(vault, "browser", "click_element", { tab_id: "OTHER" }),
    ).toBeUndefined();
    // list_tabs carries every page's own title, so it is a read too.
    expect(custodyRefusal(vault, "browser", "list_tabs", {})).toBeDefined();
    for (const tool of ["navigate_tab", "close_tab"])
      expect(
        custodyRefusal(vault, "browser", tool, { tab_id: "TAB" }),
      ).toBeUndefined();
  });

  it("lifts a taint on close, never on a navigation (a #fragment keeps the page)", () => {
    const v = new Vault({ handleTtlMs: 60_000 });
    v.taint("T", "g");
    const ok = { content: [] };
    custodyAfter(v, "browser", "navigate_tab", { tab_id: "T" }, ok);
    expect(v.isTainted("T")).toBe(true);
    custodyAfter(v, "browser", "close_tab", { tab_id: "T" }, ok);
    expect(v.isTainted("T")).toBe(false);
  });

  it("leaves messages and custody itself alone", () => {
    expect(custodyRefusal(vault, "messages", "x", {})).toBeUndefined();
    expect(custodyRefusal(vault, "custody", "deposit", {})).toBeUndefined();
  });
});

const chrome = findChrome();
if (!chrome && process.env.CI) {
  it("has a Chrome to test against in CI", () => {
    throw new Error("no Chrome/Chromium found; the CI job installs one");
  });
}

/** Tokens the page mints. Fixtures, random per run. */
const mint = () =>
  `lin_api_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}X9`;

describe.skipIf(!chrome)(
  "custody end to end, against a real Chrome and a fake strad",
  () => {
    let daemon: RunningDaemon;
    let proc: ChildProcess;
    let site: Server;
    let strad: Server;
    let origin: string;
    const downloads = mkdtempSync(join(tmpdir(), "hostd-downloads-"));
    const minted: string[] = [];
    const deposits: {
      url: string;
      authorization?: string;
      value: string;
    }[] = [];
    const SA = JSON.stringify(
      {
        type: "service_account",
        client_email: "robot@example.iam.gserviceaccount.com",
        private_key:
          "-----BEGIN PRIVATE KEY-----\nFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0123\n-----END PRIVATE KEY-----\n",
      },
      null,
      2,
    );

    type C = Awaited<ReturnType<typeof connect>>;
    let custody: C;
    let browser: C;
    let shell: C;
    const grants: Record<string, string> = {};
    const call = (
      c: C,
      server: string,
      name: string,
      args: Record<string, unknown> = {},
    ) =>
      c.callTool({
        name,
        arguments: { grant_id: grants[server], ...args },
      });
    let tab = "";

    beforeAll(async () => {
      site = createServer((req, res) => {
        if (req.url === "/mint") {
          const t = mint();
          minted.push(t);
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(t);
          return;
        }
        if (req.url === "/title") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(`<title>${minted.at(-1)}</title><p>echo</p>`);
          return;
        }
        if (req.url === "/download-big") {
          setTimeout(
            () =>
              writeFileSync(
                join(downloads, "huge.bin"),
                Buffer.alloc(70 * 1024, 1),
              ),
            300,
          );
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.url === "/download") {
          // Stands in for Chrome saving a download: the file lands in the
          // downloads directory a moment after the click.
          setTimeout(
            () => writeFileSync(join(downloads, "robot-key.json"), SA),
            300,
          );
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>Tokens</title>
<h1>API keys</h1><p>Existing key id: key_000000000000000001</p>
<button id="gen" onclick="fetch('/mint').then(r=>r.text()).then(t=>{document.getElementById('out').textContent=t;})">Generate</button>
<button id="leak" onclick="fetch('/mint').then(r=>r.text()).then(t=>{document.title=t;document.getElementById('out').textContent=t;})">Generate (into title)</button>
<button id="dl" onclick="fetch('/download')">Download key</button>
<button id="dlbig" onclick="fetch('/download-big')">Download bundle</button>
<code id="out"></code>`);
      });
      await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

      strad = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const value = (JSON.parse(body || "{}") as { value: string }).value;
          deposits.push({
            url: req.url ?? "",
            authorization: req.headers.authorization,
            value,
          });
          const [, , , slug, variable] = (req.url ?? "").split("/");
          res.writeHead(201, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              protocol: 1,
              path:
                slug === "_gateway"
                  ? `/strad/test/gateway/static/${variable}`
                  : `/strad/test/mcp/${slug}/static/${variable}`,
              version: "v1",
            }),
          );
        });
      });
      await new Promise<void>((r) => strad.listen(0, "127.0.0.1", r));
      const stradUrl = `http://127.0.0.1:${(strad.address() as { port: number }).port}`;

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
      )
        await new Promise((r) => setTimeout(r, 100));

      const base = testConfig({
        browser: { userDataDir },
        consent: { rejectCooldownSeconds: 0 },
        custody: { stradUrl, downloadsDir: downloads },
      });
      base.capabilities.custody = {
        enabled: true,
        key: CUSTODY_KEY,
        displayName: "custody-test-mbp",
        clientKeys: {},
      };
      daemon = await startDaemon(base, {
        stateDir: tmpState(),
        prompter: new ScriptedPrompter("allowed"),
        ephemeralPorts: true,
      });
      custody = await connect(daemon.mcpPort, "/custody/mcp", CUSTODY_KEY);
      browser = await connect(daemon.mcpPort, "/browser/mcp", BROWSER_KEY);
      shell = await connect(daemon.mcpPort, "/shell/mcp", SHELL_KEY);
      for (const [name, c] of [
        ["custody", custody],
        ["browser", browser],
        ["shell", shell],
      ] as const) {
        grants[name] = resultJson<{ grant_id: string }>(
          await c.callTool({
            name: "request_control",
            arguments: { purpose: "Custody test. Nothing else." },
          }),
        ).grant_id;
      }
      type Tabs = { tabs: { tab_id: string; title: string }[] };
      for (let i = 0; i < 50; i++) {
        const tabs = resultJson<Tabs>(
          await call(custody, "custody", "list_tabs"),
        ).tabs;
        if (tabs[0]?.title === "Tokens") {
          tab = tabs[0].tab_id;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }, 40_000);

    afterAll(async () => {
      for (const c of [custody, browser, shell]) await c?.close();
      await daemon?.stop();
      proc?.kill("SIGKILL");
      site?.close();
      strad?.close();
    });

    const shellWorks = async () =>
      !(await call(shell, "shell", "run_command", { command: "echo hi" }))
        .isError;

    it("will not start a capture while a shell command could run through the hold", async () => {
      const started = resultJson<{ command_id: string }>(
        await call(shell, "shell", "run_command", {
          command: "sleep 30",
          wait_seconds: 0,
        }),
      );
      const refused = await call(custody, "custody", "click_and_capture", {
        tab_id: tab,
        click_selector: "#gen",
      });
      expect(refused.isError).toBe(true);
      expect(resultText(refused)).toMatch(/shell command/);
      await call(shell, "shell", "kill_command", {
        command_id: started.command_id,
      });
      for (let i = 0; i < 50; i++) {
        const st = resultJson<{ status: string }>(
          await call(shell, "shell", "get_command", {
            command_id: started.command_id,
          }),
        );
        if (st.status !== "running") break;
        await new Promise((r) => setTimeout(r, 100));
      }
    });

    it("captures a token in one call and never returns it", async () => {
      expect(tab).not.toBe("");
      expect(await shellWorks()).toBe(true);
      const res = await call(custody, "custody", "click_and_capture", {
        tab_id: tab,
        click_selector: "#gen",
        label: "test token",
      });
      expect(res.isError).toBeFalsy();
      const token = minted.at(-1)!;
      expect(JSON.stringify(res)).not.toContain(token);
      const out = resultJson<{
        handle: string;
        shape: { length: number; prefix: string };
      }>(res);
      expect(out.handle).toMatch(/^h_/);
      expect(out.shape).toMatchObject({
        length: token.length,
        prefix: "lin_api_",
      });
    });

    it("holds: shell and browser reads are refused while the secret is live", async () => {
      expect(await shellWorks()).toBe(false);
      const read = await call(browser, "browser", "read_page", { tab_id: tab });
      expect(read.isError).toBe(true);
      expect(resultText(read)).toMatch(/custody is holding/);
      expect(JSON.stringify(read)).not.toContain(minted.at(-1)!);
    });

    it("deposits the value straight to strad, with the derived bearer", async () => {
      const { handles } = resultJson<{ handles: { handle: string }[] }>(
        await call(custody, "custody", "list_handles"),
      );
      const res = await call(custody, "custody", "deposit", {
        handle: handles[0]!.handle,
        slug: "linear",
        variable: "LINEAR_API_KEY",
      });
      expect(resultJson(res)).toEqual({
        deposited: true,
        destination: "default",
        path: "/strad/test/mcp/linear/static/LINEAR_API_KEY",
        version: "v1",
      });
      expect(deposits.at(-1)).toEqual({
        url: "/_strad/deposit/linear/LINEAR_API_KEY",
        authorization: `Bearer ${depositToken(CUSTODY_KEY)}`,
        value: minted.at(-1),
      });
      // The handle ended, but the tab still shows the token: still held.
      expect(await shellWorks()).toBe(false);
      await call(custody, "custody", "release_tab", { tab_id: tab });
      expect(await shellWorks()).toBe(true);
      // Deposited is not forgotten: while the custody grant runs, the value
      // is still filtered on every server.
      const echoed = await call(shell, "shell", "run_command", {
        command: `echo ${minted.at(-1)}`,
      });
      expect(echoed.isError).toBe(true);
      expect(resultText(echoed)).toMatch(/arguments contain the secret/);
    });

    it("withholds a result carrying a held value, from ANY server, and burns the handle", async () => {
      await call(browser, "browser", "navigate_tab", {
        tab_id: tab,
        url: `${origin}/`,
      });
      const cap = resultJson<{ handle: string }>(
        await call(custody, "custody", "click_and_capture", {
          tab_id: tab,
          click_selector: "#leak",
        }),
      );
      // custody's own list_tabs hides what a tainted page wrote about itself.
      const own = await call(custody, "custody", "list_tabs");
      expect(JSON.stringify(own)).not.toContain(minted.at(-1)!);
      expect(JSON.stringify(own)).toContain("tainted — hidden");
      // A second page puts the token in its title; open_tab is not held (it
      // reads nothing of the tainted tab) and returns that title.
      const opened = await call(browser, "browser", "open_tab", {
        url: `${origin}/title`,
      });
      expect(opened.isError).toBe(true);
      expect(resultText(opened)).toMatch(/Withheld/);
      expect(JSON.stringify(opened)).not.toContain(minted.at(-1)!);
      const dep = await call(custody, "custody", "deposit", {
        handle: cap.handle,
        slug: "linear",
        variable: "BURNED_ONE",
      });
      expect(dep.isError).toBe(true);
      expect(deposits.some((d) => d.url.endsWith("/BURNED_ONE"))).toBe(false);
      const { handles } = resultJson<{
        handles: { handle: string; state: string }[];
      }>(await call(custody, "custody", "list_handles"));
      expect(handles.find((h) => h.handle === cap.handle)?.state).toBe(
        "burned",
      );
    });

    it("burns a handle whose value a caller writes into arguments", async () => {
      // The tab is still tainted and showing the burned token; capture the
      // same one again from the page, then quote it back.
      const cap = resultJson<{ handle: string }>(
        await call(custody, "custody", "click_and_capture", {
          tab_id: tab,
          capture_selector: "#out",
        }),
      );
      const echoed = await call(browser, "browser", "open_tab", {
        url: `${origin}/?q=${minted.at(-1)}`,
      });
      expect(echoed.isError).toBe(true);
      expect(resultText(echoed)).toMatch(/arguments contain the secret/);
      const { handles } = resultJson<{
        handles: { handle: string; state: string }[];
      }>(await call(custody, "custody", "list_handles"));
      expect(handles.find((h) => h.handle === cap.handle)?.state).toBe(
        "burned",
      );
      await call(custody, "custody", "release_tab", { tab_id: tab });
    });

    it("takes a downloaded credential into custody and deletes the file", async () => {
      await call(browser, "browser", "navigate_tab", {
        tab_id: tab,
        url: `${origin}/`,
      });
      const res = await call(custody, "custody", "capture_download", {
        tab_id: tab,
        click_selector: "#dl",
      });
      expect(res.isError).toBeFalsy();
      expect(JSON.stringify(res)).not.toContain("FAKEFAKE");
      const out = resultJson<{
        handle: string;
        file: string;
        shape: { kind: string; json_keys: string[] };
      }>(res);
      expect(out.file).toBe("robot-key.json");
      expect(out.shape.kind).toBe("json");
      expect(out.shape.json_keys).toEqual([
        "type",
        "client_email",
        "private_key",
      ]);
      expect(readdirSync(downloads)).toEqual([]);
      await call(custody, "custody", "deposit", {
        handle: out.handle,
        slug: "gcs",
        variable: "GCS_KEY_JSON",
      });
      expect(deposits.at(-1)?.value).toBe(SA);
    });

    it("deposits into the gateway namespace with gateway: true, and only with slug or gateway", async () => {
      const before = deposits.length;
      for (const args of [
        { variable: "STRAD_TAILNET_OAUTH_CLIENT_SECRET" },
        { gateway: false, variable: "STRAD_TAILNET_OAUTH_CLIENT_SECRET" },
        { gateway: true, variable: "NOT-A-NAME" },
        {
          slug: "linear",
          gateway: true,
          variable: "STRAD_TAILNET_OAUTH_CLIENT_SECRET",
        },
      ]) {
        const refused = await call(custody, "custody", "deposit", {
          handle: "h_whatever",
          ...args,
        });
        expect(refused.isError).toBe(true);
        expect(resultText(refused)).toMatch(/Nothing was sent/);
      }
      expect(deposits.length).toBe(before);

      const capture = await call(custody, "custody", "capture_download", {
        tab_id: tab,
        click_selector: "#dl",
      });
      const { handle } = resultJson<{ handle: string }>(capture);
      const res = await call(custody, "custody", "deposit", {
        handle,
        gateway: true,
        variable: "STRAD_TAILNET_OAUTH_CLIENT_SECRET",
      });
      expect(resultJson(res)).toEqual({
        deposited: true,
        destination: "default",
        path: "/strad/test/gateway/static/STRAD_TAILNET_OAUTH_CLIENT_SECRET",
        version: "v1",
      });
      expect(deposits.at(-1)).toMatchObject({
        url: "/_strad/deposit/_gateway/STRAD_TAILNET_OAUTH_CLIENT_SECRET",
        authorization: `Bearer ${depositToken(CUSTODY_KEY)}`,
        value: SA,
      });
    });

    it("deletes a download it cannot keep rather than leaving it for the shell", async () => {
      const res = await call(custody, "custody", "capture_download", {
        tab_id: tab,
        click_selector: "#dlbig",
      });
      expect(res.isError).toBe(true);
      expect(resultText(res)).toMatch(/deleted/);
      expect(readdirSync(downloads)).toEqual([]);
    });

    it("ending the custody grant blanks its tainted tabs and lifts the hold", async () => {
      expect(await shellWorks()).toBe(false);
      await custody.callTool({
        name: "end_control",
        arguments: { grant_id: grants.custody },
      });
      for (let i = 0; i < 50 && !(await shellWorks()); i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(await shellWorks()).toBe(true);
      const read = resultJson<{ url: string }>(
        await call(browser, "browser", "read_page", { tab_id: tab }),
      );
      expect(read.url).toBe("about:blank");
    });
  },
);
