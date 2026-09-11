/**
 * RFC 9728 protected-resource metadata for `/mcp`.
 *
 * The gap this closes is DISCOVERY, not a new credential. `/mcp` accepted, and
 * still accepts, exactly one thing: a static `strad_<env>_<pubid>_<secret>`
 * token in `Authorization: Bearer …` (see `src/auth/tokens.ts`). What it could
 * not do was SAY so. A bare `401` and a `404` at every well-known path is
 * indistinguishable, from the outside, from a gateway whose OAuth is merely
 * misconfigured — so a client that speaks the MCP authorization spec had
 * nowhere to go after the refusal, and the only way to learn the rule was to be
 * told it out of band.
 *
 * So this module is the answer to "what are you, and how do I present a
 * credential to you", and nothing else. It mints no token, verifies none, and
 * is on no code path that decides whether a request is authenticated.
 *
 * ## `authorization_servers` names one, or is absent
 *
 * RFC 9728 §2 makes the member optional, and whether strad can answer it is a
 * property of the DEPLOYMENT rather than of this module. When
 * `auth.mcpOAuth` is configured and usable, strad IS the authorization server
 * for `/mcp` (`src/auth/mcp-oauth/`, mounted by `src/http/oauth.ts`), the
 * issuer is this same origin, and naming it is what turns the `401` into a
 * flow a client can actually walk.
 *
 * When it is NOT — no `enabled`, no Google OAuth client, no signing key — the
 * member stays absent, and that is not a formality. Advertising an issuer whose
 * `/authorize` is a `404`, or whose tokens `/mcp` would refuse, is a worse lie
 * than the `404` this document replaced: a client would run a whole consent
 * flow and be `401`ed with a valid access token at the end of it. So the caller
 * passes the issuer it has, or nothing, and this module repeats exactly that.
 *
 * The static `strad_<env>_<pubid>_<secret>` token keeps working either way, and
 * `bearer_methods_supported` says so for both credentials at once: strad reads
 * the header, and only the header.
 *
 * ## Where the two halves meet
 *
 * The `resource_metadata` parameter on `/mcp`'s `401` (see
 * `src/gateway/router.ts`) must point at the URL this document is served from,
 * or the pointer is decoration. `resourceMetadataUrl()` is the route string
 * `PROTECTED_RESOURCE_ROUTES[0]` appended to the origin — the header is built
 * from the path the route is mounted on, not from a second spelling of it.
 */

import type { Request } from "express";

/** The RFC 9728 well-known prefix. */
const WELL_KNOWN = "/.well-known/oauth-protected-resource";

/** The path of the resource described. strad serves one, and this is it. */
const MCP_PATH = "/mcp";

/**
 * The two paths the document is served from, in the order a client tries them.
 *
 * RFC 9728 §3.1 forms the metadata URL by inserting the well-known string
 * BETWEEN the host and the resource's path — so the resource `https://host/mcp`
 * is described at `https://host/.well-known/oauth-protected-resource/mcp`, and
 * that is the canonical one. The bare root path is served too because it is the
 * MCP SDK's documented fallback when the path-aware probe `404`s
 * (`discoverMetadataWithFallback` in its client), and because it is the path a
 * human reaches for — it is the one the issue's `curl` tried. Same document
 * from both: the resource strad is describing does not change with the path the
 * question arrived on.
 */
export const PROTECTED_RESOURCE_ROUTES: readonly string[] = [
  `${WELL_KNOWN}${MCP_PATH}`,
  WELL_KNOWN,
];

/** RFC 9728 §2 members, restricted to the ones strad can answer truthfully. */
export interface ProtectedResourceMetadata {
  /** REQUIRED. The resource identifier — strad's `/mcp` endpoint. */
  resource: string;
  /** Human-readable name of the resource. `gateway.name` from the config. */
  resource_name: string;
  /**
   * The issuers whose access tokens `/mcp` accepts. strad is its own, when it
   * is running one at all — hence a one-element array or an absent member,
   * never a list of somebody else's.
   */
  authorization_servers?: string[];
  /** The scopes that issuer issues. Absent when there is no issuer. */
  scopes_supported?: string[];
  /**
   * `header` and only `header`. strad reads the credential from
   * `Authorization` and from nowhere else — never a `?access_token=` query
   * parameter, never a form body. Saying so is the one piece of protocol advice
   * this document can give that is unambiguously true today.
   */
  bearer_methods_supported: string[];
  /** Where the credential actually comes from, in prose. */
  resource_documentation: string;
}

/**
 * strad's own documentation, not the deployment's. The page it points at is the
 * one that states what `/mcp` accepts and how to mint it, which is the question
 * a client hitting the `401` is really asking.
 */
const RESOURCE_DOCUMENTATION = "https://docs.strad.tadasant.com/auth/overview/";

/**
 * The resource identifier: the `/mcp` endpoint, absolute.
 *
 * `origin` is a bare http(s) origin — what `metadataBaseUrl` returns and
 * nothing else — because strad mounts `/mcp` at the root of whatever origin it
 * is on, and this is the one place the deployment says so to a client.
 */
export function resourceIdentifier(origin: string): string {
  return `${origin}${MCP_PATH}`;
}

/**
 * Where the document lives — the RFC 9728 path-inserted form.
 *
 * This is what goes in `resource_metadata` on the `401`. A client handed this
 * URL fetches it directly and does no fallback probing at all, so it is the
 * canonical form rather than the convenience one. It is the mounted route
 * appended to the origin, so the pointer and the route cannot spell the path
 * differently.
 */
