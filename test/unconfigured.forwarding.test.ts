import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import type { ServerAdapter } from "../src/gateway/adapters/types.ts";
import { EVENTS_EXTENSION } from "../src/gateway/events.ts";
import { buildGatewayServer } from "../src/gateway/mcpServer.ts";
import { Registry } from "../src/gateway/registry.ts";
import { compileToolPolicies } from "../src/gateway/toolPolicy.ts";
import {
  awaitingConsent,
  ServerUnconfiguredError,
} from "../src/gateway/unconfigured.ts";
import { createApp } from "../src/http/app.ts";
import {
  createFakeGcp,
  RESOLVER_PERMISSIONS,
} from "../src/secrets/parameters/fake.ts";
import { serverParameterPath } from "../src/secrets/parameters/namespace.ts";
import { buildSecretProviders } from "../src/secrets/provider/index.ts";

/**
 * `awaitingConsent` REBUILDS the adapter of every `oauth:` slug under a store
 * provider, and an optional method it does not copy is a capability that slug
 * loses with no error anywhere.
 *
 * That is how a gmail connector slug whose mount advertised MCP Events reached
 * clients with no events at all: core asks `supportsEvents` to decide the
 * `initialize` extension and `events/list`, the wrapper had dropped it, and the
 * answer was an empty, successful `{ events: [] }`. A Slack slug on the same
 * gateway had no `oauth:` block, was never wrapped, and worked.
 *
 * Two claims:
 *
 *   1. Every optional `ServerAdapter` method survives the wrapper. Listed here
 *      by name, so a method added to `ServerAdapter` without being
 *      added here fails the type check on `FULL` below.
 *   2. End to end, an `oauth:` slug whose mount serves events is advertised,
 *      lists its event, and has a poll routed to it.
 */

/**
 * Every method on `ServerAdapter`. `Required<>` makes a new optional one a type
 * error until it is named here. `host` is data, not a method, and is left out.
 */
const FULL: Omit<Required<ServerAdapter>, "host"> = {
  slug: "s",
  kind: "supplementary-image",
  listTools: async () => [],
  callTool: async () => ({ content: [] }),
  listResources: async () => [],
  readResource: async () => ({ contents: [] }),
  postRaw: async () => {},
  getRaw: async () => {},
  supportsEvents: async () => true,
  listEvents: async () => [],
  pollEvents: async () => ({
    events: [],
    cursor: "c",
    hasMore: false,
    truncated: false,
  }),
  subscribeEvents: async () => ({}),
  unsubscribeEvents: async () => {},
  close: async () => {},
};

const methods = (a: object) =>
  Object.entries(a)
    .filter(([, v]) => typeof v === "function")
    .map(([k]) => k)
    .sort();

