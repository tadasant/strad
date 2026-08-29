import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { GrafanaUpstream, READ_ONLY_ARGS } from "../build/index.js";

const FAKE = fileURLToPath(new URL("./fake-mcp-grafana.mjs", import.meta.url));

/** The container's environment, as the bundle really holds it. */
const CONTAINER_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GRAFANA_URL: "https://grafana.example.com",
  GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa-test-token",
  // The other nineteen mounts' credentials, which share this process's
  // environment and must not share the child's.
  SLACK_BOT_TOKEN: "xoxb-not-for-grafana",
  OP_SERVICE_ACCOUNT_TOKEN: "ops_not-for-grafana",
  SECRETS_SERVICE_ACCOUNT_KEY_JSON: '{"private_key":"not-for-grafana"}',
};

const started = [];

function upstream(overrides = {}) {
  const instance = new GrafanaUpstream({
    slug: "grafana-registry",
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
async function callJson(instance, name, args = {}) {
  const result = await instance.callTool({ name, arguments: args });
  return JSON.parse(result.content[0].text);
}

after(async () => {
  await Promise.all(started.map((instance) => instance.close()));
});

describe("the mcp-grafana child", () => {
  it("is started with the read-only flags, not merely asked to behave", async () => {
    const { flags } = await callJson(upstream(), "echo_process");

    // `-disable-write` is what makes the 13 write tools not exist, and
    // `-disable-proxied` is what stops a remote Grafana's datasources adding
    // tools this mount never enumerated. Both are the reason this mount can be
    // called read-only without qualification.
    assert.deepEqual(flags, [...READ_ONLY_ARGS]);
    assert.ok(flags.includes("-disable-write"));
    assert.ok(flags.includes("-disable-proxied"));
  });

  it("gets the Grafana credential and NOT the rest of the container's", async () => {
    const { env } = await callJson(upstream(), "echo_process");

    assert.equal(env.GRAFANA_URL, "https://grafana.example.com");
    assert.equal(env.GRAFANA_SERVICE_ACCOUNT_TOKEN, "glsa-test-token");

    // The point of the allowlist. A child process spawned with the default
    // environment would hold every credential on the bundle, and this one has a
    // tool that makes arbitrary requests to a host somebody else configures.
    assert.equal(env.SLACK_BOT_TOKEN, undefined);
    assert.equal(env.OP_SERVICE_ACCOUNT_TOKEN, undefined);
    assert.equal(env.SECRETS_SERVICE_ACCOUNT_KEY_JSON, undefined);
  });

  it("serves the tools the child lists, rather than a copy of them", async () => {
    const tools = await upstream().listTools();

    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["die", "echo_call", "echo_process"],
    );
    // Schemas come through as the child wrote them: nothing here restates a
    // tool definition that would then go stale at the next version bump.
    assert.equal(tools.find((t) => t.name === "echo_call").inputSchema.type, "object");
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

    // Same process: a cache that were not populated until the connection
    // resolved would spawn three children for a cold mount under load, and the
    // two orphans would never be reaped.
    const pids = new Set(results.map((r) => r.pid));
    assert.equal(pids.size, 1);
  });

  it("replaces a child that exited, on the next call", async () => {
    const degraded = [];
    const instance = upstream({ onDegraded: (reason) => degraded.push(reason) });

    const before = await callJson(instance, "echo_process");
    assert.deepEqual(await callJson(instance, "die"), { dying: true });
    // Let the exit land, so the next call is genuinely against a dead child.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const after = await callJson(instance, "echo_process");
    assert.notEqual(after.pid, before.pid);
    // A restart is not a degradation: the mount answered both calls. An OOM-
    // killed child that came back must not leave /healthz claiming a fault.
    assert.deepEqual(degraded.filter(Boolean), []);
  });

  it("reports a binary it cannot start, instead of failing silently", async () => {
    const degraded = [];
    const instance = upstream({
      binary: "/nonexistent/mcp-grafana",
      onDegraded: (reason) => degraded.push(reason),
    });

    await assert.rejects(() => instance.listTools());
    assert.equal(degraded.length, 1);
    assert.match(degraded[0], /could not be started/);

    // And it retries rather than caching the failure: a mount broken at boot
    // must not stay broken for the life of the container.
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
