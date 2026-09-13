import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ErrorCode,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Express, RequestHandler, Request, Response } from "express";
import type { ServerConfig, StradConfig } from "../config/schema.ts";
import { asyncRoute, jsonFailure } from "../http/async-route.ts";
import { entitledServers, resolveSelection } from "../gateway/entitlements.ts";
import { buildGatewayServer } from "../gateway/mcpServer.ts";
import type { Registry } from "../gateway/registry.ts";
import { compileToolPolicies } from "../gateway/toolPolicy.ts";
import { denamespace } from "../gateway/adapters/types.ts";
import { TROUBLESHOOT_TOOL } from "../gateway/troubleshoot.ts";
import { event } from "../telemetry/index.ts";
import {
  consolePrincipal,
  refuseTokenSession,
  signedInLabel,
} from "./console-auth.ts";
import { esc, jsonForScript, layout, renderMessage } from "./render.ts";
import { errorText } from "../util/error-text.ts";

/**
 * `/playground/:server` — a human MCP client for ONE server, in the console.
 *
 * The console could say a server existed and whether its secrets were seeded,
 * and stopped there. Whether the thing actually answers — what tools it offers
 * today, what a call returns, what the error text is when it doesn't — needed a
 * second client, a config file and a token. This is that loop closed: list the
 * tools, type the arguments, see the response.
 *
 * It is an INSPECTOR, not a chat. No model is involved at any point; a human
 * picks the tool and writes the arguments, and the bytes on screen are the
 * server's own.
 *
 * ## How it authenticates, and why it is not a hole in either gate
 *
 * strad has two doors and they share nothing: `/ui` is an HttpOnly, SameSite=Lax
 * console session (console-auth.ts), `/mcp` is a static bearer token
 * (auth/tokens.ts). A browser page therefore CANNOT reuse its console cookie
 * against `/mcp` — and it should not be able to, because that cookie is a human
 * identity and `/mcp`'s token model is what bounds an agent.
 *
 * Three ways to bridge that, and only one of them costs nothing:
 *
 *   1. Teach `/mcp` to accept a console session. Rejected outright. It would put
 *      a second credential type on the endpoint whose single credential type is
 *      the whole security model, and a cookie-authenticated `/mcp` is a CSRF
 *      target the moment it is not a preflighted JSON POST.
 *   2. Ask the human to paste a bearer token. Honest, and it moves a long-lived
 *      production credential into a browser tab to be typed, stored and
 *      shoulder-surfed. Only mint-time knows a token's plaintext (the store keeps
 *      a SHA-256), so most operators would have to mint a NEW token to look at a
 *      tool list — a permanent credential created for a transient errand.
 *   3. Keep the session on the server. What this does.
 *
 * The two POST routes below run an MCP session IN THIS PROCESS: a real
 * `@modelcontextprotocol/sdk` `Client`, linked by `InMemoryTransport` to the
 * exact `Server` object `/mcp` builds per request (`buildGatewayServer`). A real
 * `initialize` handshake, real `tools/list` and `tools/call` JSON-RPC, the real
 * adapters, the real tool policy. What it deliberately does NOT do is cross the
 * HTTP boundary — crossing it would need a `/mcp` token this process does not
 * have and must not invent. The page says so in as many words; claiming an HTTP
 * hop that did not happen would be exactly the kind of unearned green the rest
 * of this console refuses.
 *
 * ## What it is allowed to reach
 *
 * The console principal's own roles, run through `entitledServers` and
 * `resolveSelection` — the same two functions `/mcp` calls, in the same order.
 * A console identity with no roles reaches nothing here, and says so. The
 * playground is not a privileged back door into the registry; it is the console
 * session's own entitlement, rendered.
 *
 * ## CSRF
 *
 * Same reasoning as the `/ui` writes, plus one more lock. The session cookie is
 * SameSite=Lax, so a cross-site POST arrives without it and the gate 401s. On
 * top of that both routes REQUIRE `Content-Type: application/json`, which a
 * cross-site `<form>` cannot send — it is limited to the three simple types —
 * and which forces any scripted attempt through a CORS preflight this app
 * answers for nobody.
 *
 * ## Side effects are real
 *
 * A `tools/call` here runs the tool for real, against production upstreams, with
 * whatever capability the slug's `tools:` policy allows. That is the point of an
 * inspector, and the page says it out loud rather than pretending this is a
 * sandbox.
 */

export interface PlaygroundOptions {
  config: StradConfig;
  registry: Registry;
}

/** The console URL for one server's playground. */
export function playgroundHref(slug: string): string {
  return `/playground/${encodeURIComponent(slug)}`;
}

/**
 * The URL a human pastes into another MCP client to reach exactly this server.
 *
 * NO CREDENTIAL IS IN IT. strad selects servers with a query string and
 * authenticates with a bearer token, and the token never belongs in a URL: a URL
 * lands in shell history, a proxy log, a Referer header and a screenshot, and
 * every one of those outlives the copy. What is copied is a public address; the
 * client still needs a token minted with `npm run token:mint`.
 */
export function connectUrl(base: string, slug: string): string {
  return `${base.replace(/\/$/, "")}/mcp?servers=${encodeURIComponent(slug)}`;
}

