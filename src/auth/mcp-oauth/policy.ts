import type { StradConfig } from "../../config/schema.ts";
import { entitledServers } from "../../gateway/entitlements.ts";
import { clientFingerprint } from "./clients.ts";
import { MCP_SCOPE } from "./metadata.ts";

/**
 * Who may hold a grant from strad's authorization server, and what it reaches.
 *
 * ## Two inputs narrow a grant, and neither can widen it
 *
 *   1. The CLIENT's ceiling: `auth.mcpOAuth.clients[]` for a listed client,
 *      the global `auth.mcpOAuth.roles` for any other. Roles, then an optional
 *      slug allowlist intersected with what those roles reach.
 *   2. The GRANT's slug set: what the client asked for as `slug:<name>` scopes
 *      and the human left ticked on the consent screen. Sealed into the code,
 *      the refresh token and the access token. Absent means "the whole
 *      ceiling" — the `mcp` scope, and every grant minted before slug scopes
 *      existed.
 *
 * Both are applied at verification time, so a token reaches at most
 * `entitledServers(ceiling roles) ∩ client servers ∩ grant slugs`, with the
 * first two read from the CURRENT config. `Principal.slugs` carries the
 * intersection of the last two to `entitledServers`, which intersects it with
 * the first.
 *
 * ## Defaults change nothing
 *
 * With `clients: []` and `allowUnlistedClients: true` every client resolves to
 * the global roles and TTL, no `Principal.slugs` is set, and every token —
 * including one minted before this file existed — verifies to exactly the
 * principal it always did.
 */

/** The scope prefix that names one slug. */
export const SLUG_SCOPE_PREFIX = "slug:";

/** What one client may be granted, resolved from the current config. */
export interface ClientPolicy {
  /** True when an `auth.mcpOAuth.clients[]` entry matched. */
  listed: boolean;
  /** The operator's display name for a listed client. */
  name?: string;
  /** The role ceiling. */
  roles: string[];
  /** The operator's slug allowlist, when the entry has one. */
  servers?: string[];
  accessTokenTtlMs: number;
}

/**
 * The per-client view of `auth.mcpOAuth`, resolved once at boot.
 *
 * Indexed by both the client id and its fingerprint, because the token
 * endpoint and `/oauth/authorize` hold the id while an access token holds only
 * `cid` — and the access token is where the policy must still apply.
 */
export class ClientPolicies {
  private readonly byId = new Map<string, ClientPolicy>();
  private readonly byCid = new Map<string, ClientPolicy>();
  private readonly fallback: ClientPolicy;
  readonly allowUnlisted: boolean;
  readonly dynamicRegistration: boolean;
  readonly advertiseSlugScopes: boolean;

  constructor(settings: StradConfig["auth"]["mcpOAuth"]) {
    const defaultTtlMs = settings.accessTokenTtlSeconds * 1000;
    this.fallback = {
      listed: false,
      roles: settings.roles,
      accessTokenTtlMs: defaultTtlMs,
    };
    this.allowUnlisted = settings.allowUnlistedClients;
    this.dynamicRegistration = settings.dynamicRegistration;
    this.advertiseSlugScopes = settings.advertiseSlugScopes;
    for (const entry of settings.clients) {
      const policy: ClientPolicy = {
        listed: true,
        ...(entry.name ? { name: entry.name } : {}),
        roles: entry.roles ?? settings.roles,
        ...(entry.servers ? { servers: entry.servers } : {}),
        accessTokenTtlMs:
          (entry.accessTokenTtlSeconds ?? settings.accessTokenTtlSeconds) *
          1000,
      };
      this.byId.set(entry.clientId, policy);
      this.byCid.set(clientFingerprint(entry.clientId), policy);
    }
  }

  /** The policy for a client id, or null when this client may not hold a grant. */
  forClient(clientId: string): ClientPolicy | null {
    return (
      this.byId.get(clientId) ?? (this.allowUnlisted ? this.fallback : null)
    );
  }

  /** The same, from the `cid` fingerprint sealed into a grant. */
  forFingerprint(cid: string): ClientPolicy | null {
    return this.byCid.get(cid) ?? (this.allowUnlisted ? this.fallback : null);
  }

  /** Every ceiling a grant could have: the fallback (when open) and each entry. */
  all(): ClientPolicy[] {
    return [
      ...(this.allowUnlisted ? [this.fallback] : []),
      ...this.byId.values(),
    ];
  }
}

/** The slugs a client's ceiling reaches today, sorted. */
export function ceilingSlugs(policy: ClientPolicy, cfg: StradConfig): string[] {
  return [
    ...entitledServers(
      {
        kind: "mcp-oauth",
        id: "ceiling",
        label: "ceiling",
        roles: policy.roles,
        ...(policy.servers ? { slugs: policy.servers } : {}),
      },
      cfg,
    ),
  ].sort();
}

/**
 * The slug narrowing a principal carries: the grant's slugs intersected with
 * the client's allowlist. Undefined when neither narrows — which is the case
 * for every grant under a default config.
 */
export function principalSlugs(
  policy: ClientPolicy,
  grantSlugs: readonly string[] | undefined,
): string[] | undefined {
  if (!policy.servers && !grantSlugs) return undefined;
  if (!policy.servers) return [...(grantSlugs ?? [])];
  if (!grantSlugs) return [...policy.servers];
  const allowed = new Set(policy.servers);
  return grantSlugs.filter((s) => allowed.has(s));
}

/**
 * Read a `scope` parameter.
 *
 * Space-delimited (RFC 6749 §3.3). `slug:<name>` tokens are collected; `mcp`
 * and anything else are ignored, so a client that sends a scope it invented
 * still gets a connection — the same tolerance this server always had. The
 * answer is `null` when no slug was named, which means "no narrowing asked
 * for", and is the only answer a client that knows nothing of slug scopes
 * ever gets.
 */
export function requestedSlugs(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const out: string[] = [];
  for (const token of raw.split(" ")) {
    if (!token.startsWith(SLUG_SCOPE_PREFIX)) continue;
    const slug = token.slice(SLUG_SCOPE_PREFIX.length);
    if (slug !== "" && !out.includes(slug)) out.push(slug);
  }
  return out.length > 0 ? out : null;
}

/**
 * The `scope` a token response reports: `mcp` for an unnarrowed grant,
 * otherwise one `slug:` token per slug, in a stable order.
 */
export function scopeString(slugs: readonly string[] | undefined): string {
  if (!slugs) return MCP_SCOPE;
  return [...slugs]
    .sort()
    .map((s) => `${SLUG_SCOPE_PREFIX}${s}`)
    .join(" ");
}

/** The scopes the metadata documents advertise. */
export function advertisedScopes(
  policies: ClientPolicies,
  cfg: StradConfig,
): string[] {
  if (!policies.advertiseSlugScopes) return [MCP_SCOPE];
  const slugs = new Set<string>();
  for (const policy of policies.all()) {
    for (const slug of ceilingSlugs(policy, cfg)) slugs.add(slug);
  }
  return [
    MCP_SCOPE,
    ...[...slugs].sort().map((s) => `${SLUG_SCOPE_PREFIX}${s}`),
  ];
}
