import type {
  Tool,
  Resource,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ClientCapabilities } from "../clientCapabilities.ts";

/**
 * A mounted MCP server, from the gateway's point of view.
 *
 * All three config kinds — remote-http, supplementary-image, builtin — collapse
 * to this. The gateway does not know or care which it is talking to; that is
 * the whole point of the abstraction.
 */
export interface ServerAdapter {
  readonly slug: string;
  readonly kind: "remote-http" | "supplementary-image" | "builtin";

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
   * The MCP client's advertised capabilities, read from the `initialize` request
   * (see clientCapabilities.ts). A builtin can use this to opt into MCP-App
   * behaviour for clients that advertised `io.modelcontextprotocol/ui`.
   *
   * Undefined when the current request carried none — which, given strad's
   * session-less endpoint, is every request except `initialize`.
   */
  clientCapabilities?: ClientCapabilities;
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
