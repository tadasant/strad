import type { StradConfig } from "../config/schema.ts";
import { bearerToken } from "./credential.ts";
import { ACCESS_TOKEN_PREFIX } from "./mcp-oauth/grants.ts";
import { EnvTokenStore, verifyToken, type TokenStore } from "./tokens.ts";

/**
 * Who is making this request, and what are they entitled to?
 *
 * `roles` is the ONLY thing downstream authorization reads. It comes from the
 * server side — a token record or a verified Google identity — never from
 * anything the caller can set.
 */
export interface Principal {
  /**
   * `console-token` is a session opened by exchanging a single-use console
   * login token (src/auth/console-tokens.ts). Its roles were fixed by whoever
   * minted the token, and it can never mint one itself.
   */
  kind:
    | "system-token"
    | "google"
    | "console-bypass"
    | "console-token"
    | "mcp-oauth";
  /** Loggable identifier. Never a secret. */
  id: string;
  label: string;
  roles: string[];
}

export class Unauthenticated extends Error {
  constructor(
    message: string,
    /** For server logs. Never returned to the caller. */
    readonly reason: string,
  ) {
    super(message);
  }
}

/**
 * Verify an access token strad's own authorization server issued, already bound
 * to this request's canonical resource.
 *
 * A closure rather than an object, because the audience a token is checked
 * against is a property of the REQUEST — see `verifyAccessToken` in
 * `src/auth/mcp-oauth/index.ts` for why it is the origin plus `/mcp` and never
 * the URL the request arrived on. The router binds it per request; this module
 * only asks the question.
 */
export type OAuthAccessVerifier = (
  raw: string,
) => { ok: true; principal: Principal } | { ok: false; reason: string };

/**
 * Authenticate a request to /mcp.
 *
 * TWO credentials, and they are the only two. Not the console session, not the
 * dev bypass, not "no header means dev mode" — strad sits on the open internet
 * with no network perimeter in front of it, so this function is the entire gate.
 *
 *   1. A STATIC SYSTEM TOKEN, `strad_<env>_<pubid>_<secret>`. The credential a
 *      headless agent holds, minted out of band and long-lived. It is the
 *      load-bearing one for machine clients and nothing here changes it.
 *
 *   2. An OAUTH ACCESS TOKEN, `strad_oat_…`, issued by strad's own
 *      authorization server to a human who signed in through Google
 *      (`src/auth/mcp-oauth/`). Present only when `oauth` is supplied, which is
 *      to say only when that server is configured AND running.
 *
 * The prefix decides which, and it decides EXCLUSIVELY: an `strad_oat_` token
 * is never offered to the static store, and anything else never reaches the
 * OAuth verifier. That keeps each door's failures in its own vocabulary, and
 * keeps a deployment with no authorization server answering exactly as it did.
 */
export async function authenticateMcp(
  authorizationHeader: string | undefined,
  store: TokenStore,
  expectedEnv: string,
  oauth?: OAuthAccessVerifier,
): Promise<Principal> {
  const raw = bearerToken(authorizationHeader);
  if (!raw) {
    throw new Unauthenticated(
      "missing bearer token",
      "no_authorization_header",
    );
  }

  if (raw.startsWith(ACCESS_TOKEN_PREFIX)) {
    if (!oauth) {
      // A token from an authorization server this deployment does not run. It
      // cannot be a static token either — `parseToken` would read "oat" as the
      // environment segment and miss — so answering here is the difference
      // between one honest refusal and a confusing one about a `pubid`.
      throw new Unauthenticated("invalid token", "oauth_not_configured");
    }
    const verdict = oauth(raw);
    if (!verdict.ok) throw new Unauthenticated("invalid token", verdict.reason);
    return verdict.principal;
  }

  const verdict = await verifyToken(raw, store, expectedEnv);
  if (!verdict.ok) {
    // The caller always gets the same 401; `reason` is for our logs.
    throw new Unauthenticated("invalid token", verdict.reason);
  }

  return {
    kind: "system-token",
    id: verdict.record.pubid,
    label: verdict.record.label,
    roles: verdict.record.roles,
  };
}

export function tokenStoreFromConfig(
  cfg: StradConfig,
  env: NodeJS.ProcessEnv = process.env,
): TokenStore {
  if (!cfg.auth.staticTokens.enabled) {
    // An empty store, not a disabled check. /mcp still requires a token; it
    // just can never satisfy one. Fail closed.
    return new EnvTokenStore(undefined);
  }
  return new EnvTokenStore(env.STRAD_TOKENS);
}
