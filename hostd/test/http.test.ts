import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/daemon.js";
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

const PURPOSE = "Run the test suite's commands. Nothing else.";

let daemon: RunningDaemon;
const prompter = new ScriptedPrompter("allowed");

beforeAll(async () => {
  daemon = await startDaemon(testConfig(), {
    stateDir: tmpState(),
    prompter,
    ephemeralPorts: true,
  });
});
afterAll(() => daemon.stop());

const post = (path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${daemon.mcpPort}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("the second lock: each server's own bearer key", () => {
  it("answers 401 with no key, a wrong key, and ANOTHER SERVER'S key", async () => {
    expect((await post("/shell/mcp")).status).toBe(401);
    expect(
      (await post("/shell/mcp", { authorization: "Bearer nope" })).status,
    ).toBe(401);
    expect(
      (await post("/shell/mcp", { authorization: `Bearer ${BROWSER_KEY}` }))
        .status,
    ).toBe(401);
    expect(
      (await post("/browser/mcp", { authorization: `Bearer ${SHELL_KEY}` }))
        .status,
    ).toBe(401);
  });

  it("serves nothing at a path that is not a server, and nothing at the control page's routes", async () => {
    expect(
      (await post("/mcp", { authorization: `Bearer ${SHELL_KEY}` })).status,
    ).toBe(404);
    expect(
      (await post("/disable", { authorization: `Bearer ${SHELL_KEY}` })).status,
    ).toBe(404);
    expect(
      (await post("/kill-all", { authorization: `Bearer ${SHELL_KEY}` }))
        .status,
    ).toBe(404);
  });

  it("refuses to start a server that is enabled with no key, or with consent off", async () => {
    const noKey = testConfig({ capabilities: { shell: { enabled: true } } });
    await expect(
      startDaemon(noKey, { stateDir: tmpState(), ephemeralPorts: true }),
    ).rejects.toThrow(/has no key/);
    const noConsent = testConfig({ consent: { mode: "none" } });
    await expect(
      startDaemon(noConsent, { stateDir: tmpState(), ephemeralPorts: true }),
    ).rejects.toThrow(/refused by `serve`/);
  });
});

describe("the shell server, through a real MCP client", () => {
  it("lists the three control tools first, then its own, every one of those requiring grant_id", async () => {
    const client = await connect(daemon.mcpPort, "/shell/mcp", SHELL_KEY);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "request_control",
      "end_control",
      "get_control_status",
      "run_command",
      "get_command",
      "list_commands",
      "kill_command",
    ]);
    for (const t of tools.slice(3))
      expect(t.inputSchema.required).toContain("grant_id");
    expect(client.getServerVersion()?.name).toBe("shell-test-mbp");
    await client.close();
  });

  it("runs NOTHING without a grant, and says how to get one", async () => {
    const client = await connect(daemon.mcpPort, "/shell/mcp", SHELL_KEY);
    const marker = `${tmpState()}/ran`;
    for (const args of [
      { command: `touch ${marker}` },
      { command: `touch ${marker}`, grant_id: "g_forged" },
    ]) {
      const r = await client.callTool({ name: "run_command", arguments: args });
      expect(r.isError).toBe(true);
      expect(resultText(r)).toMatch(/request_control/);
      expect(resultText(r)).toMatch(/Nothing ran/);
    }
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
    await client.close();
  });

  it("request_control → run_command → end_control, across SEPARATE connections", async () => {
    // strad pools one upstream connection for every caller, and a stateless
    // listener sees no session at all: the grant_id is the only continuity.
    const a = await connect(daemon.mcpPort, "/shell/mcp", SHELL_KEY);
    const granted = resultJson<{
      grant_id: string;
      approved_by: string;
      minutes: number;
    }>(
      await a.callTool({
        name: "request_control",
        arguments: { purpose: PURPOSE, minutes: 5 },
      }),
    );
    expect(granted).toMatchObject({ approved_by: "owner", minutes: 5 });
    expect(prompter.seen.at(-1)).toMatchObject({
      server: "shell-test-mbp",
      purpose: PURPOSE,
    });
    await a.close();

    const b = await connect(daemon.mcpPort, "/shell/mcp", SHELL_KEY);
    const ran = resultJson<{
      status: string;
      exit_code: number;
      output: string;
    }>(
      await b.callTool({
        name: "run_command",
        arguments: {
          grant_id: granted.grant_id,
          command: "echo hello-$((6*7)); exit 3",
        },
      }),
    );
    expect(ran).toMatchObject({
      status: "exited",
      exit_code: 3,
      output: "hello-42\n",
    });

    const status = resultJson<{ grant: { active: boolean; calls: number } }>(
      await b.callTool({
        name: "get_control_status",
        arguments: { grant_id: granted.grant_id },
      }),
    );
    expect(status.grant).toMatchObject({ active: true, calls: 1 });

    expect(
      resultJson(
        await b.callTool({
          name: "end_control",
          arguments: { grant_id: granted.grant_id },
        }),
      ),
    ).toEqual({ ended: true });
    const after = await b.callTool({
      name: "run_command",
      arguments: { grant_id: granted.grant_id, command: "echo no" },
    });
    expect(after.isError).toBe(true);
    await b.close();
  });

  it("a shell grant opens nothing on the browser server", async () => {
    const shell = await connect(daemon.mcpPort, "/shell/mcp", SHELL_KEY);
    const { grant_id } = resultJson<{ grant_id: string }>(
      await shell.callTool({
        name: "request_control",
        arguments: { purpose: PURPOSE },
      }),
    );
    const browser = await connect(daemon.mcpPort, "/browser/mcp", BROWSER_KEY);
    const r = await browser.callTool({
      name: "list_tabs",
      arguments: { grant_id },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/not active/);
    await shell.close();
    await browser.close();
  });

  it("reports a rejection as a rejection, and validates arguments", async () => {
    const client = await connect(daemon.mcpPort, "/browser/mcp", BROWSER_KEY);
    prompter.answer = "rejected";
    const r = await client.callTool({
      name: "request_control",
      arguments: { purpose: PURPOSE },
    });
    prompter.answer = "allowed";
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/\(rejected\)/);

    const shell = await connect(daemon.mcpPort, "/shell/mcp", SHELL_KEY);
    const { grant_id } = resultJson<{ grant_id: string }>(
      await shell.callTool({
        name: "request_control",
        arguments: { purpose: PURPOSE },
      }),
    );
    const bad = await shell.callTool({
      name: "run_command",
      arguments: { grant_id, command: "" },
    });
    expect(bad.isError).toBe(true);
    expect(resultText(bad)).toMatch(/Invalid arguments for run_command/);
    await client.close();
    await shell.close();
  });
});