/** The origin to build a connect URL from: config first, then this request. */
export function originFor(config: StradConfig, requestOrigin?: string): string {
  return (config.gateway.publicUrl ?? requestOrigin ?? "").replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function mountPlayground(
  app: Express,
  gate: RequestHandler,
  opts: PlaygroundOptions,
): void {
  const policies = compileToolPolicies(opts.config);

  // A bare `/playground` is the picker: the servers this console session may
  // open, as links, and the ones it may not, with the reason.
  //
  // A page rather than a redirect to `/ui`, because the shared nav bar
  // (src/ui/nav.ts) names "playground" and a bar that lands the reader on
  // "servers" teaches them the bar is lying. The obvious objection — that the
  // console index is already a list of the same servers, and a second list is a
  // second thing to keep true — is answered by where this one comes from: it is
  // derived from `playgroundAccess`, the same function that decides whether the
  // index draws its playground icon, so the two cannot disagree about which
  // slugs open.
  //
  // Behind the gate, so an anonymous request still 401s rather than being told
  // what this gateway fronts.
  app.get("/playground", gate, (_req, res) => {
    const principal = consolePrincipal(res);
    const entitled = entitledServers(principal, opts.config);
    res.type("html").send(
      renderPlaygroundIndex({
        entries: opts.config.servers.map((server) => ({
          server,
          access: playgroundAccess(opts.config, entitled, server.slug),
        })),
        signedInAs: signedInLabel(res),
      }),
    );
  });

  app.get("/playground/:server", gate, (req, res) => {
    const slug = req.params.server ?? "";
    const signedInAs = signedInLabel(res);
    const decision = decide(res, opts.config, slug);

    if (!decision.ok) {
      res
        .status(decision.status)
        .type("html")
        .send(
          renderMessage({
            title: `${slug} · playground`,
            signedInAs,
            heading: decision.heading,
            sub: decision.detail,
            // Every refusal here is a scoping fact — a slug that names nothing,
            // one this identity is not granted, one that is switched off. None
            // of them is a fault, so none of them gets the error tone.
            tone: "warn",
            nav: "playground",
          }),
        );
      return;
    }

    const host = req.get("host");
    res.type("html").send(
      renderPlayground({
        server: decision.server,
        signedInAs,
        connectUrl: connectUrl(
          originFor(
            opts.config,
            host ? `${req.protocol}://${host}` : undefined,
          ),
          decision.server.slug,
        ),
      }),
    );
  });

  // `asyncRoute` (src/http/async-route.ts) on both POST routes, and not because
  // `withSession` is unguarded — its own `try` renders the upstream's words to
  // the human who asked for them. It is what runs OUTSIDE that `try`: `decide()`,
  // the linked transport pair, `buildGatewayServer()`, `consolePrincipal()`, and
  // on the call route the body reading above it. An unhandled rejection out of
  // any of those exits this process.
  app.post(
    "/playground/:server/tools/list",
    gate,
    requireJson,
    asyncRoute(async (req, res) => {
      await withSession(req, res, opts, policies, async (client, server) => {
        const listed = await client.listTools();
        const version = client.getServerVersion();
        res.json({
          ok: true,
          // The handshake's own answer, printed on the page. It is the difference
          // between "we rendered a tool list" and "an MCP server introduced
          // itself and then listed its tools".
          session: {
            serverName: version?.name ?? "unknown",
            serverVersion: version?.version ?? "unknown",
            transport: "in-process (InMemoryTransport)",
          },
          // A SUCCESSFUL LISTING IS NOT ALWAYS A HEALTHY ONE. See
          // `hostUnavailable` — this is the flag that keeps the page from
          // reporting a switched-off laptop as "1 tool served to you".
          hostUnavailable: hostUnavailable(server, listed.tools),
          tools: listed.tools.map((t) => shapeTool(t, server.slug)),
        });
      });
    }, PLAYGROUND_FAILURE),
  );

  app.post(
    "/playground/:server/tools/call",
    gate,
    // Listing is looking; a call makes an upstream act, which a login token's
    // session may not do. See refuseTokenSession.
    refuseTokenSession,
    requireJson,
    asyncRoute(async (req, res) => {
      const body = req.body as { tool?: unknown; arguments?: unknown };
      const tool = typeof body?.tool === "string" ? body.tool : "";
      const args =
        body?.arguments && typeof body.arguments === "object"
          ? (body.arguments as Record<string, unknown>)
          : {};

      if (!tool) {
        res.status(400).json({ ok: false, error: "A tool name is required." });
        return;
      }
      if (Array.isArray(body?.arguments)) {
        res.status(400).json({
          ok: false,
          error: "Arguments must be a JSON object, not an array.",
        });
        return;
      }

      await withSession(req, res, opts, policies, async (client, server) => {
        const slug = server.slug;
        const startedAt = Date.now();
        // Names arrive namespaced from the listing; a human editing the field can
        // also type the bare name. Both are accepted, and both are re-namespaced
        // to THIS slug — the gateway re-checks selection on the action anyway, so
        // this is convenience, not authorization.
        const parsed = denamespace(tool);
        const name = parsed && parsed.slug === slug ? tool : `${slug}__${tool}`;

        // stdout only, deliberately. The tool name is typed by a human into a text
        // field, so it is not a value from a closed set this repo wrote down, and
        // the export allowlist (src/telemetry/events.ts) is deny-by-default for
        // exactly that reason. The tool-call SPAN still ships, with
        // `strad.surface=playground` — see gateway/mcpServer.ts.
        event({
          evt: "ui.playground.tool_call",
          principal: consolePrincipal(res).id,
          server: slug,
          tool: name,
        });

        const result = await client.callTool({
          name,
          arguments: args,
        });

        res.json({
          ok: true,
          tool: name,
          elapsedMs: Date.now() - startedAt,
          result,
        });
      });
    }, PLAYGROUND_FAILURE),
  );
}

/**
 * The catch-all answer for both POST routes.
 *
 * `{ ok: false, error }` rather than the bare `{ error }` the machine routes
 * answer with, because the page's own `failure()` reads exactly those two fields
 * — a body it cannot read renders as "unknown error". The sentence is strad's
 * own: reaching here means nothing in `withSession` classified the failure, so
 * there is no upstream text worth trusting.
 */
const PLAYGROUND_FAILURE = jsonFailure("playground", {
  ok: false,
  error: "The console hit an unexpected error.",
});

/**
 * The second CSRF lock, in front of both POST routes.
 *
 * The Lax session cookie is the one that matters: a cross-site POST arrives
 * without it and the gate 401s. This adds the lock that does not depend on a
 * browser's cookie policy being what we think it is — a cross-site `<form>` can
 * only send urlencoded, plain-text or multipart, so demanding JSON puts every
 * scripted attempt behind a CORS preflight this app answers for nobody.
 *
 * It runs BEFORE anything reads the body. A 400 "that is not a tool name" for a
 * form-encoded POST would be a true statement about the wrong thing.
 */
const requireJson: RequestHandler = (req, res, next) => {
  if (!req.is("application/json")) {
    res
      .status(415)
      .json({ ok: false, error: "Content-Type must be application/json." });
    return;
  }
  next();
};

/**
 * Run one MCP session for the console principal, against one server.
 *
 * A fresh `Client`/`Server` pair per request, torn down in `finally` — the same
 * statelessness `/mcp` has, for the same reason: the toolset is derived from
 * (identity, slug) every time and never from anything held between requests. The
 * ADAPTERS are the registry's and are long-lived, so an upstream connection is
 * not re-established per click.
 */
async function withSession(
  req: Request,
  res: Response,
  opts: PlaygroundOptions,
  policies: ReturnType<typeof compileToolPolicies>,
  run: (client: Client, server: ServerConfig) => Promise<void>,
): Promise<void> {
  const slug = req.params.server ?? "";
  const decision = decide(res, opts.config, slug);
  if (!decision.ok) {
    res.status(decision.status).json({
      ok: false,
      error: decision.heading,
      detail: decision.detail,
    });
    return;
  }

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const server = buildGatewayServer({
    config: opts.config,
    registry: opts.registry,
    policies,
    // Constant rather than threaded: the whole console is mounted inside
    // `if (opts.mode === "core")` (src/http/app.ts), so a bundle has no
    // playground to serve. A `mode` parameter here would be a knob whose only
    // legal value is this one.
    mode: "core",
    surface: "playground",
    selected: [decision.server.slug],
    principalId: consolePrincipal(res).id,
    // The signed-in human's own roles, so a write made through the playground is
    // bounded by exactly what the same human's write through /connectors is.
    principalRoles: consolePrincipal(res).roles,
    log: event,
    // The console named this server, so an upstream that cannot be listed is an
    // ERROR rather than an empty tool list. That is the whole point of being
    // here: "this server is broken" and "this server has no tools" look
    // identical until someone draws the line, and /mcp draws it exactly here.
    explicit: { onUnlistable: () => {} },
  });

  const client = new Client(
    { name: "strad-console-playground", version: "0.1.0" },
    { capabilities: {} },
  );

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    await run(client, decision.server);
  } catch (err) {
    // The upstream's own words, to the human who asked for them. This is the one
    // surface where relaying them is the feature — a signed-in operator staring
    // at a tool that will not run needs the error text, and `/mcp` withholds it
    // from an AGENT for reasons that do not apply to a console page. It still
    // reaches no ingestor: nothing here hands it to telemetry.
    if (!res.headersSent) {
      res.status(statusFor(err)).json({ ok: false, error: readable(err) });
    }
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/**
 * Whether a slug's playground opens, and when it does not, why.
 *
 * The three refusals are the endpoint's own vocabulary
 * (`src/gateway/entitlements.ts`), kept rather than flattened to a boolean: the
 * page turns them into three different sentences, and a caller that only wants
 * "is there anything here" reads `.ok`.
 */
export type PlaygroundAccess =
  | { ok: true; server: ServerConfig }
  | { ok: false; status: "not_configured" }
  | { ok: false; status: "disabled" | "not_entitled"; server: ServerConfig };

/**
 * May this console identity inspect this slug?
 *
 * `resolveSelection` against the set `entitledServers` returned for the console
 * principal — the two functions `/mcp` calls, in the same order. A slug can be
 * configured, ENABLED, and still not this session's to open: `entitledServers`
 * intersects role→servers with server→`entitlements:`, so either direction
 * omitting the console's role is a refusal.
 *
 * Exported because the console INDEX asks the same question — and asks it
 * through this function, so the icon offering the playground cannot answer
 * differently from the playground. `enabled` alone is the narrower half of the
 * rule, and an icon gated on the narrow half leads to a 424.
 *
 * `entitled` is passed in rather than derived: the index computes it ONCE for
 * the whole grid, and every card is a question about the same principal.
 */
export function playgroundAccess(
  config: StradConfig,
  entitled: Set<string>,
  slug: string,
): PlaygroundAccess {
  const server = config.servers.find((s) => s.slug === slug);
  if (!server) return { ok: false, status: "not_configured" };

  const selection = resolveSelection([slug], entitled, config);
  if (selection.ok) return { ok: true, server };

  return {
    ok: false,
    status:
      selection.unavailable[0]?.status === "disabled"
        ? "disabled"
        : "not_entitled",
    server,
  };
}

type Decision =
  | { ok: true; server: ServerConfig }
  | { ok: false; status: number; heading: string; detail: string };

/**
 * `playgroundAccess`, rendered as an HTTP answer.
 *
 * The status codes mirror the endpoint's: 404 for a slug that names nothing, 424
 * for one that exists and is not yours, because "you are fine, a thing you
 * depend on is not available to you" is the same answer here as there.
 */
function decide(res: Response, config: StradConfig, slug: string): Decision {
  const principal = consolePrincipal(res);
  const access = playgroundAccess(
    config,
    entitledServers(principal, config),
    slug,
  );

  if (access.ok) return { ok: true, server: access.server };

  if (access.status === "not_configured") {
    return {
      ok: false,
      status: 404,
      heading: "No such server",
      detail: `No server named "${slug}" is configured on this gateway.`,
    };
  }

  return {
    ok: false,
    status: 424,
    heading:
      access.status === "disabled"
        ? "This server is disabled"
        : "Not available to this console identity",
    detail:
      access.status === "disabled"
        ? `"${slug}" is configured with enabled: false, so the gateway does not mount it and ` +
          `/mcp would refuse it too. Enable it in the config to inspect it here.`
        : `Your console session holds the roles [${principal.roles.join(", ") || "none"}], and ` +
          `"${slug}" grants [${access.server.entitlements.join(", ") || "none"}]. The playground applies the ` +
          `same entitlement rule /mcp does — it is your own identity, not a privileged view — so ` +
          `there is nothing here to show you. Grant the role under roles: and the server's ` +
          `entitlements:, or use a token that holds it.`,
  };
}

/**
 * 4xx for what the caller asked for, 502 only for what the upstream did.
 *
 * A `tools:` policy refusal is strad declining on purpose — `InvalidRequest`,
 * raised by `buildGatewayServer` before the adapter is touched — and answering
 * 502 for it would be a lie twice over: nothing downstream failed, and the same
 * page's fetch would report a gateway problem for a working gateway enforcing a
 * working policy. Everything else here really is the hop.
 */
export function statusFor(err: unknown): number {
  return err instanceof McpError && err.code === ErrorCode.InvalidRequest
    ? 400
    : 502;
}

/**
 * The error, once.
 *
 * A JSON-RPC error crosses two SDK layers and each one prefixes it, so a policy
 * refusal arrives as `MCP error -32600: MCP error -32600: tool "whoami" is
 * not permitted…`. The duplication is noise in front of the sentence that
 * matters, on the one surface whose entire job is showing a human what went
 * wrong. The code is kept — it is the machine-readable half — just not twice.
 */
export function readable(err: unknown): string {
  // `errorText` is the base — the playground's errors are the gateway's own
  // refusals and an upstream's JSON-RPC faults, with no store read and no
  // rendered payload anywhere in the hop. The shaping goes on top of it rather
  // than deriving the string a second way; see `src/util/error-text.ts` for
  // when the answer is `errorSummary` instead.
  return errorText(err).replace(/^(MCP error -?\d+: )(?=\1)/, "");
}

/**
 * Is this listing the DEGRADED SURFACE rather than the server's own tools?
 *
 * A `local-tunnel` whose machine is not answering does not fail a listing — it
 * keeps its place and serves exactly one tool, strad's `troubleshoot_host`
 * (gateway/troubleshoot.ts). That is right for an agent and it is a trap for
 * this page: `tools/list` returns 200 with one tool, so the status line would
 * report "1 tool(s) served to you" in the healthy tone about a laptop somebody
 * has shut. The whole point of the kind is that a machine being off is a
 * first-class, benign state, and a green line saying nothing about it drops that
 * distinction exactly as a bare status code does.
 *
 * There is no error to classify here — the listing SUCCEEDED — and there would
 * be nothing to classify by CLASS even if it had failed: this route runs a real
 * MCP session over an in-memory transport, so an adapter's error crosses a
 * JSON-RPC boundary and arrives as an `McpError` carrying its message and
 * nothing else. `LocalMachineOfflineError` is gone by the time this file sees
 * it. What survives is the substitution itself, and that is the signal: this
 * kind, one tool, and the tool is strad's own. A `local-tunnel` whose upstream
 * really did serve a single tool of that name would be read as unavailable —
 * which is the shadowing `troubleshoot_host` already accepts by name (see
 * TROUBLESHOOT_TOOL), and the reason that name is specific enough that no MCP
 * server on a laptop is likely to have picked it.
 *
 * Which of the two unavailable STATES it is — a machine that is off or one that
 * refused strad's credentials — is deliberately not guessed: both degrade this
 * way, the error that knew is gone by here, and the tool below answers it
 * properly when called. The page words this case for both.
 */
export function hostUnavailable(server: ServerConfig, tools: Tool[]): boolean {
  if (server.kind !== "local-tunnel" || tools.length !== 1) return false;
  const parsed = denamespace(tools[0]!.name);
  return parsed?.slug === server.slug && parsed.tool === TROUBLESHOOT_TOOL;
}

/**
 * What the page says when a `local-tunnel` lists the degraded surface.
 *
 * The listing succeeded, so this is not an error tone and not a bare status: it
 * is one server that is not serving its own tools, and a tool sitting right
 * there with the commands to bring it back.
 *
 * BOTH unavailable states degrade this way, and the page says both rather than
 * picking one. A machine that is off is expected; a machine that ANSWERED and
 * refused strad's credentials is not — it is a stale credential somebody has to
 * rotate, which is why the gateway keeps that one paging (mcpServer.ts). This
 * flag cannot tell them apart, so a sentence promising "expected, not a fault"
 * over both would be wrong half the time. The tool below re-probes the machine
 * and answers it properly.
 */
export function degradedSurfaceNote(slug: string): string {
  return (
    `"${slug}" is not serving its own tools: the machine hosting it is not available to strad. ` +
    `${localTunnelNote(slug)} Either that machine is not answering — which is expected while it ` +
    `is off, and not a fault in strad — or it answered and refused strad's credentials, which is ` +
    `a stale credential somebody has to rotate. The one tool below is strad's own: call it for ` +
    `the diagnosis and the exact commands to run on that machine.`
  );
}

/**
 * What the page says when no strad answer arrived at all.
 *
 * This is the shape the issue reported: the console printed `HTTP 504`, a status
 * `statusFor()` cannot emit, because the body was not JSON and the page fell
 * back to the number. These routes answer JSON for every outcome they reach, so
 * a non-JSON body came from in front of strad — and on a `local-tunnel`, the
 * commonest reason a request waits long enough to be timed out there is a
 * machine that is not answering. Said as the strong hint it is rather than as a
 * verdict the page cannot support: nothing here inspected the machine.
 *
 * `INGRESS_STATUS_TOKEN` is substituted by the page with the status it actually
 * received. The prose stays in this file — the script below holds none of its
 * own — and the token is exported so both halves of that substitution name the
 * same string.
 */
export const INGRESS_STATUS_TOKEN = "{status}";

export function ingressTimeoutNote(
  slug: string,
  status: number | string = INGRESS_STATUS_TOKEN,
): string {
  return (
    `The request timed out — HTTP ${status}, answered in front of strad rather than by strad ` +
    `itself. ${localTunnelNote(slug)} A machine that is off is the expected state for this kind, ` +
    `not a fault in strad, and waiting on one that is not there is the commonest reason for this ` +
    `— so check that machine before you check the gateway.`
  );
}

/**
 * The sentence that makes a `local-tunnel` legible to whoever is looking at it.
 *
 * Every kind-aware message on this page opens with it, because it carries the
 * fact a status code cannot: there is a MACHINE somebody owns behind this slug,
 * and it has to be awake for the server to serve. What that means for the
 * failure in hand is the next sentence's job and differs per case, so this one
 * makes no claim about which failure it is. Built here, from the slug and
 * nothing else — strad's own prose, never an upstream's — and handed to the
 * page's script as a constant, so this file is the only place it is written.
 */
export function localTunnelNote(slug: string): string {
  return (
    `"${slug}" is a local-tunnel server: it serves tools only while the machine hosting it ` +
    `is awake, running the server, and holding its tunnel open.`
  );
}

/** One tool, as the page needs it: bare name, namespaced name, schema. */
function shapeTool(tool: Tool, slug: string): Record<string, unknown> {
  const parsed = denamespace(tool.name);
  return {
    name: tool.name,
    bare: parsed && parsed.slug === slug ? parsed.tool : tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? { type: "object" },
  };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** The half of `PlaygroundAccess` that means "this slug does not open". */
type ShutAccess = Extract<PlaygroundAccess, { ok: false }>;

export interface PlaygroundIndexOptions {
  /** Every configured server, with this session's verdict on each. */
  entries: { server: ServerConfig; access: PlaygroundAccess }[];
  signedInAs?: string;
}

/**
 * `/playground` — which servers this console session can open by hand.
 *
 * Every configured slug appears, including the ones that will not open, because
 * "it is not in the list" and "it is not yours" are different facts and only one
 * of them is actionable. A slug that does not open is not a link and carries the
 * word for why: `disabled` is a config change, `not entitled` is a role change,
 * and neither is something to keep clicking at.
 */
export function renderPlaygroundIndex(opts: PlaygroundIndexOptions): string {
  const open = opts.entries.filter((e) => e.access.ok);
  // A type predicate rather than a bare `!e.access.ok`, because `filter` does
  // not narrow: without it `shutRow` has to handle an `ok: true` entry and a
  // `not_configured` one, and neither can reach it — every entry is built from
  // `config.servers`, so `playgroundAccess`'s lookup always hits.
  const shut = opts.entries.filter(
    (e): e is { server: ServerConfig; access: ShutAccess } => !e.access.ok,
  );

  // Most servers declare no `title:`, so the heading IS the slug — printing it
  // again under the heading is noise on the majority of cards. Same rule the
  // landing page's tiles follow (src/ui/landing.ts).
  const card = (server: ServerConfig): string => {
    const title = server.title ?? server.slug;
    const restated =
      title === server.slug ? "" : `<code>${esc(server.slug)}</code>`;
    return `    <a class="card card-link" href="${esc(playgroundHref(server.slug))}">
      <div class="card-head">
        <span class="card-title">${esc(title)}</span>
        <span class="chip">${esc(server.kind)}</span>
      </div>
      ${server.description ? `<p class="card-desc">${esc(server.description)}</p>` : ""}
      <div class="card-foot">${restated}<span class="card-cta">Open →</span></div>
    </a>`;
  };

  const shutRow = (entry: {
    server: ServerConfig;
    access: ShutAccess;
  }): string => {
    const reason =
      entry.access.status === "disabled" ? "disabled" : "not entitled";
    const title = entry.server.title ?? entry.server.slug;
    return `    <div class="card card-shut">
      <div class="card-head">
        <span class="card-title">${esc(title)}</span>
        <span class="chip chip-off">${esc(reason)}</span>
      </div>
      ${title === entry.server.slug ? "" : `<div class="card-foot"><code>${esc(entry.server.slug)}</code></div>`}
    </div>`;
  };

  const body = `
<section class="intro">
  <h1>Playground</h1>
  <p class="lede">A human MCP client, one server at a time. Pick a server and the page
    opens a real MCP session against it — the tools it serves <em>you</em>, and the response
    it gives when you call one. <strong>No model is involved</strong>, and a call runs for
    real against the real upstream.</p>
</section>

<section class="panel">
  <div class="panel-head">
    <h2>Open one</h2>
    <span class="panel-note">${open.length} server${open.length === 1 ? "" : "s"} you may inspect</span>
  </div>
${
  open.length
    ? `  <div class="card-grid">
${open.map((e) => card(e.server)).join("\n")}
  </div>`
    : // Three different facts reach this branch and they need three different
      // answers: a gateway with no `servers:` at all, one whose entries are all
      // switched off, and one whose entries are all granted to some other role.
      // Telling an admin on an empty gateway that their identity has no grants
      // is false, and sends them to edit roles that are not the problem.
      opts.entries.length === 0
      ? `  <p class="empty">This gateway has no servers configured, so there is nothing to
     open. Add one on the connectors page, or in the checked-in config.</p>`
      : shut.every((e) => e.access.status === "disabled")
        ? `  <p class="empty">Every server on this gateway is switched off. A disabled entry
     is not mounted, so there is nothing for a session to open.</p>`
        : `  <p class="empty">Your console identity is granted no server on this gateway, so
     there is nothing here to open. Roles are what decide it — see the servers page.</p>`
}
</section>
${
  shut.length
    ? `
<section class="panel">
  <div class="panel-head">
    <h2>Will not open here</h2>
    <span class="panel-note">configured · not yours, or not running</span>
  </div>
  <div class="card-grid">
${shut.map(shutRow).join("\n")}
  </div>
</section>`
    : ""
}
${PLAYGROUND_INDEX_CSS}`;

  return layout({
    title: "Playground",
    body,
    signedInAs: opts.signedInAs,
    nav: "playground",
    brandHref: "/",
    brandSub: "console",
    footNote: "human MCP client · no model involved",
  });
}

/**
 * The two styles the picker adds: a card that is not a link, and a call to
 * action that stays on the right even when the slug beside it is suppressed.
 */
const PLAYGROUND_INDEX_CSS = `<style>
.card-shut{opacity:.62}
.card-shut .card-title{color:var(--g2)}
.card-foot .card-cta{margin-left:auto}
</style>`;

export interface PlaygroundPageOptions {
  server: ServerConfig;
  signedInAs?: string;
  /** The `?servers=<slug>` URL, for the copy control. Never carries a token. */
  connectUrl: string;
}

export function renderPlayground(opts: PlaygroundPageOptions): string {
  const { server } = opts;
  const slug = server.slug;
  const title = server.title ?? slug;

  const body = `
<section class="intro">
  <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/connectors" class="crumb">connectors</a><span class="crumb-sep">/</span><span class="crumb crumb-current">${esc(title)}</span></nav>
  <h1>Playground <span class="env-badge">${esc(slug)}</span></h1>
  <p class="lede">A human MCP client for this one server. It lists the tools this server
    actually serves you, and calls them with the arguments you type.
    <strong>No model is involved</strong> — you pick the tool, you write the arguments, and
    what comes back is the server's own response.</p>
</section>

<div class="pg-connect">
  <div class="copy-row">
    <input class="copy-url" readonly value="${esc(opts.connectUrl)}"
      aria-label="MCP URL for ${esc(slug)}" />
    <button class="copy-btn" type="button" data-copy>Copy</button>
  </div>
  <p class="copy-note">The URL for this server in another MCP client. It carries
    <strong>no credential</strong> — the client still needs a bearer token
    (<code>npm run token:mint</code>).</p>
</div>

<div id="pg-status" class="pg-status pg-status-busy">Opening an MCP session…</div>

<div class="pg-grid">
  <section class="panel pg-tools">
    <div class="panel-head">
      <h2>Tools</h2>
      <span class="panel-note" id="pg-tool-count"></span>
    </div>
    <div id="pg-tool-list" class="listing"></div>
  </section>

  <section class="panel pg-run">
    <div class="panel-head">
      <h2 id="pg-tool-name">No tool selected</h2>
      <span class="panel-note">arguments · JSON</span>
    </div>
    <p id="pg-tool-desc" class="copy-note">Pick a tool on the left.</p>
    <details id="pg-schema-wrap" class="acc" hidden>
      <summary>Input schema</summary>
      <div class="acc-body"><pre class="acc-code" id="pg-schema"></pre></div>
    </details>
    <textarea id="pg-args" class="pg-args" spellcheck="false" rows="8"
      aria-label="Tool arguments as JSON" disabled>{}</textarea>
    <div class="pg-actions">
      <button id="pg-run" class="btn btn-primary" type="button" disabled>Call tool</button>
      <span id="pg-run-note" class="copy-note">A call runs for real, against the real
        upstream.</span>
    </div>
    <div id="pg-result" class="pg-result" hidden></div>
  </section>
</div>
${PLAYGROUND_CSS}
${playgroundScript(server)}`;

  return layout({
    title: `${slug} · playground`,
    serverSlug: slug,
    body,
    signedInAs: opts.signedInAs,
    nav: "playground",
    brandHref: "/",
    brandSub: "console",
    footNote: "human MCP client · no model involved",
    helpTitle: "Playground guide",
    help: guide(server),
  });
}

/**
 * The help drawer, for the server this page is about.
 *
 * A function rather than a constant because one paragraph is about ONE kind, and
 * prose about a kind that is not in play is noise in a drawer whose whole job is
 * explaining what is in front of the reader. Same rule the page's script follows
 * for its two sentences.
 */
function guide(server: ServerConfig): string {
  return `
  <details class="acc" open>
    <summary>What this is connected to</summary>
    <div class="acc-body">
      <p>A real MCP session — <code>initialize</code>, <code>tools/list</code>,
        <code>tools/call</code> — between an SDK client and the same
        <code>Server</code> object <code>/mcp</code> builds for every request
        (<code>src/gateway/mcpServer.ts</code>). Same selection, same entitlement check, same
        <code>tools:</code> capability policy, same adapters.</p>
      <p>It runs <b>inside this process</b>, over an in-memory transport, and does not cross the
        HTTP boundary. It cannot: <code>/mcp</code> accepts static bearer tokens only, and the
        console holds none. Teaching <code>/mcp</code> to accept a console cookie would put a
        second credential type on the endpoint whose single credential type is the security
        model. So the session stops one layer short of the wire, and this page says so rather
        than claiming a hop it did not make.</p>
    </div>
  </details>
  <details class="acc">
    <summary>Why a tool you expected is missing</summary>
    <div class="acc-body">
      <p>You are shown what you can actually call, not a catalogue. Three filters, in order:</p>
      <ul>
        <li><b>Entitlement</b> — your console identity's roles, intersected with the server's
          <code>entitlements:</code>. A server you cannot reach does not open here at all.</li>
        <li><b>Capability</b> — the slug's <code>tools:</code> allow/deny policy. A read-only
          slug hides its upstream's write tools here exactly as it hides them from an agent,
          and calling one anyway is refused on the action.</li>
        <li><b>The upstream</b> — what the server itself offers right now. An empty list from a
          server that should have tools is the shape a dead upstream makes.</li>
      </ul>
      ${
        server.kind === "local-tunnel"
          ? `<p>This one is a <code>local-tunnel</code>: it runs on a machine somebody owns, and
        that machine is off much of the time by design. While it is, the slug does not fail and
        does not go quiet — it serves a single <code>troubleshoot_host</code> tool with the
        commands to bring the machine back, and this page says so above the list rather than
        reporting a healthy session with one tool in it.</p>`
          : ""
      }
    </div>
  </details>
  <details class="acc">
    <summary>Calls are real</summary>
    <div class="acc-body">
      <p>There is no sandbox. A <code>tools/call</code> from this page reaches the same
        upstream, with the same credentials, as an agent's would — it sends the email, writes
        the row, creates the item. The read-only variant of a slug exists for exactly this
        reason; if one is configured, inspect that.</p>
      <p>What is NOT recorded: the arguments you type and the response you get. The tool-call
        span carries the server slug, the tool name, argument COUNT and byte size, and nothing
        else (<code>src/telemetry/redact.ts</code>). It is tagged
        <code>strad.surface=playground</code> so a human poking at a tool is not confused for
        an agent calling it.</p>
    </div>
  </details>
  <details class="acc">
    <summary>The URL at the top</summary>
    <div class="acc-body">
      <p><code>/mcp?servers=&lt;slug&gt;</code> — the address of this one server through strad,
        for Claude Desktop, Cursor, or any other MCP client. It contains <b>no credential</b>,
        and that is deliberate: a URL ends up in shell history, proxy logs, a
        <code>Referer</code> header and screenshots, all of which outlive the paste. The client
        needs a bearer token as well, minted with <code>npm run token:mint</code> and sent as
        <code>Authorization: Bearer …</code>.</p>
    </div>
  </details>`;
}

/**
 * The page's own client, in plain JS.
 *
 * No build step, no framework — same rule as the rest of the console. It talks
 * to the two POST routes above with `fetch`, which sends the session cookie on a
 * same-origin request and is refused cross-site by SameSite=Lax.
 *
 * Everything the server or an upstream authored is written with `textContent`,
 * never `innerHTML`. A tool description is text from someone else's MCP server
 * and a tool result is arbitrary bytes; neither is ever parsed as HTML.
 */
function playgroundScript(server: ServerConfig): string {
  return `<script>
(function () {
  var SLUG = ${jsonForScript(server.slug)};
  // The slug's KIND, because one kind fails in a way that is not a fault.
  // Nothing else on the page branches on it.
  var KIND = ${jsonForScript(server.kind)};
  var UNAVAILABLE_NOTE = ${jsonForScript(
    server.kind === "local-tunnel" ? degradedSurfaceNote(server.slug) : "",
  )};
  var TIMED_OUT_NOTE = ${jsonForScript(
    server.kind === "local-tunnel" ? ingressTimeoutNote(server.slug) : "",
  )};
  var STATUS_TOKEN = ${jsonForScript(INGRESS_STATUS_TOKEN)};
  // "STRAD WAITED, AND NOTHING CAME" — the shape a wait on a machine that is not
  // there makes when it outlives the patience of whatever sits in front of the
  // app. A 504 is a gateway that gave up waiting on strad; a 524 is a Cloudflare
  // origin that accepted the request and did not answer in time.
  //
  // Deliberately much narrower than the adapter's ORIGIN_UNREACHABLE_STATUSES
  // (src/gateway/adapters/http.ts), which asks a different question one hop
  // further in. A 502, a 503 and a 521/522/523 all mean strad ITSELF was not
  // reached — nothing waited on anybody's laptop — and saying "check that
  // machine" about them points at the wrong machine.
  var TIMED_OUT = { 504: 1, 524: 1 };
  var tools = [];
  var current = null;

  var statusEl = document.getElementById("pg-status");
  var listEl = document.getElementById("pg-tool-list");
  var countEl = document.getElementById("pg-tool-count");
  var nameEl = document.getElementById("pg-tool-name");
  var descEl = document.getElementById("pg-tool-desc");
  var schemaWrap = document.getElementById("pg-schema-wrap");
  var schemaEl = document.getElementById("pg-schema");
  var argsEl = document.getElementById("pg-args");
  var runEl = document.getElementById("pg-run");
  var resultEl = document.getElementById("pg-result");

  function post(path, payload) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload || {})
    }).then(function (r) {
      // NO JSON BODY. These two routes answer JSON for every outcome they reach,
      // including a failure, so this answer came from something in front of
      // them — the platform ingress, a proxy, or the console gate redirecting a
      // session that expired mid-page. Which of those is a question the status
      // answers, not this flag: it records only that nothing here authored the
      // body. The status is kept rather than only rendered, because on a
      // local-tunnel it is the only thing left to reason about (see failure()).
      return r.json().catch(function () {
        return { ok: false, error: "HTTP " + r.status, status: r.status, nonJsonBody: true };
      });
    });
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "pg-status " + cls;
  }

  /**
   * A failed request, in words.
   *
   * The one case worth its own sentence is a request that never reached strad
   * at all: the body was not JSON, so something in front of the app answered,
   * and on a local-tunnel the commonest reason for that is a wait on a machine
   * that is not there. When strad ITSELF answers, its message is already its
   * own — it names the machine and the commands — so it is printed as it
   * arrived. Everything else keeps the wording it had.
   */
  function failure(res) {
    if (KIND === "local-tunnel" && res.nonJsonBody && TIMED_OUT[res.status]) {
      return {
        label: "Host machine is not answering",
        text: TIMED_OUT_NOTE.replace(STATUS_TOKEN, String(res.status)),
        warn: true
      };
    }
    return { label: "Call failed", text: res.error || "unknown error", warn: false };
  }

  /** A starting point for the argument editor, from the tool's own schema. */
  function skeleton(schema) {
    var out = {};
    if (!schema || typeof schema !== "object") return out;
    var props = schema.properties || {};
    var required = Array.isArray(schema.required) ? schema.required : [];
    for (var i = 0; i < required.length; i++) {
      var key = required[i];
      var spec = props[key] || {};
      out[key] = spec.type === "number" || spec.type === "integer" ? 0
        : spec.type === "boolean" ? false
        : spec.type === "array" ? []
        : spec.type === "object" ? {}
        : "";
    }
    return out;
  }

  function select(tool) {
    current = tool;
    nameEl.textContent = tool.bare;
    descEl.textContent = tool.description || "This tool declares no description.";
    schemaEl.textContent = JSON.stringify(tool.inputSchema, null, 2);
    schemaWrap.hidden = false;
    argsEl.value = JSON.stringify(skeleton(tool.inputSchema), null, 2);
    argsEl.disabled = false;
    runEl.disabled = false;
    resultEl.hidden = true;
    var buttons = listEl.querySelectorAll("[data-tool]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle("is-current", buttons[i].getAttribute("data-tool") === tool.name);
    }
  }

  function renderTools() {
    listEl.textContent = "";
    countEl.textContent = tools.length + (tools.length === 1 ? " tool" : " tools");
    if (!tools.length) {
      var empty = document.createElement("p");
      empty.className = "copy-note";
      empty.textContent =
        "This server served no tools. That is not the same as a server with nothing to offer — " +
        "an upstream that is down lists empty too.";
      listEl.appendChild(empty);
      return;
    }
    tools.forEach(function (tool) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pg-tool";
      btn.setAttribute("data-tool", tool.name);
      var name = document.createElement("span");
      name.className = "pg-tool-name";
      name.textContent = tool.bare;
      var desc = document.createElement("span");
      desc.className = "pg-tool-desc";
      desc.textContent = tool.description || "";
      btn.appendChild(name);
      btn.appendChild(desc);
      btn.addEventListener("click", function () { select(tool); });
      listEl.appendChild(btn);
    });
  }

  function block(label, text, cls) {
    var wrap = document.createElement("div");
    wrap.className = "pg-block";
    var head = document.createElement("div");
    head.className = "pg-block-head " + (cls || "");
    head.textContent = label;
    var pre = document.createElement("pre");
    pre.className = "acc-code";
    pre.textContent = text;
    wrap.appendChild(head);
    wrap.appendChild(pre);
    return wrap;
  }

  function renderResult(res) {
    resultEl.textContent = "";
    resultEl.hidden = false;

    if (!res.ok) {
      var f = failure(res);
      resultEl.appendChild(block(f.label, f.text, f.warn ? "pg-warn" : "pg-bad"));
      if (res.detail) resultEl.appendChild(block("Detail", res.detail, "pg-bad"));
      return;
    }

    var result = res.result || {};
    var isError = result.isError === true;
    var head = document.createElement("p");
    head.className = "pg-verdict " + (isError ? "pg-bad" : "pg-ok");
    head.textContent = (isError ? "isError: true" : "isError: false") +
      " · " + ((result.content || []).length) + " content block(s) · " + res.elapsedMs + " ms";
    resultEl.appendChild(head);

    (result.content || []).forEach(function (item, i) {
      var label = "content[" + i + "] · " + (item.type || "unknown");
      var text = item.type === "text" && typeof item.text === "string"
        ? item.text
        : JSON.stringify(item, null, 2);
      resultEl.appendChild(block(label, text, isError ? "pg-bad" : ""));
    });

    if (result.structuredContent) {
      resultEl.appendChild(
        block("structuredContent", JSON.stringify(result.structuredContent, null, 2), "")
      );
    }
    resultEl.appendChild(block("raw JSON-RPC result", JSON.stringify(result, null, 2), ""));
  }

  runEl.addEventListener("click", function () {
    if (!current) return;
    var args;
    try {
      args = argsEl.value.trim() === "" ? {} : JSON.parse(argsEl.value);
    } catch (e) {
      resultEl.textContent = "";
      resultEl.hidden = false;
      resultEl.appendChild(block("Arguments are not valid JSON", String(e), "pg-bad"));
      return;
    }
    runEl.disabled = true;
    runEl.textContent = "Calling…";
    post("/playground/" + encodeURIComponent(SLUG) + "/tools/call", {
      tool: current.name,
      arguments: args
    }).then(function (res) {
      renderResult(res);
    }).catch(function (err) {
      renderResult({ ok: false, error: String(err) });
    }).then(function () {
      runEl.disabled = false;
      runEl.textContent = "Call tool";
    });
  });

  post("/playground/" + encodeURIComponent(SLUG) + "/tools/list", {}).then(function (res) {
    if (!res.ok) {
      var f = failure(res);
      setStatus(
        f.warn ? f.text : "Could not open a session: " + f.text,
        f.warn ? "pg-status-warn" : "pg-status-bad"
      );
      if (res.detail) {
        var p = document.createElement("p");
        p.className = "copy-note";
        p.textContent = res.detail;
        statusEl.appendChild(p);
      }
      return;
    }
    tools = res.tools || [];
    // A LISTING THAT SUCCEEDED IS NOT ALWAYS A SERVER THAT IS SERVING. One tool,
    // strad's own, is what a local-tunnel offers while its machine is not there
    // — and reporting that as "1 tool(s) served to you" in the healthy tone
    // drops the distinction this kind exists to make.
    setStatus(
      res.hostUnavailable
        ? UNAVAILABLE_NOTE
        : "MCP session open · initialize answered by " + res.session.serverName +
          " " + res.session.serverVersion + " · transport: " + res.session.transport +
          " · " + tools.length + " tool(s) served to you",
      res.hostUnavailable ? "pg-status-warn" : "pg-status-ok"
    );
    renderTools();
  }).catch(function (err) {
    setStatus("Could not open a session: " + String(err), "pg-status-bad");
  });

  // The copy control for the connect URL, same behaviour as the landing page.
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-copy]");
    if (!btn) return;
    var input = btn.parentElement.querySelector(".copy-url");
    var text = btn.getAttribute("data-url") || (input && input.value);
    if (!text) return;
    if (input) input.select();
    var done = function () {
      var was = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = was; }, 1200);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(done, function () {});
    } else if (input && document.execCommand("copy")) {
      done();
    }
  });
})();
</script>
<noscript><p class="posture posture-warn">The playground needs JavaScript: it opens an MCP
  session and renders the response. The URL above is still copyable by hand, and the console
  index works without JS.</p></noscript>`;
}

const PLAYGROUND_CSS = `<style>
.pg-connect{margin:0 0 1.2rem}
.pg-status{font-family:var(--font-mono);font-size:.76rem;padding:.6rem .8rem;border-radius:.4rem;
  border:1px solid var(--g5);background:var(--g6);color:var(--g2);margin:0 0 1.2rem;line-height:1.6}
.pg-status-ok{border-color:color-mix(in srgb,var(--accent) 45%,var(--g5));color:var(--text-accent)}
.pg-status-bad{border-color:color-mix(in srgb,#e8776b 45%,var(--g5));color:#e8776b}
.pg-status-warn{border-color:color-mix(in srgb,#e0a63b 45%,var(--g5));color:#e0a63b}
.pg-status-busy{color:var(--g3)}
.pg-grid{display:grid;grid-template-columns:minmax(0,20rem) minmax(0,1fr);gap:1.1rem;align-items:start}
@media (max-width:900px){.pg-grid{grid-template-columns:1fr}}
.pg-tools .listing{display:flex;flex-direction:column;gap:.3rem;max-height:34rem;overflow:auto}
.pg-tool{display:flex;flex-direction:column;gap:.2rem;text-align:left;cursor:pointer;
  background:none;border:1px solid transparent;border-radius:.4rem;padding:.5rem .6rem;color:inherit;
  font-family:inherit}
.pg-tool:hover{border-color:var(--g5);background:var(--g6)}
.pg-tool:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.pg-tool.is-current{border-color:color-mix(in srgb,var(--accent) 55%,var(--g5));background:var(--g6)}
.pg-tool-name{font-family:var(--font-mono);font-size:.8rem;color:var(--white)}
.pg-tool-desc{font-size:.74rem;color:var(--g3);line-height:1.45;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pg-args{width:100%;box-sizing:border-box;margin:.7rem 0 0;padding:.6rem .7rem;border-radius:.4rem;
  border:1px solid var(--g5);background:var(--g7);color:var(--g1);font-family:var(--font-mono);
  font-size:.78rem;line-height:1.6;resize:vertical}
.pg-args:focus{outline:2px solid var(--accent);outline-offset:1px}
.pg-actions{display:flex;align-items:center;gap:.8rem;flex-wrap:wrap;margin:.7rem 0 0}
.pg-actions .copy-note{margin:0}
.pg-result{margin:1rem 0 0;border-top:1px solid var(--g6);padding:.8rem 0 0}
.pg-verdict{font-family:var(--font-mono);font-size:.76rem;margin:0 0 .6rem}
.pg-ok{color:var(--text-accent)}
.pg-bad{color:#e8776b}
.pg-warn{color:#e0a63b}
.pg-block{margin:0 0 .7rem}
.pg-block-head{font-family:var(--font-mono);font-size:.7rem;color:var(--g4);
  text-transform:uppercase;letter-spacing:.05em;margin:0 0 .3rem}
.pg-block .acc-code{white-space:pre-wrap;word-break:break-word;max-height:24rem;overflow:auto}
</style>`;
