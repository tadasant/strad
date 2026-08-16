import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { BuiltinServerAdapter } from "../src/gateway/adapters/builtin.ts";
import type {
  BuiltinContext,
  BuiltinModule,
} from "../src/gateway/adapters/types.ts";
import {
  clientCapabilitiesFromInitialize,
  clientSupportsUiApps,
  GATEWAY_UPSTREAM_CAPABILITIES,
  UI_APPS_EXTENSION,
} from "../src/gateway/clientCapabilities.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";

// =============================================================================
// The capability seam: pure functions
// =============================================================================

describe("clientCapabilities", () => {
  it("reads capabilities off a raw initialize body, verbatim", () => {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { extensions: { [UI_APPS_EXTENSION]: {} } },
        clientInfo: { name: "c", version: "1" },
      },
    };
    expect(clientCapabilitiesFromInitialize(body)).toEqual({
      extensions: { [UI_APPS_EXTENSION]: {} },
    });
  });

  it("returns undefined for a non-initialize / capability-less body", () => {
    expect(clientCapabilitiesFromInitialize(undefined)).toBeUndefined();
    expect(
      clientCapabilitiesFromInitialize({ method: "tools/list" }),
    ).toBeUndefined();
    expect(
      clientCapabilitiesFromInitialize({ method: "initialize", params: {} }),
    ).toBeUndefined();
  });

  it("clientSupportsUiApps keys strictly off capabilities.extensions", () => {
    expect(
      clientSupportsUiApps({ extensions: { [UI_APPS_EXTENSION]: {} } }),
    ).toBe(true);
    expect(clientSupportsUiApps(undefined)).toBe(false);
    expect(clientSupportsUiApps({})).toBe(false);
    expect(clientSupportsUiApps({ extensions: {} })).toBe(false);
    expect(clientSupportsUiApps({ extensions: { "other/ext": {} } })).toBe(
      false,
    );
    // `experimental` is not treated as an apps opt-in.
    expect(
      clientSupportsUiApps({ experimental: { [UI_APPS_EXTENSION]: {} } }),
    ).toBe(false);
  });

  it("the gateway advertises the UI extension to upstreams", () => {
    expect(clientSupportsUiApps(GATEWAY_UPSTREAM_CAPABILITIES)).toBe(true);
  });
});

// =============================================================================
// The capability seam threads into a builtin's context
// =============================================================================

describe("BuiltinServerAdapter forwards clientCapabilities into the call context", () => {
  it("passes the request's client capabilities to the module", async () => {
    let seen: BuiltinContext | undefined;
    const mod: BuiltinModule = {
      tools: [
        {
          name: "peek",
          description: "",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      async call(_name, _args, ctx) {
        seen = ctx;
        return { content: [] };
      },
    };
    const adapter = new BuiltinServerAdapter("srv", mod, async () => ({}), {
      mode: "core",
      bundle: "core",
      hostname: "test",
    });

    await adapter.callTool(
      "peek",
      {},
      {
        clientCapabilities: { extensions: { [UI_APPS_EXTENSION]: {} } },
      },
    );

    expect(seen?.clientCapabilities).toEqual({
      extensions: { [UI_APPS_EXTENSION]: {} },
    });
    // And it stays optional: a call with no context yields undefined, not a throw.
    await adapter.callTool("peek", {});
    expect(seen?.clientCapabilities).toBeUndefined();
  });
});

// =============================================================================
// End-to-end: an app-server's ui:// resource reaches a client THROUGH strad
// =============================================================================

/**
 * A minimal session-ful MCP "app upstream" that gates its MCP-App surface on the
 * capabilities IT receives. Because strad advertises the UI extension to its
 * upstreams, this server offers its app to strad — which is exactly what we
 * assert reaches the end client. `sawUiExtension` proves strad forwarded it.
 */
function startAppUpstream(): Promise<{
  url: string;
  close: () => Promise<void>;
  sawUiExtension: () => boolean;
}> {
  let sawUi = false;
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const PANEL = "ui://app-upstream/panel";
  const META = { ui: { resourceUri: PANEL }, "ui/resourceUri": PANEL };

  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req: Request, res: Response) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const existing = sid ? transports[sid] : undefined;
    if (existing) {
      await existing.handleRequest(req, res, req.body);
      return;
    }
    if (!sid && isInitializeRequest(req.body)) {
      const appUi = clientSupportsUiApps(
        clientCapabilitiesFromInitialize(req.body),
      );
      if (appUi) sawUi = true;

      const server = new McpServer(
        { name: "app-upstream", version: "0" },
        { capabilities: { tools: {}, ...(appUi ? { resources: {} } : {}) } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "panel_demo",
            description: "demo",
            inputSchema: { type: "object", properties: {} },
            ...(appUi ? { _meta: META } : {}),
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: "text", text: "ok" }],
      }));
      if (appUi) {
        server.setRequestHandler(ListResourcesRequestSchema, async () => ({
          resources: [
            {
              uri: PANEL,
              name: "panel",
              mimeType: "text/html;profile=mcp-app",
            },
          ],
        }));
        server.setRequestHandler(ReadResourceRequestSchema, async (r) => ({
          contents: [
            {
              uri: r.params.uri,
              mimeType: "text/html;profile=mcp-app",
              text: "<h1>panel</h1>",
            },
          ],
        }));
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "no session" },
      id: null,
    });
  });

  const handleSession = async (req: Request, res: Response): Promise<void> => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const transport = sid ? transports[sid] : undefined;
    if (!transport) {
      res.status(400).send("bad session");
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", handleSession);
  app.delete("/mcp", handleSession);

  return new Promise((resolve) => {
    const s = app.listen(0, () => {
      const addr = s.address();
      if (typeof addr === "string" || !addr) throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        close: () => new Promise<void>((r) => s.close(() => r())),
        sawUiExtension: () => sawUi,
      });
    });
  });
}

