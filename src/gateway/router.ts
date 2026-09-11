import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Request, Response } from "express";
import { clientCapabilitiesFromInitialize } from "./clientCapabilities.ts";
import { bearerToken, secretEquals } from "../auth/credential.ts";
import {
  metadataBaseUrl,
  resourceIdentifier,
  resourceMetadataUrl,
  wwwAuthenticate,
} from "../auth/protected-resource.ts";
import { verifyAccessToken, type McpOAuth } from "../auth/mcp-oauth/index.ts";
import {
  authenticateMcp,
  Unauthenticated,
  type Principal,
} from "../auth/index.ts";
import type { TokenStore } from "../auth/tokens.ts";
import type { StradConfig } from "../config/schema.ts";
import {
  elapsedSeconds,
  event,
  instruments,
  tracer,
} from "../telemetry/index.ts";
import {
  entitledServers,
  parseServersParam,
  resolveSelection,
} from "./entitlements.ts";
import { buildGatewayServer } from "./mcpServer.ts";
import type { Mode, Registry } from "./registry.ts";
import { compileToolPolicies } from "./toolPolicy.ts";

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
 *
 * This file owns 1 and 2 — the door. It owns 3 by DELEGATION:
 * `buildGatewayServer` (gateway/mcpServer.ts) is the protocol half, and the
 * console playground drives the same builder over an in-memory transport, so a
 * human clicking a tool in the console is answered by this code rather than by a
 * second implementation of it.
 */

export interface McpHandlerOptions {
  config: StradConfig;
  registry: Registry;
  tokenStore: TokenStore;
  mode: Mode;
  env?: NodeJS.ProcessEnv;
  log?: (event: Record<string, unknown>) => void;
  /**
   * strad's own authorization server, when this deployment runs one.
   *
   * Null — the default — is a deployment whose `/mcp` takes static tokens and
   * nothing else, which is every deployment that has not configured
   * `auth.mcpOAuth`. It is the SAME object `src/http/oauth.ts` serves the flow
   * from, so a token this endpoint accepts is one those routes issued, under
   * the same key and the same hosted domain.
   */
  oauth?: McpOAuth | null;
}

export function createMcpHandler(opts: McpHandlerOptions) {
  const env = opts.env ?? process.env;
  // `event`, not a bare console.log: the auth and 424 lines are on the export
  // allowlist, so they reach the obs stack as well as stdout. Still injectable,
  // because a test wants the payload rather than the stream.
  const log = opts.log ?? event;

  // Compiled once: the policy is a property of the config, not of the request.
  const policies = compileToolPolicies(opts.config);

  /**
   * The `resource_metadata` URL for this request's `401`, or null.
   *
   * Per request rather than per handler because the origin can be the one the
   * request arrived on — see `metadataBaseUrl` in
   * `src/auth/protected-resource.ts` for why that is the fallback and not the
   * primary. Null in bundle mode, and null whenever that function has no origin
   * to give: no `gateway.publicUrl` and no `Host`, or one of them that is not a
   * bare http(s) origin. There is no document at a URL we will not name.
   */
  function metadataUrl(req: Request): string | null {
    if (opts.mode !== "core") return null;
    const base = metadataBaseUrl(req, opts.config.gateway.publicUrl);
    return base === null ? null : resourceMetadataUrl(base);
  }

  /**
   * The OAuth half of the door, bound to THIS request's resource identifier.
   *
   * The binding is the whole point. RFC 8707 says a token names the resource it
   * is for, and the resource here is `https://host/mcp` — the origin plus the
   * literal path, built by `resourceIdentifier`, which is also what the
   * protected-resource document publishes and what `/oauth/authorize` mints
   * against. It is NOT `req.originalUrl`: the URL a human pastes into a client
   * carries `?servers=granola`, and `?servers=` is a selection hint rather than
   * a resource (see `entitlements.ts`), so a token minted for the endpoint has
   * to work at every query string that endpoint answers on.
   *
   * Undefined in bundle mode and on a deployment with no authorization server,
   * which is what makes `strad_oat_…` a plain refusal there rather than a
   * verification against keys nobody holds.
   */
  function oauthVerifier(
    req: Request,
  ): ((raw: string) => ReturnType<typeof verifyAccessToken>) | undefined {
    const oauth = opts.oauth;
    if (!oauth || opts.mode !== "core") return undefined;
    const base = metadataBaseUrl(req, opts.config.gateway.publicUrl);
    const resource = base === null ? null : resourceIdentifier(base);
    return (raw: string) => verifyAccessToken(raw, oauth, resource);
  }

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

    try {
      await context.with(trace.setSpan(context.active(), span), () =>
        serve(req, res, span, (o) => (outcome = o)),
      );
    } catch (err) {
      // The ANSWER to a failure here is the route guard's — this handler is
      // mounted through `asyncRoute` (src/http/async-route.ts), which renders
      // the 500. What has to happen before the rethrow is the BOOKKEEPING,
      // because the books are closed by the `close` listener above and by then
      // this frame is gone.
      //
      // Without the outcome, a request that failed inside strad is counted as
      // `ok` in strad.mcp.requests and the only trace of it is whatever the
      // renderer wrote to stderr. The span status is set here rather than left
      // to the `close` listener's `status >= 500` rule because a failure part
      // way through a streamed response has already sent a 200.
      //
      // Both are no-ops on a request the CLIENT abandoned: `close` fired first
      // and the books are shut. That case is already legible — an aborted
      // request is an aborted request — and the one this covers is the failure
      // strad itself produced while the caller was still listening.
      outcome = "internal_error";
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    }
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
              oauthVerifier(req),
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
        //
        // `resource_metadata` (RFC 9728 §5.1) is the half that makes that
        // pointer followable rather than aspirational: it names the URL of the
        // protected-resource document, which says what `/mcp` accepts. The
        // document itself is `src/auth/protected-resource.ts`, and the URL is
        // the route string it is mounted on appended to the origin, so the
        // pointer and the route cannot spell the path differently.
        //
        // CORE ONLY. A bundle's `/mcp` is reached over strad's private network
        // with the shared `STRAD_INTERNAL_TOKEN` and serves no well-known path,
        // so a pointer from there would be a `404` waiting to happen. Its `401`
        // is the two parameters it always carried.
        res
          .status(401)
          .set("WWW-Authenticate", wwwAuthenticate(metadataUrl(req)))
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
    // The protocol half — list, call, resources, and capability enforced on the
    // action — is `buildGatewayServer`, shared with the console playground so
    // that a human and an agent are answered by the same code. Everything above
    // this line (auth, `?servers=`, the 424) is this endpoint's alone.
    const server = buildGatewayServer({
      config: opts.config,
      registry: opts.registry,
      policies,
      mode: opts.mode,
      surface: "mcp",
      selected,
      principalId: principal.id,
      log,
      clientCapabilities,
      // Did the CALLER name these servers, or is this "everything I'm entitled
      // to"? It decides whether a broken upstream is an error or a smaller
      // toolset. See listToolsFor.
      explicit:
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
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    // `.catch(() => {})` on both, and not for tidiness: this fires on EVERY
    // request including every aborted one, a close can reject on a socket that
    // is already gone, and an unhandled rejection takes this process down (see
    // src/telemetry/errors.ts). There is nothing to do about a teardown that
    // fails — the response is over — which is why the handler is empty rather
    // than logging. Same shape as `servers/bundle/host/src/index.ts` and
    // `src/gateway/adapters/http.ts`.
    res.on("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
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

  const presented = bearerToken(header);
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