export function resourceMetadataUrl(origin: string): string {
  return `${origin}${PROTECTED_RESOURCE_ROUTES[0]}`;
}

/**
 * The document, for a deployment whose public origin is `origin`.
 *
 * `authorizationServer` is the issuer to advertise, or null when this
 * deployment runs none — see the header. It is passed in rather than derived
 * here so that ONE resolution of "is the OAuth flow usable" (`resolveMcpOAuth`)
 * decides what this document says, what the well-known metadata route serves
 * and which credentials `/mcp` accepts.
 */
export function protectedResourceMetadata(
  origin: string,
  name: string,
  authorizationServer?: { issuer: string; scopes: string[] } | null,
): ProtectedResourceMetadata {
  return {
    resource: resourceIdentifier(origin),
    resource_name: name,
    ...(authorizationServer
      ? {
          authorization_servers: [authorizationServer.issuer],
          scopes_supported: authorizationServer.scopes,
        }
      : {}),
    bearer_methods_supported: ["header"],
    resource_documentation: RESOURCE_DOCUMENTATION,
  };
}

/**
 * Every character RFC 3986 allows in a URI, and nothing else.
 *
 * The two that matter are `"` and `\`. The origin is interpolated into a
 * `quoted-string` on the `401`'s `WWW-Authenticate` (RFC 9110 §5.6.4), so a
 * quote inside it ends the parameter early and leaves a client parsing
 * something strad did not mean to say. Both of the places an origin comes from
 * can carry one: `Host` is whatever the caller sent, and `z.string().url()` in
 * `src/config/schema.ts` accepts `https://a"b.example` — WHATWG `new URL()`
 * parses it too, so neither the schema nor a parse is the check.
 *
 * Node refuses a CR or LF in a header value, so this is not the response-
 * splitting guard; it is the one that keeps the document and the header from
 * repeating back a string that is not a URL.
 */
const URI_CHARACTERS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/**
 * The candidate, if it is a BARE http(s) origin we are willing to repeat back —
 * scheme, host, port, and nothing else. Null otherwise.
 *
 * Bare, because everything past the authority is a thing the caller's `Host`
 * could dictate and strad would then publish under its own name: userinfo
 * (`legit.example@attacker.example` reads as the first host and resolves to
 * the second), a path (`ok.example/evil` puts `/evil/mcp` in `resource`), a
 * query, a fragment (a resource identifier may not carry one — RFC 8707 §2 —
 * and a `resource_metadata` URL with one truncates at the `#` when a client
 * parses it). A declared `gateway.publicUrl` with a path is refused on the same
 * rule, and for a reason of its own: strad mounts `/mcp` and this document at
 * the ROOT of its origin, so a prefixed identifier would point at a path
 * nothing serves.
 *
 * The scheme is checked because `${req.protocol}://${host}` with `trust proxy`
 * on means the scheme is `X-Forwarded-Proto` — also the caller's — and
 * `javascript://host` parses.
 *
 * The character check runs on the SERIALISED origin as well as the candidate.
 * WHATWG percent-decodes the host, so `a.example%22x` passes the first check
 * and serialises with a literal quote; returning `url.origin` without the
 * second check would reopen the breakout the first one closes.
 */
export function safeOrigin(candidate: string): string | null {
  if (!URI_CHARACTERS.test(candidate)) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/") return null;
  if (!URI_CHARACTERS.test(url.origin)) return null;
  return url.origin;
}

/**
 * The origin the request arrived on. `trust proxy` is on, so behind App
 * Platform this is the public hostname rather than the container's own
 * host:port — the same fallback the landing page and the playground take
 * (`src/ui/landing.ts`, `src/ui/playground.ts`).
 */
function requestOrigin(req: Request): string | null {
  const host = req.get("host");
  return host ? `${req.protocol}://${host}` : null;
}

/**
 * The base URL to describe: the declared one, else the one the request arrived
 * on, else nothing.
 *
 * ONE function, because two call sites must agree on the answer — the route
 * that serves the document (`src/http/app.ts`) and the `401` that points at it
 * (`src/gateway/router.ts`). A pointer to a document whose `resource` names a
 * different origin is worse than no pointer: the client compares the two.
 *
 * `gateway.publicUrl` first, for the same reason the console's OAuth redirect
 * URI is derived from it and never from a header — it is the operator's
 * declaration of what this deployment IS, and it does not move when someone
 * sends a `Host` they made up.
 *
 * Null when there is neither, and null when what there is does not survive
 * `safeOrigin`. The `resource` member is REQUIRED and there would be nothing
 * to put in it, so the route answers `404` and the `401` omits the parameter,
 * rather than either of them inventing an origin or quoting a string that is
 * not one. A declared `publicUrl` that is refused is also said at boot, once,
 * by `src/http/app.ts` — the two answers are otherwise indistinguishable from
 * a deployment that declared nothing.
 */
export function metadataBaseUrl(
  req: Request,
  publicUrl: string | undefined,
): string | null {
  const candidate = publicUrl ?? requestOrigin(req);
  return candidate === null ? null : safeOrigin(candidate);
}

/**
 * The `401`'s `WWW-Authenticate`.
 *
 * `realm` and `error` are unchanged and stay first — a client that only ever
 * read those two reads the same bytes it always did. `resource_metadata` is
 * appended when there is a URL to append; RFC 9728 §5.1 is the form.
 */
export function wwwAuthenticate(metadataUrl: string | null): string {
  const base = 'Bearer realm="strad", error="invalid_token"';
  return metadataUrl ? `${base}, resource_metadata="${metadataUrl}"` : base;
}
