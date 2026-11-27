import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";

import {
  GrafanaUpstream,
  READ_ONLY_ARGS,
  READ_WRITE_ARGS,
  upstreamArgs,
} from "../src/index.js";

const FAKE = fileURLToPath(new URL("./fake-mcp-grafana.mjs", import.meta.url));

/** The container's environment, as the bundle really holds it. */
const CONTAINER_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GRAFANA_URL: "https://grafana.example.com",
  GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa-test-token",
  // The other twenty mounts' credentials, which share this process's
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

afterAll(async () => {
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

  it("is started without -disable-write, and still with -disable-proxied, when the view opts in", async () => {
    const logged = [];
    const instance = upstream({
      env: { ...CONTAINER_ENV, GRAFANA_ALLOW_WRITE: "true" },
      log: (line) => logged.push(line),
    });
    const { flags, env } = await callJson(instance, "echo_process");

    assert.deepEqual(flags, [...READ_WRITE_ARGS]);
    assert.ok(!flags.includes("-disable-write"));
    // Opting into Grafana's own writes is not opting into tools a datasource
    // advertises: those stay off on every mount.
    assert.ok(flags.includes("-disable-proxied"));
    assert.equal(instance.writeEnabled, true);
    // A switch on how strad starts the binary, not something the binary reads.
    assert.equal(env.GRAFANA_ALLOW_WRITE, undefined);
    // The boot line says so, rather than leaving it to a reading of the flags.
    assert.ok(logged.some((line) => /mcp-grafana up, WRITE-ENABLED/.test(line)));
  });

  it("logs a read-only mount as read-only", async () => {
    const logged = [];
    const instance = upstream({ log: (line) => logged.push(line) });
    await instance.listTools();

    assert.equal(instance.writeEnabled, false);
    assert.ok(logged.some((line) => /mcp-grafana up, read-only \(.*-disable-write/.test(line)));
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

describe("upstreamArgs", () => {
  it("is read-only by default", () => {
    assert.deepEqual(upstreamArgs(CONTAINER_ENV), [...READ_ONLY_ARGS]);
    assert.deepEqual(upstreamArgs({}), [...READ_ONLY_ARGS]);
  });

  it("drops -disable-write and nothing else for exactly `true`", () => {
    const args = upstreamArgs({ GRAFANA_ALLOW_WRITE: "true" });
    assert.deepEqual(
      args,
      READ_ONLY_ARGS.filter((flag) => flag !== "-disable-write"),
    );
  });

  it("keeps -disable-proxied in every mode", () => {
    for (const value of [undefined, "", "true", "false", "1"]) {
      assert.ok(upstreamArgs({ GRAFANA_ALLOW_WRITE: value }).includes("-disable-proxied"));
    }
  });

  it("stays read-only for anything that is not exactly `true`", () => {
    // A looser parse is a read-only mount one typo away from writing.
    for (const value of ["", "false", "1", "yes", "TRUE", "True", " true", "true "]) {
      assert.deepEqual(upstreamArgs({ GRAFANA_ALLOW_WRITE: value }), [...READ_ONLY_ARGS]);
    }
  });

  it("does not read a slug-prefixed name itself — resolving that is the host's job", () => {
    // The host lays a slug's own `<SLUG>__GRAFANA_ALLOW_WRITE` onto the bare
    // name in the view it hands this tree. A prefixed name that reached the view
    // unresolved — a sibling's, say — must not count.
    assert.deepEqual(
      upstreamArgs({ GRAFANA_OTHER_RW__GRAFANA_ALLOW_WRITE: "true" }),
      [...READ_ONLY_ARGS],
    );
  });
});
