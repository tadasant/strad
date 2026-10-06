import type {
  OAuthRefresh,
  ServerConfig,
  StradConfig,
} from "../config/schema.ts";
import { soleRefName } from "../config/schema.ts";
import { secretRefsIn } from "../config/env-name.ts";
import { tokenUrlAllowed } from "../gateway/adapters/oauth-refresh.ts";
import {
  oauthParameterPath,
  serverNamespaces,
  type ParameterMeta,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import { withRequestDeadline } from "../util/deadline.ts";
import {
  buildPkceAuthorizeUrl,
  ConnectorError,
  exchangeAuthorizationCode,
  grantedScopeSet,
  stringField,
  type PendingConnectorAuth,
} from "./oauth-flow.ts";

/**
 * **Connect** for a `remote-http` server that mints its bearer with
 * `oauthRefresh:` — the consent half of strad#338.
 *
 * `oauthRefresh:` already turns a refresh token into short-lived access tokens
 * and writes a rotated one back. What it could not do is get the FIRST refresh
 * token: a human had to run some other OAuth client against the upstream, copy
 * the token out of it and seed it by hand. This module is the OAuth client,
 * run from the console, the way the MCP authorization spec describes one:
 *
 *   1. PROBE the upstream with an unauthenticated `initialize` and read the
 *      `401`'s `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728 §5.1),
 *      falling back to the well-known protected-resource paths.
 *   2. READ the protected-resource metadata for its authorization server, then
 *      that server's own metadata (RFC 8414, with the OpenID Connect paths as
 *      the fallback the MCP spec names).
 *   3. REGISTER a public client (RFC 7591) whose one redirect URI is strad's
 *      console callback — or use the client id the config already names.
 *   4. AUTHORIZE with code + PKCE and `resource=` (RFC 8707), and exchange the
 *      code at the token endpoint discovery returned.
 *
 * Then the console writes what it learned into the slug's own `oauth/`
 * namespace, under the `${NAME}`s the `oauthRefresh:` block already declares —
 * so nothing in the config changes, and a slug whose names are `mayBeUnseeded`
 * starts serving on its next request (core resolves them per operation).
 *
 * ## What the config decides, and what discovery decides
 *
 * A field written as exactly one `${NAME}` is the flow's to WRITE. A field
 * written as a literal is the config's, and discovery must agree with it or the
 * flow refuses: a literal `tokenUrl` that is not the token endpoint the
 * upstream advertises would mint a refresh token at one server and spend it at
 * another. A literal `clientId` is a pre-registered client, and no registration
 * happens. Anything else — a `${NAME}` inside a longer string — is a value the
 * flow can neither write nor check, and the page says so instead of a button.
 *
 * ## Public clients only, when strad registers one
 *
 * The transaction that carries the client from the connect POST to the
 * callback is a SIGNED cookie, not an encrypted one (src/connectors/state.ts).
 * A client id is public by definition and rides in it safely; a client secret
 * would ride in the browser in the clear. So strad registers with
 * `token_endpoint_auth_method: none` and refuses a registration that comes back
 * confidential. A server that declares `oauthRefresh.clientSecret:` uses a
 * client a human registered and seeded, and the callback reads its secret from
 * the store, never from the cookie.
 *
 * ## Nothing upstream-authored is quoted, except URLs strad validated
 *
 * Every refusal is a code from a closed set and a sentence this repo wrote. The
 * one exception is a URL — the metadata document strad asked for, the issuer it
 * was told about — which is parsed, checked for https and rendered escaped,
 * because "the metadata at THIS address answered 403" is the sentence that
 * tells a human whether the problem is theirs. No response BODY is read for
 * text, ever.
 */

/** The `provider` a transaction for this flow is sealed under. */
export const UPSTREAM_PROVIDER = "mcp";

/** Each discovery request's deadline. The token exchange keeps its own. */
export const DISCOVERY_TIMEOUT_MS = 10_000;

type RemoteHttp = Extract<ServerConfig, { kind: "remote-http" }>;

/** A `remote-http` server with `oauthRefresh:`, narrowed. */
export interface UpstreamConnector {
  server: RemoteHttp;
  oauth: OAuthRefresh;
}

/**
 * The `remote-http` + `oauthRefresh:` server for a slug, or null. Config only.
 *
 * `enabled: false` is a no, for the reason `connectorFor` gives: a disabled
 * server is never built, so a consent run against it would mint a credential
 * nothing reads.
 */
export function upstreamConnectorFor(
  config: StradConfig,
  slug: string,
): UpstreamConnector | null {
  const server = config.servers.find((s) => s.slug === slug);
  if (!server?.enabled || server.kind !== "remote-http") return null;
  if (!server.oauthRefresh) return null;
  return { server, oauth: server.oauthRefresh };
}

/** One `oauthRefresh:` field, as the flow reads it. */
export type PlannedField =
  /** Exactly one `${NAME}`: the flow writes it. */
  | { mode: "write"; variable: string }
  /** No reference at all: the config's value, which discovery must agree with. */
  | { mode: "literal"; value: string };

/**
 * What a Connect would do with this server's config, decided before anything
 * is fetched.
 *
 * `problems` non-empty means there is no button: each entry is a sentence
 * naming the field and why the flow cannot honour it.
 */
export interface UpstreamPlan {
  /** The upstream MCP URL, when it is a literal. */
  url: string | null;
  tokenUrl: PlannedField | null;
  clientId: PlannedField | null;
  /** `null` when the block declares no `resource:`. */
  resource: PlannedField | null;
  /** The literal `scope:`, split; `null` to take the upstream's advertised scopes. */
  scopes: string[] | null;
  /** The `${NAME}` holding a configured client secret, or null for a public client. */
  clientSecretVariable: string | null;
  /** The `${NAME}` the refresh token is written to. Enforced by the schema. */
  refreshVariable: string;
  problems: string[];
}

function planField(field: string, value: string, problems: string[]) {
  const variable = soleRefName(value);
  if (variable) return { mode: "write", variable } as const;
  if (secretRefsIn(value).length === 0) {
    return { mode: "literal", value } as const;
  }
  problems.push(
    `oauthRefresh.${field} mixes a \${NAME} with other text, so the flow can ` +
      `neither write it nor check it. Make it exactly one \${NAME} or a literal.`,
  );
  return null;
}

export function upstreamPlan(entry: UpstreamConnector): UpstreamPlan {
  const { server, oauth } = entry;
  const problems: string[] = [];

  const url = secretRefsIn(server.url).length === 0 ? server.url : null;
  if (!url) {
    problems.push(
      `url: is a \${NAME}. Discovery starts from the upstream's address, and ` +
        `the console does not resolve references, so it must be a literal.`,
    );
  }

  const tokenUrl = planField("tokenUrl", oauth.tokenUrl, problems);
  const clientId = planField("clientId", oauth.clientId, problems);
  const resource =
    oauth.resource === undefined
      ? null
      : planField("resource", oauth.resource, problems);

  let scopes: string[] | null = null;
  if (oauth.scope !== undefined) {
    if (secretRefsIn(oauth.scope).length > 0) {
      problems.push(
        `oauthRefresh.scope is a \${NAME}. The consent asks for these scopes ` +
          `before anything is stored, so they must be a literal.`,
      );
    } else {
      scopes = oauth.scope.split(/\s+/).filter(Boolean);
    }
  }

  const clientSecretVariable =
    oauth.clientSecret === undefined ? null : soleRefName(oauth.clientSecret);

  // The schema already refuses anything else; this is the type narrowing.
  const refreshVariable = soleRefName(oauth.refreshToken) ?? "";
  if (!refreshVariable) {
    problems.push("oauthRefresh.refreshToken is not exactly one ${NAME}.");
  }

  return {
    url,
    tokenUrl,
    clientId,
    resource,
    scopes,
    clientSecretVariable,
    refreshVariable,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** A closed set. Every one is a strad word, safe to log, export and put in a URL. */
export type UpstreamErrorCode =
  | "upstream_unreachable"
  | "metadata_blocked"
  | "metadata_unavailable"
  | "metadata_invalid"
  | "resource_mismatch"
  | "issuer_mismatch"
  | "insecure_endpoint"
  | "pkce_unsupported"
  | "token_url_mismatch"
  | "registration_failed"
  | "registration_confidential"
  | "no_client";

export class UpstreamConnectError extends Error {
  constructor(
    readonly code: UpstreamErrorCode,
    message: string,
    /** The HTTP status that decided it, when one did. A number, never text. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpstreamConnectError";
  }
}

/**
 * May discovery send a request to `url`, found in metadata `upstreamUrl`
 * pointed at?
 *
 * https, always — every URL past the configured `url:` is one the UPSTREAM
 * chose, and plain http to a loopback host is the one exception
 * `tokenUrlAllowed` makes for a token endpoint a human configured. Here it
 * would let a third party's metadata point core at its own loopback ports. So
 * loopback http is honoured only when the configured upstream is itself on
 * loopback: a local test rig, never a deployment.
 */
export function endpointAllowed(upstreamUrl: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  return (
    tokenUrlAllowed(url) &&
    tokenUrlAllowed(upstreamUrl) &&
    isLoopback(upstreamUrl)
  );
}

function isLoopback(raw: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/** `origin + pathname` of a URL strad validated: no query, no fragment. */
export function shown(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.origin : `${u.origin}${u.pathname}`;
  } catch {
    return "(an unparseable URL)";
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** What discovery established. Every URL in it passed `endpointAllowed`. */
export interface UpstreamDiscovery {
  /** The protected-resource metadata document read, or null when none was found. */
  resourceMetadataUrl: string | null;
  /** The RFC 8707 resource the consent and every refresh are bound to. */
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  /** The scopes to request. Empty means the `scope` parameter is omitted. */
  scopes: string[];
}

interface Fetched {
  status: number;
  json: unknown;
}

/**
 * GET a metadata document, bounded. The body is read as JSON and nothing else.
 *
 * Redirects are followed — a metadata path that 301s to its trailing-slash twin
 * is ordinary — and the URL the answer finally came from must still pass
 * `allowed`, so an answer from a plain-http address is never USED. The hops in
 * between have been requested by then: unauthenticated GETs carrying nothing.
 */
async function getJson(
  url: string,
  fetchImpl: typeof fetch,
  allowed: (url: string) => boolean,
): Promise<Fetched> {
  return withRequestDeadline(
    DISCOVERY_TIMEOUT_MS,
    async (signal) => {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          headers: { accept: "application/json" },
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        throw new UpstreamConnectError(
          "upstream_unreachable",
          `strad could not reach ${shown(url)} at all: the connection failed ` +
            `before any HTTP answer. Nothing was registered or written.`,
        );
      }
      if (res.url && !allowed(res.url)) {
        await res.body?.cancel().catch(() => undefined);
        throw new UpstreamConnectError(
          "insecure_endpoint",
          `${shown(url)} redirected to a plain-http address, so strad stopped ` +
            `following it. Nothing was registered or written.`,
        );
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { status: res.status, json: null };
      }
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
    () =>
      new UpstreamConnectError(
        "upstream_unreachable",
        `${shown(url)} did not answer within ${DISCOVERY_TIMEOUT_MS / 1000}s. ` +
          `Nothing was registered or written.`,
      ),
  );
}

/** A 403 on a metadata document, in the words that tell a human whose problem it is. */
function blocked(url: string, status: number): UpstreamConnectError {
  return new UpstreamConnectError(
    "metadata_blocked",
    `${shown(url)} answered HTTP ${status} to strad. A metadata document is ` +
      `public by design, so a refusal here is almost always a web application ` +
      `firewall (Cloudflare, typically) blocking this deployment's outbound ` +
      `addresses — a cloud provider's — rather than an OAuth answer. Nothing in ` +
      `strad's config changes that: the upstream has to allow this ` +
      `deployment's egress, or this server cannot be connected from here. ` +
      `Nothing was registered or written.`,
    status,
  );
}

/**
 * The `WWW-Authenticate` parameters discovery reads, from a `Bearer` challenge.
 * Quoted or bare values, parameter names case-insensitive (RFC 9110 §11.2).
 */
export function bearerChallenge(header: string | null): {
  resourceMetadata: string | null;
  scope: string | null;
} {
  const none = { resourceMetadata: null, scope: null };
  const at = header ? /(^|[\s,])bearer(\s|$)/i.exec(header) : null;
  if (!header || !at) return none;
  // Walk the challenge's parameters in order, so a `scope=` inside a quoted
  // value — a metadata URL with a query string — is consumed with that value
  // rather than matched on its own. A bare token that is not a parameter is
  // the next challenge's scheme, and ends this one.
  const params = new Map<string, string>();
  const re =
    /\s*,?\s*([A-Za-z0-9_-]+)\s*(?:=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+)))?/y;
  re.lastIndex = at.index + at[0].length;
  for (let m = re.exec(header); m; m = re.exec(header)) {
    const value = m[2] ?? m[3];
    if (value === undefined) break;
    const name = m[1]!.toLowerCase();
    if (!params.has(name)) params.set(name, value);
  }
  return {
    resourceMetadata: params.get("resource_metadata") ?? null,
    scope: params.get("scope") ?? null,
  };
}

/**
 * Ask the upstream, without a credential, what it wants.
 *
 * An MCP `initialize`, because that is the request an MCP server is obliged to
 * answer — and the one whose `401` the spec says carries the challenge. The
 * body of the answer is not read.
 */
async function probe(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number; challenge: ReturnType<typeof bearerChallenge> }> {
  return withRequestDeadline(
    DISCOVERY_TIMEOUT_MS,
    async (signal) => {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "strad", version: "1" },
            },
          }),
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        throw new UpstreamConnectError(
          "upstream_unreachable",
          `strad could not reach ${shown(url)}: the connection failed before ` +
            `any HTTP answer. Nothing was registered or written.`,
        );
      }
      await res.body?.cancel().catch(() => undefined);
      return {
        status: res.status,
        challenge: bearerChallenge(res.headers.get("www-authenticate")),
      };
    },
    () =>
      new UpstreamConnectError(
        "upstream_unreachable",
        `${shown(url)} did not answer within ${DISCOVERY_TIMEOUT_MS / 1000}s. ` +
          `Nothing was registered or written.`,
      ),
  );
}

