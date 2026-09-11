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
 * ## `authorization_servers` is ABSENT, deliberately
 *
 * RFC 9728 §2 makes it optional, and strad has no authorization server to name.
 * Google Workspace OAuth here is the HUMAN console door — `/console` and `/ui`,
 * resolved in `src/ui/console-auth.ts`, which never consults the `/mcp` token
 * store. Naming it here would advertise an issuer whose tokens `/mcp` refuses,
 * which is a worse lie than the `404` was: a client would run a whole consent
 * flow and be `401`ed with a valid access token at the end of it.
 *
 * Binding an authorization server to `/mcp` is a product decision and is
 * tracked in issue #53. Until someone makes it, the honest document is one that
 * describes the resource and stops. A client reading it learns three true
 * things — this is a protected resource, it takes a bearer token in the header,
 * and here is where the credential comes from — and learns them from a
 * `200` rather than by guessing.
 *
 * ## Where the two halves meet
 *
 * The `resource_metadata` parameter on `/mcp`'s `401` (see
 * `src/gateway/router.ts`) must point at the URL this document is served from,
 * or the pointer is decoration. Both come from `resourceMetadataUrl()` so there
 * is one string and not two that merely agree.
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

function trimSlash(base: string): string {
  return base.replace(/\/$/, "");
}

/** The resource identifier: the `/mcp` endpoint, absolute. */
export function resourceIdentifier(base: string): string {
  return `${trimSlash(base)}${MCP_PATH}`;
}

/**
 * Where the document lives — the RFC 9728 path-inserted form.
 *
 * This is what goes in `resource_metadata` on the `401`. A client handed this
 * URL fetches it directly and does no fallback probing at all, so it is the
 * canonical form rather than the convenience one.
 */
export function resourceMetadataUrl(base: string): string {
  return `${trimSlash(base)}${WELL_KNOWN}${MCP_PATH}`;
}

/** The document, for a deployment whose public base URL is `base`. */
export function protectedResourceMetadata(
  base: string,
  name: string,
): ProtectedResourceMetadata {
  return {
    resource: resourceIdentifier(base),
    resource_name: name,
    bearer_methods_supported: ["header"],
    resource_documentation: RESOURCE_DOCUMENTATION,
  };
}

/**
 * Every character RFC 3986 allows in a URI, and nothing else.
 *
 * The two that matter are `"` and `\`. This base is interpolated into a
 * `quoted-string` on the `401`'s `WWW-Authenticate` (RFC 9110 §5.6.4), so a
 * quote inside it ends the parameter early and leaves a client parsing
 * something strad did not mean to say. Both of the places a base comes from can
 * carry one: `Host` is whatever the caller sent, and `z.string().url()` in
 * `src/config/schema.ts` accepts `https://a"b.example` — WHATWG `new URL()`
 * parses it too, so neither the schema nor a parse is the check.
 *
 * Node refuses a CR or LF in a header value, so this is not the response-
 * splitting guard; it is the one that keeps the document and the header from
 * repeating back a string that is not a URL.
 */
const URI_CHARACTERS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/** The candidate, if it is an http(s) URL we are willing to repeat back. */
function safeBaseUrl(candidate: string): string | null {
  if (!URI_CHARACTERS.test(candidate)) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  // `${req.protocol}://${host}` with `trust proxy` on means the scheme is
  // `X-Forwarded-Proto`, i.e. also the caller's. `javascript://host` parses.
  return url.protocol === "http:" || url.protocol === "https:"
    ? candidate
    : null;
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
 * `safeBaseUrl`. The `resource` member is REQUIRED and there would be nothing
 * to put in it, so the route answers `404` and the `401` omits the parameter,
 * rather than either of them inventing an origin or quoting a string that is
 * not a URL.
 */
export function metadataBaseUrl(
  req: Request,
  publicUrl: string | undefined,
): string | null {
  const candidate = publicUrl ?? requestOrigin(req);
  return candidate === null ? null : safeBaseUrl(candidate);
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
