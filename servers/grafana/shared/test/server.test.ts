import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
  createMCPServer,
  GRAFANA_ENV_NAMES,
  missingCredentials,
  upstreamEnv,
} from "../src/index.js";

const FAKE = fileURLToPath(new URL("./fake-mcp-grafana.mjs", import.meta.url));

const CONFIGURED = {
  PATH: process.env.PATH,
  GRAFANA_URL: "https://grafana.prod.registry.modelcontextprotocol.io",
  GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa-test-token",
};

/** A stand-in for the `Server` the bundle host builds per request. */
function recordingServer() {
  const handlers = new Map();
  return {
    handlers,
    setRequestHandler(schema, handler) {
      // The SDK keys handlers off the literal method in the request schema.
      handlers.set(schema.shape.method.value, handler);
    },
  };
}

describe("what the mount needs before it can serve", () => {
  it("names the variables an instance is made of", () => {
    assert.deepEqual(
      [...GRAFANA_ENV_NAMES],
      ["GRAFANA_URL", "GRAFANA_SERVICE_ACCOUNT_TOKEN"],
    );
  });

  it("reports each missing variable by name", () => {
    assert.deepEqual(missingCredentials(CONFIGURED), []);
    assert.deepEqual(missingCredentials({}), [
      "GRAFANA_URL",
      "GRAFANA_SERVICE_ACCOUNT_TOKEN",
    ]);
    assert.deepEqual(missingCredentials({ GRAFANA_URL: "https://g" }), [
      "GRAFANA_SERVICE_ACCOUNT_TOKEN",
    ]);
  });

  it("drops an empty credential rather than sending an empty bearer token", () => {
    // A `${NAME}` that resolved to nothing is absent, not blank: passed through,
    // mcp-grafana would send `Authorization: Bearer ` and Grafana would answer
    // 401 — a rejected credential, which reads like the wrong token rather than
    // like no token.
    const env = upstreamEnv({ ...CONFIGURED, GRAFANA_SERVICE_ACCOUNT_TOKEN: "" });
    assert.equal("GRAFANA_SERVICE_ACCOUNT_TOKEN" in env, false);
  });

  it("carries the optional org id, and nothing not on the list", () => {
    const env = upstreamEnv({
      ...CONFIGURED,
      GRAFANA_ORG_ID: "2",
      GRAFANA_PASSWORD: "basic-auth-is-not-plumbed",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4317",
    });

    assert.equal(env.GRAFANA_ORG_ID, "2");
    assert.equal(env.GRAFANA_PASSWORD, undefined);
    // mcp-grafana would export its own traces and logs — records strad did not
    // author, arriving outside the allowlist in src/telemetry/events.ts.
    assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  });

  it("does not hand the child the write opt-in", () => {
    // It decides the flags the child is started with; mcp-grafana itself has
    // no use for it, and the allowlist stays an allowlist.
    const env = upstreamEnv({ ...CONFIGURED, GRAFANA_ALLOW_WRITE: "true" });
    assert.equal(env.GRAFANA_ALLOW_WRITE, undefined);
  });
});

describe("the handlers the host registers", () => {
  it("registers tools/list and tools/call, and nothing else", async () => {
    const created = createMCPServer({
      version: "test",
      env: CONFIGURED,
      slug: "grafana-registry",
      binary: FAKE,
      log: () => {},
    });
    const server = recordingServer();
    await created.registerHandlers(server);

    // mcp-grafana declares tools and nothing else. A resources or prompts
    // handler here would be a surface this proxy invented.
    assert.deepEqual([...server.handlers.keys()].sort(), [
      "tools/call",
      "tools/list",
    ]);

    const listed = await server.handlers.get("tools/list")();
    assert.deepEqual(
      listed.tools.map((t) => t.name).sort(),
      ["die", "echo_call", "echo_process"],
    );

    const called = await server.handlers.get("tools/call")({
      params: { name: "echo_call", arguments: { note: "through the proxy" } },
    });
    assert.deepEqual(JSON.parse(called.content[0].text).arguments, {
      note: "through the proxy",
    });

    await created.close();
  });

  it("reports a mount nobody has given a credential, without refusing to build", async () => {
    // The bundle host mounts this DEGRADED rather than not at all: the console
    // and an agent's tools/list must still show what the slug would offer once a
    // token lands, and one server's missing config must not cost the other
    // twenty their boot.
    const created = createMCPServer({
      version: "test",
      env: { PATH: process.env.PATH },
      binary: FAKE,
      log: () => {},
    });

    assert.deepEqual(created.missing, [
      "GRAFANA_URL",
      "GRAFANA_SERVICE_ACCOUNT_TOKEN",
    ]);

    // And it still serves its tool list, which is what makes the degraded mount
    // worth having.
    const server = recordingServer();
    await created.registerHandlers(server);
    const listed = await server.handlers.get("tools/list")();
    assert.equal(listed.tools.length, 3);

    await created.close();
  });
});
