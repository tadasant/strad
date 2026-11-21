import type { StradConfig } from "../../config/schema.ts";
import type { Principal } from "../index.ts";
import type { BlobStore } from "../../state/store.ts";
import {
  ACCESS_TOKEN_PREFIX,
  readAccessToken,
  readRecordAccessToken,
  SpentCodes,
} from "./grants.ts";
import {
  grantBlobsFor,
  grantPrefix,
  GrantStore,
  type CredentialReader,
  type GrantRecord,
} from "./grant-store.ts";
import { ClientMetadataResolver, type DocumentFetcher } from "./cimd.ts";
import { ClientAssertionVerifier, ClientAuthenticator } from "./client-auth.ts";
import { grantProviderFromEnv, type McpGoogleProvider } from "./google.ts";
import {
  mcpOAuthKeysFromEnv,
  oauthKeyProblem,
  type McpOAuthKeys,
} from "./keys.ts";
import { ClientPolicies, principalSlugs, type ClientPolicy } from "./policy.ts";

/**
 * Is strad an authorization server on this deployment, and what does it issue?
 *
 * Resolved ONCE at boot and shared, exactly as `resolveConsoleAuth` is and for
 * the same reason: the routes that serve the flow, the metadata document that
 * advertises it, the protected-resource document that points at it and the
 * `/mcp` door that accepts its tokens must all agree on whether it exists. Two
 * independent readings of "is OAuth usable?" is how you get a `401` pointing at
 * an authorization server whose `/authorize` answers `404`.
 *
 * `ready` is narrower than `auth.mcpOAuth.enabled`, on the same three counts the
 * console's is: the flag, a Google OAuth client, and key material. A deployment
 * that flipped the flag and seeded nothing advertises no authorization server
 * at all — a `404` at the well-known path is an honest "there is none here",
 * and an advertised one that cannot complete is not.
 */
export interface McpOAuth {
  /** The Workspace domain enforced on every authorization and every refresh. */
  hostedDomain: string;
  /**
   * Per-client roles, slug allowlist and TTL, plus the two open-door flags
   * (`policy.ts`). The global `auth.mcpOAuth.roles` and TTL are its fallback,
   * which is the whole answer when no `clients` are configured.
   */
  policies: ClientPolicies;
  keys: McpOAuthKeys;
  google: McpGoogleProvider;
  /** The one piece of server-side state in the flow. See `SpentCodes`. */
  spent: SpentCodes;
  /**
   * Client id metadata documents (`cimd.ts`): the fetch, the checks and the
   * cache. On whenever the flow is — there is no separate switch, for the
   * reason open registration has none.
   */
  clientMetadata: ClientMetadataResolver;
  /**
   * `private_key_jwt` client authentication (`client-auth.ts`). Always
   * present: whether a request must authenticate is decided per request, and
   * a grant sealed to a confidential client still demands its assertion after
   * the feature is switched off.
   */
  clientAuth: ClientAuthenticator;
  /**
   * Server-side grant records (`grant-store.ts`), or null when
   * `auth.mcpOAuth.grants.enabled` is off — which is the stateless server,
   * unchanged.
   */
  grants: GrantsRuntime | null;
}

/** What the grant-record half of the server needs at request time. */
export interface GrantsRuntime {
  store: GrantStore;
  /** `refreshReuseGraceSeconds`, in ms. */
  graceMs: number;
  legacy: "accept" | "upgrade" | "refuse";
}

export interface ResolveMcpOAuthOptions {
  config: StradConfig;
  env: NodeJS.ProcessEnv;
  /**
   * Test seam: substitute the whole Google leg. A real round trip needs
   * accounts.google.com, so the end-to-end tests replace this and drive every
   * other line of the flow for real.
   */
  google?: McpGoogleProvider | null;
  /**
   * Test seam: substitute the client-metadata fetch. The real one refuses
   * every loopback address, which is where a test's document server lives.
   */
  clientMetadataFetch?: DocumentFetcher;
  /**
   * How the grant store reads `STRAD_STATE_GCS_*`: the gateway's secret
   * provider, so a store-backed deployment needs nothing hydrated. Falls back
   * to `env`.
   */
  credentials?: CredentialReader;
  /** Test seam: the durable layer under the grant store. */
  grantBlobs?: () => Promise<BlobStore>;
  /** Test seam: the clock the grant store measures staleness and sweeps on. */
  now?: () => number;
  log?: (msg: string) => void;
}

