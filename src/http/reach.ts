import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, RequestHandler, Response } from "express";
import { internalCaller } from "../auth/internal-token.ts";
import { activeGrants, reachPins, reachPolicies } from "../config/reach.ts";
import type { StradConfig } from "../config/schema.ts";
import { buildGatewayServer } from "../gateway/mcpServer.ts";
import type { Registry } from "../gateway/registry.ts";
import { event, reachPrincipalAttr } from "../telemetry/index.ts";
import { asyncRoute, jsonFailure } from "./async-route.ts";

/**
 * `/_strad/reach/{slug}/mcp` — FLOW-THROUGH: a hosted server's MCP session onto
 * the other slugs its checked-in `reaches:` grants name.
 *
 * The caller is a COMPONENT, proven by its own derived internal token
 * (`internalCaller`, src/auth/internal-token.ts), speaking for `{slug}` — which
 * must be an enabled supplementary-image server on that same component. What it
 * gets is `buildGatewayServer` over exactly the grant's targets, under:
 *
 *   - the grant's tool list intersected with each target's own `tools:` policy
 *     (`reachPolicies`), enforced on tools/call as everywhere else;
 *   - the grant's pinned arguments, checked on every call (`reachPins`);
 *   - no resources: a grant names tools.
 *
 * Tool names are namespaced `<target>__<tool>`, as on `/mcp`. The target's
 * credential never leaves the target's container, so the source holds no new
 * secret; the rules for what a grant may be are in src/config/reach.ts.
 *
 * CORE ONLY, and mounted beside the other `/_strad/` routes a bundle calls. The
 * public ingress routes every path to core, so "only reachable on the private
 * network" is not what protects it — the token is, as for `/_strad/params`.
 *
 * ONE ANSWER FOR EVERY "NO" after authentication: 403 `reach_not_granted`,
 * whether the slug is unknown, on another component, disabled, or grants
 * nothing. The caller holds a component token, so it is ours, but nothing it
 * can do with the difference is worth telling it.
 */
export interface ReachHandlerOptions {
  config: StradConfig;
  registry: Registry;
  env: NodeJS.ProcessEnv;
}

export const REACH_ROUTE = "/_strad/reach/:slug/mcp";

export function createReachHandler(opts: ReachHandlerOptions): RequestHandler {
  return asyncRoute(async (req: Request, res: Response) => {
    const caller = internalCaller(
      req.get("authorization"),
      opts.config,
      opts.env,
    );
    if (!caller.ok) {
      res.status(caller.status).json({ error: caller.error });
      return;
    }

    const slug = req.params.slug ?? "";
    const source = opts.config.servers.find(
      (s) =>
        s.slug === slug &&
        s.enabled &&
        s.kind === "supplementary-image" &&
        s.bundle === caller.component,
    );
    const grants = source ? activeGrants(opts.config, source.slug) : [];
    if (!source || grants.length === 0) {
      // No fields: `slug` is the caller's own bytes until it has matched.
      event({ evt: "mcp.reach_refused" });
      console.warn(
        `[strad] refused ${req.method} /_strad/reach for "${slug}" from ` +
          `component "${caller.component}": no enabled supplementary-image ` +
          `server by that name on that component holds an active reaches: grant`,
      );
      res.status(403).json({ error: "reach_not_granted" });
      return;
    }

    const selected = grants.map((g) => g.slug).sort();
    const server = buildGatewayServer({
      config: opts.config,
      registry: opts.registry,
      policies: reachPolicies(opts.config, grants),
      pins: reachPins(grants),
      resources: false,
      mode: "core",
      surface: "reach",
      selected,
      principalId: `reach:${source.slug}`,
      principalAttr: reachPrincipalAttr(source.slug),
      log: event,
      // A grant is named in full by the source's own config, so a broken
      // target is a failure the source should hear about, not a smaller list.
      explicit: { onUnlistable: () => {} },
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    // Same teardown as router.ts: every request, including aborted ones, and a
    // rejected close must not become an unhandled rejection.
    res.on("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }, jsonFailure("reach"));
}
