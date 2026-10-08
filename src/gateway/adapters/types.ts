import type {
  Tool,
  Resource,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import type { RuntimeConfig } from "../../config/runtime.ts";
import type { WritingPrincipal } from "../../config/overlay.ts";
import type { ServerKind } from "../../config/schema.ts";
import type { ClientCapabilities } from "../clientCapabilities.ts";
import type { ElicitationChannel } from "../elicitation.ts";
import type { LocalHost } from "../troubleshoot.ts";

/**
 * A mounted MCP server, from the gateway's point of view.
 *
 * Every config kind collapses to this. The gateway does not know or care which
 * it is talking to; that is the whole point of the abstraction.
 */
export interface ServerAdapter {
  readonly slug: string;
  readonly kind: ServerKind;

  /**
   * The machine this server runs on, when it runs on one somebody owns.
   *
   * Set for `local-tunnel` and for nothing else, which is what makes it the
   * test for "may this slug degrade to a troubleshooting tool instead of
   * failing a listing" (see gateway/troubleshoot.ts). A kind that strad
   * deploys, or a third party's URL, has no machine anyone can go and switch
   * on, so it has none of this.
   */
  readonly host?: LocalHost;

  /** Tools this server offers, WITHOUT the `<slug>__` prefix. */
  listTools(): Promise<Tool[]>;

  /** Call a tool by its bare (unprefixed) name. */
  callTool(
    name: string,
    args: Record<string, unknown>,
    ctx?: CallContext,
  ): Promise<CallToolResult>;

  /**
   * Resources this server offers (e.g. an MCP App's `ui://` template).
   *
   * OPTIONAL: a server that serves no resources — every builtin today — simply
   * omits this. The gateway treats a missing method as "no resources", which is
   * how MCP Apps stay strictly additive: nothing about resource proxying touches
   * a tools-only server.
   */
  listResources?(): Promise<Resource[]>;

  /** Read one resource by URI. Present exactly when `listResources` is. */
  readResource?(uri: string): Promise<ReadResourceResult>;

  /**
   * Proxy a non-MCP POST to this upstream. Present only for supplementary
   * images that expose a signed data-plane route beside MCP.
   */
  postRaw?(path: string, req: Request, res: Response): Promise<void>;

  /**
   * Proxy a non-MCP GET to this upstream, STREAMING the response body.
   *
   * The mirror of {@link postRaw}, and deliberately not a variant of it: that
   * one buffers, which is right for an upload bounded at 100MB and wrong for a
   * download of unknown size. This one pipes, so the gateway's memory does not
   * scale with the artifact.
   *
   * The gateway verifies nothing here — the upstream owns the token it signed.
   */
  getRaw?(path: string, req: Request, res: Response): Promise<void>;

  /** Release upstream connections. */
  close(): Promise<void>;
}

/**
 * Per-request context threaded from the gateway into a server call.
 *
 * Today it carries the client's advertised capabilities, so an in-process server
 * can vary behaviour by what the client asked for (e.g. an MCP App). It is
 * optional and additive — a server that ignores it behaves exactly as before.
 */
export interface CallContext {
  clientCapabilities?: ClientCapabilities;
  /**
   * Who authenticated this request, reduced to what a bound reads of them.
   *
   * Threaded for the roster editor (src/servers/connectors.ts), whose writes are
   * bounded by what their author can already reach — `assertWithinReach` in
   * src/config/overlay.ts. Nothing else reads it, and it grants nothing: the
   * question "may this caller reach these slugs" was answered before this
   * request reached an adapter at all.
   */
  principal?: WritingPrincipal;
  /**
   * Where a human confirms this call, as the caller named it and core checked
   * it — or why core refused it. Undefined when the caller named none, which a
   * confirmed tool turns into a refusal. Only the HTTP adapter for a
   * `supplementary-image` slug with `confirmations: true` forwards it; see
   * src/gateway/elicitation.ts.
   */
  elicitation?: ElicitationChannel;
}

export interface CallToolResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * The interface a `builtin` module must default-export.
 *
 * This is how internal/private servers (tadasant-internal) plug into the same
 * config surface as public ones — same `servers:` list, same entitlements, same
 * namespacing. Nothing about a builtin is privileged.
 */
export interface BuiltinModule {
  tools: Tool[];
  /**
   * The tools this builtin actually offers, when that depends on what the
   * PROCESS can do rather than on what the module implements.
   *
   * Optional, and `tools` is the answer when it is absent — which is every
   * builtin that has a fixed surface. The one that does not is the connector
   * editor (src/servers/connectors.ts): its write tools exist only where this
   * gateway holds a credential that can persist a roster change, and a tool
   * that is listed and then refuses every call is worse than one that is not
   * listed. That is the same shape the `secrets` server derives from its IAM
   * probe, and for the same reason.
   *
   * It is handed a NARROWED context — no `options` — because a tool list is
   * metadata and must not be able to fail on a secret-store outage. See the
   * note on BuiltinServerAdapter's `options` thunk.
   */
  visibleTools?(ctx: Omit<BuiltinContext, "options">): Tool[];
  call(
    name: string,
    args: Record<string, unknown>,
    ctx: BuiltinContext,
  ): Promise<CallToolResult>;
}

export interface BuiltinContext {
  /** Config `options:` for this server, with `${SECRET}` refs already resolved. */
  options: Record<string, unknown>;
  /**
   * Which strad process is hosting this builtin.
   *
   * Passed in rather than read from process.env by the builtin itself, so that
   * a builtin is a pure function of its inputs — and so two of them can be
   * exercised in one test process without lying about where they live.
   */
  component: {
    mode: "core" | "bundle";
    bundle: string;
    hostname: string;
  };
  /**
   * The process's mutable server roster, when it has one.
   *
   * A thunk and nullable, both deliberately. Nullable because
   * `gateway.configStore:` is off by default and a builtin that needs it must
   * say so rather than assume. A THUNK because the roster holder is built after
   * the registry it is handed to — it owns the rebuild, and the rebuild is what
   * produces the registry — so there is nothing to capture at build time.
   *
   * The import is type-only, which is what keeps a gateway module from pulling
   * the config layer's dependency tree in at runtime.
   */
  runtime?: () => RuntimeConfig | null;
  /**
   * The MCP client's advertised capabilities, read from the `initialize` request
   * (see clientCapabilities.ts). A builtin can use this to opt into MCP-App
   * behaviour for clients that advertised `io.modelcontextprotocol/ui`.
   *
   * Undefined when the current request carried none — which, given strad's
   * session-less endpoint, is every request except `initialize`.
   */
  clientCapabilities?: ClientCapabilities;
  /**
   * Who authenticated the request this call is serving. See {@link CallContext}.
   *
   * Optional in the type and supplied by both doors in practice: `/mcp`
   * (src/gateway/router.ts) and the console playground (src/ui/playground.ts)
   * each build their gateway server with the principal they authenticated.
   */
  principal?: WritingPrincipal;
}

/** The separator between a server slug and its tool name: `good-eggs__search`. */
export const NS = "__";

export function namespaced(slug: string, tool: string): string {
  return `${slug}${NS}${tool}`;
}

/**
 * Split `good-eggs__search_products` -> ["good-eggs", "search_products"].
 *
 * Tool names legitimately contain underscores, so we split on the FIRST `__`
 * only and rejoin the rest. Slugs cannot contain `_` (see the schema regex),
 * which is what makes this unambiguous.
 */
export function denamespace(
  name: string,
): { slug: string; tool: string } | null {
  const i = name.indexOf(NS);
  if (i <= 0) return null;
  const slug = name.slice(0, i);
  const tool = name.slice(i + NS.length);
  if (!tool) return null;
  return { slug, tool };
}
