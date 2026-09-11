import type { StradConfig } from "../../config/schema.ts";
import type { Principal } from "../index.ts";
import { ACCESS_TOKEN_PREFIX, readAccessToken, SpentCodes } from "./grants.ts";
import { grantProviderFromEnv, type McpGoogleProvider } from "./google.ts";
import {
  mcpOAuthKeysFromEnv,
  oauthKeyProblem,
  type McpOAuthKeys,
} from "./keys.ts";

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
  /** Roles an authenticated member of that domain holds at `/mcp`. */
  roles: string[];
  accessTokenTtlMs: number;
  keys: McpOAuthKeys;
  google: McpGoogleProvider;
  /** The one piece of server-side state in the flow. See `SpentCodes`. */
  spent: SpentCodes;
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

  return {
    hostedDomain,
    roles: settings.roles,
    accessTokenTtlMs: settings.accessTokenTtlSeconds * 1000,
    keys,
    google,
    spent: new SpentCodes(),
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
        | "oauth_no_resource_identifier";
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
 * Roles come from the current config too, never from the token. Every failure
 * mode returns the same `401` to the caller; the reason is for our logs.
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

  return {
    ok: true,
    principal: {
      kind: "mcp-oauth",
      // The Google subject, not the email: it is the stable identity and the
      // one that does not change when a person is renamed. It is what reaches
      // the logs and the spans.
      id: payload.sub,
      label: payload.email,
      roles: oauth.roles,
    },
  };
}

export { HostedDomainRefused } from "./google.ts";
export type { McpGoogleProvider } from "./google.ts";