/** The authorization server, or null when this deployment has none. */
export function resolveMcpOAuth(opts: ResolveMcpOAuthOptions): McpOAuth | null {
  const { config: cfg, env } = opts;
  const log = opts.log ?? console.warn;
  const settings = cfg.auth.mcpOAuth;

  if (!settings.enabled) return null;

  // The schema refuses `enabled` with neither domain declared, so this fallback
  // has a value in every config that reaches here. The `??` is the type's, not
  // a second policy.
  const hostedDomain =
    settings.hostedDomain ?? cfg.auth.google?.hostedDomain ?? "";

  const google =
    opts.google !== undefined
      ? opts.google
      : grantProviderFromEnv(hostedDomain, env);
  const keys = mcpOAuthKeysFromEnv(env);

  if (!google || !keys || hostedDomain === "") {
    const why =
      hostedDomain === ""
        ? "no hosted domain is declared"
        : !google
          ? "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not both set"
          : (oauthKeyProblem(env) ?? "unknown");
    log(
      `[strad] auth.mcpOAuth.enabled is true but the /mcp authorization server ` +
        `cannot run: ${why}. /mcp accepts static tokens only, and no ` +
        `authorization-server metadata is published.`,
    );
    return null;
  }

  if (settings.roles.length === 0) {
    // Not a failure — the flow completes and the token verifies — but every
    // `?servers=` it is used with answers 424 and an empty selection serves no
    // tools, which from a client looks exactly like a broken gateway.
    log(
      `[strad] auth.mcpOAuth.roles is empty, so a human who signs in through ` +
        `the /mcp OAuth flow is entitled to no servers at all. Name a role.`,
    );
  }

  log(
    `[strad] /mcp OAuth is live for the ${hostedDomain} Google Workspace. The ` +
      `OAuth client's authorized redirect URI must include: ` +
      `<publicUrl>/oauth/callback/google`,
  );

  if (!settings.allowUnlistedClients && settings.clients.length === 0) {
    log(
      `[strad] auth.mcpOAuth.allowUnlistedClients is false and no clients are ` +
        `listed, so no client can complete the /mcp OAuth flow.`,
    );
  }

  const policies = new ClientPolicies(settings);
  const clientMetadata = new ClientMetadataResolver({
    ...(opts.clientMetadataFetch ? { fetch: opts.clientMetadataFetch } : {}),
    parse: { privateKeyJwt: policies.privateKeyJwt },
  });
  let grants: GrantsRuntime | null = null;
  if (settings.grants.enabled) {
    const read: CredentialReader =
      opts.credentials ??
      (async (name) => {
        const value = env[name];
        return value && value.trim() !== "" ? value : undefined;
      });
    const kind = settings.grants.store;
    grants = {
      store: new GrantStore({
        kind,
        blobs: opts.grantBlobs ?? grantBlobsFor(kind, read, log),
        key: keys.grantState,
        prefix: grantPrefix(cfg.gateway.env),
        ...(opts.now ? { now: opts.now } : {}),
        warn: log,
      }),
      graceMs: settings.grants.refreshReuseGraceSeconds * 1000,
      legacy: settings.grants.legacyTokens,
    };
    // Said at boot rather than at the first refresh that needs it: with
    // records on, a stateless refresh consults the store too, so a store this
    // process cannot reach is every connector failing its next refresh.
    const store = grants.store;
    void store.probe().then((problem) => {
      if (problem) {
        log(
          `[strad] auth.mcpOAuth.grants is on but the grant store cannot be ` +
            `reached: ${problem} Record-backed grants are refused, and ` +
            `refreshing or revoking a stateless one answers 503, until it can.`,
        );
      }
    });
    log(
      kind === "memory"
        ? `[strad] auth.mcpOAuth.grants is on with store: memory. Every ` +
            `record-backed grant is forgotten on restart, and its client signs ` +
            `in again. Use store: gcs on any deployment people rely on.`
        : `[strad] auth.mcpOAuth.grants is on: new grants are record-backed, ` +
            `kept under ${grantPrefix(cfg.gateway.env)}/ in the shared state ` +
            `store. Legacy (stateless) tokens: ${settings.grants.legacyTokens}.`,
    );
  }

  return {
    hostedDomain,
    policies,
    keys,
    google,
    spent: new SpentCodes(),
    clientMetadata,
    clientAuth: new ClientAuthenticator(
      new ClientAssertionVerifier(
        opts.clientMetadataFetch ? { fetch: opts.clientMetadataFetch } : {},
      ),
      clientMetadata,
    ),
    grants,
  };
}

