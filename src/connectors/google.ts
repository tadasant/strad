import { createHash, randomBytes } from "node:crypto";
import { verifyGoogleIdToken } from "../auth/google.ts";
import { withRequestDeadline } from "../util/deadline.ts";

/**
 * The Google half of a console connector: build the consent URL, exchange the
 * code, and prove WHICH account came back.
 *
 * This is NOT src/auth/google.ts, and the separation is deliberate rather than
 * incidental. That module signs a human INTO strad — one OAuth client, the
 * deployment's own, scoped to `openid email profile`, checked against a Workspace
 * `hd` claim, and the thing it returns is a session. This one obtains a
 * CREDENTIAL FOR A SERVER: a different OAuth client (the one the server's own
 * namespace holds), capability scopes the config pins, an offline grant, and the
 * thing it returns is a refresh token that goes straight into the parameter
 * store. Overloading the console-login callback with it would mean one redirect
 * URI, one client, and one consent posture serving two jobs that agree on none of
 * those.
 *
 * What they DO share is the ID-token verifier, and sharing it is the point: a
 * second RS256/JWKS/issuer/audience implementation is a second place to get the
 * only proof of identity in this flow wrong.
 *
 * ## Nothing here is ever quoted back
 *
 * Every failure below is a {@link ConnectorError} carrying a code from a closed
 * set and a sentence this repo wrote. Google's own error bodies are read for
 * NOTHING — not for a message, not for a hint, not for a log line. An upstream
 * OAuth error body is attacker-influenceable text on a path that is one string
 * concatenation away from a rendered page, a span attribute and an exception
 * report, and the operational value of it ("invalid_grant" versus a 400) is
 * carried by the code instead.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * How long the code exchange waits on Google before it is a refusal.
 *
 * Ten seconds, the number src/auth/google.ts bounds the console's own handshake
 * with: a different OAuth client and a different flow, but the same endpoint and
 * the same human waiting on a redirect. Node's `fetch` has no overall timeout,
 * so without it a stalled token endpoint holds this callback for undici's 300s
 * header timeout — and an authorization code is single-use and short-lived, so
 * every second past the point the exchange could have worked is spent on a code
 * that will be refused anyway.
 */
const EXCHANGE_TIMEOUT_MS = 10_000;

/**
 * The scopes strad adds to every connector consent, on top of the config's.
 *
 * They are how the callback learns WHICH account consented. Without them the
 * only available answer is "whichever one the browser was signed into", which is
 * not an answer at all — the account chooser is the human's to drive, and the
 * whole point of pinning `oauth.account` is that strad checks the result rather
 * than trusting the choice.
 *
 * `openid` mints the ID token; `email` puts a verified address in it. `profile`
 * is deliberately absent: a name and a picture are not needed to decide whether
 * this is the right account, and a connector should ask for the least that
 * settles the question.
 */
export const IDENTITY_SCOPES = ["openid", "email"] as const;

/** A closed set. Every one of these is a strad word, safe to log and export. */
export type ConnectorErrorCode =
  | "exchange_failed"
  | "exchange_timed_out"
  | "no_refresh_token"
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
  /** The CSRF value Google echoes back. Sealed into the transaction cookie. */
  state: string;
  /** The PKCE verifier. Sealed into the transaction cookie; never in a URL. */
  verifier: string;
  url: string;
}

export interface AuthorizeInput {
  clientId: string;
  /** Exact, allowlisted, derived from `gateway.publicUrl`. Never from a request. */
  redirectUri: string;
  /** The full set: identity scopes plus the config's capability scopes. */
  scopes: readonly string[];
  /** The account the slug is pinned to, as a hint to Google's chooser only. */
  loginHint: string;
}

/**
 * Build the consent URL for one slug.
 *
 * Three parameters here are what make the grant usable at all, and all three are
 * fixed by strad rather than configurable:
 *
 *   - `access_type=offline` is what asks for a refresh token instead of only an
 *     access token. Without it the exchange returns something that expires in an
 *     hour and the connector has nothing durable to store.
 *   - `prompt=consent` FORCES the consent screen even for an account that has
 *     already granted these scopes. Google returns a refresh token only on a
 *     fresh consent, so a reconnect without this comes back with no
 *     `refresh_token` at all — which the callback correctly refuses, leaving a
 *     human clicking Reconnect forever on a slug that never rotates.
 *   - `include_granted_scopes` is NOT set. Incremental authorization would hand
 *     back a token carrying whatever else that account had previously granted
 *     this client, which for a `-ro` slug is precisely the write scope its
 *     sibling asked for. A connector's grant should be exactly what its config
 *     names.
 */
export function buildAuthorizeUrl(
  input: AuthorizeInput,
  random: (bytes: number) => Buffer = randomBytes,
): PendingConnectorAuth {
  const state = random(32).toString("base64url");
  const verifier = random(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  // A hint to the account chooser, and NOT a security control: the human may
  // pick any account they like, and the callback checks what came back.
  url.searchParams.set("login_hint", input.loginHint);

  return { state, verifier, url: url.toString() };
}

export interface ExchangeInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  verifier: string;
  /** The account the slug is pinned to. The verified email must equal this. */
  expectedAccount: string;
  /** The capability scopes the config named. Every one must come back granted. */
  requiredScopes: readonly string[];
}

/**
 * What a successful consent yields. The token is the only secret in it, and the
 * only caller hands it straight to the parameter store.
 */
export interface ConnectorGrant {
  refreshToken: string;
  /** The verified `email` claim. Equal to `expectedAccount`, case-folded. */
  email: string;
  /** What Google says it granted, sorted. Safe metadata; no capability to it. */
  grantedScopes: string[];
}

