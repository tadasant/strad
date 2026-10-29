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
  elapsedSeconds,
  errorKind,
  event,
  instruments,
  resultShape,
  tracer,
} from "../telemetry/index.ts";
import { ServerUnconfiguredError } from "./unconfigured.ts";
import { withDeadline } from "../util/deadline.ts";
import {
  LocalHostUnavailableError,
  LocalMachineOfflineError,
} from "./adapters/http.ts";
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
import type { ElicitationChannel } from "./elicitation.ts";
import type { CallProgress } from "./adapters/types.ts";
import type { Mode, Registry } from "./registry.ts";
import {
  toolAllowed,
  unmatchedAllowEntries,
  type ToolPolicies,
} from "./toolPolicy.ts";
import { errorText } from "../util/error-text.ts";
import { pinViolation, type ArgumentPins } from "../config/reach.ts";
import { EVENTS_EXTENSION, registerEventHandlers } from "./events.ts";

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
export type Surface = "mcp" | "playground" | "app" | "reach";

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
  /**
   * The roles that principal holds, for a server whose ANSWER depends on who is
   * asking rather than only on whether they may ask.
   *
   * The roster editor is the one: its writes are bounded by what their author
   * can already reach (`assertWithinReach`), so it needs the roles the
   * entitlement intersection was computed from — not a second derivation of
   * them. Every other builtin ignores it, and it authorizes nothing: `selected`
   * has already decided which slugs this session may touch at all.
   */
  principalRoles?: readonly string[];
  log: (event: Record<string, unknown>) => void;
  clientCapabilities?: ClientCapabilities;
  /**
   * The caller's confirmation channel, already checked against the allowlist.
   * Only `/mcp` sets it; the console playground and the flow-through route
   * have no human on the line, so a confirmed tool refuses there. See
   * src/gateway/elicitation.ts.
   */
  elicitation?: ElicitationChannel;
  /**
   * Present exactly when the caller NAMED its servers, in which case an
   * unlistable upstream fails the listing rather than shrinking it. See
   * listToolsFor.
   */
  explicit?: { onUnlistable: (slug: string) => void };
  /**
   * Arguments fixed per slug, checked on every call after the capability
   * check. Only the flow-through route sets it (src/http/reach.ts); see
   * `pinViolation` in src/config/reach.ts for what "fixed" means.
   */
  pins?: ArgumentPins;
  /**
   * Whether to relay resources at all. Default true. The flow-through route
   * turns it off: a grant names TOOLS, and a resource read is not one of them.
   */
  resources?: boolean;
  /**
   * MCP Events (src/gateway/events.ts). Absent: no `events/*` handlers at all,
   * which is every door but `/mcp`. Present: the handlers are registered, and
   * the extension is advertised when `advertise` is true — which the router
   * decides on `initialize` from the selected upstreams' own handshakes.
   */
  events?: { advertise: boolean };
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
  const principal = { roles: opts.principalRoles ?? [] };

  const relayResources = opts.resources ?? true;
  const server = new Server(
    { name: config.gateway.name, version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        ...(relayResources ? { resources: {} } : {}),
        ...(opts.events?.advertise
          ? { extensions: { [EVENTS_EXTENSION]: {} } }
          : {}),
      },
    },
  );

  if (opts.events) {
    registerEventHandlers(server, {
      selected,
      registry,
      principalId,
      log,
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await listToolsFor(selected, registry, policies, log, explicit),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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
    //
    // NOTE the condition: it is answerable on a local-tunnel slug WHENEVER, not
    // only while that slug's host is down — the listing decides when to OFFER
    // it, and this decides who answers it. Two consequences, both wanted. A
    // caller who has just run the commands can ask again and be told the machine
    // is back, without a listing round trip. And the answer never depends on
    // state carried between two stateless requests, which this endpoint has no
    // way to carry anyway.
    //
    // It therefore SHADOWS an upstream tool of this name on a local-tunnel slug,
    // permanently. See the note on TROUBLESHOOT_TOOL, HACKS.md #60, and the
    // limitations page.
    // Never on a flow-through session: a grant is exhaustive, and this tool is
    // outside every policy.
    const isTroubleshoot =
      parsed.tool === TROUBLESHOOT_TOOL &&
      adapter.host !== undefined &&
      surface !== "reach";

    // CAPABILITY. The upstream container holds every tool the server has —
    // read-only is this check, and nothing else. It runs BEFORE the adapter, so
    // a withheld tool never reaches the upstream at all: no API call, no side
    // effect, no "we only sent the write to Gmail, we didn't mean it".
    if (
      !isTroubleshoot &&
      !toolAllowed(policies.get(parsed.slug), parsed.tool)
    ) {
      // A REFUSAL IS AN EVENT AND A COUNT, AND THE COUNT IS THE PART THAT
      // SURVIVES THE ALLOWLIST.
      //
      // `parsed.tool` is the caller's own bytes — whatever followed the `__` —
      // so it may not reach a metric attribute (an unbounded series any token
      // holder can mint) nor an exported log record. `parsed.slug` is not that:
      // by this line it has survived `selected.includes()` and `registry.get()`
      // above, so it is one of the config's own slugs. The counter is attributed
      // by the slug alone, which is what makes "how often is this slug refusing
      // calls" answerable without the name. It is deliberately not an `outcome`
      // on `toolCalls`, whose attributes include `mcp.tool`.
      //
      // It comes BEFORE the throw for the reason this counter exists at all: the
      // `strad.mcp.tool_calls` block below is past the refusal and never runs.
      inst.toolDenials.add(1, {
        "mcp.server": parsed.slug,
        "strad.mode": mode,
        "strad.surface": surface,
      });
      // `slug`, not `server`: the allowlist exports this record, every other
      // exported record names a server under `slug`, and the throttle keys on
      // that spelling. `tool` and `principal` stay in the payload and stay OFF
      // the allowlist — `tool` is the caller's own bytes, and `principal` is a
      // token `pubid` through router.ts but a signed-in human's Google `sub`
      // through ui/playground.ts, which builds this same server. The stream
      // carries both; the ingestor gets the slug. See src/telemetry/events.ts.
      log({
        evt: "mcp.tool_denied",
        principal: principalId,
        slug: parsed.slug,
        tool: parsed.tool,
      });
      throw new McpError(
        ErrorCode.InvalidRequest,
        `tool "${parsed.tool}" is not permitted on server "${parsed.slug}": ` +
          `this server's capability policy withholds it.`,
      );
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // PINNED ARGUMENTS, on the action for the same reason as the capability
    // check above: a flow-through grant fixed to one spreadsheet is only fixed
    // if a call naming another one never reaches the upstream. Only the NAME of
    // the argument is logged — its value is the caller's bytes.
    // Under a pin, an argument the tool does not DECLARE is refused too: a pin
    // names one spelling of the resource, and an undeclared alternative
    // (`spreadsheetId`, `url`) would reach the same resource around it.
    const pin = opts.pins?.get(parsed.slug);
    let pinned = pinViolation(pin, args);
    if (pinned === null && pin) {
      const declared = (await adapter.listTools()).find(
        (t) => t.name === parsed.tool,
      )?.inputSchema?.properties;
      pinned =
        Object.keys(args).find(
          (k) => !declared || !Object.hasOwn(declared, k),
        ) ?? null;
    }
    if (pinned !== null) {
      inst.toolDenials.add(1, {
        "mcp.server": parsed.slug,
        "strad.mode": mode,
        "strad.surface": surface,
      });
      log({
        evt: "mcp.pin_refused",
        principal: principalId,
        slug: parsed.slug,
        // A pin KEY is the config's own word; an undeclared argument's name is
        // the caller's bytes, and never reaches the exported record.
        argument: pin && Object.hasOwn(pin, pinned) ? pinned : "(undeclared)",
      });
      throw new McpError(
        ErrorCode.InvalidRequest,
        `argument "${pinned}" is not allowed for "${parsed.slug}" on this ` +
          `grant: pinned arguments must be exactly the configured value, and ` +
          `an argument the tool does not declare is refused.`,
      );
    }

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
            ? troubleshoot(adapter, policies.get(parsed.slug))
            : adapter.callTool(parsed.tool, args, {
                clientCapabilities,
                principal,
                elicitation: opts.elicitation,
                signal: extra.signal,
                onProgress: progressRelay(request.params._meta, extra),
              }),
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
      // A DISPATCH ONTO A SLUG THAT IS WAITING FOR A TOKEN SAYS SO.
      //
      // Relayed in full because strad constructed it — a slug and a set of
      // `${NAME}`s from our own config, with no upstream text and no value in it
      // — and as `InvalidRequest` rather than `InternalError`, because nothing
      // internal went wrong. A caller that reaches here asked a server to work
      // before anyone gave it a credential, and the one useful thing to tell them
      // is exactly that. Re-thrown AFTER the metrics below so the call still
      // counts.
      if (err instanceof ServerUnconfiguredError) {
        inst.toolCalls.add(1, {
          ...toolAttrs,
          outcome: "error",
          "error.kind": kind,
        });
        inst.toolCallDuration.record(elapsedSeconds(toolStartedAt), {
          ...toolAttrs,
          outcome: "error",
        });
        callSpan.setStatus({ code: SpanStatusCode.ERROR });
        throw new McpError(ErrorCode.InvalidRequest, err.message);
      }
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
  if (!relayResources) return server;

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: await listResourcesFor(selected, registry),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    readResourceFor(selected, registry, request.params.uri),
  );

  return server;
}

/**
 * How long `troubleshoot_host` will wait for the machine before answering.
 *
 * The adapter's own bounds are wrong for this one question. `connectTimeoutMs`
 * (5s) covers only the handshake, and the REQUEST hop that follows it inherits
 * `timeoutMs` — two minutes by default, because a tool driving a browser on
 * somebody's desktop is legitimately slow. A half-open host, which accepts a
 * connection and then never answers, would therefore hang this tool for the
 * full two minutes. That is absurd for a tool whose entire job is a fast
 * re-check, and it is longer than most clients will wait, so the answer would
 * be lost anyway.
 */
const TROUBLESHOOT_PROBE_MS = 10_000;

/**
 * Answer `troubleshoot_host`: re-check the machine, then say what to do.
 *
 * It PROBES rather than replaying whatever the listing found, because the gap
 * between the two is exactly when somebody is running the commands. Being told
 * "it is back, list again" the moment it is back is most of this tool's value;
 * a cached verdict would tell them it is still down while they watch it come up.
 *
 * Never throws. Everything it can find out is an answer worth returning, and a
 * tool whose job is to explain a failure has no business failing.
 */
async function troubleshoot(
  adapter: ServerAdapter,
  policy: ReturnType<ToolPolicies["get"]>,
): Promise<CallToolResult> {
  const host = adapter.host!;
  try {
    // A deadline the adapter does not impose on itself: this tool answers a
    // human who is watching, so it must answer.
    const tools = await withDeadline(
      () => adapter.listTools(),
      TROUBLESHOOT_PROBE_MS,
      "the machine",
    );
    // The count this slug's clients would actually see. The raw upstream total
    // would answer a question nobody asked — how much an allow-list withholds.
    return recoveredResult(
      host,
      tools.filter((t) => toolAllowed(policy, t.name)).length,
    );
  } catch (err) {
    if (err instanceof LocalHostUnavailableError) {
      return troubleshootResult(host, err.state);
    }
    // The machine answered and something else is wrong — including our own
    // deadline above, which only fires on a host that accepted a connection and
    // then went quiet. Saying "it is offline" here would send its owner to
    // restart a tunnel that is working fine.
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
 * NOTE ALSO how this reads to an OPERATOR, which is a separate question:
 * `probeToolSurfaces` calls the adapter directly and reports a switched-off
 * machine as `offline`, out of `/healthz`'s `degraded` list, because the slug is
 * still connectable and there is nothing to go and fix. A host that REFUSES, a
 * 404 and a 500 all stay `unreachable` and stay degraded. See
 * gateway/reachability.ts.
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
        // The distinction is made HERE, at the emit, and not later for the
        // return value only. `_failed` is a fault: the exporter ships it at
        // ERROR severity and an alert rule keyed on `severity >= ERROR` pages
        // on it. A laptop being off is not a fault — it is the advertised
        // behaviour of the kind — and reporting it as one paged a production
        // channel over a machine somebody had switched off. So an unavailable
        // host gets the event that already exists to say exactly that, at Info,
        // and `mcp.list_tools_failed` keeps meaning what it says.
        const unavailable =
          adapter.host && err instanceof LocalHostUnavailableError ? err : null;
        // TWO decisions, and they are not the same predicate. The DEGRADED
        // SURFACE is offered for either shape of unavailable host, because both
        // have a machine somebody owns and a remedy to hand them. The EVENT is
        // narrower: only a machine that is off is exempt from being a fault. A
        // host that REFUSES is answering, a credential has gone stale, and it
        // will not clear until somebody rotates it — so it keeps the
        // ERROR-severity `_failed` record and keeps paging. `listResourcesFor`
        // below draws the same line.
        // A SLUG WAITING ON A TOKEN IS NOT A FAULT, AND MUST NOT PAGE.
        //
        // `mcp.list_tools_failed` ships at ERROR severity and an alert rule keyed
        // on `severity >= ERROR` pages on it. A deploy that shipped ahead of a
        // credential on purpose (src/deploy/unseeded.ts) would otherwise page a
        // production channel once per listing, for as long as the value is
        // pending — which would make the deferral useless. Same line
        // `LocalMachineOfflineError` already drew, for the same reason.
        if (err instanceof ServerUnconfiguredError) {
          event({
            evt: "mcp.server_unconfigured",
            slug,
            explicit: Boolean(explicit),
            // strad's own config authored these. No value, nothing upstream.
            names: err.names,
          });
          return { ok: false, slug, err };
        }

        const offline = err instanceof LocalMachineOfflineError;
        event(
          offline
            ? {
                evt: "mcp.local_machine_offline",
                slug,
                listed: false,
                explicit: Boolean(explicit),
                state: err.state,
                error: err.message,
              }
            : {
                evt: "mcp.list_tools_failed",
                slug,
                explicit: Boolean(explicit),
                // Stays on stdout in full; the exporter substitutes `error.kind`.
                error: errorText(err),
              },
        );

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
        if (unavailable) {
          const tool = troubleshootTool(adapter.host!, unavailable.state);
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
  // the fleet is unaffected. A local-tunnel host that is not answering is the
  // exception here too — the substitution above runs before this line, so an
  // "everything I'm entitled to" listing carries one troubleshooting tool per
  // sleeping laptop rather than a silent gap. That is deliberate: it is the same
  // question ("where did those tools go?") asked by a caller who did not name
  // anything, and it deserves the same answer.
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
    // AN UNCONFIGURED SLUG SAYS SO, IN STRAD'S OWN WORDS.
    //
    // Reported first when there is one, because "this server is waiting for a
    // credential" and "this server's upstream is broken" send a caller to
    // opposite places, and the generic sentence below would send them to the
    // wrong one. This message is safe to relay in full precisely because strad
    // constructed it: a slug and a set of `${NAME}`s out of our own config, and
    // no upstream text or secret value anywhere in it.
    // A GENUINE FAULT OUTRANKS A DEFERRAL. A named selection holding both an
    // unconfigured slug and a broken one reports the BROKEN one: "seed a token"
    // is advice somebody can act on and act on wrongly, and it would send them
    // away from an upstream that is actually down. The unconfigured message is
    // for the case where it is the only thing wrong — which is the case a
    // console-issued `?servers=<slug>` link produces.
    const broken = failures.find(
      (f) => !(f.err instanceof ServerUnconfiguredError),
    );
    const pending = failures.find(
      (f) => f.err instanceof ServerUnconfiguredError,
    );
    if (pending && !broken) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        (pending.err as ServerUnconfiguredError).message,
      );
    }
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
 *
 * An offline machine reports the same way it does on the tools path, and for the
 * same reason: `listResources()` reaches `connect()` before it can discover the
 * upstream has no resources capability, so a closed laptop throws here on every
 * client that lists resources — and a `_failed` event is an ERROR-severity
 * record that pages. Nothing failed.
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
        // A slug waiting on a deferred credential is not a fault, and
        // `mcp.list_resources_failed` ships at ERROR severity. Every client that
        // lists resources would otherwise page once per listing, for as long as
        // the value is pending — the same trap the tools path draws this line to
        // avoid.
        if (err instanceof ServerUnconfiguredError) {
          event({
            evt: "mcp.server_unconfigured",
            slug,
            explicit: false,
            names: err.names,
          });
          return [];
        }
        event(
          // `LocalMachineOfflineError` and NOT the `LocalHostUnavailableError`
          // base: a host that REFUSES is answering, and a stale credential is a
          // fault that should keep paging. Only a machine that is off is exempt.
          err instanceof LocalMachineOfflineError
            ? {
                evt: "mcp.local_machine_offline",
                slug,
                listed: false,
                state: err.state,
                error: err.message,
              }
            : {
                evt: "mcp.list_resources_failed",
                slug,
                error: errorText(err),
              },
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
 * Relay an upstream's progress to the caller, under the CALLER's token.
 *
 * Undefined when the caller sent no `progressToken`: a progress notification
 * without one is not a thing the protocol lets a server send. The upstream's
 * own token is the gateway's, minted by the SDK for the hop, and never leaves
 * core. What a confirmed tool sends here is a keepalive while a human decides,
 * and for a caller whose own client gives up on a silent response it is what
 * keeps the call open. See src/gateway/elicitation.ts.
 */
function progressRelay(
  meta: { progressToken?: string | number } | undefined,
  extra: {
    sendNotification: (n: {
      method: "notifications/progress";
      params: { progressToken: string | number } & CallProgress;
    }) => Promise<void>;
  },
): ((progress: CallProgress) => void) | undefined {
  const token = meta?.progressToken;
  if (token === undefined) return undefined;
  return (progress) => {
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { ...progress, progressToken: token },
      })
      .catch(() => {});
  };
}