/**
 * RFC 9728 §3.1's well-known locations for a resource, path-suffixed first.
 */
export function protectedResourceCandidates(resourceUrl: string): string[] {
  const u = new URL(resourceUrl);
  const path = u.pathname.replace(/\/$/, "");
  const out: string[] = [];
  if (path) out.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  out.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return out;
}

/**
 * Where an issuer's metadata may live, in the order the MCP authorization spec
 * says to try them: RFC 8414 path-inserted, then OpenID Connect path-inserted,
 * then OpenID Connect path-appended. An issuer with no path has two.
 */
export function authorizationServerCandidates(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, "");
  if (!path) {
    return [
      `${u.origin}/.well-known/oauth-authorization-server`,
      `${u.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
}

/**
 * May a resource identifier stand for this upstream URL?
 *
 * The rule the MCP SDK applies: same origin, and the upstream's path is at or
 * beneath the identifier's. A protected-resource document that names some
 * other resource is describing a different server, and binding a token to it
 * would mint a credential this upstream need not accept.
 */
export function resourceCovers(resource: string, upstream: string): boolean {
  let r: URL;
  let u: URL;
  try {
    r = new URL(resource);
    u = new URL(upstream);
  } catch {
    return false;
  }
  if (r.origin !== u.origin) return false;
  const base = r.pathname.endsWith("/") ? r.pathname : `${r.pathname}/`;
  const path = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
  return path.startsWith(base);
}

const sameIssuer = (a: string, b: string): boolean =>
  a.replace(/\/$/, "") === b.replace(/\/$/, "");

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v !== "")
    : [];
}

function httpsField(
  meta: Record<string, unknown>,
  field: string,
  where: string,
  allowed: (url: string) => boolean,
): string {
  const value = meta[field];
  if (typeof value !== "string" || value === "") {
    throw new UpstreamConnectError(
      "metadata_invalid",
      `The authorization server metadata at ${shown(where)} has no ${field}, ` +
        `so strad cannot run an authorization against it. Nothing was ` +
        `registered or written.`,
    );
  }
  if (!allowed(value)) {
    throw new UpstreamConnectError(
      "insecure_endpoint",
      `The authorization server metadata at ${shown(where)} names a ${field} ` +
        `that is not https, and an authorization code or a refresh token would ` +
        `travel over it. Nothing was registered or written.`,
    );
  }
  return value;
}

/**
 * Discover the upstream's authorization server, end to end.
 *
 * `upstreamUrl` is the config's literal `url:`. `resourceOverride` is a literal
 * `oauthRefresh.resource:`, which wins over what the metadata names because
 * every refresh will send it. `scopes` is a literal `oauthRefresh.scope:`.
 */
export async function discoverUpstream(
  input: {
    upstreamUrl: string;
    resourceOverride?: string;
    scopes: string[] | null;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<UpstreamDiscovery> {
  const { upstreamUrl } = input;
  const allowed = (url: string) => endpointAllowed(upstreamUrl, url);
  const first = await probe(upstreamUrl, fetchImpl);

  // THE PROTECTED-RESOURCE DOCUMENT. The challenge's own pointer first, then
  // the well-known paths. A 404 moves on; any other refusal is the answer.
  const candidates: string[] = [];
  const pointer = first.challenge.resourceMetadata;
  if (pointer) {
    if (!allowed(pointer)) {
      throw new UpstreamConnectError(
        "insecure_endpoint",
        `${shown(upstreamUrl)} points at protected-resource metadata that is ` +
          `not https. Nothing was registered or written.`,
      );
    }
    candidates.push(pointer);
  }
  for (const c of protectedResourceCandidates(upstreamUrl)) {
    if (!candidates.includes(c)) candidates.push(c);
  }

  let prm: Record<string, unknown> | null = null;
  let prmUrl: string | null = null;
  for (const candidate of candidates) {
    const got = await getJson(candidate, fetchImpl, allowed);
    if (got.status === 404 || got.status === 410) continue;
    if (got.status === 401 || got.status === 403) {
      throw blocked(candidate, got.status);
    }
    if (got.status < 200 || got.status >= 300) {
      throw new UpstreamConnectError(
        "metadata_unavailable",
        `${shown(candidate)} answered HTTP ${got.status}. Nothing was ` +
          `registered or written.`,
        got.status,
      );
    }
    if (!got.json || typeof got.json !== "object") {
      throw new UpstreamConnectError(
        "metadata_invalid",
        `${shown(candidate)} did not answer with a JSON document. Nothing was ` +
          `registered or written.`,
      );
    }
    prm = got.json as Record<string, unknown>;
    prmUrl = candidate;
    break;
  }

  // THE RESOURCE. The metadata's own identifier when it covers this URL; a
  // document describing another resource is refused rather than trusted.
  let resource = upstreamUrl;
  if (prm && typeof prm.resource === "string" && prm.resource !== "") {
    if (!resourceCovers(prm.resource, upstreamUrl)) {
      throw new UpstreamConnectError(
        "resource_mismatch",
        `The protected-resource metadata at ${shown(prmUrl!)} describes ` +
          `${shown(prm.resource)}, which is not ${shown(upstreamUrl)}. strad ` +
          `will not bind a credential for this server to another resource. ` +
          `Nothing was registered or written.`,
      );
    }
    resource = prm.resource;
  }
  if (input.resourceOverride !== undefined) resource = input.resourceOverride;

  // THE ISSUER. Without protected-resource metadata, the MCP spec's fallback is
  // the upstream's own origin acting as its authorization server.
  let issuer: string;
  if (prm) {
    const servers = stringArray(prm.authorization_servers);
    if (servers.length === 0) {
      throw new UpstreamConnectError(
        "metadata_invalid",
        `The protected-resource metadata at ${shown(prmUrl!)} names no ` +
          `authorization server. Nothing was registered or written.`,
      );
    }
    issuer = servers[0]!;
  } else {
    if (first.status !== 401) {
      throw new UpstreamConnectError(
        "metadata_unavailable",
        `${shown(upstreamUrl)} did not ask for authorization (HTTP ` +
          `${first.status}) and publishes no protected-resource metadata, so ` +
          `there is no authorization server to connect to. Nothing was ` +
          `registered or written.`,
        first.status,
      );
    }
    issuer = new URL(upstreamUrl).origin;
  }
  if (!allowed(issuer)) {
    throw new UpstreamConnectError(
      "insecure_endpoint",
      `The authorization server ${shown(issuer)} is not https. Nothing was ` +
        `registered or written.`,
    );
  }

  let asMeta: Record<string, unknown> | null = null;
  let asUrl = "";
  for (const candidate of authorizationServerCandidates(issuer)) {
    const got = await getJson(candidate, fetchImpl, allowed);
    if (got.status === 404 || got.status === 410) continue;
    if (got.status === 401 || got.status === 403) {
      throw blocked(candidate, got.status);
    }
    if (got.status < 200 || got.status >= 300) {
      throw new UpstreamConnectError(
        "metadata_unavailable",
        `${shown(candidate)} answered HTTP ${got.status}. Nothing was ` +
          `registered or written.`,
        got.status,
      );
    }
    if (!got.json || typeof got.json !== "object") {
      throw new UpstreamConnectError(
        "metadata_invalid",
        `${shown(candidate)} did not answer with a JSON document. Nothing was ` +
          `registered or written.`,
      );
    }
    asMeta = got.json as Record<string, unknown>;
    asUrl = candidate;
    break;
  }
  if (!asMeta) {
    throw new UpstreamConnectError(
      "metadata_unavailable",
      `The authorization server ${shown(issuer)} publishes no metadata at any ` +
        `of the RFC 8414 or OpenID Connect well-known paths. Nothing was ` +
        `registered or written.`,
      404,
    );
  }

  // RFC 8414 §3.3: the document must name the issuer it was fetched for.
  // Anything else is a document for a different server.
  if (typeof asMeta.issuer === "string" && !sameIssuer(asMeta.issuer, issuer)) {
    throw new UpstreamConnectError(
      "issuer_mismatch",
      `The metadata at ${shown(asUrl)} names issuer ${shown(asMeta.issuer)}, ` +
        `not ${shown(issuer)}, which is the server the upstream pointed at. ` +
        `Nothing was registered or written.`,
    );
  }

  const authorizationEndpoint = httpsField(
    asMeta,
    "authorization_endpoint",
    asUrl,
    allowed,
  );
  const tokenEndpoint = httpsField(asMeta, "token_endpoint", asUrl, allowed);
  const registrationEndpoint =
    typeof asMeta.registration_endpoint === "string" &&
    asMeta.registration_endpoint !== ""
      ? httpsField(asMeta, "registration_endpoint", asUrl, allowed)
      : null;

  // PKCE is not optional on this flow. A server that SAYS which methods it
  // takes and leaves S256 out cannot run it; one that says nothing is given the
  // benefit of the doubt, because many do not publish the field and strad
  // sends S256 regardless.
  const methods = asMeta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !stringArray(methods).includes("S256")) {
    throw new UpstreamConnectError(
      "pkce_unsupported",
      `The authorization server ${shown(issuer)} does not list S256 among its ` +
        `PKCE methods, and strad will not run an authorization without it. ` +
        `Nothing was registered or written.`,
    );
  }

  // THE SCOPES. A literal in the config is the whole answer. Otherwise what the
  // challenge asked for, then what the resource advertises — and
  // `offline_access` when the server knows the word, because a refresh token
  // is the entire point of this flow and some servers issue one only for it.
  let scopes: string[];
  if (input.scopes) {
    scopes = [...input.scopes];
  } else {
    const challenged = first.challenge.scope?.split(/\s+/).filter(Boolean);
    scopes =
      challenged && challenged.length > 0
        ? challenged
        : stringArray(prm?.scopes_supported);
    if (
      stringArray(asMeta.scopes_supported).includes("offline_access") &&
      !scopes.includes("offline_access")
    ) {
      scopes.push("offline_access");
    }
  }

  return {
    resourceMetadataUrl: prmUrl,
    resource,
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    scopes,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a PUBLIC client (RFC 7591) whose only redirect URI is the console's.
 *
 * A fresh registration on every Connect, by design: the client is cheap, it is
 * bound to this deployment's exact callback, and re-using one registered by a
 * different flow is how a token ends up minted for a client whose redirect URI
 * strad does not own. The previous one is simply never used again.
 */
export async function registerPublicClient(
  input: {
    registrationEndpoint: string;
    redirectUri: string;
    clientName: string;
    scopes: string[];
  },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body: Record<string, unknown> = {
    client_name: input.clientName,
    redirect_uris: [input.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  if (input.scopes.length > 0) body.scope = input.scopes.join(" ");

  const where = shown(input.registrationEndpoint);
  return withRequestDeadline(
    DISCOVERY_TIMEOUT_MS,
    async (signal) => {
      let res: Response;
      try {
        res = await fetchImpl(input.registrationEndpoint, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        throw new UpstreamConnectError(
          "upstream_unreachable",
          `strad could not reach the registration endpoint ${where}. Nothing ` +
            `was registered or written.`,
        );
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        if (res.status === 401 || res.status === 403) {
          throw new UpstreamConnectError(
            "registration_failed",
            `The registration endpoint ${where} refused to register a client ` +
              `(HTTP ${res.status}). Either it only registers clients that ` +
              `present an initial access token, or this deployment's egress is ` +
              `blocked. If the upstream will issue a client id by hand, ` +
              `register it with this deployment's redirect URI, seed it under ` +
              `this server's own static/ namespace as the clientId \${NAME}, ` +
              `and Connect uses it instead. Nothing was written.`,
            res.status,
          );
        }
        throw new UpstreamConnectError(
          "registration_failed",
          `The registration endpoint ${where} refused to register a client ` +
            `(HTTP ${res.status}). Nothing was written.`,
          res.status,
        );
      }
      let json: Record<string, unknown> = {};
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        // falls through to the missing-client_id refusal below
      }
      const clientId = json.client_id;
      if (typeof clientId !== "string" || clientId === "") {
        throw new UpstreamConnectError(
          "registration_failed",
          `The registration endpoint ${where} answered without a client_id. ` +
            `Nothing was written.`,
        );
      }
      // A CONFIDENTIAL client is one strad could not carry to the callback
      // without putting its secret in a browser cookie. See the header.
      const method = json.token_endpoint_auth_method;
      const confidential =
        (typeof method === "string" && method !== "none") ||
        (method === undefined && typeof json.client_secret === "string");
      if (confidential) {
        throw new UpstreamConnectError(
          "registration_confidential",
          `The registration endpoint ${where} issued a confidential client ` +
            `(one with a client secret) when strad asked for a public one. ` +
            `strad carries a registered client to the callback in a signed ` +
            `cookie, so it will not hold that secret. Register a client by hand, ` +
            `seed its id and secret under this server's oauthRefresh clientId ` +
            `and clientSecret \${NAME}s, and Connect uses it. Nothing was written.`,
        );
      }
      return clientId;
    },
    () =>
      new UpstreamConnectError(
        "registration_failed",
        `The registration endpoint ${where} did not answer within ` +
          `${DISCOVERY_TIMEOUT_MS / 1000}s. Nothing was written.`,
      ),
  );
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/**
 * The terms a transaction seals for this flow: what the callback must exchange
 * against, decided at the connect POST and never re-derived from the request.
 */