/**
 * When a record-backed grant stops being refreshable: the record's own
 * deadline, tightened by the client's CURRENT refresh TTL so that lowering it
 * in config shortens grants already issued. Null = no deadline.
 */
export function grantDeadline(
  record: GrantRecord,
  policy: ClientPolicy | null,
): number | null {
  const fromPolicy =
    policy?.refreshTokenTtlMs != null
      ? record.createdAt + policy.refreshTokenTtlMs
      : null;
  if (record.expiresAt === null) return fromPolicy;
  if (fromPolicy === null) return record.expiresAt;
  return Math.min(record.expiresAt, fromPolicy);
}

/** Does this credential claim to be an access token this server issued? */
export function looksLikeAccessToken(raw: string): boolean {
  return raw.startsWith(ACCESS_TOKEN_PREFIX);
}

export type AccessVerdict =
  | { ok: true; principal: Principal }
  | {
      ok: false;
      reason:
        | "oauth_malformed"
        | "oauth_expired_or_forged"
        | "oauth_audience_mismatch"
        | "oauth_domain_changed"
        | "oauth_no_resource_identifier"
        | "oauth_client_not_allowed"
        | "oauth_legacy_refused"
        | "oauth_grants_disabled"
        | "oauth_grant_unknown"
        | "oauth_grant_dead"
        | "oauth_grant_expired"
        | "oauth_token_revoked"
        | "oauth_exchange_disabled";
    };

/**
 * Verify an OAuth access token presented at `/mcp`.
 *
 * Three checks, and the order is not arbitrary.
 *
 * 1. **The envelope.** AES-GCM either opens it or it does not, which covers
 *    forgery, tampering and a token from a rotated key in one answer. Expiry is
 *    checked on the payload.
 *
 * 2. **The audience (RFC 8707).** The token's `aud` must be the canonical
 *    resource identifier for THIS request's origin — `https://host/mcp`, built
 *    from the origin and the literal path, and never from `req.originalUrl`.
 *    That is what keeps `?servers=granola` out of the comparison: a token
 *    minted for `https://host/mcp` is the same token at
 *    `https://host/mcp?servers=granola`, because `?servers=` is a selection
 *    hint and not a resource (`src/gateway/entitlements.ts`).
 *
 * 3. **The domain, against the CURRENT config.** Re-checked here rather than
 *    trusted from the token, so re-pointing a deployment at another Workspace
 *    — or turning the flow off — takes effect on tokens already in the wild
 *    within the access token's lifetime rather than at its issuer's discretion.
 *
 * 4. **The client, against the CURRENT config.** The token's `cid` picks the
 *    client's policy (`policy.ts`): a listed client's roles and slug
 *    allowlist, or the global roles. A client the config no longer admits —
 *    `allowUnlistedClients: false` and not listed — is refused.
 *
 * Roles come from the current config too, never from the token. The token
 * contributes only its optional slug narrowing, which `entitledServers`
 * intersects last and which can therefore only remove. Every failure mode
 * returns the same `401` to the caller; the reason is for our logs.
 *
 * 5. **The grant record**, for a token that names one (`v: 4`): it must exist,
 *    be active, be inside its deadline, have every ancestor active, and not
 *    list this token's `jti` as revoked. Read through the grant store's cache,
 *    so this is a map lookup on the hot path and a GCS read at most once per
 *    `staleAfterMs` per grant. A store that cannot answer, with nothing
 *    cached, THROWS — see `OAuthAccessVerifier`.
 *
 *    A stateless token (`v: 1 | 2`) has no record and is judged as it always
 *    was, unless `grants.legacyTokens` is `refuse`.
 */
