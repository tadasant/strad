/**
 * Surfacing the MCP client's advertised capabilities into the gateway.
 *
 * A client declares what it can do in its `initialize` capabilities — including,
 * for MCP Apps, an OPT-IN entry under `capabilities.extensions`
 * (`io.modelcontextprotocol/ui`). strad is a gateway: it terminates the client's
 * MCP connection and re-issues calls to upstream servers. Two things follow, and
 * this module owns both:
 *
 *   1. READ the client's capabilities off the RAW `initialize` body. A strict
 *      schema parse can drop unknown keys, and the whole point of `extensions`
 *      is that it carries keys the core schema doesn't know — so we read the
 *      untouched object.
 *
 *   2. FORWARD an MCP-Apps-capable posture to upstreams. strad renders nothing
 *      itself; it relays an app-server's `ui://` resource to the client. So the
 *      gateway advertises the UI extension to its upstreams unconditionally
 *      (`GATEWAY_UPSTREAM_CAPABILITIES`), which lets an app-server like good-eggs
 *      offer its app to the gateway. Whether a given END client actually renders
 *      it is decided by that client (it only renders if IT advertised the
 *      extension) and, authoritatively, by the app-owning server.
 *
 * NB on statelessness: strad's /mcp endpoint is deliberately session-less (it
 * derives the toolset per request, never from session state — see router.ts).
 * Capabilities therefore travel on the `initialize` request only; a later
 * tools/call POST carries none. Consumers must treat `clientCapabilities` as
 * "present on initialize, otherwise undefined" rather than a per-session value.
 */

/**
 * The MCP Apps extension key. A client advertises it under
 * `capabilities.extensions` to say "I can render inline UI".
 */
export const UI_APPS_EXTENSION = "io.modelcontextprotocol/ui";

/**
 * A permissive, structural view of a client's advertised capabilities. We only
 * ever inspect `extensions`; everything else rides along untouched.
 */
export interface ClientCapabilities {
  extensions?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Extract `params.capabilities` from a raw JSON-RPC `initialize` body, without a
 * schema parse so opt-in `extensions` keys survive. Returns undefined for any
 * body that is not an initialize carrying an object of capabilities.
 */
export function clientCapabilitiesFromInitialize(
  body: unknown,
): ClientCapabilities | undefined {
  const caps = (
    body as
      { method?: unknown; params?: { capabilities?: unknown } } | undefined
  )?.params?.capabilities;
  return caps && typeof caps === "object"
    ? (caps as ClientCapabilities)
    : undefined;
}

/**
 * Did the client advertise the MCP Apps extension? True only when the exact key
 * is present under `capabilities.extensions` (the value may be `{}`, so we test
 * key presence, not truthiness).
 */
export function clientSupportsUiApps(
  capabilities: ClientCapabilities | undefined,
): boolean {
  const extensions = capabilities?.extensions;
  return Boolean(
    extensions &&
    typeof extensions === "object" &&
    Object.prototype.hasOwnProperty.call(extensions, UI_APPS_EXTENSION),
  );
}

/**
 * What the gateway advertises to its UPSTREAM MCP servers when it connects as a
 * client. It declares MCP-Apps capability so an app-server offers its `ui://`
 * resource + tool `_meta` to the gateway, which the gateway then relays to the
 * end client. Constant (not per-end-client), so it is safe to cache one upstream
 * connection across every request.
 */
export const GATEWAY_UPSTREAM_CAPABILITIES: ClientCapabilities = {
  extensions: { [UI_APPS_EXTENSION]: {} },
};