export interface UpstreamTerms {
  clientId: string;
  /** Did strad register `clientId` on this Connect? Then the callback writes it. */
  registered: boolean;
  tokenUrl: string;
  resource: string;
  issuer: string;
}

/**
 * The config terms a transaction binds, as one comparable string — the
 * `genericTerms` of this flow. The upstream URL and the whole `oauthRefresh:`
 * block: every field of it decides where a code is sent or what is stored.
 */
export function upstreamConfigTerms(entry: UpstreamConnector): string {
  return JSON.stringify([entry.server.url, entry.oauth]);
}

/** Where the client id comes from, decided from the plan and the store. */
export type ClientSource =
  | { kind: "literal"; clientId: string }
  | { kind: "seeded"; variable: string; path: string }
  | { kind: "register" };

/**
 * Which client a Connect will use, BEFORE anything is fetched where possible.
 *
 * A literal is a client the config already names. A `${NAME}` is registered
 * fresh when the upstream offers registration and the block declares no client
 * secret; otherwise it must already be seeded in this slug's own namespace,
 * and that value is used. `held` is the slug's namespace listing.
 */
export function clientSource(
  plan: UpstreamPlan,
  canRegister: boolean,
  held: ReadonlyMap<string, ParameterMeta>,
): ClientSource | null {
  const field = plan.clientId;
  if (!field) return null;
  if (field.mode === "literal") {
    return { kind: "literal", clientId: field.value };
  }
  if (canRegister && plan.clientSecretVariable === null) {
    return { kind: "register" };
  }
  const meta = held.get(field.variable);
  return meta
    ? { kind: "seeded", variable: field.variable, path: meta.path }
    : null;
}

