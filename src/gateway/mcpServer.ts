import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import type { StradConfig } from "../config/schema.ts";
import {
  argShape,
  errorKind,
  event,
  instruments,
  resultShape,
  tracer,
} from "../telemetry/index.ts";
import { LocalHostUnavailableError } from "./adapters/http.ts";
import {
  denamespace,
  namespaced,
  type CallToolResult,
  type ServerAdapter,
} from "./adapters/types.ts";
import {
  recoveredResult,
  troubleshootResult,
  troubleshootTool,
  undiagnosedResult,
  TROUBLESHOOT_TOOL,
} from "./troubleshoot.ts";
import type { ClientCapabilities } from "./clientCapabilities.ts";
import type { Mode, Registry } from "./registry.ts";
import {
  toolAllowed,
  unmatchedAllowEntries,
  type ToolPolicies,
} from "./toolPolicy.ts";

/**
 * The MCP `Server` strad builds for ONE already-authorized selection.
 *
 * It is deliberately not the `/mcp` handler: authentication, `?servers=`
 * resolution and the 424 live in router.ts, and by the time anything here runs
 * the question "may this caller reach these slugs" has been answered. What is
 * left is the protocol half — list, call, and the capability policy enforced on
 * the action — and that half has two consumers:
 *
 *   1. `/mcp`, per request, over Streamable HTTP (router.ts).
 *   2. The console playground, per request, over an in-memory transport
 *      (src/ui/playground.ts).
 *
 * ONE implementation, because the alternative is two. A playground that reached
 * into the registry directly would be a second listing path with its own idea of
 * what a tool policy means, and the first time `tools:` grew a rule the human
 * console would show a human something they cannot actually call. Capability is
 * enforced here, on the action, so both doors get the same answer by
 * construction rather than by discipline.
 */

/** Which door a session came through. Telemetry only; it grants nothing. */
export type Surface = "mcp" | "playground";

export interface GatewayServerOptions {
  config: StradConfig;
  registry: Registry;
  /** Compiled once from the config; a property of the config, not the request. */
  policies: ToolPolicies;
  mode: Mode;
  /**
   * The door this session came through, recorded on the tool-call span and its
   * metrics. A human poking at a tool in the console and an agent calling it in
   * anger are different events, and a latency graph that cannot tell them apart
   * is a latency graph with a human's thinking time in it. Defaults to "mcp".
   */
  surface?: Surface;
  /** The slugs this session may reach. Already resolved and authorized. */
  selected: string[];
  /** Principal id, for log lines. Never a credential. */
  principalId: string;
  log: (event: Record<string, unknown>) => void;
  clientCapabilities?: ClientCapabilities;
  /**
   * Present exactly when the caller NAMED its servers, in which case an
   * unlistable upstream fails the listing rather than shrinking it. See
   * listToolsFor.
   */
  explicit?: { onUnlistable: (slug: string) => void };
}

/**
 * Build a one-shot MCP server over `selected`.
 *
 * `resources` is advertised unconditionally: the gateway proxies resources
 * (which is how an MCP App's `ui://` template reaches the client), the endpoint
 * is session-less — a follow-up resources/list POST carries no capabilities to
 * re-derive a conditional advertisement from — and the SDK refuses to register a
 * resources handler for a server that didn't declare the capability. A selected
 * server that serves no resources simply returns an empty list.
 */
