import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import { resultJson, resultText, tmpState } from "./helpers.js";

/** The BUILT cli, as a local MCP client would launch it: no daemon, no tunnel, no key. */
async function launch(args: string[]): Promise<Client> {
  const client = new Client({ name: "local-claude-code", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["build/cli.js", ...args],
      env: { ...process.env, STRAD_HOSTD_HOME: tmpState() } as Record<
        string,
        string
      >,
    }),
  );
  return client;
}

describe("local-run mode: the same server over stdio", () => {
  it("serves the identical tool surface, with no config file at all", async () => {
    const client = await launch(["stdio", "shell", "--no-consent"]);
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

    const granted = resultJson<{ grant_id: string; approved_by: string }>(
      await client.callTool({
        name: "request_control",
        arguments: { purpose: "Run one command locally over stdio." },
      }),
    );
    expect(granted.approved_by).toBe("local");
    const ran = resultJson<{ output: string; exit_code: number }>(
      await client.callTool({
        name: "run_command",
        arguments: {
          grant_id: granted.grant_id,
          command: "echo local-$((20+3))",
        },
      }),
    );
    expect(ran).toMatchObject({ output: "local-23\n", exit_code: 0 });
    await client.close();
  });

  it("still requires a grant and a purpose with the dialog off — the interface does not change", async () => {
    const client = await launch(["stdio", "shell", "--no-consent"]);
    const r = await client.callTool({
      name: "run_command",
      arguments: { command: "echo no" },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/request_control/);
    await client.close();
  });

  it("keeps the dialog ON by default, and denies when it cannot be shown", async () => {
    // No display and no zenity in a test runner: the dialog is unavailable, which is a denial.
    const client = await launch(["stdio", "shell"]);
    const r = await client.callTool({
      name: "request_control",
      arguments: { purpose: "Ask with the dialog still on." },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/\((no_display|timeout|rejected)\)/);
    await client.close();
  });
});