/**
 * Exchange the code, prove the identity, check the grant — then, and only then,
 * return something the caller may store.
 *
 * The ORDER is the atomicity story. Every refusal below happens before this
 * function returns, and it returns the token only once all of them have passed,
 * so the caller has no state in which it holds a token it should not write. The
 * previous credential is untouched by construction: nothing here can reach the
 * store.
 */
export async function exchangeCode(
  input: ExchangeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectorGrant> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.verifier,
  });

  // THE BODY READ IS INSIDE THE DEADLINE, not merely the response. A host that
  // sends its headers and then trickles the body is the stall a header timeout
  // never catches, and a rejection that arrives after this call returned would
  // reach `src/ui/connector.ts` as a bare `DOMException` — classified
  // `store_failed`, "the write was refused", on a flow that never got a token.
  const json = await withRequestDeadline(
    EXCHANGE_TIMEOUT_MS,
    async (signal) => {
      const res = await fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal,
      });

      if (!res.ok) {
        // The STATUS and nothing else. Google's body on a failed exchange
        // carries `error_description`, which is upstream text — and on a
        // redirect-URI mismatch it quotes the URI back, which is ours but sets
        // the precedent.
        throw new ConnectorError(
          "exchange_failed",
          `Google refused the authorization code (HTTP ${res.status}). The code may ` +
            `have expired, been used already, or been issued for a different OAuth ` +
            `client than the one this server's namespace holds.`,
        );
      }

      return (await res.json()) as {
        refresh_token?: unknown;
        id_token?: unknown;
        scope?: unknown;
      };
    },
    // A CODE FROM THE CLOSED SET, like every other refusal here, because the
    // callback puts it in a query string and an event field. A timeout is not
    // `exchange_failed`: Google refusing a code and Google not answering send a
    // human to different places, and the page's sentence for each says so.
    () =>
      new ConnectorError(
        "exchange_timed_out",
        `The authorization code exchange timed out after ` +
          `${EXCHANGE_TIMEOUT_MS}ms. Nothing was written.`,
      ),
  );

  const refreshToken =
    typeof json.refresh_token === "string" && json.refresh_token !== ""
      ? json.refresh_token
      : null;
  const idToken =
    typeof json.id_token === "string" && json.id_token !== ""
      ? json.id_token
      : null;

  // NO REFRESH TOKEN IS A FAILURE, NOT A PARTIAL SUCCESS. Google withholds one
  // when the account has already consented and `prompt=consent` was not honoured
  // — an access token alone is an hour of capability and nothing to store, so
  // reporting success here would leave a slug that says "connected" and dies at
  // teatime.
  if (!refreshToken) {
    throw new ConnectorError(
      "no_refresh_token",
      `Google completed the consent but returned no refresh token, so there is ` +
        `nothing durable to store. Nothing was written. This usually means the ` +
        `account had already granted these scopes; revoking strad's access at ` +
        `myaccount.google.com and connecting again forces a fresh grant.`,
    );
  }

  if (!idToken) {
    throw new ConnectorError(
      "no_identity",
      `Google returned no ID token, so strad cannot prove which account ` +
        `consented. Nothing was written.`,
    );
  }

  // The ONE proof of identity, verified against Google's signing keys with this
  // slug's own client id as the audience — so an ID token minted for a different
  // OAuth client cannot be replayed into this flow.
  //
  // Its refusals are `AuthError`s and they stay that way. That class is the
  // console LOGIN's, so one reaching `src/ui/connector.ts` is classified
  // `store_failed` — which is wrong, and is wrong for every verifier refusal on
  // this route rather than only for the bounded one above. Translating them here
  // would coarsen a set of specific diagnoses ("audience mismatch", "signed by
  // an unknown key") into one code, which is a decision about this flow's
  // vocabulary and not about deadlines.
  const claims = await verifyGoogleIdToken(idToken, input.clientId);

  if (!claims.email || claims.email_verified !== true) {
    throw new ConnectorError(
      "identity_unverified",
      `The Google account that consented has no verified email address, so ` +
        `strad cannot check it against this server's configured account. ` +
        `Nothing was written.`,
    );
  }

  // Case-insensitive, because Google addresses are. Compared against the CONFIG,
  // never against anything the browser sent.
  if (claims.email.toLowerCase() !== input.expectedAccount.toLowerCase()) {
    throw new ConnectorError(
      "account_mismatch",
      `This server is pinned to ${input.expectedAccount}, and the consent came ` +
        `back from ${claims.email}. The token was discarded and the stored ` +
        `credential is unchanged. Sign in to Google as ` +
        `${input.expectedAccount} and try again.`,
    );
  }

  // WHAT GOOGLE GRANTED, NOT WHAT STRAD ASKED FOR. The consent screen lets a
  // human untick a scope; a token stored from that consent leaves a slug that
  // looks connected and 403s on its first real call, which is the least
  // diagnosable outcome available.
  const granted = new Set(
    typeof json.scope === "string"
      ? json.scope.split(/\s+/).filter(Boolean)
      : [],
  );
  const withheld = input.requiredScopes.filter((s) => !granted.has(s));
  if (withheld.length > 0) {
    throw new ConnectorError(
      "scope_not_granted",
      `The consent did not grant ${withheld.length === 1 ? "the scope" : "the scopes"} ` +
        `this server requires (${withheld.join(", ")}). Nothing was written. ` +
        `Re-run the flow and leave every requested permission ticked.`,
    );
  }

  return {
    refreshToken,
    email: claims.email,
    grantedScopes: [...granted].sort(),
  };
}
