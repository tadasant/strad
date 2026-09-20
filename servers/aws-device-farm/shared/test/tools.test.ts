import { describe, expect, it, vi } from "vitest";

import { createDriverPool } from "../src/drivers.js";
import { createGateway } from "../src/gateway.js";
import { parseToolGroups, toolDefinitions, toolNames } from "../src/tools.js";
import { DESCRIPTION_BUDGET, type Deps, type ToolDefinition } from "../src/tools/shared.js";
import {
  APPIUM_ENDPOINT,
  DEVICE_ARN,
  PROJECT_ARN,
  RUN_ARN,
  SESSION_ARN,
  SCREEN_XML,
  UPLOAD_ARN,
  fakeDeviceFarm,
  fakeHttp,
  runningSession,
} from "./fakes.js";

const WD_SESSION = "wd-1";

function harness(
  state: Parameters<typeof fakeDeviceFarm>[0] = {},
  routes: Parameters<typeof fakeHttp>[0] = {},
) {
  const api = fakeDeviceFarm(state);
  const http = fakeHttp({
    "/session": { body: { value: { sessionId: WD_SESSION } } },
    "/source": { body: { value: SCREEN_XML("0:42") } },
    "/elements": { body: { value: [{ "element-6066-11e4-a52e-4f735466cecf": "e1" }] } },
    "/click": { body: { value: null } },
    "/clear": { body: { value: null } },
    "/value": { body: { value: null } },
    "/actions": { body: { value: null } },
    "/execute/sync": { body: { value: 4 } },
    "/screenshot": { body: { value: PNG_BASE64 } },
    "builds.example.com": { bytes: new Uint8Array(16), headers: { "content-length": "16" } },
    "s3.amazonaws.com/put": { status: 200 },
    ...routes,
  });
  const gateway = createGateway({ api, projectArn: PROJECT_ARN });
  const deps: Deps = {
    gateway,
    pool: createDriverPool({ gateway, fetchImpl: http.fetchImpl }),
    maxUploadBytes: 1024 * 1024,
    fetchImpl: http.fetchImpl,
  };
  const tools = toolDefinitions(async () => deps);
  const call = async (name: string, argv: Record<string, unknown> = {}) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool named ${name}`);
    return tool.handler(argv);
  };
  /**
   * A tool result, in both shapes it comes in. A success and a classified
   * failure are JSON; an ordinary failure is one sentence, so `payload` falls
   * back to it rather than throwing and reporting a passing tool as a broken
   * test.
   */
  const json = async (name: string, argv: Record<string, unknown> = {}) => {
    const result = await call(name, argv);
    const text = (result.content.find((c) => c.type === "text") as { text: string }).text;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = { message: text };
    }
    return { isError: result.isError ?? false, text, payload, result };
  };
  return { api, http, tools, call, json };
}

/** A 2x1 PNG, so the screenshot tool has a real header to read. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("the surface", () => {
  it("is nineteen tools", () => {
    expect(toolNames()).toHaveLength(19);
  });

  it("names every tool verb-first, in snake_case, with no server prefix", () => {
    for (const name of toolNames()) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(name.length).toBeLessThanOrEqual(25);
      // The client prefixes with the server name; `aws_device_farm_list_devices`
      // would arrive as `aws-device-farm:aws_device_farm_list_devices`.
      expect(name.startsWith("aws_")).toBe(false);
      expect(name.startsWith("device_farm")).toBe(false);
    }
  });

  it("keeps every description inside the budget a client will show", () => {
    // Past it, the tail is text no agent on Claude Code ever reads, and the cut
    // is reported to the client's own log rather than to this server.
    for (const tool of toolDefinitions(async () => {
      throw new Error("not used");
    })) {
      expect(
        tool.description.length,
        `${tool.name} is ${tool.description.length} characters`,
      ).toBeLessThanOrEqual(DESCRIPTION_BUDGET);
    }
  });

  it("gives every description an example response and a use case", () => {
    for (const tool of toolDefinitions(async () => {
      throw new Error("not used");
    })) {
      expect(tool.description, tool.name).toMatch(/Example|example/);
      expect(tool.description, tool.name).toMatch(/Use cases:/);
    }
  });

  it("marks the tools that cannot change anything as read-only", () => {
    const readOnly = (name: string): boolean | undefined =>
      toolDefinitions(async () => {
        throw new Error("not used");
      }).find((t) => t.name === name)?.annotations?.readOnlyHint;
    for (const name of [
      "get_account_status",
      "list_devices",
      "list_device_pools",
      "list_uploads",
      "get_run",
      "list_run_artifacts",
      "list_device_sessions",
      "read_screen",
      "take_screenshot",
    ]) {
      expect(readOnly(name), name).toBe(true);
    }
    for (const name of ["schedule_run", "start_device_session", "tap_screen"]) {
      expect(readOnly(name), name).toBe(false);
    }
  });

  it("exposes nothing that could delete a project or buy a slot", () => {
    // The surface is the boundary. An agent with this credential must not be
    // able to make a $250/month decision or destroy a project's history.
    const names = toolNames().join(" ");
    expect(names).not.toMatch(/delete|purchase|slot|renew|create_project/);
  });
});

describe("the groups are about money", () => {
  it("gives a readonly deployment nothing that starts a phone or a run", () => {
    const names = toolNames(["readonly"]);
    expect(names).not.toContain("start_device_session");
    expect(names).not.toContain("schedule_run");
    expect(names).not.toContain("upload_app");
    expect(names).not.toContain("tap_screen");
  });

  it("puts both brakes in every group, including readonly", () => {
    // Stopping can only ever reduce a bill, and a slug that can SEE a runaway
    // session and cannot end it is the worst arrangement available here.
    for (const group of ["readonly", "automation", "interactive"] as const) {
      expect(toolNames([group]), group).toContain("stop_device_session");
      expect(toolNames([group]), group).toContain("stop_run");
    }
  });

  it("gives an interactive deployment the whole driving loop", () => {
    const names = toolNames(["interactive"]);
    for (const name of [
      "start_device_session",
      "read_screen",
      "take_screenshot",
      "tap_screen",
      "type_text",
      "swipe_screen",
      "run_mobile_command",
      "install_app",
      "stop_device_session",
    ]) {
      expect(names).toContain(name);
    }
    // It can upload a build to install, and it cannot schedule a paid run.
    expect(names).toContain("upload_app");
    expect(names).not.toContain("schedule_run");
  });

  it("fails closed on a group name nobody recognises", () => {
    expect(parseToolGroups(undefined)).toEqual([
      "readonly",
      "automation",
      "interactive",
    ]);
    expect(parseToolGroups("interactive")).toEqual(["interactive"]);
    expect(parseToolGroups("readonly,automation")).toEqual(["readonly", "automation"]);
    // Somebody meant to restrict this and mistyped it. Falling back to
    // everything would cost them the guarantee, and here that is a bill.
    expect(parseToolGroups("interactiv")).toEqual(["readonly"]);
  });
});

describe("the loop an agent actually runs", () => {
  it("reports what a minute costs before anything is spent", async () => {
    const { json } = harness();
    const { payload } = await json("get_account_status");
    expect(payload.free_trial_minutes_remaining).toBe(827.5);
    expect(payload.metered_rate_usd_per_minute).toBe(0.17);
  });

  it("defaults list_devices to an iPhone you can have now and can drive", async () => {
    const { api, json } = harness();
    const { payload } = await json("list_devices");
    expect((payload.devices as unknown[])[0]).toMatchObject({ model: "iPhone 15 Pro" });
    const filters = api.calls[0]!.input.filters as { attribute: string }[];
    expect(filters.map((f) => f.attribute)).toEqual([
      "PLATFORM",
      "REMOTE_ACCESS_ENABLED",
      "AVAILABILITY",
    ]);
  });

  it("explains an empty device list instead of implying there are no iPhones", async () => {
    const { json } = harness({ devices: [] });
    const { payload } = await json("list_devices");
    expect(payload.returned).toBe(0);
    expect(String(payload.note)).toContain("available_only=false");
  });

  it("uploads a build and reports it ready", async () => {
    const { json } = harness();
    const { payload } = await json("upload_app", {
      source_url: "https://builds.example.com/Motet.ipa",
      name: "Motet.ipa",
    });
    expect(payload).toMatchObject({ arn: UPLOAD_ARN, status: "SUCCEEDED", ready: true });
  });

  it("starts a session, waits for the phone, and says what it costs", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeDeviceFarm();
      const http = fakeHttp({});
      const gateway = createGateway({ api, projectArn: PROJECT_ARN });
      const tools = toolDefinitions(async () => ({
        gateway,
        pool: createDriverPool({ gateway, fetchImpl: http.fetchImpl }),
        maxUploadBytes: 1024,
        fetchImpl: http.fetchImpl,
      }));
      const start = tools.find((t) => t.name === "start_device_session")!;

      const pending = start.handler({ device_arn: DEVICE_ARN, wait_seconds: 60 });
      // Let the session be created first — the fake records a PENDING one, and
      // replacing the list before that would leave it in front of the running
      // session under the same ARN.
      await vi.advanceTimersByTimeAsync(0);
      // The phone finishes being allocated while the tool is waiting.
      api.state.sessions = [runningSession()];
      await vi.advanceTimersByTimeAsync(6000);
      const result = await pending;

      const payload = JSON.parse(
        (result.content[0] as { text: string }).text,
      ) as Record<string, unknown>;
      expect(payload).toMatchObject({ status: "RUNNING", drivable: true });
      expect(String(payload.next)).toContain("stop_device_session");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands back a real session even when the wait runs out", async () => {
    // The session exists and is already billing. Reporting a failure would
    // lose the ARN that stops it.
    const { json } = harness();
    const { payload, isError } = await json("start_device_session", {
      device_arn: DEVICE_ARN,
      wait_seconds: 0,
    });
    expect(isError).toBe(false);
    expect(payload.status).toBe("PENDING");
    expect(String(payload.next)).toContain("stop_device_session");
  });

  it("reads the screen as something to assert on", async () => {
    const { json } = harness({ sessions: [runningSession()] });
    const { payload } = await json("read_screen", { query: "elapsed" });
    expect(payload.session_arn).toBe(SESSION_ARN);
    expect((payload.elements as { value: string }[])[0]!.value).toBe("0:42");
  });

  it("returns a screenshot as an image, with its pixel size beside it", async () => {
    const { call } = harness({ sessions: [runningSession()] });
    const result = await call("take_screenshot");
    const image = result.content.find((c) => c.type === "image") as {
      data: string;
      mimeType: string;
    };
    expect(image.mimeType).toBe("image/png");
    expect(image.data).toBe(PNG_BASE64);
    const meta = JSON.parse(
      (result.content.find((c) => c.type === "text") as { text: string }).text,
    ) as Record<string, unknown>;
    expect(meta).toMatchObject({ width_px: 2, height_px: 1 });
    expect(String(meta.note)).toContain("POINTS");
  });

  it("taps by label through an escaped iOS predicate", async () => {
    const { http, json } = harness({ sessions: [runningSession()] });
    const { payload } = await json("tap_screen", { label: 'The "Play" button' });
    expect(payload).toMatchObject({ tapped: "label" });
    const find = http.calls.find((c) => c.url.endsWith("/elements"))!;
    // A label containing a quote must not break the predicate — a broken one
    // reads as "no such element", the most misleading failure available here.
    expect(JSON.parse(String(find.init?.body))).toEqual({
      using: "-ios predicate string",
      value: 'name == "The \\"Play\\" button" OR label == "The \\"Play\\" button"',
    });
  });

  it("taps a coordinate when given one", async () => {
    const { http, json } = harness({ sessions: [runningSession()] });
    const { payload } = await json("tap_screen", { x: 197, y: 642 });
    expect(payload).toMatchObject({ tapped: "point", x: 197, y: 642 });
    expect(http.calls.some((c) => c.url.endsWith("/actions"))).toBe(true);
  });

  it("refuses a tap with no target and a tap with two", async () => {
    const { json } = harness({ sessions: [runningSession()] });
    expect((await json("tap_screen")).isError).toBe(true);
    const both = await json("tap_screen", { label: "Play", x: 1, y: 2 });
    expect(both.isError).toBe(true);
    expect(JSON.stringify(both.payload)).toContain("not both");
  });

  it("says nothing was tapped when the label is not on screen", async () => {
    const { json } = harness({ sessions: [runningSession()] }, {
      "/elements": { body: { value: [] } },
    });
    const { isError, payload } = await json("tap_screen", { label: "Play" });
    expect(isError).toBe(true);
    expect(JSON.stringify(payload)).toContain("read_screen");
  });

  it("clears a field before typing into it", async () => {
    const { http, json } = harness({ sessions: [runningSession()] });
    const { payload } = await json("type_text", { label: "Email", text: "a@b.example" });
    expect(payload).toMatchObject({ typed: true, characters: 11, cleared: true });
    expect(http.calls.some((c) => c.url.endsWith("/clear"))).toBe(true);
    const typed = http.calls.find((c) => c.url.endsWith("/value"))!;
    expect(JSON.parse(String(typed.init?.body)).text).toBe("a@b.example");
  });

  it("never puts typed text in the result it returns", async () => {
    // It is typed into a phone Device Farm records on video; it does not also
    // need to be in a transcript.
    const { json } = harness({ sessions: [runningSession()] });
    const { result } = await json("type_text", { label: "Email", text: "hunter2" });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("types into whatever a coordinate tap focused", async () => {
    const { http, json } = harness({ sessions: [runningSession()] });
    const { payload } = await json("type_text", { x: 100, y: 200, text: "hi" });
    expect(payload).toMatchObject({ target: "point" });
    const find = http.calls.find((c) => c.url.endsWith("/elements"))!;
    expect(JSON.parse(String(find.init?.body)).value).toBe("hasKeyboardFocus == 1");
  });

  it("says so when a tap put the keyboard nowhere", async () => {
    const { json } = harness({ sessions: [runningSession()] }, {
      "/elements": { body: { value: [] } },
    });
    const { isError, payload } = await json("type_text", { x: 1, y: 2, text: "hi" });
    expect(isError).toBe(true);
    expect(JSON.stringify(payload)).toContain("POINTS");
  });

  it("swipes with a duration that reads as a drag", async () => {
    const { json } = harness({ sessions: [runningSession()] });
    const { payload } = await json("swipe_screen", {
      from_x: 196,
      from_y: 1400,
      to_x: 196,
      to_y: 600,
    });
    expect(payload).toMatchObject({ duration_ms: 400 });
  });

  it("runs a mobile: command with or without the prefix", async () => {
    const { http, json } = harness({ sessions: [runningSession()] });
    const bare = await json("run_mobile_command", {
      command: "queryAppState",
      args: { bundleId: "com.tadasant.motet" },
    });
    expect(bare.payload).toMatchObject({ command: "mobile: queryAppState", result: 4 });
    const script = JSON.parse(
      String(http.calls.find((c) => c.url.endsWith("/execute/sync"))!.init?.body),
    ) as { script: string; args: unknown[] };
    expect(script.script).toBe("mobile: queryAppState");
    expect(script.args).toEqual([{ bundleId: "com.tadasant.motet" }]);

    const prefixed = await json("run_mobile_command", { command: "mobile: pressButton" });
    expect(prefixed.payload).toMatchObject({ command: "mobile: pressButton" });
  });

  it("refuses anything outside the mobile: namespace", async () => {
    // The bound is the namespace, not a list. This is not a general WebDriver
    // pipe, and `/session/:id/url` is not reachable through it.
    const { json } = harness({ sessions: [runningSession()] });
    for (const command of ["execute: rm -rf /", "../url", "window handles"]) {
      const { isError } = await json("run_mobile_command", { command });
      expect(isError, command).toBe(true);
    }
  });

  it("ends the WebDriver session before it stops the Device Farm one", async () => {
    const { http, json } = harness({ sessions: [runningSession()] });
    await json("read_screen");
    const { payload } = await json("stop_device_session", { session_arn: SESSION_ARN });
    expect(payload.status).toBe("STOPPING");
    expect(http.calls.at(-1)!.init?.method).toBe("DELETE");
  });

  it("drops the pooled driver when a new build is installed", async () => {
    // The pooled session launched the PREVIOUS build. Keeping it would drive
    // the old app and report it as the new one.
    const { http, json } = harness({ sessions: [runningSession()] });
    await json("read_screen");
    await json("install_app", { session_arn: SESSION_ARN, app_arn: UPLOAD_ARN });
    await json("read_screen");
    expect(http.calls.filter((c) => c.url === `${APPIUM_ENDPOINT}/session`)).toHaveLength(2);
  });
});

describe("failures an agent has to act on", () => {
  it("marks an IAM refusal as needing a human, not a retry", async () => {
    const denied = new Error("not authorized to perform: devicefarm:ScheduleRun");
    denied.name = "AccessDeniedException";
    const { json } = harness({ failWith: denied });
    const { isError, payload } = await json("list_devices");
    expect(isError).toBe(true);
    expect(payload).toMatchObject({ error: "AuthError", needs_human: true, retryable: false });
  });

  it("points a concurrency failure at the session nobody stopped", async () => {
    const limit = new Error("maximum number of devices reached");
    limit.name = "LimitExceededException";
    const { json } = harness({ failWith: limit });
    const { payload } = await json("start_device_session", { device_arn: DEVICE_ARN });
    expect(payload).toMatchObject({ next: "list_device_sessions", retryable: false });
  });

  it("calls a session that is still starting retryable, and a finished one not", async () => {
    const starting = harness({
      sessions: [{ arn: SESSION_ARN, status: "PREPARING" }],
    });
    // Named explicitly: a PREPARING session is not RUNNING, so leaving it out
    // would be answered by "nothing is running" before the phone was reached.
    expect(
      (await starting.json("read_screen", { session_arn: SESSION_ARN })).payload,
    ).toMatchObject({
      error: "SessionNotReadyError",
      session_status: "PREPARING",
      retryable: true,
    });

    // And with no ARN at all, the answer is about the fleet rather than a phone.
    expect((await starting.json("read_screen")).text).toContain(
      "No device session is running",
    );
  });

  it("does not tell a caller to retry a run ARN that does not exist", async () => {
    const missing = new Error("Run not found");
    missing.name = "NotFoundException";
    const { json } = harness({ failWith: missing });
    const { isError, payload } = await json("get_run", { run_arn: RUN_ARN });
    expect(isError).toBe(true);
    expect(JSON.stringify(payload)).toContain("NotFoundException");
  });

  it("refuses a test type that needs a package it was not given", async () => {
    const { json } = harness();
    const { isError, payload } = await json("schedule_run", {
      test_type: "XCTEST_UI",
      app_arn: UPLOAD_ARN,
      device_arns: [DEVICE_ARN],
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(payload)).toContain("test_package_arn");
  });

  it("refuses something that is not a Device Farm ARN before spending a call", async () => {
    const { api, json } = harness();
    const { isError } = await json("get_run", { run_arn: "motet-smoke-run" });
    expect(isError).toBe(true);
    expect(api.calls).toEqual([]);
  });
});

/** Every tool, for the assertions that must not miss one. */
function everyTool(): ToolDefinition[] {
  return toolDefinitions(async () => {
    throw new Error("not used");
  });
}

describe("the tool list itself", () => {
  it("has no two tools with the same name", () => {
    const names = everyTool().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("closes every input schema, so a typo'd argument is refused", () => {
    for (const tool of everyTool()) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });
});