describe("awaitingConsent", () => {
  it("carries every method the adapter it wraps has", () => {
    const wrapped = awaitingConsent(FULL, "REFRESH", async () => true);
    expect(methods(wrapped)).toEqual(methods(FULL));
  });

  it("adds none the adapter lacks", () => {
    const bare: ServerAdapter = {
      slug: "s",
      kind: "supplementary-image",
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const wrapped = awaitingConsent(bare, "REFRESH", async () => true);
    expect(methods(wrapped)).toEqual(methods(bare));
  });

  it("answers supportsEvents from the adapter, without asking the store", async () => {
    let asked = 0;
    const wrapped = awaitingConsent(FULL, "REFRESH", async () => {
      asked += 1;
      return false;
    });
    expect(await wrapped.supportsEvents!()).toBe(true);
    expect(asked).toBe(0);
  });

  const GUARDED = {
    listEvents: (a: ServerAdapter) => a.listEvents!(),
    pollEvents: (a: ServerAdapter) =>
      a.pollEvents!({ name: "e", arguments: {}, cursor: null }),
    subscribeEvents: (a: ServerAdapter) =>
      a.subscribeEvents!({
        name: "e",
        arguments: {},
        delivery: {},
        _meta: {},
      }),
    unsubscribeEvents: (a: ServerAdapter) =>
      a.unsubscribeEvents!({
        name: "e",
        arguments: {},
        delivery: { url: "https://example.com/hook" },
        _meta: {},
      }),
  } as const;

  for (const [method, call] of Object.entries(GUARDED)) {
    it(`translates a failed ${method} on a slug nobody connected, as it does a tool call`, async () => {
      const failing: ServerAdapter = {
        ...FULL,
        [method]: async () => {
          throw new Error("upstream 401");
        },
      };
      const unconnected = awaitingConsent(
        failing,
        "REFRESH",
        async () => false,
      );
      await expect(call(unconnected)).rejects.toBeInstanceOf(
        ServerUnconfiguredError,
      );
      const connected = awaitingConsent(failing, "REFRESH", async () => true);
      await expect(call(connected)).rejects.toThrow("upstream 401");
    });
  }
});

// --- end to end ----------------------------------------------------------------

const ENV = "test";
const SLUG = "gmail-example-ro";
const REFRESH = "GMAIL_OAUTH_REFRESH_TOKEN";

const CONFIG = `
version: 1
gateway:
  name: strad
  env: ${ENV}
  secrets: { provider: gcp-parameter-store }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
servers:
  - slug: ${SLUG}
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /${SLUG}
    entitlements: [admin]
    oauth:
      provider: google
      account: someone@example.com
      scopes: [https://www.googleapis.com/auth/gmail.readonly]
      clientIdVariable: GMAIL_OAUTH_CLIENT_ID
      clientSecretVariable: GMAIL_OAUTH_CLIENT_SECRET
      refreshTokenVariable: ${REFRESH}
`;

const ListEvents = z.object({
  method: z.literal("events/list"),
  params: z.object({}).passthrough().optional(),
});
const PollEvents = z.object({
  method: z.literal("events/poll"),
  params: z.object({ name: z.string() }).passthrough(),
});

/** A gmail mount as the bundle host serves one with its ingest configured. */
function gmailMount(polls: string[], failing = false) {
  return async (req: Request, res: Response) => {
    const server = new McpServer(
      { name: "gmail-workspace-mcp-server", version: "0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "list_email_conversations",
          description: "list",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));
    server.registerCapabilities({ extensions: { [EVENTS_EXTENSION]: {} } });
    server.setRequestHandler(ListEvents, async () => {
      // A mount whose credential never arrived: the handshake still advertises.
      if (failing) throw new Error("no refresh token");
      return {
        events: [
          {
            name: "message_received",
            description: "a message arrived",
            delivery: ["poll", "webhook"],
            inputSchema: { type: "object", properties: {} },
            payloadSchema: { type: "object", properties: {} },
          },
        ],
      };
    });
    server.setRequestHandler(PollEvents, async (r) => {
      if (failing) throw new Error("no refresh token");
      polls.push(r.params.name);
      return {
        events: [],
        cursor: "v1.gmail",
        truncated: false,
        hasMore: false,
      } as never;
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function listen(app: express.Express): Promise<number> {
  const server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return addr.port;
}

/** A core registry over the store, with the slug connected (its refresh token held) or not. */
async function registryFor(
  polls: string[],
  opts: { connected: boolean; failing?: boolean },
) {
  const bundle = express().use(express.json());
  bundle.post(`/${SLUG}`, gmailMount(polls, opts.failing));

  const admin = mintToken({ env: ENV, label: "admin", roles: ["admin"] });
  const env: NodeJS.ProcessEnv = {
    STRAD_TOKENS: JSON.stringify([admin.record]),
    STRAD_BUNDLE_URL_BUNDLE: `http://127.0.0.1:${await listen(bundle)}`,
  };
  const config = parseConfig(CONFIG);
  const fake = createFakeGcp();
  if (opts.connected) {
    await fake.another().create({
      path: serverParameterPath(ENV, SLUG, "oauth", REFRESH),
      secret: true,
      value: "refresh-token",
    });
  }
  const resolver = fake.storeAs(RESOLVER_PERMISSIONS);
  const registry = await Registry.build({
    config,
    secrets: buildSecretProviders({ config, env, resolver }),
    mode: "core",
    env,
    resolver,
  });
  cleanup.push(() => registry.close());
  return { registry, config, env, admin };
}

async function gateway(polls: string[]) {
  const { registry, config, env, admin } = await registryFor(polls, {
    connected: true,
  });
  const app = createApp({
    config,
    registry,
    tokenStore: tokenStoreFromConfig(config, env),
    mode: "core",
    env,
  });
  const base = `http://127.0.0.1:${await listen(app as unknown as express.Express)}`;
  return { base, token: admin.plaintext };
}

const Loose = ResultSchema.passthrough();

describe("an oauth: slug whose mount serves events", () => {
  it("is advertised on initialize, lists its event, and has a poll routed to it", async () => {
    const polls: string[] = [];
    const { base, token } = await gateway(polls);
    const c = new Client({ name: "zimmer-discovery", version: "1" });
    await c.connect(
      new StreamableHTTPClientTransport(
        new URL(`${base}/mcp?servers=${SLUG}`),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } },
      ),
    );
    cleanup.push(() => c.close());

    expect(
      c.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION],
    ).toBeDefined();
    const listed = (
      (await c.request({ method: "events/list", params: {} }, Loose))
        .events as { name: string }[]
    ).map((e) => e.name);
    expect(listed).toEqual([`${SLUG}__message_received`]);

    const res = await c.request(
      {
        method: "events/poll",
        params: {
          name: `${SLUG}__message_received`,
          arguments: {},
          cursor: null,
        },
      },
      Loose,
    );
    expect(res.cursor).toBe("v1.gmail");
    expect(polls).toEqual(["message_received"]);
  });
});

describe("an oauth: slug nobody has connected, whose mount advertises events", () => {
  it("is skipped by events/list with no fault record, and a poll says it is not connected", async () => {
    const { registry, config } = await registryFor([], {
      connected: false,
      failing: true,
    });
    const logged: Record<string, unknown>[] = [];
    const server = buildGatewayServer({
      config,
      registry,
      policies: compileToolPolicies(config),
      mode: "core",
      selected: [SLUG],
      principalId: "test",
      principalAttr: "test",
      log: (e) => logged.push(e),
      events: { advertise: true },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), c.connect(a)]);
    cleanup.push(async () => {
      await c.close();
      await server.close();
    });

    const listed = await c.request(
      { method: "events/list", params: {} },
      Loose,
    );
    expect(listed.events).toEqual([]);
    expect(logged.map((e) => e.evt)).not.toContain("mcp.events_list_failed");

    await expect(
      c.request(
        {
          method: "events/poll",
          params: {
            name: `${SLUG}__message_received`,
            arguments: {},
            cursor: null,
          },
        },
        Loose,
      ),
    ).rejects.toThrow(new RegExp(REFRESH));
  });
});
