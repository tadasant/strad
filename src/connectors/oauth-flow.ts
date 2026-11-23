import { createHash, randomBytes } from "node:crypto";
import { withRequestDeadline } from "../util/deadline.ts";
import { formEncode } from "../gateway/adapters/oauth-refresh.ts";

/**
 * The parts of an authorization-code flow that are the same whoever is on the
 * other end: PKCE, the shape of the consent URL, and the one POST that turns a
 * code into a token.
 *
 * It exists because there are two providers now (`src/connectors/google.ts` and
 * `src/connectors/generic.ts`) and exactly one of the differences between them
 * is interesting. Google's flow proves WHO consented — an ID token, verified
 * against Google's signing keys, checked against the account the slug is pinned
 * to. The generic flow cannot, because nothing in RFC 6749 says who a token
 * belongs to. Everything either side of that proof is this file, written once:
 * a second PKCE implementation or a second deadline around a token endpoint
 * would be two chances to get the same thing wrong, and one of them would be
 * the one nobody exercises.
 *
 * ## Nothing here is ever quoted back
 *
 * Every failure is a {@link ConnectorError} carrying a code from a closed set
 * and a sentence this repo wrote. A provider's own error body is read for
 * NOTHING — not for a message, not for a hint, not for a log line. An upstream
 * OAuth error body is attacker-influenceable text on a path that is one string
 * concatenation away from a rendered page, a span attribute and an exception
 * report, and the operational value of it ("invalid_grant" versus a 400) is
 * carried by the code instead.
 */

/**
 * How long the code exchange waits on the provider before it is a refusal.
 *
 * Ten seconds, the number src/auth/google.ts bounds the console's own handshake
 * with: a different OAuth client and a different flow, but the same kind of
 * endpoint and the same human waiting on a redirect. Node's `fetch` has no
 * overall timeout, so without it a stalled token endpoint holds the callback for
 * undici's 300s header timeout — and an authorization code is single-use and
 * short-lived, so every second past the point the exchange could have worked is
 * spent on a code that will be refused anyway.
 */
export const EXCHANGE_TIMEOUT_MS = 10_000;

/** A closed set. Every one of these is a strad word, safe to log and export. */
export type ConnectorErrorCode =
  | "exchange_failed"
  | "exchange_timed_out"
  | "no_refresh_token"
  | "no_credential"
  | "no_identity"
  | "identity_unverified"
  | "account_mismatch"
  | "scope_not_granted";

export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface PendingConnectorAuth {
  /** The CSRF value the provider echoes back. Sealed into the transaction cookie. */
  state: string;
  /** The PKCE verifier. Sealed into the transaction cookie; never in a URL. */
  verifier: string;
  url: string;
}

export interface AuthorizeUrlInput {
  /** The provider's authorization endpoint. */
  endpoint: string;
  clientId: string;
  /** Exact, allowlisted, derived from `gateway.publicUrl`. Never from a request. */
  redirectUri: string;
  /** The full set: identity scopes, where there are any, plus the config's. */
  scopes: readonly string[];
  /**
   * Provider-specific query parameters — `access_type=offline`, `login_hint`,
   * `duration=permanent`. Applied AFTER the parameters strad owns, and unable to
   * overwrite one: {@link RESERVED_AUTHORIZE_PARAMS} is refused by the config
   * gate, and this loop skips a reserved key even so.
   */
  extra?: Readonly<Record<string, string>>;
}

/**
 * The authorization-URL parameters strad owns, and which no config may set.
 *
 * `redirect_uri` and `code_challenge` are the two controls that keep an
 * authorization code from leaving the building, and `client_id`, `scope` and
 * `state` are the terms a human is shown before they consent. A config key that
 * could rewrite any of them would make the whole "the browser supplies nothing"
 * story advisory. The config gate refuses one by name (src/config/schema.ts);
 * the skip below is the belt, so this function is safe on its own terms rather
 * than safe because someone else checked.
 */
export const RESERVED_AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
] as const;

const RESERVED = new Set<string>(RESERVED_AUTHORIZE_PARAMS);

/**
 * The parameters `oauthRefresh.authorizeParams:` may not set: strad's own, and
 * the ones that would change the grant or the answer by another route.
 *
 *   - `resource` (RFC 8707) binds the tokens, and discovery decided it.
 *   - `request` / `request_uri` (RFC 9101) carry a whole authorization request
 *     that REPLACES the query parameters beside it, PKCE and redirect included.
 *   - `response_mode` moves the code out of the callback's query string.
 *   - `authorization_details` (RFC 9396) and `include_granted_scopes` (Google)
 *     widen the grant past the scopes the page names.
 *
 * Wider than {@link RESERVED_AUTHORIZE_PARAMS} rather than a replacement for
 * it: `oauth: provider: generic` has no discovered resource, so a config there
 * may legitimately name one.
 */
export const RESERVED_UPSTREAM_AUTHORIZE_PARAMS = [
  ...RESERVED_AUTHORIZE_PARAMS,
  "resource",
  "request",
  "request_uri",
  "response_mode",
  "authorization_details",
  "include_granted_scopes",
] as const;

const RESERVED_UPSTREAM = new Set<string>(RESERVED_UPSTREAM_AUTHORIZE_PARAMS);

/**
 * May `oauthRefresh.authorizeParams:` NOT set `key`? Case-folded and trimmed:
 * parameter names are case-sensitive on the wire, and a server that reads them
 * otherwise should not be where strad finds out.
 */
export function isReservedUpstreamAuthorizeParam(key: string): boolean {
  return RESERVED_UPSTREAM.has(key.trim().toLowerCase());
}

