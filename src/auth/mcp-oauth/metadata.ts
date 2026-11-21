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
 * The scope that means "everything this client's ceiling grants".
 *
 * A scope on this server can only NARROW. The ceiling is server-side config —
 * the client's role ceiling and optional slug allowlist
 * (`src/auth/mcp-oauth/policy.ts`), intersected with the two-way entitlement on
 * every request (`src/gateway/entitlements.ts`). `mcp`, or no scope, asks for
 * all of it; `slug:<name>` scopes ask for those slugs only, and the token is
 * then confined to them. No scope value adds anything the ceiling does not
 * already reach.
 */
export const MCP_SCOPE = "mcp";

/** RFC 8693 §2.1: the token-exchange grant type. */
export const TOKEN_EXCHANGE_GRANT =
  "urn:ietf:params:oauth:grant-type:token-exchange";

/** RFC 8693 §3: the one token type strad exchanges from and issues. */
export const ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

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
  /** Absent when `auth.mcpOAuth.dynamicRegistration` is false. */
  registration_endpoint?: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  /** Present only when `private_key_jwt` is advertised. */
  token_endpoint_auth_signing_alg_values_supported?: string[];
  revocation_endpoint_auth_methods_supported: string[];
  /** Present only when `private_key_jwt` is advertised. */
  revocation_endpoint_auth_signing_alg_values_supported?: string[];
  scopes_supported: string[];
  service_documentation: string;
  /** RFC 9207: every authorization response carries `iss`. */
  authorization_response_iss_parameter_supported: true;
  /**
   * `draft-ietf-oauth-client-id-metadata-document`: an `https` URL is accepted
   * as a `client_id` without registering first (`cimd.ts`). The MCP spec has a
   * client that sees this prefer it over `registration_endpoint`.
   */
  client_id_metadata_document_supported: true;
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
 * here is a PUBLIC client by default: an MCP client registers itself
 * dynamically and runs where its user can read it, so a client secret it was
 * handed would be a secret in a browser. PKCE is what binds the code to the
 * client instead. A deployment that turns on `private_key_jwt`
 * (`client-auth.ts`) advertises it beside `none`, with its algorithm list, on
 * both the token and the revocation endpoint — and only then, so a deployment
 * that has not turned it on publishes the document it always did.
 */
export function authorizationServerMetadata(
  origin: string,
  opts: {
    scopes?: string[];
    registration?: boolean;
    /** The signing algorithms, when `private_key_jwt` is on. */
    privateKeyJwtAlgs?: readonly string[];
    /** Some client may use RFC 8693 token exchange. */
    tokenExchange?: boolean;
  } = {},
): AuthorizationServerMetadata {
  const methods = opts.privateKeyJwtAlgs
    ? ["none", "private_key_jwt"]
    : ["none"];
  const algs = opts.privateKeyJwtAlgs ? [...opts.privateKeyJwtAlgs] : undefined;
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    ...(opts.registration === false
      ? {}
      : { registration_endpoint: `${origin}${REGISTER_PATH}` }),
    revocation_endpoint: `${origin}${REVOKE_PATH}`,
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      ...(opts.tokenExchange ? [TOKEN_EXCHANGE_GRANT] : []),
    ],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: methods,
    ...(algs ? { token_endpoint_auth_signing_alg_values_supported: algs } : {}),
    revocation_endpoint_auth_methods_supported: [...methods],
    ...(algs
      ? { revocation_endpoint_auth_signing_alg_values_supported: [...algs] }
      : {}),
    scopes_supported: opts.scopes ?? [MCP_SCOPE],
    service_documentation: SERVICE_DOCUMENTATION,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}
