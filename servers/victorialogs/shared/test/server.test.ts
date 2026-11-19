import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
  createMCPServer,
  missingCredentials,
  upstreamEnv,
  VICTORIALOGS_ENV_NAMES,
} from "../src/index.js";

const FAKE = fileURLToPath(
  new URL("./fake-mcp-victorialogs.mjs", import.meta.url),
);

const CONFIGURED = {
  PATH: process.env.PATH,
  VL_INSTANCE_ENTRYPOINT: "https://logs.example.com",
  VL_INSTANCE_BEARER_TOKEN: "token",
};

type Handler = (request?: unknown) => Promise<any>;

/** A stand-in for the `Server` the bundle host builds per request. */
function recordingServer() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    setRequestHandler(
      schema: { shape: { method: { value: string } } },
      handler: Handler,
    ) {
      handlers.set(schema.shape.method.value, handler);
    },
  };
}

describe("what the mount needs before it can serve", () => {
  it("is made of an entrypoint alone; a token is optional", () => {
    assert.deepEqual([...VICTORIALOGS_ENV_NAMES], ["VL_INSTANCE_ENTRYPOINT"]);
    assert.deepEqual(missingCredentials(CONFIGURED), []);
    assert.deepEqual(
      missingCredentials({ VL_INSTANCE_ENTRYPOINT: "https://logs" }),
      [],
    );
    assert.deepEqual(missingCredentials({}), ["VL_INSTANCE_ENTRYPOINT"]);
  });

  it("drops an empty token rather than sending an empty bearer header", () => {
    const env = upstreamEnv({ ...CONFIGURED, VL_INSTANCE_BEARER_TOKEN: "" });
    assert.equal("VL_INSTANCE_BEARER_TOKEN" in env, false);
  });

  it("carries the optional headers and tenant, and nothing not on the list", () => {
    const env = upstreamEnv({
      ...CONFIGURED,
      VL_INSTANCE_HEADERS: "X-Scope=a",
      VL_DEFAULT_TENANT_ID: "1:2",
      MCP_LISTEN_ADDR: "0.0.0.0:8081",
      MCP_PASSTHROUGH_HEADERS: "Authorization",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4317",
    });
    assert.equal(env.VL_INSTANCE_HEADERS, "X-Scope=a");
    assert.equal(env.VL_DEFAULT_TENANT_ID, "1:2");
    assert.equal(env.MCP_LISTEN_ADDR, undefined);
    assert.equal(env.MCP_PASSTHROUGH_HEADERS, undefined);
    assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  });
});

describe("the handlers the host registers", () => {
  it("registers tools/list and tools/call, and nothing else", async () => {
    const created = createMCPServer({
      version: "test",
      env: CONFIGURED,
      binary: FAKE,
      log: () => {},
    });
    const server = recordingServer();
    await created.registerHandlers(server);
    assert.deepEqual([...server.handlers.keys()].sort(), [
      "tools/call",
      "tools/list",
    ]);

    const listed = await server.handlers.get("tools/list")!();
    assert.deepEqual(listed.tools.map((t: { name: string }) => t.name).sort(), [
      "die",
      "echo_call",
      "echo_process",
    ]);
    const called = await server.handlers.get("tools/call")!({
      params: { name: "echo_call", arguments: { note: "through the proxy" } },
    });
    assert.deepEqual(JSON.parse(called.content[0].text).arguments, {
      note: "through the proxy",
    });
    await created.close();
  });

  it("lists on a mount with no entrypoint, and refuses its calls by name", async () => {
    const created = createMCPServer({
      version: "test",
      env: { PATH: process.env.PATH },
      binary: FAKE,
      log: () => {},
    });
    assert.deepEqual(created.missing, ["VL_INSTANCE_ENTRYPOINT"]);

    const server = recordingServer();
    await created.registerHandlers(server);
    const listed = await server.handlers.get("tools/list")!();
    assert.equal(listed.tools.length, 3);

    const called = await server.handlers.get("tools/call")!({
      params: { name: "echo_call", arguments: {} },
    });
    assert.equal(called.isError, true);
    assert.match(called.content[0].text, /VL_INSTANCE_ENTRYPOINT is not set/);
    await created.close();
  });
});
