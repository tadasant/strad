import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
  type Resource,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Request, Response } from "express";
import { clientCapabilitiesFromInitialize } from "./clientCapabilities.ts";
import {
  authenticateMcp,
  secretEquals,
  Unauthenticated,
  type Principal,
} from "../auth/index.ts";
import type { TokenStore } from "../auth/tokens.ts";
import type { StradConfig } from "../config/schema.ts";
import {
  argShape,
  errorKind,
  instruments,
  resultShape,
  tracer,
} from "../telemetry/index.ts";
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
    // --- telemetry: one SERVER span per /mcp request ------------------------
    // Everything below runs inside this span's context, so the tool-call and
    // upstream-hop spans nest under it and a slow request can be read as a
    // waterfall rather than a pile of unrelated timings.
    //
    // Attributes are slugs, counts and statuses. Never the token, never the
    // body, never a header. See src/telemetry/redact.ts.
    const inst = instruments();
    const startedAt = process.hrtime.bigint();
    const modeAttrs = { "strad.mode": opts.mode };
    const span = tracer().startSpan("mcp.request", {
      kind: SpanKind.SERVER,
      attributes: {
        ...modeAttrs,
        "http.request.method": req.method,
        "http.route": "/mcp",
      },
    });

    inst.inFlight.add(1, modeAttrs);

    // `close` always fires — on a clean finish and on an aborted connection
    // alike — which is what makes it the right place to close the books. Doing
    // this on `finish` would leak the in-flight gauge upward on every client
    // that hangs up mid-stream, and a permanently-climbing concurrency number is
    // worse than none.
    let outcome = "ok";
    res.on("close", () => {
      inst.inFlight.add(-1, modeAttrs);
      const status = res.statusCode;
      const attrs = {
        ...modeAttrs,
        outcome,
        "http.response.status_code": status,
      };
      inst.requests.add(1, attrs);
      inst.requestDuration.record(elapsedSeconds(startedAt), attrs);
      span.setAttribute("http.response.status_code", status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    });

    await context.with(trace.setSpan(context.active(), span), () =>
      serve(req, res, span, (o) => (outcome = o)),
    );
  };

  async function serve(
    req: Request,
    res: Response,
    span: import("@opentelemetry/api").Span,
    setOutcome: (outcome: string) => void,
  ): Promise<void> {
    const inst = instruments();
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
        // `err.reason` is one of a fixed set of enum-ish strings we author
        // ("no_internal_token", "internal_token_mismatch", ...) — never the
        // presented token, and never anything derived from it.
        setOutcome("unauthenticated");
        inst.authFailures.add(1, {
          "strad.mode": opts.mode,
          "auth.failure_reason": err.reason,
        });
        span.setAttribute("auth.failure_reason", err.reason);
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

    span.setAttribute("mcp.principal.kind", principal.kind);

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
      // The 424 fail-closed path. Worth its own counter rather than being folded
      // into "4xx": a 424 is not a client error in the usual sense, it is strad
      // telling a correctly-authenticated client that a server it asked for is
      // not available to it. A spike here means an entitlement or a config is
      // wrong, which is a completely different investigation from a spike in 401s.
      setOutcome("unavailable");
      const unavailable = selection.unavailable.map((u) => u.slug);
      for (const slug of unavailable) {
        inst.unavailable.add(1, {
          "strad.mode": opts.mode,
          "mcp.server": slug,
        });
      }
      span.setAttribute("mcp.servers.unavailable", unavailable);
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

    // Requested vs selected, both as slug arrays. This pair is the whole story of
    // what `?servers=` did: asking for three and getting one is invisible in a
    // status code and obvious here.
    span.setAttributes({
      "mcp.servers.requested": requested,
      "mcp.servers.selected": selected,
      "mcp.servers.selected_count": selected.length,
    });

    // The client's advertised capabilities, read off the raw initialize body so
    // opt-in `extensions` survive. Threaded into the call context below so an
    // in-process server can vary behaviour by them. Present on the initialize
    // request only — this endpoint is session-less, so a later tools/call POST
    // carries none (see clientCapabilities.ts).
    const clientCapabilities = clientCapabilitiesFromInitialize(req.body);

    // --- build a one-shot MCP server for exactly this request ---------------
    // `resources` is advertised unconditionally: the gateway now proxies
    // resources (which is how an MCP App's `ui://` template reaches the client),
    // and the endpoint is session-less — a follow-up resources/list POST carries
    // no capabilities to re-derive a conditional advertisement from, and the SDK
    // refuses to register a resources handler for a server that didn't declare
    // the capability. A selected server that serves no resources simply returns
    // an empty list, so this stays a no-op for tools-only setups.
    const server = new Server(
      { name: opts.config.gateway.name, version: "0.1.0" },
      { capabilities: { tools: {}, resources: {} } },
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

      const args = (request.params.arguments ?? {}) as Record<string, unknown>;

      // The tool-call span.
      //
      // NOTE WHAT IS AND IS NOT HERE. The server slug and the tool name are
      // identifiers from our own config and the tool's own schema, so they are
      // recorded. The ARGUMENTS are not — only their count and byte size — and
      // neither is the RESULT. `args` for a 1Password tool call is a vault item
      // reference; the result is its contents. Both are one `setAttribute` away
      // from being sitting in an ingestor forever. See src/telemetry/redact.ts,
      // and test/telemetry.redaction.test.ts, which fails if this changes.
      const toolAttrs = {
        "mcp.server": parsed.slug,
        "mcp.tool": parsed.tool,
        "strad.mode": opts.mode,
      };
      const callSpan = tracer().startSpan("mcp.tools.call", {
        attributes: { ...toolAttrs, ...argShape(args) },
      });
      const toolStartedAt = process.hrtime.bigint();

      try {
        const result = await context.with(
          trace.setSpan(context.active(), callSpan),
          () => adapter.callTool(parsed.tool, args, { clientCapabilities }),
        );

        const shape = resultShape(result);
        callSpan.setAttributes(shape);

        // A tool that ran and returned isError:true is not the same event as a
        // hop that blew up, and conflating them would hide the resource story
        // under a pile of ordinary "no results found" responses.
        const toolOutcome = shape["mcp.tool.is_error"] ? "tool_error" : "ok";
        inst.toolCalls.add(1, { ...toolAttrs, outcome: toolOutcome });
        inst.toolCallDuration.record(elapsedSeconds(toolStartedAt), {
          ...toolAttrs,
          outcome: toolOutcome,
        });
        return result as never;
      } catch (err) {
        const kind = errorKind(err);
        callSpan.setAttribute("error.kind", kind);
        // setStatus, NOT recordException: recordException writes the exception
        // MESSAGE and STACK as span-event attributes, and an upstream MCP
        // server's error message is arbitrary text we did not author. See
        // redact.ts.
        callSpan.setStatus({ code: SpanStatusCode.ERROR });
        inst.toolCalls.add(1, {
          ...toolAttrs,
          outcome: "error",
          "error.kind": kind,
        });
        inst.toolCallDuration.record(elapsedSeconds(toolStartedAt), {
          ...toolAttrs,
          outcome: "error",
        });
        throw err;
      } finally {
        callSpan.end();
      }
    });

    // --- resource proxying (for MCP Apps) -----------------------------------
    // A selected server's `ui://` template must reach the client, so the gateway
    // relays resources the same way it relays tools: union on list, route on
    // read, scoped to the servers selected for THIS request. A server that
    // serves no resources (every builtin today) simply contributes none.
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: await listResourcesFor(selected, opts.registry),
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return readResourceFor(selected, opts.registry, request.params.uri);
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
  }
}