describe("gateway relays an MCP App's ui:// resource end-to-end", () => {
  let upstream: Awaited<ReturnType<typeof startAppUpstream>>;
  let stradServer: HttpServer;
  let registry: Registry;
  let baseUrl: string;

  beforeAll(async () => {
    upstream = await startAppUpstream();

    const config = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: app-upstream
    kind: remote-http
    url: "${upstream.url}"
    entitlements: [admin]
`);
    const token = mintToken({ env: "test", label: "admin", roles: ["admin"] });
    const env: NodeJS.ProcessEnv = {
      STRAD_TOKENS: JSON.stringify([token.record]),
    };
    registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env,
    });
    const app = createApp({
      config,
      registry,
      tokenStore: tokenStoreFromConfig(config, env),
      mode: "core",
      env,
    });
    await new Promise<void>((resolve) => {
      stradServer = app.listen(0, () => resolve());
    });
    const addr = stradServer.address();
    if (typeof addr === "string" || !addr) throw new Error("no port");
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Stash the token for the test's client.
    (globalThis as { __token?: string }).__token = token.plaintext;
  });

  afterAll(async () => {
    stradServer?.close();
    // Release the gateway's cached upstream connection first, or the upstream's
    // HTTP server won't finish closing (it waits on that keep-alive socket).
    await registry?.close();
    await upstream?.close();
  });

  async function connectApps(): Promise<Client> {
    const client = new Client(
      { name: "apps-client", version: "1" },
      { capabilities: { extensions: { [UI_APPS_EXTENSION]: {} } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: {
          headers: {
            authorization: `Bearer ${(globalThis as { __token?: string }).__token}`,
          },
        },
      }),
    );
    return client;
  }

  it("advertises resources and lists the upstream's ui:// resource", async () => {
    const client = await connectApps();
    expect(client.getServerCapabilities()?.resources).toBeDefined();

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("ui://app-upstream/panel");
    await client.close();
  });

  it("reads the ui:// resource back through the gateway", async () => {
    const client = await connectApps();
    const read = await client.readResource({ uri: "ui://app-upstream/panel" });
    expect((read.contents[0] as { text?: string } | undefined)?.text).toBe(
      "<h1>panel</h1>",
    );
    await client.close();
  });

  it("relays the tool's _meta binding, and the gateway forwarded the UI extension", async () => {
    const client = await connectApps();
    const { tools } = await client.listTools();
    const demo = tools.find((t) => t.name === "app-upstream__panel_demo");
    expect(demo?._meta).toMatchObject({
      ui: { resourceUri: "ui://app-upstream/panel" },
      "ui/resourceUri": "ui://app-upstream/panel",
    });
    await client.close();

    // The upstream only offered the app because strad advertised the UI
    // extension to it — the whole point of GATEWAY_UPSTREAM_CAPABILITIES.
    expect(upstream.sawUiExtension()).toBe(true);
  });
});