/**
 * This slug's own variables, from one listing: variable -> the winning copy.
 *
 * `oauth/` ahead of `static/`, by prefix, exactly as `presenceFrom` reads a
 * connector's — the resolver keys on a path's last segment, so a value at
 * depth is still the variable it is named for.
 */
export function heldVariables(
  config: StradConfig,
  slug: string,
  metas: readonly ParameterMeta[],
): Map<string, ParameterMeta> {
  const held = new Map<string, ParameterMeta>();
  for (const namespace of serverNamespaces(config.gateway.env, slug)) {
    for (const meta of metas) {
      if (!meta.path.startsWith(namespace) || !meta.hasValue) continue;
      if (!held.has(meta.variable)) held.set(meta.variable, meta);
    }
  }
  return held;
}

/** Build the consent URL. `scope` is omitted entirely when there is nothing to ask for. */
export function beginUpstreamAuthorization(input: {
  discovery: UpstreamDiscovery;
  clientId: string;
  redirectUri: string;
}): PendingConnectorAuth {
  const pending = buildPkceAuthorizeUrl({
    endpoint: input.discovery.authorizationEndpoint,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    scopes: input.discovery.scopes,
    extra: { resource: input.discovery.resource },
  });
  if (input.discovery.scopes.length > 0) return pending;
  const url = new URL(pending.url);
  url.searchParams.delete("scope");
  return { ...pending, url: url.toString() };
}

