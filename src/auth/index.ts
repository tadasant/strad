import type { StradConfig } from "../config/schema.ts";
import type { ServerSecretProviders } from "../secrets/provider/index.ts";
import { event } from "../telemetry/index.ts";
import { bearerToken } from "./credential.ts";
import { ACCESS_TOKEN_PREFIX } from "./mcp-oauth/grants.ts";
import {
  EnvTokenStore,
  ParameterTokenStore,
  verifyToken,
  type TokenStore,
} from "./tokens.ts";

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

/**
 * The token store could not be read, so no credential was judged at all.
 *
 * NOT an `Unauthenticated`, and the distinction is the point. A `401` tells the
 * caller its credential is bad, and a spec-compliant MCP client answers that by
 * discarding the token and walking into the re-authentication flow that
 * `/.well-known/oauth-protected-resource` points it at. Doing that to every
 * agent in a fleet because a parameter read timed out is a worse outage than the
 * blip that caused it. Nothing here was decided about the token, so nothing is
 * claimed about it: this propagates to the route guard
 * (`src/http/async-route.ts`), which answers `500 {"error":"internal_error"}` —
 * strad could not answer, come back.
 *
 * It carries NO detail. The store client's own message quotes resources and
 * payloads, and this error is constructed on a path whose every value is logged.
 * The fact ships as `strad.token_store_unavailable`; the reason is on stderr at
 * the throw site.
 */
export class TokenStoreUnavailable extends Error {
  constructor() {
    super("the system-token store could not be read");
    this.name = "TokenStoreUnavailable";
  }
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
/**
 * When the store-outage line was last written. Module-level because the outage
 * is a property of the PROCESS, not of a request: two concurrent requests are
 * seeing one outage and should produce one line between them.
 */
let lastOutageReportAt = -Infinity;

/** How often a continuing outage repeats itself, in ms. */
const OUTAGE_REPORT_INTERVAL_MS = 60_000;

function reportStoreOutage(
  detail: string | undefined,
  now: () => number = Date.now,
): void {
  const at = now();
  if (at - lastOutageReportAt < OUTAGE_REPORT_INTERVAL_MS) return;
  lastOutageReportAt = at;
  event({ evt: "strad.token_store_unavailable" });
  console.error(
    "[strad] the system-token store could not be read, so /mcp is failing " +
      "every request. This is fail-closed and deliberate: a store that cannot " +
      "be read is not an empty store and must not be treated as an open one." +
      (detail ? ` Reason: ${detail}` : ""),
  );
}

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
    if (verdict.reason === "unavailable") {
      // NOT an `Unauthenticated`. The store could not be read, so EVERY request
      // is failing rather than this one, and nothing was decided about the
      // credential in hand — see `TokenStoreUnavailable` for why answering `401`
      // would be the expensive mistake. It ships as an event because "every
      // agent is locked out" and "one agent has a bad token" are the same thing
      // from outside and opposite investigations from inside, and because a
      // gateway rejecting every agent it has is exactly what an operator needs
      // to learn from the ingestor rather than from a stream nothing scrapes.
      //
      // No fields: everything that could say more is either the caller's bytes
      // or the store client's own text. The REASON goes to stderr instead,
      // where `verdict.detail` is safe to print — see `TokenVerdict`.
      //
      // THROTTLED, because this fires on a path that by definition is failing
      // for every caller at once: unthrottled it is one exported record and one
      // stderr paragraph per request, which floods the ingestor at exactly the
      // moment an operator needs to read it. The same shape
      // `gateway/reachability.ts` uses — say it when it starts, then say it
      // again occasionally so a long outage does not go quiet.
      reportStoreOutage(verdict.detail);
      throw new TokenStoreUnavailable();
    }
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

/**
 * The token store this deployment declares.
 *
 * `auth.staticTokens.store` decides, and the two values differ in exactly one
 * property: WHEN the records are read. `env` reads `process.env` once, at
 * construction, so a mint or a revoke is a redeploy. `parameter-store` reads
 * through the runtime provider on the request path, so a mint or a revoke made
 * in the console at `/tokens` takes effect on the next request.
 *
 * Both read the same name and the same payload shape, which is what makes the
 * flip a config change with no data move. See `src/auth/tokens.ts`.
 *
 * `providers` is optional so the many call sites that build a store from a
 * config and an environment alone need not change. Its ABSENCE under
 * `parameter-store` is not a silent downgrade to the env var, though: without a
 * provider there is nothing to read the parameter with, and a store that quietly
 * fell back would serve the baked records to a deployment that believes it is
 * serving revocations. It fails closed, with the reason on stderr.
 */
export function tokenStoreFromConfig(
  cfg: StradConfig,
  env: NodeJS.ProcessEnv = process.env,
  providers?: ServerSecretProviders,
): TokenStore {
  if (!cfg.auth.staticTokens.enabled) {
    // An empty store, not a disabled check. /mcp still requires a token; it
    // just can never satisfy one. Fail closed.
    return new EnvTokenStore(undefined);
  }
  if (cfg.auth.staticTokens.store === "parameter-store") {
    // `gatewayStore`, NOT `shared`. The shared provider is the store CHAINED in
    // front of `process.env`, and that chain is the wrong seam for this one
    // name: `hydrateBootEnv` puts a copy of the roster in `process.env` at boot,
    // so a store miss on `STRAD_TOKENS` — a parameter destroyed, or one that
    // renders to nothing — would fall through to a frozen boot-time roster and
    // start admitting every token that was live then, revocations included.
    // Reading the store layer alone makes a miss a miss. See
    // `ServerSecretProviders` in src/secrets/provider/index.ts.
    if (!providers?.gatewayStore) {
      console.error(
        '[strad] auth.staticTokens.store is "parameter-store" but this process ' +
          "has no parameter-store layer to read the records from, so /mcp will " +
          "reject every request. That combination is refused by the config " +
          "schema, so reaching it means the store was built by a call site " +
          "that did not supply one.",
      );
      return new EnvTokenStore(undefined);
    }
    return new ParameterTokenStore(providers.gatewayStore);
  }
  return new EnvTokenStore(env.STRAD_TOKENS);
}
