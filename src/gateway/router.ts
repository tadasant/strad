import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import {
  authenticateMcp,
  secretEquals,
  Unauthenticated,
  type Principal,
} from "../auth/index.ts";
import type { TokenStore } from "../auth/tokens.ts";
import type { StradConfig } from "../config/schema.ts";
import { denamespace, namespaced } from "./adapters/types.ts";
import {
  entitledServers,
  parseServersParam,
  resolveSelection,
} from "./entitlements.ts";
import type { Mode, Registry } from "./registry.ts";

/**
 * The /mcp endpoint.
 *
 * Two properties matter here, and everything else follows from them.
 *
 * 1. STATELESS. `sessionIdGenerator: undefined`. A fresh Server + transport per
 *    request, torn down when the response closes. The toolset is derived from
 *    (token, URL) EVERY time — never from session state.
 *
 *    This is not just tidiness. MCP's 2026-07-28 revision removes sessions and
 *    forbids a server from varying its toolset per connection; it explicitly
 *    DOES allow varying by per-request input. Deriving the toolset from the
 *    request is what keeps `?servers=` conformant rather than a protocol
 *    violation wearing a query string.
 *
 * 2. FAIL CLOSED. Asking for a server you cannot have is 424, never 401.
 *    A 401 would tell the client "re-authenticate to strad", and it would dutifully
 *    walk into an OAuth loop against the gateway — which is not the thing that's
 *    missing. 424 Failed Dependency says: you are fine, a thing you depend on is
 *    not ready, and here is where to go fix it.
 */

export interface McpHandlerOptions {
  config: StradConfig;
  registry: Registry;
  tokenStore: TokenStore;
  mode: Mode;
  env?: NodeJS.ProcessEnv;
  log?: (event: Record<string, unknown>) => void;
}

export function createMcpHandler(opts: McpHandlerOptions) {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((e) => console.log(JSON.stringify(e)));

  return async function handleMcp(req: Request, res: Response): Promise<void> {
    let principal: Principal;

    try {
      principal =
        opts.mode === "bundle"
          ? authenticateInternal(req.headers.authorization, env)
          : await authenticateMcp(
              req.headers.authorization,
              opts.tokenStore,
              opts.config.gateway.env,
            );
    } catch (err) {
      if (err instanceof Unauthenticated) {
        log({
          evt: "mcp.auth_failed",
          reason: err.reason,
          ip: req.ip,
        });
        // WWW-Authenticate points a spec-compliant client at where to get a
        // token, without leaking whether the one it sent was close.
        res
          .status(401)
          .set(
            "WWW-Authenticate",
            'Bearer realm="strad", error="invalid_token"',
          )
          .json({ error: "invalid_token" });
        return;
      }
      throw err;
    }

    // --- selection: the query string proposes, the token disposes -----------
    const requested = parseServersParam(req.query.servers);

    const entitled =
      opts.mode === "bundle"
        ? new Set(opts.registry.slugs)
        : entitledServers(principal, opts.config);

    const selection = resolveSelection(
      requested,
      entitled,
      opts.config,
      opts.config.gateway.publicUrl,
    );

    if (!selection.ok) {
      log({
        evt: "mcp.unavailable",
        principal: principal.id,
        requested,
        unavailable: selection.unavailable.map((u) => u.slug),
      });
      res.status(424).json({
        error: "downstream_not_authenticated",
        message:
          "One or more requested MCP servers are not configured or not authorized for this principal.",
        servers: selection.unavailable,
      });
      return;
    }

    const selected = selection.selected;

    log({
      evt: "mcp.request",
      principal: principal.id,
      kind: principal.kind,
      requested: requested.length ? requested : "*",
      selected,
    });

    // --- build a one-shot MCP server for exactly this request ---------------
    const server = new Server(
      { name: opts.config.gateway.name, version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await listToolsFor(selected, opts.registry),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const parsed = denamespace(request.params.name);
      if (!parsed) {
        throw new Error(
          `tool "${request.params.name}" is not namespaced as <server>__<tool>`,
        );
      }

      // Re-check selection at call time. ListTools already filtered, but a
      // client can call any name it likes — including one it saw on a previous
      // request with a different ?servers=. Authorization belongs on the action.
      if (!selected.includes(parsed.slug)) {
        throw new Error(
          `server "${parsed.slug}" is not selected for this request`,
        );
      }

      const adapter = opts.registry.get(parsed.slug);
      if (!adapter) throw new Error(`server "${parsed.slug}" is not mounted`);

      const result = await adapter.callTool(
        parsed.tool,
        (request.params.arguments ?? {}) as Record<string, unknown>,
      );
      return result as never;
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

/**
 * Merge the selected servers' tools, namespaced.
 *
 * One slow upstream must not take down the whole tools/list, so a failing
 * server contributes zero tools and a log line rather than a 500. The client
 * sees a smaller toolset; it does not see a broken gateway.
 */
async function listToolsFor(
  selected: string[],
  registry: Registry,
): Promise<Tool[]> {
  const lists = await Promise.all(
    selected.map(async (slug) => {
      const adapter = registry.get(slug);
      if (!adapter) return [];
      try {
        const tools = await adapter.listTools();
        return tools.map((t) => ({ ...t, name: namespaced(slug, t.name) }));
      } catch (err) {
        console.error(
          JSON.stringify({
            evt: "mcp.list_tools_failed",
            slug,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return [];
      }
    }),
  );
  return lists.flat();
}

/**
 * Bundle components sit on the private network with no public route, but that
 * is a reachability property, not an authorization one. Require the shared
 * internal token anyway.
 */
function authenticateInternal(
  header: string | undefined,
  env: NodeJS.ProcessEnv,
): Principal {
  const expected = env.STRAD_INTERNAL_TOKEN;
  if (!expected) {
    throw new Unauthenticated(
      "internal token not configured",
      "no_internal_token",
    );
  }

  const presented = header?.replace(/^Bearer\s+/i, "").trim();
  if (!presented || !secretEquals(presented, expected)) {
    throw new Unauthenticated(
      "invalid internal token",
      "internal_token_mismatch",
    );
  }

  return {
    kind: "system-token",
    id: "core",
    label: "strad core",
    roles: [],
  };
}
