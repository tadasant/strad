import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addClientKey,
  ConfigSchema,
  matchKey,
  revokeClientKey,
} from "../src/config.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import {
  BROWSER_KEY,
  connect,
  ScriptedPrompter,
  SHELL_KEY,
  testConfig,
  tmpState,
} from "./helpers.js";

const KEY_A = "claude-a-key-0123456789abcdef0123456789abcdef";
const KEY_B = "claude-b-key-0123456789abcdef0123456789abcdef";

describe("client keys in the config", () => {
  it("matches the server's own key with no client, a client key with its name, and nothing else", () => {
    const cfg = testConfig({
      capabilities: {
        shell: { enabled: true, key: SHELL_KEY },
        browser: { enabled: true, key: BROWSER_KEY, clientKeys: { a: KEY_A } },
      },
    });
    expect(matchKey(cfg.capabilities.browser, BROWSER_KEY)).toEqual({
      ok: true,
    });
    expect(matchKey(cfg.capabilities.browser, KEY_A)).toEqual({
      ok: true,
      client: "a",
    });
    expect(matchKey(cfg.capabilities.browser, SHELL_KEY)).toEqual({
      ok: false,
    });
    expect(matchKey(cfg.capabilities.shell, KEY_A)).toEqual({ ok: false });
  });

  it("adds a key to the raw file, refuses a name already in use, and revokes by name", () => {
    const raw: Record<string, unknown> = {
      capabilities: { browser: { enabled: true, key: BROWSER_KEY } },
    };
    addClientKey(raw, "browser", "claude-1", KEY_A);
    expect(() => addClientKey(raw, "browser", "claude-1", KEY_B)).toThrow(
      /already has a key for "claude-1"/,
    );
    expect(() => addClientKey(raw, "browser", "bad name!", KEY_B)).toThrow();
    expect(() => addClientKey(raw, "browser", "short", "tooshort")).toThrow();
    addClientKey(raw, "shell", "claude-1", KEY_B);
    const parsed = ConfigSchema.parse(raw);
    expect(parsed.capabilities.browser.clientKeys).toEqual({
      "claude-1": KEY_A,
    });
    expect(parsed.capabilities.shell.clientKeys).toEqual({ "claude-1": KEY_B });
    expect(revokeClientKey(raw, "browser", "claude-1")).toBe(true);
    expect(revokeClientKey(raw, "browser", "claude-1")).toBe(false);
    expect(ConfigSchema.parse(raw).capabilities.browser.clientKeys).toEqual({});
  });
});

describe("reloading keys into a running daemon", () => {
  let daemon: RunningDaemon;
  let configPath: string;
  const rawConfig = () =>
    JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const post = (path: string, fields: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${daemon.controlPort}${path}`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ token: daemon.controlToken, ...fields }),
    });

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostd-keys-"));
    configPath = join(dir, "config.json");
    const config = testConfig();
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    daemon = await startDaemon(config, {
      stateDir: tmpState(),
      prompter: new ScriptedPrompter("allowed"),
      ephemeralPorts: true,
      configPath,
    });
  });
  afterAll(() => daemon.stop());

  it("a key written to the file works after POST /reload-keys, and not before", async () => {
    const raw = rawConfig();
    addClientKey(raw, "browser", "claude-2", KEY_B);
    writeFileSync(configPath, JSON.stringify(raw, null, 2));
    await expect(
      connect(daemon.mcpPort, "/browser/mcp", KEY_B),
    ).rejects.toThrow(/unauthorized/);
    expect((await post("/reload-keys")).status).toBe(200);
    const client = await connect(daemon.mcpPort, "/browser/mcp", KEY_B);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
    // The same key opens nothing on the shell server.
    await expect(connect(daemon.mcpPort, "/shell/mcp", KEY_B)).rejects.toThrow(
      /unauthorized/,
    );
  });

  it("needs the control token, and answers 400 on a file that does not parse", async () => {
    const bad = await fetch(
      `http://127.0.0.1:${daemon.controlPort}/reload-keys`,
      { method: "POST", body: new URLSearchParams({ token: "nope" }) },
    );
    expect(bad.status).toBe(403);
    writeFileSync(configPath, "{ not json");
    expect((await post("/reload-keys")).status).toBe(400);
    // The keys in force are unchanged by a failed reload.
    const client = await connect(daemon.mcpPort, "/browser/mcp", KEY_B);
    await client.close();
  });

  it("revoking in the file and reloading shuts that client out", async () => {
    const raw = { ...testConfig() } as unknown as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify(raw, null, 2));
    expect((await post("/reload-keys")).status).toBe(200);
    await expect(
      connect(daemon.mcpPort, "/browser/mcp", KEY_B),
    ).rejects.toThrow(/unauthorized/);
    const still = await connect(daemon.mcpPort, "/browser/mcp", BROWSER_KEY);
    await still.close();
  });
});
