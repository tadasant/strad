import {
  buildPkceAuthorizeUrl,
  ConnectorError,
  exchangeAuthorizationCode,
  grantedScopeSet,
  stringField,
  type PendingConnectorAuth,
} from "./oauth-flow.ts";

/**
 * The GENERIC half of a console connector: RFC 6749 authorization code with
 * PKCE, against endpoints the config names.
 *
 * It is the same shape as `./google.ts` minus one thing, and the missing thing
 * is the interesting one: there is no proof of WHO consented. OpenID Connect is
 * what makes Google's account pinning possible, and nothing in plain OAuth 2.0
 * says whose account a token belongs to. So this flow checks the two things it
 * CAN check — that the durable credential the config asked for actually came
 * back, and that the scopes the config named were actually granted — and is
 * honest about the third. The console page says "whoever you were signed in as"
 * rather than naming an account strad did not verify.
 *
 * ## The two knobs, and why they are declared rather than sniffed
 *
 * `credential:` picks WHICH field of the token response is durable. The default
 * is `refresh_token`; `access_token` is for the providers whose access tokens do
 * not expire and which issue no refresh token at all. A "take the refresh token
 * if there is one, else the access token" rule would store an hour-long
 * credential the moment a provider changed its mind, and the symptom would be a
 * slug that worked all afternoon and was dead by morning.
 *
 * `clientAuth:` picks how the client secret reaches the token endpoint. There is
 * no fallback from one to the other for the same reason there is no retry: an
 * authorization code is single-use at the provider, so a second attempt with the
 * other method exchanges a spent code and reports the wrong cause.
 *
 * ## Nothing here is ever quoted back
 *
 * Same rule as everywhere else on this path, and it is enforced one file over —
 * every refusal is a {@link ConnectorError} with a code from a closed set and a
 * sentence this repo wrote. A provider's error body is read for nothing.
 */

export interface GenericAuthorizeInput {
  /** The provider's authorization endpoint, from `oauth.authorizeUrl`. */
  authorizeUrl: string;
  clientId: string;
  /** Exact, allowlisted, derived from `gateway.publicUrl`. Never from a request. */
  redirectUri: string;
  /** The config's capability scopes. There are no identity scopes to add. */
  scopes: readonly string[];
  /** `oauth.authorizeParams` — `access_type=offline` and friends. */
  extraParams: Readonly<Record<string, string>>;
}

/**
 * Build the consent URL for one generic slug.
 *
 * Every parameter strad owns is set by `buildPkceAuthorizeUrl`, and the config's
 * extras are applied after it — unable to overwrite one, both because the config
 * gate refuses a reserved key by name and because the builder skips it anyway.
 */
export function buildGenericAuthorizeUrl(
  input: GenericAuthorizeInput,
  random?: (bytes: number) => Buffer,
): PendingConnectorAuth {
  return buildPkceAuthorizeUrl(
    {
      endpoint: input.authorizeUrl,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      scopes: input.scopes,
      extra: input.extraParams,
    },
    random,
  );
}

export interface GenericExchangeInput {
  /** The provider's token endpoint, from `oauth.tokenUrl`. */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  verifier: string;
  /** How the client credentials travel. From `oauth.clientAuth`. */
  clientAuth: "post" | "basic";
  /** Which response field is the durable credential. From `oauth.credential`. */
  credential: "refresh_token" | "access_token";
  /** The capability scopes the config named. Every one must come back granted. */
  requiredScopes: readonly string[];
}

/** What a successful generic consent yields. The token is the only secret in it. */
export interface GenericGrant {
  /** The durable credential — whichever field `credential:` named. */
  token: string;
  /** What the provider says it granted, sorted. Empty when it said nothing. */
  grantedScopes: string[];
}

/**
 * Exchange the code, check the grant — then, and only then, return something the
 * caller may store.
 *
 * The ORDER is the atomicity story, as in the Google flow: every refusal happens
 * before this function returns, and it returns the token only once all of them
 * have passed, so the caller has no state in which it holds a token it should
 * not write.
 */
export async function exchangeGenericCode(
  input: GenericExchangeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<GenericGrant> {
  const json = await exchangeAuthorizationCode(
    {
      endpoint: input.tokenUrl,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      redirectUri: input.redirectUri,
      code: input.code,
      verifier: input.verifier,
      clientAuth: input.clientAuth,
    },
    fetchImpl,
  );

  // THE FIELD THE CONFIG NAMED, AND NO OTHER. Falling back to the other one
  // would quietly store a short-lived credential under a name the deployment
  // treats as durable.
  const token = stringField(json, input.credential);
  if (!token) {
    throw new ConnectorError(
      "no_credential",
      `The provider completed the consent but its token response carried no ` +
        `${input.credential}, which is the field this server's oauth.credential: ` +
        `names as the durable one. Nothing was written. Either the provider needs ` +
        `an extra authorization parameter to grant offline access (set it under ` +
        `oauth.authorizeParams:), or this provider's durable credential is the ` +
        `other field.`,
    );
  }

  // WHAT THE PROVIDER GRANTED, NOT WHAT STRAD ASKED FOR — but only when it said.
  //
  // RFC 6749 §5.1 makes `scope` OPTIONAL in a token response, and required only
  // when the grant differs from the request. A provider that omits it is
  // therefore asserting that the grant is what was asked for, and refusing on
  // silence would refuse every correct consent from a spec-compliant provider.
  // When it DOES speak, it is checked exactly as Google's is: a consent screen
  // where a human unticked a box leaves a slug that looks connected and fails on
  // its first real call.
  const granted = grantedScopeSet(json);
  if (granted.size > 0) {
    const withheld = input.requiredScopes.filter((s) => !granted.has(s));
    if (withheld.length > 0) {
      throw new ConnectorError(
        "scope_not_granted",
        `The consent did not grant ${withheld.length === 1 ? "the scope" : "the scopes"} ` +
          `this server requires (${withheld.join(", ")}). Nothing was written. ` +
          `Re-run the flow and leave every requested permission ticked.`,
      );
    }
  }

  return { token, grantedScopes: [...granted].sort() };
}
