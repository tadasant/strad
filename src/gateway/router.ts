import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
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
  event,
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
import {
  compileToolPolicies,
  toolAllowed,
  unmatchedAllowEntries,
  type ToolPolicies,
} from "./toolPolicy.ts";

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
 *
 * 3. CAPABILITY IS ENFORCED ON THE ACTION. A server's `tools:` policy (see
 *    gateway/toolPolicy.ts) filters tools/list AND rejects a tools/call for a
 *    tool it withholds. Filtering the listing alone would be decoration: a client
 *    can call any name it likes, including one it saw last week on a different
 *    slug. `onepassword-ro` declining to LIST a write tool and then RUNNING it
 *    would be the worst of both worlds.
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
  // `event`, not a bare console.log: the auth and 424 lines are on the export
  // allowlist, so they reach the obs stack as well as stdout. Still injectable,
  // because a test wants the payload rather than the stream.
  const log = opts.log ?? event;

  // Compiled once: the policy is a property of the config, not of the request.
  const policies = compileToolPolicies(opts.config);

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
      const unavailable = selection.unavailable.map((u) => u.slug);

      // A requested slug that is NOT CONFIGURED is a string the caller invented
      // — `?servers=` is parsed, trimmed and deduped, and validated against
      // nothing. So it is split here, once, and the two halves are treated
      // differently everywhere below: a configured slug is our own vocabulary
      // and may be named; an unconfigured one is counted and never repeated
      // back. Echoing it would put caller-authored text in an exported log
      // record, and — worse, because it is silent — mint a new metric time
      // series per distinct string, from anyone holding a token.
      // `resolveSelection` already made this call — `not_configured` is set from
      // the same `cfg.servers` lookup — so read its verdict rather than
      // recomputing it. One rule in two places is one rule that drifts the day
      // a fifth status appears.
      const known = selection.unavailable
        .filter((u) => u.status !== "not_configured")
        .map((u) => u.slug);
      const unknown = unavailable.length - known.length;

      log({
        evt: "mcp.unavailable",
        principal: principal.id,
        // Full detail on stdout; the allowlist in telemetry/events.ts ships the
        // counts and the known slugs and drops the rest.
        requested,
        requested_count: requested.length,
        unavailable: known,
        unknown_count: unknown,
      });
      // The 424 fail-closed path. Worth its own counter rather than being folded
      // into "4xx": a 424 is not a client error in the usual sense, it is strad
      // telling a correctly-authenticated client that a server it asked for is
      // not available to it. A spike here means an entitlement or a config is
      // wrong, which is a completely different investigation from a spike in 401s.
      setOutcome("unavailable");
      for (const slug of known) {
        inst.unavailable.add(1, {
          "strad.mode": opts.mode,
          "mcp.server": slug,
        });
      }
      if (unknown > 0) {
        // One bounded series for every string that names nothing, rather than
        // one series per string.
        inst.unavailable.add(unknown, {
          "strad.mode": opts.mode,
          "mcp.server": "(not configured)",
        });
      }
      span.setAttribute("mcp.servers.unavailable", known);
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
      tools: await listToolsFor(
        selected,
        opts.registry,
        policies,
        log,
        // Did the CALLER name these servers, or is this "everything I'm
        // entitled to"? It decides whether a broken upstream is an error or a
        // smaller toolset. See listToolsFor.
        requested.length > 0
          ? {
              // A JSON-RPC error rides inside a 200, so the request-level
              // signal cannot come from the status code. Without this the
              // failure this whole change exists to make loud would be
              // invisible in the request metrics — visible only as the
              // upstream-error counter the adapter's hop() already bumps.
              onUnlistable: (slug: string) => {
                setOutcome("upstream_unlistable");
                span.setAttribute("mcp.list_tools.unlistable", slug);
                inst.unlistable.add(1, {
                  "strad.mode": opts.mode,
                  "mcp.server": slug,
                });
              },
            }
          : undefined,
      ),
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

      // CAPABILITY. The upstream container holds every tool the server has —
      // read-only is this check, and nothing else. It runs BEFORE the adapter,
      // so a withheld tool never reaches the upstream at all: no API call, no
      // side effect, no "we only sent the write to Gmail, we didn't mean it".
      if (!toolAllowed(policies.get(parsed.slug), parsed.tool)) {
        log({
          evt: "mcp.tool_denied",
          principal: principal.id,
          server: parsed.slug,
          tool: parsed.tool,
        });
        throw new McpError(
          ErrorCode.InvalidRequest,
          `tool "${parsed.tool}" is not permitted on server "${parsed.slug}": ` +
            `this server's capability policy withholds it.`,
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
 * Merge the selected servers' tools, namespaced, and filtered by capability.
 *
 * The upstream hands back everything it has — a single container now serves the
 * read-only and read-write slugs alike — so this is where the two diverge. It is
 * the cosmetic half of enforcement; the load-bearing half is on tools/call.
 *
 * ## A failing upstream is degraded when the caller took what it was given, and
 * ## an ERROR when the caller asked for it by name
 *
 * `resolveSelection` already draws this line for entitlement: a `?servers=slack`
 * the token cannot have is a 424, never a silently smaller toolset, because "a
 * client that asked for slack and got a toolset without Slack in it would look
 * like a broken Slack integration". Reachability deserves the same answer, and
 * for a while it did not get it: `?servers=secrets` against a bundle that 404'd
 * `/secrets` returned `200 {"tools":[]}`, which reads as "that server has no
 * tools" and is indistinguishable from a server that genuinely offers none. The
 * failure had to be discovered by polling.
 *
 * So: when the request NAMED its servers, an upstream that cannot be listed
 * fails the request. When it did not — the unfiltered "everything I'm entitled
 * to" listing, which is a fleet-wide question — one sick server still must not
 * take down the other twenty-six, so it contributes zero tools and a log line.
 * That asymmetry is the whole rule. `ToolSurfaceMonitor` is what makes the
 * degraded case visible without anyone having to ask (see reachability.ts).
 *
 * ANY named server failing fails the listing, not all of them, and that is the
 * uncomfortable half. `?servers=slack,secrets` loses Slack's tools because
 * `secrets` is down. It is deliberate and it is the same rule
 * `resolveSelection` applies to the same query string one step earlier — an
 * unavailable member there fails the request rather than narrowing it, and a
 * caller already has to handle that. The alternative, dropping just the broken
 * one, is precisely the behaviour that hid a dead `secrets` slug. In practice
 * the multi-slug case is rare: the console hands out one `?servers=<slug>` per
 * server (src/ui/landing.ts).
 *
 * NOTE the boundary. This fires when `listTools()` THROWS. A named server that
 * answers with an empty list is still an empty list — that is a server with no
 * tools, and it is `ToolSurfaceMonitor`'s job to notice, not this one's.
 */
async function listToolsFor(
  selected: string[],
  registry: Registry,
  policies: ToolPolicies,
  log: (event: Record<string, unknown>) => void,
  /** Present exactly when the caller named its servers. See above. */
  explicit?: { onUnlistable: (slug: string) => void },
): Promise<Tool[]> {
  const lists = await Promise.all(
    selected.map(async (slug) => {
      const adapter = registry.get(slug);
      if (!adapter) return [];
      try {
        const tools = await adapter.listTools();
        const policy = policies.get(slug);

        // An allow-list entry the upstream doesn't offer is a typo, and a typo
        // here silently narrows a toolset by one — say so rather than shrug.
        const unmatched = unmatchedAllowEntries(
          policy,
          tools.map((t) => t.name),
        );
        if (unmatched.length) {
          log({ evt: "mcp.policy_unmatched_tools", slug, tools: unmatched });
        }

        return tools
          .filter((t) => toolAllowed(policy, t.name))
          .map((t) => ({ ...t, name: namespaced(slug, t.name) }));
      } catch (err) {
        event({
          evt: "mcp.list_tools_failed",
          slug,
          explicit: Boolean(explicit),
          // Stays on stdout in full; the exporter substitutes `error.kind`.
          error: err instanceof Error ? err.message : String(err),
        });
        if (explicit) {
          explicit.onUnlistable(slug);
          // The upstream's own message is NOT relayed. It is arbitrary text from
          // someone else's server — the one that motivated this branch was a
          // full HTML error page — and it would land in a client's error
          // surface. The slug is ours and is the actionable half.
          throw new McpError(
            ErrorCode.InternalError,
            `server "${slug}" was requested by name but its upstream could not be listed, ` +
              `so it is serving no tools. This is a failure, not an empty toolset.`,
          );
        }
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
        event({
          evt: "mcp.list_resources_failed",
          slug,
          error: err instanceof Error ? err.message : String(err),
        });
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
 * fall back to the rest only if the hint misses. That keeps the common case to
 * one hop instead of a sweep across every selected server — a server that never
 * advertised `resources` is skipped without a round trip, but one that did and
 * simply does not hold this URI costs a real call. Scoping to the selected set
 * means `?servers=` applies to resources exactly as to tools: you cannot read a
 * resource from a server you did not select.
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