/** What a successful upstream consent yields. */
export interface UpstreamGrant {
  refreshToken: string;
  grantedScopes: string[];
}

/**
 * Exchange the code and insist on a refresh token — the one thing this flow
 * exists to obtain. An access token alone would work for an hour and then
 * leave a slug the minter cannot keep alive.
 */
export async function completeUpstreamAuthorization(
  input: {
    terms: UpstreamTerms;
    clientSecret: string | undefined;
    clientAuth: "basic" | "post";
    redirectUri: string;
    code: string;
    verifier: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<UpstreamGrant> {
  // A transport failure or an unparseable 200 is the EXCHANGE failing, not the
  // store: everything here runs before a single write, and the page must not
  // tell a human their stored values may be half-replaced when nothing was.
  let json: Awaited<ReturnType<typeof exchangeAuthorizationCode>>;
  try {
    json = await exchangeAuthorizationCode(
      {
        endpoint: input.terms.tokenUrl,
        clientId: input.terms.clientId,
        clientSecret: input.clientSecret,
        clientAuth: input.clientAuth,
        redirectUri: input.redirectUri,
        code: input.code,
        verifier: input.verifier,
        resource: input.terms.resource,
      },
      fetchImpl,
    );
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError(
      "exchange_failed",
      `The code exchange with the upstream's token endpoint failed before an ` +
        `answer strad could read. Nothing was written.`,
    );
  }
  const refreshToken = stringField(json, "refresh_token");
  if (!refreshToken) {
    throw new ConnectorError(
      "no_refresh_token",
      `The upstream completed the consent but issued no refresh token, so ` +
        `there is nothing durable to store. Nothing was written.`,
    );
  }
  return { refreshToken, grantedScopes: [...grantedScopeSet(json)].sort() };
}

/** One value the callback writes, in the order it writes them. */
export interface UpstreamWrite {
  variable: string;
  path: string;
  value: string;
  secret: boolean;
}

/**
 * Everything a completed consent writes, under this slug's `oauth/` kind.
 *
 * The REFRESH TOKEN IS LAST. The minter reads the four together on the next
 * request, and a refresh token that landed before its client id would be spent
 * against the old client. Only `${NAME}` fields are written; a literal is the
 * config's, and was checked against discovery before the consent began.
 */
export function upstreamWrites(
  config: StradConfig,
  entry: UpstreamConnector,
  plan: UpstreamPlan,
  terms: UpstreamTerms,
  refreshToken: string,
): UpstreamWrite[] {
  const at = (variable: string) =>
    oauthParameterPath(config.gateway.env, entry.server.slug, variable);
  const out: UpstreamWrite[] = [];
  if (plan.tokenUrl?.mode === "write") {
    const v = plan.tokenUrl.variable;
    out.push({
      variable: v,
      path: at(v),
      value: terms.tokenUrl,
      secret: false,
    });
  }
  if (plan.clientId?.mode === "write" && terms.registered) {
    const v = plan.clientId.variable;
    out.push({
      variable: v,
      path: at(v),
      value: terms.clientId,
      secret: false,
    });
  }
  if (plan.resource?.mode === "write") {
    const v = plan.resource.variable;
    out.push({
      variable: v,
      path: at(v),
      value: terms.resource,
      secret: false,
    });
  }
  out.push({
    variable: plan.refreshVariable,
    path: at(plan.refreshVariable),
    value: refreshToken,
    secret: true,
  });
  return out;
}

/**
 * Write each value: rotate what is already at its exact path, create the rest.
 *
 * `existing` is the set of exact paths the listing found. The note rides on the
 * refresh token only, and its failure is not the write's, for the reason
 * `storeRefreshToken` gives.
 */
export async function storeUpstreamWrites(
  store: ParameterStore,
  writes: readonly UpstreamWrite[],
  existing: ReadonlySet<string>,
  note: string,
): Promise<void> {
  for (const w of writes) {
    const noted = w.secret ? note : undefined;
    if (existing.has(w.path)) {
      await store.rotate(w.path, w.value);
      if (noted) await store.setNote(w.path, noted).catch(() => undefined);
      continue;
    }
    await store.create({
      path: w.path,
      secret: w.secret,
      value: w.value,
      ...(noted ? { note: noted } : {}),
    });
  }
}

/** The note beside the stored refresh token. Metadata only, as `connectionNote`'s is. */
export function upstreamNote(
  terms: UpstreamTerms,
  grantedScopes: readonly string[],
  at: Date,
): string {
  const client = terms.registered
    ? "a client strad registered"
    : "the configured client";
  const granted =
    grantedScopes.length > 0
      ? `; granted: ${grantedScopes.join(" ")}`
      : "; the server named no scopes";
  return (
    `connected via the strad console on ${at.toISOString()} against ` +
    `${shown(terms.issuer)} with ${client}${granted}`
  );
}
