import type { StradConfig } from "../../config/schema.ts";
import type { Principal } from "../index.ts";
import { ACCESS_TOKEN_PREFIX, readAccessToken, SpentCodes } from "./grants.ts";
import { ClientMetadataResolver, type DocumentFetcher } from "./cimd.ts";
import { ClientAssertionVerifier, ClientAuthenticator } from "./client-auth.ts";
import { grantProviderFromEnv, type McpGoogleProvider } from "./google.ts";
import {
  mcpOAuthKeysFromEnv,
  oauthKeyProblem,
  type McpOAuthKeys,
} from "./keys.ts";
import { ClientPolicies, principalSlugs } from "./policy.ts";

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
  };
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
        | "oauth_client_not_allowed";
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
 */
export function verifyAccessToken(
  raw: string,
  oauth: McpOAuth,
  resource: string | null,
  now: number = Date.now(),
): AccessVerdict {
  if (!looksLikeAccessToken(raw))
    return { ok: false, reason: "oauth_malformed" };

  const payload = readAccessToken(oauth.keys.access, raw, now);
  if (!payload) return { ok: false, reason: "oauth_expired_or_forged" };

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