export function buildGatewayServer(opts: GatewayServerOptions): Server {
  const {
    config,
    registry,
    policies,
    mode,
    selected,
    principalId,
    log,
    clientCapabilities,
    explicit,
  } = opts;
  const surface: Surface = opts.surface ?? "mcp";

  const server = new Server(
    { name: config.gateway.name, version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await listToolsFor(selected, registry, policies, log, explicit),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const inst = instruments();
    const parsed = denamespace(request.params.name);
    if (!parsed) {
      throw new Error(
        `tool "${request.params.name}" is not namespaced as <server>__<tool>`,
      );
    }

    // Re-check selection at call time. ListTools already filtered, but a client
    // can call any name it likes — including one it saw on a previous request
    // with a different ?servers=. Authorization belongs on the action.
    if (!selected.includes(parsed.slug)) {
      throw new Error(
        `server "${parsed.slug}" is not selected for this request`,
      );
    }

    const adapter = registry.get(parsed.slug);
    if (!adapter) throw new Error(`server "${parsed.slug}" is not mounted`);

    // strad's OWN tool on a local-tunnel slug, offered while that slug's machine
    // is not answering (see gateway/troubleshoot.ts). It is answered here rather
    // than forwarded, because there is nothing to forward it to.
    //
    // It sits ahead of the capability check on purpose, and for the same reason
    // the listing does not filter it: `tools:` describes which of the UPSTREAM's
    // tools this slug may serve, and this is not one of them. A slug with an
    // `allow:` list would otherwise offer a tool in its listing and refuse it on
    // call, which is the worst of both. It is safe to exempt because it takes no
    // arguments, reaches nothing but this slug's own upstream, and returns text
    // strad and the operator wrote.
    const isTroubleshoot =
      parsed.tool === TROUBLESHOOT_TOOL && adapter.host !== undefined;

    // CAPABILITY. The upstream container holds every tool the server has —
    // read-only is this check, and nothing else. It runs BEFORE the adapter, so
    // a withheld tool never reaches the upstream at all: no API call, no side
    // effect, no "we only sent the write to Gmail, we didn't mean it".
    if (
      !isTroubleshoot &&
      !toolAllowed(policies.get(parsed.slug), parsed.tool)
    ) {
      log({
        evt: "mcp.tool_denied",
        principal: principalId,
        server: parsed.slug,
        tool: parsed.tool,
      });
      throw new McpError(
        ErrorCode.InvalidRequest,
        `tool "${parsed.tool}" is not permitted on server "${parsed.slug}": ` +
          `this server's capability policy withholds it.`,
      );
    }

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
      "strad.mode": mode,
      "strad.surface": surface,
    };
    const callSpan = tracer().startSpan("mcp.tools.call", {
      attributes: { ...toolAttrs, ...argShape(args) },
    });
    const toolStartedAt = process.hrtime.bigint();

    try {
      const result = await context.with(
        trace.setSpan(context.active(), callSpan),
        () =>
          isTroubleshoot
            ? troubleshoot(adapter)
            : adapter.callTool(parsed.tool, args, { clientCapabilities }),
      );

      const shape = resultShape(result);
      callSpan.setAttributes(shape);

      // A tool that ran and returned isError:true is not the same event as a hop
      // that blew up, and conflating them would hide the resource story under a
      // pile of ordinary "no results found" responses.
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
      // MESSAGE and STACK as span-event attributes, and an upstream MCP server's
      // error message is arbitrary text we did not author. See redact.ts.
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

  // --- resource proxying (for MCP Apps) -------------------------------------
  // A selected server's `ui://` template must reach the client, so the gateway
  // relays resources the same way it relays tools: union on list, route on read,
  // scoped to the servers selected for THIS request. A server that serves no
  // resources (every builtin today) simply contributes none.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: await listResourcesFor(selected, registry),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    readResourceFor(selected, registry, request.params.uri),
  );

  return server;
}

/** Seconds elapsed since an `hrtime.bigint()` mark. */
function elapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}

/**
 * Answer `troubleshoot_host`: re-check the machine, then say what to do.
 *
 * It PROBES rather than replaying whatever the listing found, because the gap
 * between the two is exactly when somebody is running the commands. Being told
 * "it is back, list again" the moment it is back is most of this tool's value;
 * a cached verdict would tell them it is still down while they watch it come up.
 * The probe is a `tools/list`, so it costs one bounded handshake
 * (`connectTimeoutMs`, five seconds by default) and nothing on the machine.
 *
 * Never throws. Everything it can find out is an answer worth returning, and a
 * tool whose job is to explain a failure has no business failing.
 */
async function troubleshoot(adapter: ServerAdapter): Promise<CallToolResult> {
  const host = adapter.host!;
  try {
    const tools = await adapter.listTools();
    return recoveredResult(host, tools.length);
  } catch (err) {
    if (err instanceof LocalHostUnavailableError) {
      return troubleshootResult(host, err.state);
    }
    // The machine answered and something else is wrong. Saying "it is offline"
    // here would send its owner to restart a tunnel that is working fine.
    return undiagnosedResult(host);
  }
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
 * take down the other twenty-eight, so it contributes zero tools and a log line.
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
 * ## The one exception: a `local-tunnel` whose machine is not answering
 *
 * The rule above exists because a silently smaller toolset HIDES a fault. For a
 * `local-tunnel` there is no fault to hide: the server is a laptop, the laptop
 * is off, and that is the advertised behaviour of the kind rather than a
 * condition anyone needs to discover.
 *
 * So it neither fails the listing nor vanishes from it. The slug KEEPS ITS PLACE
 * and contributes one tool — `troubleshoot_host`, which says which machine is
 * down and what to run on it (gateway/troubleshoot.ts). `?servers=anki,slack`
 * with the laptop asleep is a working Slack, no Anki tools, and one tool
 * explaining the gap; `?servers=anki` alone is that one tool rather than an
 * error, which is the case a human actually hits — the console hands out one
 * `?servers=<slug>` per server.
 *
 * That covers what the old shape could not. A shorter list said nothing, so
 * "Anki is off" and "Anki has no tools" were indistinguishable from outside; and
 * an error on the single-slug case gave a client no way forward at all. Both are
 * now a tool that anything speaking MCP can already read.
 *
 * NOTE the boundary. This fires when `listTools()` THROWS a
 * `LocalHostUnavailableError` — a machine that is off, or one that refused
 * strad's credentials. Any OTHER failure from a local-tunnel (a 404 on a wrong
 * path, a 500) is an ordinary broken upstream and fails a named listing like
 * anything else: nobody at that machine can fix it, so sending them there would
 * be a lie. A named server that ANSWERS with an empty list is still an empty
 * list — that is a server with no tools, and it is `ToolSurfaceMonitor`'s job to
 * notice, not this one's.
 *
 * NOTE ALSO what does not change: `probeToolSurfaces` calls the adapter
 * directly, so `/healthz`, the reachability monitor and the deploy gate keep
 * seeing an unreachable slug as unreachable. The troubleshooting tool is a
 * courtesy to CLIENTS, not a way for a machine being off to read as healthy.
 */
