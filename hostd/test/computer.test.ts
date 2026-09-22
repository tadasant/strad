import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CAPABILITIES } from "../src/capabilities.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { dialogText } from "../src/consent/prompter.js";
import { FakeHelper } from "./fake-ax.js";
import {
  connect,
  resultJson,
  resultText,
  ScriptedPrompter,
  testConfig,
  tmpState,
} from "./helpers.js";

const HEADLESS_KEY = "headless-key-0123456789abcdef0123456789abc";
const COMPUTER_KEY = "computer-key-0123456789abcdef0123456789abc";
const PURPOSE = "Save the open note in Notes and confirm it saved.";

let daemon: RunningDaemon;
let fake: FakeHelper;
const prompter = new ScriptedPrompter("allowed");

function config() {
  return testConfig({
    capabilities: {
      shell: {
        enabled: true,
        key: "shell-key-0123456789abcdef0123456789abcdef",
        displayName: "shell-test-mbp",
      },
      browser: { enabled: false },
      "computer-headless": {
        enabled: true,
        key: HEADLESS_KEY,
        displayName: "computer-use-test-mbp-headless",
      },
      computer: {
        enabled: true,
        key: COMPUTER_KEY,
        displayName: "computer-use-test-mbp",
      },
    },
  });
}

beforeAll(async () => {
  fake = new FakeHelper();
  daemon = await startDaemon(config(), {
    stateDir: tmpState(),
    prompter,
    helperTransport: fake.transport,
    ephemeralPorts: true,
  });
});
afterAll(() => daemon.stop());

const grantOn = async (path: string, key: string) => {
  const client = await connect(daemon.mcpPort, path, key);
  const r = await client.callTool({
    name: "request_control",
    arguments: { purpose: PURPOSE },
  });
  if (r.isError) throw new Error(resultText(r));
  return { client, grantId: resultJson<{ grant_id: string }>(r).grant_id };
};

