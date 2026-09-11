/**
 * RFC 8414 authorization-server metadata, and the RFC 8707 resource identifier
 * the tokens it describes are bound to.
 *
 * ## The issuer is the origin, and the endpoints hang off it
 *
 * strad mounts everything at the root of one origin, so the issuer is that
 * origin with no path — which means the RFC 8414 §3 metadata URL is the plain
 * `/.well-known/oauth-authorization-server`, with no issuer path to suffix. The
 * path-suffixed variant is served anyway, at `…/oauth-authorization-server/mcp`,
 * because that is the first URL the MCP SDK probes when the protected resource
 * lives at `/mcp` — it inserts the well-known string between the host and the
 * RESOURCE's path before it falls back to the bare one. Same document from
 * both; the authorization server strad is describing does not change with the
 * path the question arrived on.
 *
 * ## `resource=` and `?servers=`
 *
 * The URL a human pastes into a client is
 * `https://strad.tadasant.com/mcp?servers=granola`. The RFC 8707 resource
 * indicator for it is `https://strad.tadasant.com/mcp` — §2 requires an
 * absolute URI without a fragment, and RECOMMENDS omitting the query. Clients
 * do both: some send the URL they were given, query and all, and some send the
 * canonical form.
 *
 * strad's `?servers=` is a SELECTION HINT, never an authorization boundary
 * (`src/gateway/entitlements.ts`) — so two requests to the same endpoint with
 * different `?servers=` are the same resource, and a token minted for one must
 * work at the other. `canonicalResource()` is the one spelling of that resource,
 * and `resourceMatches()` normalises an indicator to it by dropping the query
 * and the fragment before comparing. Every audience decision in this directory
 * goes through those two functions and never through `req.originalUrl`, which
 * is what keeps a `?servers=granola` URL from being rejected by the audience
 * check for a query the indicator did not carry.
 */

import { resourceIdentifier } from "../protected-resource.ts";

/** Mounted under this prefix, all of it. */
export const OAUTH_PREFIX = "/oauth";

export const AUTHORIZE_PATH = `${OAUTH_PREFIX}/authorize`;
export const APPROVE_PATH = `${OAUTH_PREFIX}/approve`;
export const TOKEN_PATH = `${OAUTH_PREFIX}/token`;
export const REGISTER_PATH = `${OAUTH_PREFIX}/register`;
export const REVOKE_PATH = `${OAUTH_PREFIX}/revoke`;
/** Where Google sends the browser back. Registered in the Google OAuth client. */
export const GOOGLE_CALLBACK_PATH = `${OAUTH_PREFIX}/callback/google`;

/** The RFC 8414 well-known prefix. */
const WELL_KNOWN = "/.well-known/oauth-authorization-server";

/** The two paths the document is served from, in the order a client tries them. */
export const AUTHORIZATION_SERVER_ROUTES: readonly string[] = [
  `${WELL_KNOWN}/mcp`,
  WELL_KNOWN,
];

/**
 * The one scope strad issues. It is not a capability — what a principal may
 * reach is decided by `roles` and the two-way entitlement, server-side, on
 * every request (`src/gateway/entitlements.ts`). It exists so a client that
 * insists on asking for something has something to ask for.
 */
export const MCP_SCOPE = "mcp";

/**
 * The resource identifier a token issued by this server is bound to: the `/mcp`
 * endpoint of `origin`, with no query and no fragment, ever.
 *
 * The same function the RFC 9728 document uses for its `resource` member, so
 * the two documents cannot name the endpoint differently.
 */
export function canonicalResource(origin: string): string {
  return resourceIdentifier(origin);
}

/**
 * Does a client-supplied `resource=` name this gateway's `/mcp`?
 *
 * Query and fragment are dropped before comparing — see the header. Anything
 * that is not a parseable absolute URI is a no rather than a throw.
 */
export function resourceMatches(candidate: string, origin: string): boolean {
  return normalizeResource(candidate) === canonicalResource(origin);
}

/** A resource indicator with its query and fragment removed, or null. */
export function normalizeResource(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  url.search = "";
  url.hash = "";
  // `new URL("https://h/mcp").href` is "https://h/mcp", but a trailing slash
  // survives — and `https://h/mcp/` is a different resource identifier from
  // `https://h/mcp`. A client that adds one means the endpoint it was given,
  // so it is normalised away rather than refused.
  return url.href.replace(/\/$/, "");
}

/** RFC 8414 §2 members, restricted to the ones strad can answer truthfully. */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  revocation_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
  service_documentation: string;
  /** RFC 9207: every authorization response carries `iss`. */
  authorization_response_iss_parameter_supported: true;
}

const SERVICE_DOCUMENTATION = "https://docs.strad.tadasant.com/auth/overview/";

/**
 * The document, for a deployment whose public origin is `origin`.
 *
 * `code_challenge_methods_supported` is `["S256"]` and not `["S256", "plain"]`:
 * advertising `plain` would be advertising a downgrade, and `/authorize`
 * refuses it outright. Omitting the member entirely would be worse than either
 * — RFC 8414 §2 says its absence means the server does not support PKCE at all,
 * which would tell an OAuth 2.1 client to give up.
 *
 * `token_endpoint_auth_methods_supported` is `["none"]` because every client
 * here is a PUBLIC client: an MCP client registers itself dynamically and runs
 * where its user can read it, so a client secret it was handed would be a
 * secret in a browser. PKCE is what binds the code to the client instead.
 */
export function authorizationServerMetadata(
  origin: string,
): AuthorizationServerMetadata {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    registration_endpoint: `${origin}${REGISTER_PATH}`,
    revocation_endpoint: `${origin}${REVOKE_PATH}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE],
    service_documentation: SERVICE_DOCUMENTATION,
    authorization_response_iss_parameter_supported: true,
  };
}
