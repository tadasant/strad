import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { HANDSHAKE_MAX_AGE_MS } from "../src/gateway/adapters/http.ts";
import { EVENTS_EXTENSION } from "../src/gateway/events.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * MCP Events for a mount SPLIT ACROSS TWO COMPONENTS — prod's `/slack`:
 * `slack` on the shared `bundle`, where events are not configured, and
 * `slack-zimmer` on `bundle-slack-zimmer`, where they are. Same path, two
 * containers, two answers to "do you serve events".
 *
 * What is pinned:
 *
 *   - events resolve by the selected SLUG's component, exactly as tools do —
 *     never by the mount path the two slugs share;
 *   - a component REPLACED behind its URL with events switched on is
 *     advertised once the cached handshake has aged out
 *     (`HANDSHAKE_MAX_AGE_MS`). The upstream is stateless, so the replacement
 *     breaks nothing core can see: tools kept working on the old handshake,
 *     and the events advertisement stayed off until core shook hands again.
 */

const ListEvents = z.object({
  method: z.literal("events/list"),
  params: z.object({}).passthrough().optional(),
});
const PollEvents = z.object({
  method: z.literal("events/poll"),
  params: z.object({ name: z.string() }).passthrough(),
});

/** One bundle component's `/slack` mount. `events()` is read per request, like a fresh container's env. */
function slackMount(component: string, events: () => boolean, polls: string[]) {
  return async (req: Request, res: Response) => {
    const on = events();
    const server = new McpServer(
      { name: `slack@${component}`, version: "0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "slack_get_channels",
          description: "channels",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));
    // The real mount registers the handlers always and the capability only
    // when its ingest is configured (servers/bundle-api/fork/slack).
    if (on) {
      server.registerCapabilities({ extensions: { [EVENTS_EXTENSION]: {} } });
    }
    server.setRequestHandler(ListEvents, async () => ({
      events: on
        ? [
            {
              name: "message_posted",
              description: "a message",
              delivery: ["poll", "webhook"],
              inputSchema: { type: "object", properties: {} },
              payloadSchema: { type: "object", properties: {} },
            },
          ]
        : [],
    }));
    server.setRequestHandler(PollEvents, async () => {
      polls.push(component);
      return {
        events: [],
        cursor: `v1.${component}`,
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

const CONFIG = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
  - name: bundle-slack-zimmer
servers:
  - slug: slack
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /slack
    entitlements: [admin]
  - slug: slack-zimmer
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-slack-zimmer
    path: /slack
    entitlements: [admin]
`;

const open: HttpServer[] = [];
const registries: Registry[] = [];
let token: string;
let polls: string[];
/** Whether `bundle-slack-zimmer`'s CURRENT container has events configured. */
let zimmerEvents: boolean;

async function listen(app: express.Express): Promise<number> {
  const server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  open.push(server);
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return addr.port;
}

/** A fresh gateway — its own registry, so its own connection cache. */
async function gateway(): Promise<string> {
  const bundle = express().use(express.json());
  bundle.post(
    "/slack",
    slackMount("bundle", () => false, polls),
  );
  const zimmer = express().use(express.json());
  zimmer.post(
    "/slack",
    slackMount("bundle-slack-zimmer", () => zimmerEvents, polls),
  );

  const admin = mintToken({ env: "test", label: "admin", roles: ["admin"] });
  token = admin.plaintext;
  const env: NodeJS.ProcessEnv = {
    STRAD_TOKENS: JSON.stringify([admin.record]),
    STRAD_BUNDLE_URL_BUNDLE: `http://127.0.0.1:${await listen(bundle)}`,
    STRAD_BUNDLE_URL_BUNDLE_SLACK_ZIMMER: `http://127.0.0.1:${await listen(zimmer)}`,
  };
  const config = parseConfig(CONFIG);
  const registry = await Registry.build({
    config,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env,
  });
  registries.push(registry);
  const app = createApp({
    config,
    registry,
    tokenStore: tokenStoreFromConfig(config, env),
    mode: "core",
    env,
  });
  return `http://127.0.0.1:${await listen(app as unknown as express.Express)}`;
}

async function client(base: string, servers: string): Promise<Client> {
  const c = new Client({ name: "zimmer-discovery", version: "1" });
  await c.connect(
    new StreamableHTTPClientTransport(
      new URL(`${base}/mcp?servers=${servers}`),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    ),
  );
  return c;
}

const Loose = ResultSchema.passthrough();

async function discover(base: string, servers: string) {
  const c = await client(base, servers);
  const advertised =
    c.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION] !== undefined;
  const listed = (
    (await c.request({ method: "events/list", params: {} }, Loose)).events as {
      name: string;
    }[]
  ).map((e) => e.name);
  await c.close();
  return { advertised, listed };
}

beforeAll(() => {
  polls = [];
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  for (const r of registries) await r.close();
  for (const s of open) s.close();
});

describe("a mount split across two components", () => {
  let base: string;
  beforeAll(async () => {
    zimmerEvents = true;
    base = await gateway();
  });

  it("advertises and lists events for the slug whose component serves them", async () => {
    expect(await discover(base, "slack-zimmer")).toEqual({
      advertised: true,
      listed: ["slack-zimmer__message_posted"],
    });
  });

  it("does not, for the sibling slug on the component that does not", async () => {
    expect(await discover(base, "slack")).toEqual({
      advertised: false,
      listed: [],
    });
  });

  it("lists only the serving slug's events when both are selected", async () => {
    expect(await discover(base, "slack,slack-zimmer")).toEqual({
      advertised: true,
      listed: ["slack-zimmer__message_posted"],
    });
  });

  it("routes a poll to the slug's own component", async () => {
    polls.length = 0;
    const c = await client(base, "slack-zimmer");
    const res = await c.request(
      {
        method: "events/poll",
        params: {
          name: "slack-zimmer__message_posted",
          arguments: {},
          cursor: null,
        },
      },
      Loose,
    );
    await c.close();
    expect(res.cursor).toBe("v1.bundle-slack-zimmer");
    expect(polls).toEqual(["bundle-slack-zimmer"]);
  });
});

describe("a component replaced behind its URL with events switched on", () => {
  it("is advertised once the cached handshake ages out, with no core restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T01:00:00Z"));

    // The container before the deploy: events not configured. Core shakes
    // hands with it, and caches the connection, on the first use of the slug.
    zimmerEvents = false;
    const base = await gateway();
    expect(await discover(base, "slack-zimmer")).toEqual({
      advertised: false,
      listed: [],
    });

    // The deploy replaces it with one that serves events. Nothing core holds
    // breaks: tools still answer on the connection it cached.
    zimmerEvents = true;
    const c = await client(base, "slack-zimmer");
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual([
      "slack-zimmer__slack_get_channels",
    ]);
    await c.close();

    // ...and the advertisement is still the old container's, until the
    // handshake has aged out. This is the state prod was in.
    vi.setSystemTime(
      new Date(Date.parse("2026-11-16T01:00:00Z") + HANDSHAKE_MAX_AGE_MS - 1),
    );
    expect(await discover(base, "slack-zimmer")).toEqual({
      advertised: false,
      listed: [],
    });

    // Past the handshake's age, the next use re-handshakes and sees events.
    vi.setSystemTime(
      new Date(Date.parse("2026-11-16T01:00:00Z") + HANDSHAKE_MAX_AGE_MS),
    );
    expect(await discover(base, "slack-zimmer")).toEqual({
      advertised: true,
      listed: ["slack-zimmer__message_posted"],
    });
  });
});