/** Seconds elapsed since an `hrtime.bigint()` mark. */
function elapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
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
 * Merge the selected servers' resources.
 *
 * Resource URIs are already app-namespaced by convention (`ui://<server>/…`), so
 * unlike tools they are relayed verbatim — the URI a client sees is the one it
 * reads back. As with tools/list, one failing upstream contributes zero
 * resources and a log line rather than a 500.
 */
async function listResourcesFor(
  selected: string[],
  registry: Registry,
): Promise<Resource[]> {
  const lists = await Promise.all(
    selected.map(async (slug) => {
      const adapter = registry.get(slug);
      if (!adapter?.listResources) return [];
      try {
        return await adapter.listResources();
      } catch (err) {
        console.error(
          JSON.stringify({
            evt: "mcp.list_resources_failed",
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
 * Read a resource by URI from whichever selected server owns it.
 *
 * Routing prefers the owner encoded in the URI: a `ui://<slug>/…` app template
 * names its server as the authority, so we try that selected server first and
 * fall back to the rest only if the hint misses. This matters because an
 * upstream adapter drops its cached connection on a failed read — trying the
 * wrong server first would needlessly churn healthy connections. Scoping to the
 * selected set means `?servers=` applies to resources exactly as to tools: you
 * cannot read a resource from a server you did not select.
 */
async function readResourceFor(
  selected: string[],
  registry: Registry,
  uri: string,
): Promise<ReadResourceResult> {
  const hint = slugFromResourceUri(uri);
  const order =
    hint && selected.includes(hint)
      ? [hint, ...selected.filter((s) => s !== hint)]
      : selected;

  for (const slug of order) {
    const adapter = registry.get(slug);
    if (!adapter?.readResource) continue;
    try {
      return await adapter.readResource(uri);
    } catch {
      // Not this server's resource (or it failed) — try the next selected one.
    }
  }
  throw new Error(`resource "${uri}" is not offered by any selected server`);
}

/** `ui://good-eggs/search-results` -> `good-eggs` (the URI authority), else null. */
function slugFromResourceUri(uri: string): string | null {
  const match = /^ui:\/\/([^/]+)\//.exec(uri);
  return match ? (match[1] ?? null) : null;
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