/**
 * Build a consent URL with PKCE, and return the two secrets the callback will
 * need back.
 *
 * `code_challenge_method=S256` unconditionally. PKCE is not optional here even
 * though this is a confidential client holding a client secret: the redirect
 * lands on a console route, and the verifier is what makes an intercepted
 * authorization code useless on its own.
 */
export function buildPkceAuthorizeUrl(
  input: AuthorizeUrlInput,
  random: (bytes: number) => Buffer = randomBytes,
): PendingConnectorAuth {
  const state = random(32).toString("base64url");
  const verifier = random(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const url = new URL(input.endpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (RESERVED.has(key)) continue;
    url.searchParams.set(key, value);
  }

  return { state, verifier, url: url.toString() };
}

export interface TokenRequestInput {
  /** The provider's token endpoint. */
  endpoint: string;
  clientId: string;
  /**
   * The client secret, for a confidential client. `undefined` is a PUBLIC
   * client (RFC 6749 §2.1) — a dynamically registered MCP client with
   * `token_endpoint_auth_method: none` — which sends its `client_id` in the body
   * and authenticates with nothing but the PKCE verifier.
   */
  clientSecret: string | undefined;
  redirectUri: string;
  code: string;
  verifier: string;
  /** How the client credentials travel. See the config's `clientAuth:`. */
  clientAuth?: "post" | "basic";
  /**
   * RFC 8707 `resource`, repeated on the token request. An MCP authorization
   * server binds the issued tokens to it. Omitted when absent.
   */
  resource?: string;
}

/** What a token endpoint may hand back that strad reads. Nothing else is looked at. */
export interface TokenResponse {
  refresh_token?: unknown;
  access_token?: unknown;
  id_token?: unknown;
  scope?: unknown;
}

/**
 * Exchange an authorization code, bounded, and return the parsed JSON.
 *
 * THE BODY READ IS INSIDE THE DEADLINE, not merely the response. A host that
 * sends its headers and then trickles the body is the stall a header timeout
 * never catches, and a rejection that arrives after this call returned would
 * reach `src/ui/connector.ts` as a bare `DOMException` — classified
 * `store_failed`, "the write was refused", on a flow that never got a token.
 */
export async function exchangeAuthorizationCode(
  input: TokenRequestInput,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const secret = input.clientSecret;
  const basic = input.clientAuth === "basic" && secret !== undefined;
  const body = new URLSearchParams({
    code: input.code,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.verifier,
  });
  // RFC 6749 §2.3.1: the client id is sent in the body OR in the header, never
  // usefully in both — but a client id in the body alongside Basic auth is
  // common and harmless, and several providers key their rate limiting on it.
  // The SECRET is what moves.
  body.set("client_id", input.clientId);
  if (secret !== undefined && !basic) body.set("client_secret", secret);
  if (input.resource !== undefined) body.set("resource", input.resource);

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    // Some token endpoints content-negotiate and hand back form-encoded bodies
    // unless asked otherwise. Asking costs a header and removes a whole class of
    // "the exchange succeeded and strad could not read it".
    accept: "application/json",
  };
  if (basic && secret !== undefined) {
    // §2.3.1 again: both halves are form-urlencoded BEFORE base64, which matters
    // for the providers whose secrets carry `+` or `/`. `formEncode` is the
    // refresh minter's, reused rather than re-expressed — `encodeURIComponent`
    // is NOT the same function (it renders a space as `%20`, not `+`).
    const credential = `${formEncode(input.clientId)}:${formEncode(secret)}`;
    // Bracket notation, as in the refresh minter. The dotted spelling is how a
    // door READS an inbound header, and `test/auth-header.doors.test.ts` greps
    // the whole file for it — comments included. This header is one strad SENDS.
    headers["authorization"] =
      `Basic ${Buffer.from(credential, "utf8").toString("base64")}`;
  }

  return withRequestDeadline(
    EXCHANGE_TIMEOUT_MS,
    async (signal) => {
      const res = await fetchImpl(input.endpoint, {
        method: "POST",
        // A 307/308 would resend the code, the verifier and any client secret
        // to wherever it pointed. The refresh minter refuses redirects for the
        // same reason; a redirect here lands as `exchange_failed`.
        redirect: "manual",
        headers,
        body,
        signal,
      });

      if (!res.ok) {
        // The STATUS and nothing else. A provider's body on a failed exchange
        // carries `error_description`, which is upstream text — and on a
        // redirect-URI mismatch it quotes the URI back, which is ours but sets
        // the precedent.
        throw new ConnectorError(
          "exchange_failed",
          `The provider refused the authorization code (HTTP ${res.status}). The code ` +
            `may have expired, been used already, or been issued for a different ` +
            `OAuth client than the one this server's namespace holds.`,
        );
      }

      return (await res.json()) as TokenResponse;
    },
    // A CODE FROM THE CLOSED SET, like every other refusal here, because the
    // callback puts it in a query string and an event field. A timeout is not
    // `exchange_failed`: a provider refusing a code and a provider not answering
    // send a human to different places, and the page's sentence for each says so.
    () =>
      new ConnectorError(
        "exchange_timed_out",
        `The authorization code exchange timed out after ` +
          `${EXCHANGE_TIMEOUT_MS}ms. Nothing was written.`,
      ),
  );
}

/** The `scope` field of a token response, as a set. Absent reads as empty. */
export function grantedScopeSet(json: TokenResponse): Set<string> {
  return new Set(
    typeof json.scope === "string"
      ? json.scope.split(/\s+/).filter(Boolean)
      : [],
  );
}

/** A non-empty string field of a token response, or null. */
export function stringField(
  json: TokenResponse,
  field: "refresh_token" | "access_token" | "id_token",
): string | null {
  const value = json[field];
  return typeof value === "string" && value !== "" ? value : null;
}
