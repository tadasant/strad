#!/usr/bin/env node
/**
 * bundle-api — the strad `supplementary-image` face of SIX pure-API MCP
 * servers, colocated in ONE internal HTTP component.
 *
 * Every server here is a plain HTTP/API wrapper (no browser, no subprocess), so
 * they cost almost nothing to run and share a single Node process happily. Each
 * one reuses the SAME `shared/` tool logic as its published stdio `local/`
 * server (vendored verbatim under ../upstream/<slug>) — nothing about any tool
 * is reimplemented here. The only thing this file adds is the transport: an
 * Express front door that speaks StreamableHTTPServerTransport, which strad's
 * core gateway proxies to over the private network at
 * ${bundle-api.PRIVATE_URL}/<slug>.
 *
 * Each upstream `createMCPServer()` returns `{ server, registerHandlers }`. We
 * call the factory ONCE at startup (a couple of them memoize a client or hold a
 * session store) and reuse its `registerHandlers` per request. The stateless
 * streamable-HTTP pattern — a fresh low-level `Server` + transport per request,
 * `sessionIdGenerator: undefined` — is exactly the good-eggs bundle pattern.
 *
 * Credentials: every server reads its own credential env vars LAZILY, when a
 * tool is actually invoked. This process holds none of them; strad injects them
 * onto the bundle-api component at deploy time (see the config `env:` map).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

import { createMCPServer as createSlack } from "slack-workspace-mcp-server-shared";
import { createMCPServer as createSerpapiHotels } from "serpapi-hotels-mcp-server-shared";
import { createMCPServer as createTailscale } from "tailscale-vpn-mcp-server-shared";
import {
  createMCPServer as createMonarch,
  createFileSessionStore,
  resolveSession,
} from "monarch-money-mcp-server-shared";
import { createMCPServer as createGcs } from "gcs-mcp-server-shared";
import { createMCPServer as createGoogleFlights } from "google-flights-mcp-server-shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
) as { version: string };
const VERSION = packageJson.version;

const PORT = parseInt(process.env.PORT || "8080", 10);

function ts(): string {
  // No Date import gymnastics — a plain ISO stamp for a container log line.
  return new Date().toISOString();
}
function log(msg: string): void {
  console.error(`[${ts()}] [bundle-api] ${msg}`);
}
function logError(scope: string, err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[${ts()}] [bundle-api] [${scope}] ERROR ${message}`);
}
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function jsonRpcError(err: unknown): unknown {
  return {
    jsonrpc: "2.0",
    error: { code: -32603, message: errMessage(err) },
    id: null,
  };
}

/**
 * `registerHandlers(server)` — the upstream factory's handler-registration
 * function. It accepts an optional client-factory second arg (we always want
 * the default, which reads credentials from the environment), so a one-arg
 * signature is all this host needs.
 */
type RegisterHandlers = (server: Server) => Promise<void>;

interface RegisteredServer {
  /** Path segment AND strad config slug: proxied at /<slug>. */
  slug: string;
  /** MCP server name reported in `initialize` (cosmetic; the gateway renames). */
  serverName: string;
  /** Must match what the upstream registerHandlers actually registers. */
  capabilities: ServerCapabilities;
  registerHandlers: RegisterHandlers;
  /**
   * The upstream env var this server reads (SYNCHRONOUSLY, at registerHandlers
   * time) to decide its capability tool-group set — e.g. read-only vs write.
   * Left undefined for servers with no such toggle. See CAPABILITY_TOGGLES.md.
   */
  toggleEnvVar?: string;
}

/** `serpapi-hotels` -> `SERPAPI_HOTELS`, matching strad's env convention. */
function slugEnv(slug: string): string {
  return slug.toUpperCase().replace(/-/g, "_");
}

/** Set (or delete, when value is undefined) an env var without stringifying. */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Register a server's handlers onto a fresh `Server`, honoring its capability
 * toggle.
 *
 * The wrinkle this solves: several upstreams read the SAME bare env var (e.g.
 * `ENABLED_TOOLGROUPS`), and in one process a single global value can't
 * configure them independently. So each toggled server ALSO accepts a
 * slug-namespaced override `<SLUG>_<VAR>` (e.g. `SLACK_ENABLED_TOOLGROUPS`);
 * when present we apply it onto the bare upstream name for the duration of THIS
 * registration only.
 *
 * This is race-safe: every upstream reads its toggle synchronously inside the
 * `registerHandlers(server)` call, before the returned promise yields. We set
 * the override, call registerHandlers (whose synchronous body consumes it), and
 * restore the previous value in `finally` — all before we `await`. So a
 * concurrent request for another server can never observe our temporary value.
 */
