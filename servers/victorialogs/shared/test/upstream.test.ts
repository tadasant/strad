import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";

import { UNCONFIGURED_ENTRYPOINT, VictoriaLogsUpstream } from "../src/index.js";

const FAKE = fileURLToPath(
  new URL("./fake-mcp-victorialogs.mjs", import.meta.url),
);

/** The container's environment, as the bundle really holds it. */
const CONTAINER_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  VL_INSTANCE_ENTRYPOINT: "https://grafana.example.com/api/datasources/proxy/uid/VictoriaLogs",
  VL_INSTANCE_BEARER_TOKEN: "glsa-test-token",
  // The other mounts' credentials, which share this process's environment and
  // must not share the child's.
  SLACK_BOT_TOKEN: "xoxb-not-for-victorialogs",
  OP_SERVICE_ACCOUNT_TOKEN: "ops_not-for-victorialogs",
  GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa-not-for-victorialogs",
  // Binary settings a deployment must not be able to reach by accident.
  MCP_SERVER_MODE: "http",
  MCP_DISABLED_TOOLS: "query",
};

const started: VictoriaLogsUpstream[] = [];

function upstream(
  overrides: Partial<ConstructorParameters<typeof VictoriaLogsUpstream>[0]> = {},
): VictoriaLogsUpstream {
  const instance = new VictoriaLogsUpstream({
    slug: "victorialogs-example",
    version: "test",
    env: CONTAINER_ENV,
    binary: FAKE,
    log: () => {},
    ...overrides,
  });
  started.push(instance);
  return instance;
}

/** The JSON a fake tool answered with. */
async function callJson(
  instance: VictoriaLogsUpstream,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const result = await instance.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

afterAll(async () => {
  await Promise.all(started.map((instance) => instance.close()));
});

describe("the mcp-victorialogs child", () => {
  it("gets the VictoriaLogs settings and NOT the rest of the container's", async () => {
    const { env, flags } = await callJson(upstream(), "echo_process");

    assert.equal(env.VL_INSTANCE_ENTRYPOINT, CONTAINER_ENV.VL_INSTANCE_ENTRYPOINT);
    assert.equal(env.VL_INSTANCE_BEARER_TOKEN, "glsa-test-token");
    assert.equal(env.SLACK_BOT_TOKEN, undefined);
    assert.equal(env.OP_SERVICE_ACCOUNT_TOKEN, undefined);
    assert.equal(env.GRAFANA_SERVICE_ACCOUNT_TOKEN, undefined);
    // Pinned to stdio whatever the container says, and the tool list is not
    // narrowed behind the gateway's back.
    assert.equal(env.MCP_SERVER_MODE, "stdio");
    assert.equal(env.MCP_DISABLED_TOOLS, undefined);
    assert.deepEqual(flags, []);
  });

  it("starts against an unresolvable entrypoint when none is configured, so it can list", async () => {
    const instance = upstream({ env: { PATH: process.env.PATH } });
    const tools = await instance.listTools();
    assert.ok(tools.length > 0);
    const { env } = await callJson(instance, "echo_process");
    assert.equal(env.VL_INSTANCE_ENTRYPOINT, UNCONFIGURED_ENTRYPOINT);
  });

  it("forwards a call's params verbatim", async () => {
    const echoed = await callJson(upstream(), "echo_call", {
      note: "unaltered",
      nested: { list: [1, 2, 3] },
    });
    assert.equal(echoed.name, "echo_call");
    assert.deepEqual(echoed.arguments, {
      note: "unaltered",
      nested: { list: [1, 2, 3] },
    });
  });

  it("starts ONE child for concurrent first calls", async () => {
    const instance = upstream();
    const results = await Promise.all([
      callJson(instance, "echo_process"),
      callJson(instance, "echo_process"),
      callJson(instance, "echo_process"),
    ]);
    assert.equal(new Set(results.map((r) => r.pid)).size, 1);
  });

  it("replaces a child that exited, on the next call", async () => {
    const degraded: (string | null)[] = [];
    const instance = upstream({ onDegraded: (reason) => degraded.push(reason) });
    const before = await callJson(instance, "echo_process");
    assert.deepEqual(await callJson(instance, "die"), { dying: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await callJson(instance, "echo_process");
    assert.notEqual(after.pid, before.pid);
    assert.deepEqual(degraded.filter(Boolean), []);
  });

  it("reports a binary it cannot start, and retries rather than caching the failure", async () => {
    const degraded: (string | null)[] = [];
    const instance = upstream({
      binary: "/nonexistent/mcp-victorialogs",
      onDegraded: (reason) => degraded.push(reason),
    });
    await assert.rejects(() => instance.listTools());
    assert.equal(degraded.length, 1);
    assert.match(String(degraded[0]), /could not be started/);
    await assert.rejects(() => instance.listTools());
    assert.equal(degraded.length, 2);
  });

  it("refuses to start a child after close()", async () => {
    const instance = upstream();
    await instance.listTools();
    await instance.close();
    await assert.rejects(() => instance.listTools(), /closed/);
  });
});

/**
 * The pinned binary itself, when a copy is at hand. CI's `servers` leg has
 * none and skips this; the bundle image's smoke test boots the real one. Run it
 * locally with the release asset the Dockerfile pins:
 *
 *   MCP_VICTORIALOGS_BINARY=/path/to/mcp-victorialogs npm test
 */
const REAL = process.env.MCP_VICTORIALOGS_BINARY;

describe.skipIf(!REAL)("the real mcp-victorialogs binary", () => {
  it("starts unconfigured and lists its thirteen read-only tools", async () => {
    const instance = upstream({ binary: REAL, env: { PATH: process.env.PATH } });
    const tools = await instance.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "documentation",
      "facets",
      "field_names",
      "field_values",
      "flags",
      "hits",
      "query",
      "stats_query",
      "stats_query_range",
      "stream_field_names",
      "stream_field_values",
      "stream_ids",
      "streams",
    ]);
    for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true);
  });
});