export async function verifyAccessToken(
  raw: string,
  oauth: McpOAuth,
  resource: string | null,
  now: number = Date.now(),
): Promise<AccessVerdict> {
  if (!looksLikeAccessToken(raw))
    return { ok: false, reason: "oauth_malformed" };

  const record = readRecordAccessToken(oauth.keys.access, raw, now);
  const payload = record ?? readAccessToken(oauth.keys.access, raw, now);
  if (!payload) return { ok: false, reason: "oauth_expired_or_forged" };
  if (!record && oauth.grants?.legacy === "refuse") {
    return { ok: false, reason: "oauth_legacy_refused" };
  }

  if (resource === null) {
    // No origin means no canonical resource to compare against — the same
    // state that makes the protected-resource document a 404. Accepting the
    // token anyway would be skipping the audience check whenever the origin is
    // unreadable, which is precisely when it matters.
    return { ok: false, reason: "oauth_no_resource_identifier" };
  }
  if (payload.aud !== resource) {
    return { ok: false, reason: "oauth_audience_mismatch" };
  }

  if (payload.hd !== oauth.hostedDomain) {
    return { ok: false, reason: "oauth_domain_changed" };
  }

  const policy = oauth.policies.forFingerprint(payload.cid);
  if (!policy) return { ok: false, reason: "oauth_client_not_allowed" };

  if (record) {
    if (!oauth.grants) return { ok: false, reason: "oauth_grants_disabled" };
    const store = oauth.grants.store;
    const grant = await store.get(record.gid);
    if (!grant || grant.cid !== record.cid) {
      return { ok: false, reason: "oauth_grant_unknown" };
    }
    // A token-exchange child is honoured only while its client's entry still
    // allows exchange, so removing `tokenExchange` from config ends every
    // child at once rather than at each one's expiry.
    if (grant.exchange && !policy.tokenExchange) {
      return { ok: false, reason: "oauth_exchange_disabled" };
    }
    const { dead, path } = await store.chain(grant);
    if (dead) return { ok: false, reason: "oauth_grant_dead" };
    // Every grant on the chain must be inside its deadline, not only this
    // one: a token-exchange child dies when the grant it was minted under
    // expires, including when a config change shortens that grant.
    for (const link of path) {
      const deadline = grantDeadline(
        link,
        link === grant ? policy : oauth.policies.forFingerprint(link.cid),
      );
      if (deadline !== null && deadline <= now) {
        return { ok: false, reason: "oauth_grant_expired" };
      }
    }
    if (grant.revokedAccess?.[record.jti]) {
      return { ok: false, reason: "oauth_token_revoked" };
    }
    store.touch(grant.gid);
  }

  const slugs = principalSlugs(policy, payload.slugs);

  return {
    ok: true,
    principal: {
      kind: "mcp-oauth",
      // The Google subject, not the email: it is the stable identity and the
      // one that does not change when a person is renamed. It is what reaches
      // the logs and the spans.
      id: payload.sub,
      label: payload.email,
      roles: policy.roles,
      ...(slugs ? { slugs } : {}),
    },
  };
}

export { HostedDomainRefused } from "./google.ts";
export type { McpGoogleProvider } from "./google.ts";