export async function listToolsFor(
  selected: string[],
  registry: Registry,
  policies: ToolPolicies,
  log: (event: Record<string, unknown>) => void,
  /** Present exactly when the caller named its servers. See above. */
  explicit?: { onUnlistable: (slug: string) => void },
): Promise<Tool[]> {
  const lists = await Promise.all(
    selected.map(async (slug): Promise<Listing> => {
      const adapter = registry.get(slug);
      if (!adapter) return { ok: true, tools: [] };
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

        return {
          ok: true,
          tools: tools
            .filter((t) => toolAllowed(policy, t.name))
            .map((t) => ({ ...t, name: namespaced(slug, t.name) })),
        };
      } catch (err) {
        event({
          evt: "mcp.list_tools_failed",
          slug,
          explicit: Boolean(explicit),
          // Stays on stdout in full; the exporter substitutes `error.kind`.
          error: err instanceof Error ? err.message : String(err),
        });

        // THE DEGRADED SURFACE. A local-tunnel whose machine is not answering
        // keeps its place in the listing and offers one tool: how to bring that
        // machine back. See gateway/troubleshoot.ts for why a tool rather than
        // an empty list, a `_meta` field or an error.
        //
        // NOT filtered by the `tools:` policy, deliberately. That policy is a
        // statement about the UPSTREAM's capabilities — which tools of its own
        // this slug may serve — and this tool is not one of them; it is strad's,
        // and it is the only thing standing between a caller and an unexplained
        // gap. An `allow:` list written for the real toolset would otherwise
        // filter it away and reinstate exactly the silence this replaces.
        if (adapter.host && err instanceof LocalHostUnavailableError) {
          event({
            evt: "mcp.local_machine_offline",
            slug,
            listed: false,
            state: err.state,
          });
          const tool = troubleshootTool(adapter.host, err.state);
          return {
            ok: true,
            tools: [{ ...tool, name: namespaced(slug, tool.name) }],
          };
        }

        return { ok: false, slug, err };
      }
    }),
  );

  const failures = lists.flatMap((l) => (l.ok ? [] : [l]));
  const tools = lists.flatMap((l) => (l.ok ? l.tools : []));

  // Not a named selection: one sick server contributes nothing and the rest of
  // the fleet is unaffected.
  if (!explicit) return tools;

  // A named server that is genuinely broken fails the whole listing — see the
  // header. An unavailable local-tunnel host never reaches here: it was turned
  // into a troubleshooting tool above, so it is a successful listing with one
  // unusual tool in it rather than a failure to arbitrate.
  if (failures.length > 0) {
    // EVERY broken slug, not just the one thrown about. `onUnlistable` drives a
    // per-slug metric, and reporting only the first would make the second dead
    // bundle in a two-bundle outage invisible to the counter that exists to
    // find it.
    for (const f of failures) explicit.onUnlistable(f.slug);
    // The upstream's own message is NOT relayed. It is arbitrary text from
    // someone else's server — the one that motivated this branch was a
    // full HTML error page — and it would land in a client's error
    // surface. The slug is ours and is the actionable half.
    throw new McpError(
      ErrorCode.InternalError,
      `server "${failures[0]!.slug}" was requested by name but its upstream could not be listed, ` +
        `so it is serving no tools. This is a failure, not an empty toolset.`,
    );
  }

  return tools;
}

/** One selected server's contribution to a listing, or why it has none. */
type Listing =
  { ok: true; tools: Tool[] } | { ok: false; slug: string; err: unknown };

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