async function registerWithToggle(
  s: RegisteredServer,
  server: Server,
): Promise<void> {
  const varName = s.toggleEnvVar;
  const override = varName
    ? process.env[`${slugEnv(s.slug)}_${varName}`]
    : undefined;

  // No override: the bare upstream var (if the operator set it) applies as-is.
  if (!varName || override === undefined) {
    await s.registerHandlers(server);
    return;
  }

  const prev = process.env[varName];
  setEnv(varName, override);
  let pending: Promise<void>;
  try {
    // Synchronous body runs here and consumes the env before any await.
    pending = s.registerHandlers(server);
  } finally {
    setEnv(varName, prev); // restore before yielding to the event loop
  }
  await pending;
}

function makeHandler(s: RegisteredServer) {
  return async (req: Request, res: Response): Promise<void> => {
    const server = new Server(
      { name: s.serverName, version: VERSION },
      { capabilities: s.capabilities },
    );

    try {
      await registerWithToggle(s, server);
    } catch (err) {
      logError(s.slug, err);
      if (!res.headersSent) res.status(500).json(jsonRpcError(err));
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logError(s.slug, err);
      if (!res.headersSent) res.status(500).json(jsonRpcError(err));
    }
  };
}

/**
 * Build the six servers. Factories are called ONCE here: tailscale memoizes
 * its OAuth client at module scope, and monarch needs a single session store
 * threaded through, so per-request factory calls would be wrong for them.
 */
async function buildServers(): Promise<RegisteredServer[]> {
  const servers: RegisteredServer[] = [];

  servers.push({
    slug: "slack",
    serverName: "slack-workspace-mcp-server",
    capabilities: { tools: {} },
    registerHandlers: createSlack({ version: VERSION }).registerHandlers,
    toggleEnvVar: "ENABLED_TOOLGROUPS",
  });

  servers.push({
    slug: "serpapi-hotels",
    serverName: "serpapi-hotels-mcp-server",
    capabilities: { resources: {}, tools: {} },
    // apiKey is an optional eager override; undefined falls back to the lazy
    // per-call SERPAPI_API_KEY read, which is what we want for a credential-free
    // image whose secret is injected onto the component at deploy time.
    registerHandlers: createSerpapiHotels({
      version: VERSION,
      apiKey: process.env.SERPAPI_API_KEY,
    }).registerHandlers,
  });

  servers.push({
    slug: "tailscale",
    serverName: "tailscale-vpn-mcp-server",
    capabilities: { tools: {} },
    registerHandlers: createTailscale({ version: VERSION }).registerHandlers,
    toggleEnvVar: "TOOL_GROUPS",
  });

  // monarch-money: warm the session store in the BACKGROUND. It reads MONARCH_*
  // credentials from the environment and may perform a real network login; we
  // deliberately do NOT await it, so a slow login never delays this component
  // coming healthy or the other six servers' readiness. The store is the source
  // of truth and monarch's client reloads it per call, so at worst the FIRST
  // monarch tool call races the warm — and the in-protocol auth tools recover
  // either way. Failure is non-fatal: log and carry on.
  const monarchSessionStore = createFileSessionStore();
  void resolveSession({ sessionStore: monarchSessionStore }).catch((err) => {
    log(
      `monarch-money: background session resolution failed (auth tools remain available): ${errMessage(err)}`,
    );
  });
  servers.push({
    slug: "monarch-money",
    serverName: "mcp-server-monarch-money",
    capabilities: { tools: {} },
    registerHandlers: createMonarch({
      version: VERSION,
      sessionStore: monarchSessionStore,
    }).registerHandlers,
    toggleEnvVar: "MONARCH_ENABLED_TOOL_GROUPS",
  });

  servers.push({
    slug: "gcs",
    serverName: "gcs-mcp-server",
    capabilities: { resources: {}, tools: {} },
    registerHandlers: createGcs({ version: VERSION }).registerHandlers,
    toggleEnvVar: "GCS_ENABLED_TOOLGROUPS",
  });

  servers.push({
    slug: "google-flights",
    serverName: "google-flights-mcp-server",
    capabilities: { resources: {}, tools: {} },
    registerHandlers: createGoogleFlights({ version: VERSION }).registerHandlers,
  });

  return servers;
}

async function main(): Promise<void> {
  const servers = await buildServers();
  const bySlug = new Map(servers.map((s) => [s.slug, s]));

  const app = express();
  app.use(express.json({ limit: "20mb" }));

  // Liveness for App Platform. Reports which servers are mounted.
  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      ok: true,
      component: "bundle-api",
      version: VERSION,
      servers: [...bySlug.keys()],
    });
  });

  for (const s of servers) {
    app.all(`/${s.slug}`, makeHandler(s));
  }

  const shutdown = (signal: string) => {
    log(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // One stray rejection from one server must not kill the other six. Log it.
  process.on("unhandledRejection", (reason) => {
    logError("unhandledRejection", reason);
  });

  app.listen(PORT, "0.0.0.0", () => {
    log(
      `streamable-HTTP on :${PORT} — mounted ${servers
        .map((s) => `/${s.slug}`)
        .join(", ")}`,
    );
  });
}

main().catch((error) => {
  logError("main", error);
  process.exit(1);
});
