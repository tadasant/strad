import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import express, { type Request, type Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { EVENTS_EXTENSION } from "../src/gateway/events.ts";
import { buildGatewayServer } from "../src/gateway/mcpServer.ts";
import { Registry } from "../src/gateway/registry.ts";
import { compileToolPolicies } from "../src/gateway/toolPolicy.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import {
  disableEventExport,
  enableEventExport,
  event,
  resetEventThrottle,
} from "../src/telemetry/index.ts";

/**
 * `mcp.events_list_failed` names the KIND of failure and how the listing
 * retry ended, the way the tools and resources `_failed` records do (#475) —
 * through the real wiring: a real upstream that advertises MCP Events and
 * answers `events/list` with a JSON-RPC error, the HTTP adapter, and the
 * gateway server core builds, logging through `event()` to the exporter.
 */

/** An upstream advertising events whose `events/list` throws `code`. */
function startUpstream(code: number): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = new McpServer(
      { name: "feed", version: "0" },
      { capabilities: { tools: {}, extensions: { [EVENTS_EXTENSION]: {} } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [],
    }));
    server.fallbackRequestHandler = async (request) => {
      if (request.method === "events/list") {
        throw Object.assign(new Error("upstream says no"), { code });
      }
      throw Object.assign(new Error("not found"), { code: -32601 });
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return new Promise((resolve) => {
    const s: HttpServer = app.listen(0, () => {
      const addr = s.address();
      if (typeof addr === "string" || !addr) throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        close: () =>
          new Promise<void>((r) => {
            s.closeAllConnections();
            s.close(() => r());
          }),
      });
    });
  });
}

const CONFIG = (url: string) =>
  parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: feed
    kind: remote-http
    url: "${url}"
    entitlements: [admin]
`);

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

describe("mcp.events_list_failed", () => {
  it("exports the retry outcome and the status / code / class discriminator, and no upstream text", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    logs.disable();
    logs.setGlobalLoggerProvider(provider);
    enableEventExport("strad-test", "0.0.0");
    resetEventThrottle();
    const quiet = [
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "log").mockImplementation(() => {}),
    ];

    const up = await startUpstream(-32602);
    const config = CONFIG(up.url);
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: {},
    });
    cleanup.push(async () => {
      disableEventExport();
      await provider.shutdown().catch(() => {});
      logs.disable();
      for (const s of quiet) s.mockRestore();
      await registry.close();
      await up.close();
    });

    const server = buildGatewayServer({
      config,
      registry,
      policies: compileToolPolicies(config),
      mode: "core",
      selected: ["feed"],
      principalId: "test",
      log: event,
      events: { advertise: true },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const res = await client.request(
        { method: "events/list", params: {} },
        ResultSchema.passthrough(),
      );
      expect((res as { events?: unknown }).events).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }

    const failed = exporter
      .getFinishedLogRecords()
      .filter((r) => r.body === "mcp.events_list_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.attributes).toMatchObject({
      slug: "feed",
      attempts: 1,
      retry: "not_transient",
      rpc_code: -32602,
      error_class: "McpError",
    });
    expect(failed[0]!.attributes).not.toHaveProperty("status");
    expect(JSON.stringify(exporter.getFinishedLogRecords())).not.toMatch(
      /upstream says no/,
    );
  });
});