describe("the headless computer-use server, through a real MCP client", () => {
  it("serves the control tools, then the seven Accessibility tools, all needing grant_id", async () => {
    const client = await connect(
      daemon.mcpPort,
      "/computer-headless/mcp",
      HEADLESS_KEY,
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "request_control",
      "end_control",
      "get_control_status",
      "list_apps",
      "read_ui_tree",
      "find_elements",
      "get_element",
      "perform_action",
      "set_value",
      "read_text",
    ]);
    for (const t of tools.slice(3))
      expect(t.inputSchema.required).toContain("grant_id");
    expect(client.getServerVersion()?.name).toBe(
      "computer-use-test-mbp-headless",
    );
    await client.close();
  });

  it("its key opens nothing on the foreground server, and vice versa", async () => {
    const post = (path: string, key: string) =>
      fetch(`http://127.0.0.1:${daemon.mcpPort}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post("/computer/mcp", HEADLESS_KEY)).status).toBe(401);
    expect((await post("/computer-headless/mcp", COMPUTER_KEY)).status).toBe(
      401,
    );
    expect((await post("/computer-headless/mcp", HEADLESS_KEY)).status).toBe(
      200,
    );
  });

  it("reads a tree as an outline, acts on an element, sets a value, reads it back", async () => {
    const { client, grantId } = await grantOn(
      "/computer-headless/mcp",
      HEADLESS_KEY,
    );
    const tree = await client.callTool({
      name: "read_ui_tree",
      arguments: { grant_id: grantId, app: "Notes" },
    });
    const out = resultText(tree);
    expect(out).toContain('e1 Window "Untitled"');
    expect(out).toContain('  e3 Button "Save" {press}');
    expect(out).toContain("[focused]");
    expect(out).toContain('"truncated":false');
    // A secure field's value is never in the tree — the fake sends none, the real helper omits it.
    expect(out).not.toMatch(/Password.*=/);

    const pressed = resultJson<{ performed: string }>(
      await client.callTool({
        name: "perform_action",
        arguments: { grant_id: grantId, element: "e3" },
      }),
    );
    expect(pressed.performed).toBe("AXPress");

    await client.callTool({
      name: "set_value",
      arguments: { grant_id: grantId, element: "e2", value: "Groceries" },
    });
    const text = resultText(
      await client.callTool({
        name: "read_text",
        arguments: { grant_id: grantId, app: "Notes" },
      }),
    );
    expect(text).toContain("Title: Groceries");

    const found = resultJson<{ elements: { id: string }[] }>(
      await client.callTool({
        name: "find_elements",
        arguments: { grant_id: grantId, app: "Notes", text: "save" },
      }),
    );
    expect(found.elements.map((e) => e.id)).toEqual(["e3"]);

    const bad = await client.callTool({
      name: "perform_action",
      arguments: { grant_id: grantId, element: "e3", action: "increment" },
    });
    expect(bad.isError).toBe(true);
    expect(resultText(bad)).toMatch(/does not offer/);

    await client.callTool({
      name: "end_control",
      arguments: { grant_id: grantId },
    });
    await client.close();
  });

  it("refuses everything without a grant, and the helper is never asked", async () => {
    const before = fake.ops.length;
    const client = await connect(
      daemon.mcpPort,
      "/computer-headless/mcp",
      HEADLESS_KEY,
    );
    const r = await client.callTool({
      name: "perform_action",
      arguments: { element: "e3", grant_id: "g_forged" },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/request_control/);
    expect(
      fake.ops
        .slice(before)
        .filter((o) => o.op !== "set_state" && o.op !== "hello"),
    ).toEqual([]);
    await client.close();
  });

  it("shows NO dialog when the helper is not trusted: the owner cannot fix that in five seconds", async () => {
    fake.state.accessibility = false;
    const shown = prompter.seen.length;
    const client = await connect(
      daemon.mcpPort,
      "/computer-headless/mcp",
      HEADLESS_KEY,
    );
    const r = await client.callTool({
      name: "request_control",
      arguments: { purpose: PURPOSE },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/\(helper_unavailable\).*Accessibility/);
    expect(prompter.seen).toHaveLength(shown);
    const status = resultJson<{
      helper: { running: boolean; accessibility: boolean };
    }>(await client.callTool({ name: "get_control_status", arguments: {} }));
    expect(status.helper).toMatchObject({
      running: true,
      accessibility: false,
    });
    fake.state.accessibility = true;
    await client.close();
  });

  it("shows NO dialog when the helper is down, and says how to find out why", async () => {
    fake.state.fail = "connect ENOENT ax.sock";
    daemon.core.helper.close();
    const client = await connect(
      daemon.mcpPort,
      "/computer-headless/mcp",
      HEADLESS_KEY,
    );
    const r = await client.callTool({
      name: "request_control",
      arguments: { purpose: PURPOSE },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/helper_unavailable.*not running.*ENOENT/);
    delete fake.state.fail;
    await client.close();
  });
});

describe("the foreground computer-use server", () => {
  it("serves the eight tools, and warns in the dialog that it takes the mouse", async () => {
    const client = await connect(daemon.mcpPort, "/computer/mcp", COMPUTER_KEY);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).slice(3)).toEqual([
      "take_screenshot",
      "list_displays",
      "click",
      "move_mouse",
      "drag",
      "scroll",
      "type_text",
      "press_keys",
    ]);
    expect(CAPABILITIES.computer.mode).toBe("foreground");
    const before = prompter.seen.length;
    const r = await client.callTool({
      name: "request_control",
      arguments: { purpose: PURPOSE },
    });
    expect(r.isError).toBeFalsy();
    const req = prompter.seen[before]!;
    expect(req.note).toMatch(/move your mouse/);
    expect(dialogText(req)).toContain(
      "Press any key or click to take the machine back.",
    );
    await client.callTool({
      name: "end_control",
      arguments: { grant_id: resultJson<{ grant_id: string }>(r).grant_id },
    });
    await client.close();
  });

  it("screenshots as an image with the mapping back to screen points, and drives the mouse and keyboard", async () => {
    const { client, grantId } = await grantOn("/computer/mcp", COMPUTER_KEY);
    const shot = await client.callTool({
      name: "take_screenshot",
      arguments: { grant_id: grantId },
    });
    const content = shot.content as {
      type: string;
      mimeType?: string;
      text?: string;
    }[];
    expect(content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(JSON.parse(content[1]!.text!)).toMatchObject({
      width: 1280,
      origin: { x: 0, y: 0 },
      cursor: { x: 10, y: 20 },
    });
    expect(content[1]!.text).not.toContain("image_base64");

    await client.callTool({
      name: "click",
      arguments: {
        grant_id: grantId,
        x: 500,
        y: 140,
        count: 2,
        modifiers: ["cmd"],
      },
    });
    await client.callTool({
      name: "press_keys",
      arguments: { grant_id: grantId, keys: "cmd+shift+s" },
    });
    await client.callTool({
      name: "type_text",
      arguments: { grant_id: grantId, text: "hello\n" },
    });
    await client.callTool({
      name: "scroll",
      arguments: { grant_id: grantId, x: 300, y: 300 },
    });
    const sent = fake.ops
      .filter((o) =>
        ["click", "press_keys", "type_text", "scroll"].includes(o.op),
      )
      .slice(-4);
    expect(sent).toEqual([
      {
        op: "click",
        args: { x: 500, y: 140, button: "left", count: 2, modifiers: ["cmd"] },
      },
      { op: "press_keys", args: { key: "s", modifiers: ["cmd", "shift"] } },
      { op: "type_text", args: { text: "hello\n" } },
      { op: "scroll", args: { x: 300, y: 300, dx: 0, dy: 300 } },
    ]);
    const bad = await client.callTool({
      name: "press_keys",
      arguments: { grant_id: grantId, keys: "cmd+" },
    });
    expect(bad.isError).toBe(true);

    // Ending the grant lets go of the keyboard.
    const releases = fake.ops.filter((o) => o.op === "input_release").length;
    await client.callTool({
      name: "end_control",
      arguments: { grant_id: grantId },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.ops.filter((o) => o.op === "input_release").length).toBe(
      releases + 1,
    );
    await client.close();
  });

  it("refuses the dialog when Screen Recording is missing, which the headless server does not need", async () => {
    fake.state.screenRecording = false;
    const foreground = await connect(
      daemon.mcpPort,
      "/computer/mcp",
      COMPUTER_KEY,
    );
    const r = await foreground.callTool({
      name: "request_control",
      arguments: { purpose: PURPOSE },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/Screen & System Audio Recording/);
    const { client, grantId } = await grantOn(
      "/computer-headless/mcp",
      HEADLESS_KEY,
    );
    await client.callTool({
      name: "end_control",
      arguments: { grant_id: grantId },
    });
    fake.state.screenRecording = true;
    await foreground.close();
    await client.close();
  });

  it("ends a foreground grant on the owner's first key or click, and NOT a background one", async () => {
    const fg = await grantOn("/computer/mcp", COMPUTER_KEY);
    const bg = await grantOn("/computer-headless/mcp", HEADLESS_KEY);
    fake.emit({ event: "owner_input", grant_id: fg.grantId });
    fake.emit({ event: "owner_input", grant_id: bg.grantId });
    await new Promise((r) => setTimeout(r, 30));
    const active = daemon.core.deps.gate.grants.active().map((g) => g.id);
    expect(active).not.toContain(fg.grantId);
    expect(active).toContain(bg.grantId);
    const after = await fg.client.callTool({
      name: "click",
      arguments: { grant_id: fg.grantId, x: 1, y: 1 },
    });
    expect(after.isError).toBe(true);
    expect(
      daemon.core.deps.audit
        .tail(5)
        .some((e) => e.detail.includes("owner_input")),
    ).toBe(true);
    await bg.client.callTool({
      name: "end_control",
      arguments: { grant_id: bg.grantId },
    });
    await fg.client.close();
    await bg.client.close();
  });
});

describe("the banner", () => {
  it("mirrors every grant, on every server, with its mode — and clears when they end", async () => {
    const shell = await grantOn(
      "/shell/mcp",
      "shell-key-0123456789abcdef0123456789abcdef",
    );
    const fg = await grantOn("/computer/mcp", COMPUTER_KEY);
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.state.banner).toMatchObject({
      disabled: false,
      control_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
      grants: [
        {
          id: shell.grantId,
          server: "shell-test-mbp",
          purpose: PURPOSE,
          foreground: false,
        },
        {
          id: fg.grantId,
          server: "computer-use-test-mbp",
          purpose: PURPOSE,
          foreground: true,
        },
      ],
    });
    // The Kill button on the banner.
    fake.emit({ event: "kill", grant_id: shell.grantId });
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.state.banner?.grants.map((g) => g.id)).toEqual([fg.grantId]);
    // And Disable everything.
    fake.emit({ event: "disable" });
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.state.banner).toMatchObject({ disabled: true, grants: [] });
    expect(daemon.core.deps.killSwitch.isDisabled()).toBe(true);
    daemon.core.deps.gate.enable();
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.state.banner?.disabled).toBe(false);
    await shell.client.close();
    await fg.client.close();
  });
});
