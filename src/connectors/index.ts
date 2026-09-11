import type { ServerConfig, StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import {
  parameterPath,
  staticNamespace,
  type ParameterMeta,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import { storeForPath } from "../ui/store-client.ts";
import { IDENTITY_SCOPES } from "./google.ts";

export {
  buildAuthorizeUrl,
  exchangeCode,
  ConnectorError,
  IDENTITY_SCOPES,
  type ConnectorErrorCode,
  type ConnectorGrant,
} from "./google.ts";

/**
 * What the console needs to know about one server's OAuth connector, derived
 * from config and from the store — and never from a request.
 *
 * ## The three values are the SLUG's, and only the slug's
 *
 * Every lookup here composes `/strad/{env}/mcp/{slug}/static/{VARIABLE}` and asks
 * the parameter store about that exact path. It does not go through
 * `ServerSecretProviders.forServer()`, and the difference matters: that provider
 * layers the deployment-wide `/gateway/static/` namespace BEHIND the slug's own,
 * which is right for resolving a `${NAME}` and wrong here. A client id seeded
 * once at the gateway would make all six Google Sheets slugs look ready while
 * none of them owned a credential, and the refresh token this flow writes would
 * land beside a client secret that belongs to nobody in particular.
 *
 * So: this slug's namespace, no fallback, no sibling, no gateway. A slug that is
 * not seeded reads as NOT READY, which is the honest answer and the one the
 * console can act on.
 *
 * ## Why the ADMIN store and not the resolver
 *
 * The console already holds the store-admin credential — it is the only
 * credential in strad that can write a parameter or read a secret value, it is
 * injected on the core component alone (`consoleEnv:`), and it is what
 * `/ui/<secrets-slug>` and the parameter write-back route already use. Reusing it
 * means this flow adds no fourth credential, no second secret-writing
 * implementation, and no new place for the base64url envelope or the
 * per-parameter Secret Manager grant to be got wrong.
 */

/** A server that declares `oauth:`, with the block narrowed to non-optional. */
export interface ConnectorServer {
  server: ServerConfig;
  oauth: NonNullable<ServerConfig["oauth"]>;
}

/**
 * The `oauth:`-declaring server for a slug, or null. Config only.
 *
 * `enabled: false` is a NO here, and that is the console's fence as much as the
 * renderer's: a disabled server is skipped by `renderAppSpec` entirely, so a
 * consent run against one would mint a real Google credential into a namespace
 * no render will ever read — the same "credential in a drawer" the kind check in
 * the config gate refuses, arriving at runtime instead.
 */
export function connectorFor(
  config: StradConfig,
  slug: string,
): ConnectorServer | null {
  const server = config.servers.find((s) => s.slug === slug);
  if (!server?.enabled || !server.oauth) return null;
  return { server, oauth: server.oauth };
}

/** Every ENABLED server on this deployment that declares a connector, in config order. */
export function connectorServers(config: StradConfig): ConnectorServer[] {
  return config.servers
    .filter((s) => s.enabled && s.oauth)
    .map((s) => ({ server: s, oauth: s.oauth! }));
}

/**
 * The tier a slug's scopes amount to, DERIVED rather than declared.
 *
 * A label in the config would be a second source of truth for something the
 * scopes already say, and the failure mode of a wrong one is a page telling a
 * human "read-only" above a button that requests write. Google's convention is
 * that a read-only scope ends in `.readonly`, so the rule is: every capability
 * scope read-only, or the tier is read-write. It errs toward the alarming word,
 * which is the right direction for a sentence a human reads before consenting.
 */
export function connectorTier(
  scopes: readonly string[],
): "read-only" | "read-write" {
  return scopes.every((s) => s.endsWith(".readonly"))
    ? "read-only"
    : "read-write";
}

/**
 * Everything strad asks Google for: identity first, then the config's capability
 * scopes. Deduplicated, order preserved, because the config gate already refuses
 * an identity scope written by hand.
 */
export function requestedScopes(oauth: {
  scopes: readonly string[];
}): string[] {
  return [...new Set([...IDENTITY_SCOPES, ...oauth.scopes])];
}

/**
 * The exact, allowlisted redirect URI for this deployment's connector flow.
 *
 * Derived from `gateway.publicUrl` and from nothing else — never from a `Host`
 * header, never from a query parameter. Staging and production therefore have
 * DIFFERENT exact callback URIs, and each must be registered on the Google OAuth
 * client; that is a property of the design rather than a wart, because a
 * redirect URI an attacker can influence is the classic way an authorization
 * code leaves the building.
 *
 * Null when the deployment declares no `publicUrl`: without one there is no URI
 * to register, and offering a button that redirects to a URI Google will reject
 * is worse than saying so.
 */
export function connectorRedirectUri(config: StradConfig): string | null {
  const publicUrl = config.gateway.publicUrl;
  if (!publicUrl) return null;
  return `${publicUrl.replace(/\/$/, "")}${CONNECTOR_CALLBACK_PATH}`;
}

/** One path, for every slug. Which server is being connected lives in sealed state. */
export const CONNECTOR_CALLBACK_PATH = "/ui/oauth/callback";

/** The store path this connector's refresh token lives at. */
export function refreshTokenPath(
  config: StradConfig,
  entry: ConnectorServer,
): string {
  return parameterPath(
    config.gateway.env,
    entry.server.slug,
    entry.oauth.refreshTokenVariable,
  );
}

/**
 * Which of the three variables this slug's own namespace holds.
 *
 * Metadata only — `list()` returns no secret value, and for a secret parameter
 * the Parameter Manager payload is a `__REF__` pointer. So the console can answer
 * "is this connector set up, and is it connected" without any value-reading
 * permission and without reading a value.
 */
export interface ConnectorPresence {
  clientId: boolean;
  clientSecret: boolean;
  refreshToken: boolean;
  /**
   * The note strad wrote when it last connected this slug: the verified email,
   * the granted scopes, and when. Safe metadata by construction — see
   * {@link connectionNote}. Absent for a token seeded by hand.
   */
  note?: string;
}

export function presenceFrom(
  entry: ConnectorServer,
  namespace: string,
  metas: readonly ParameterMeta[],
): ConnectorPresence {
  const held = new Map<string, ParameterMeta>();
  for (const meta of metas) {
    if (!meta.path.startsWith(namespace)) continue;
    if (!meta.hasValue) continue;
    held.set(meta.variable, meta);
  }
  const token = held.get(entry.oauth.refreshTokenVariable);
  return {
    clientId: held.has(entry.oauth.clientIdVariable),
    clientSecret: held.has(entry.oauth.clientSecretVariable),
    refreshToken: Boolean(token),
    ...(token?.note ? { note: token.note } : {}),
  };
}

/** The connector's setup state, as the console renders it. */
export type ConnectorState =
  | { kind: "no_store"; reason: string }
  | { kind: "no_redirect_uri" }
  | { kind: "store_error"; reason: string }
  | { kind: "incomplete"; missing: string[] }
  | { kind: "ready"; presence: ConnectorPresence }
  | { kind: "connected"; presence: ConnectorPresence };

export interface ConnectorDeps {
  config: StradConfig;
  secrets: SecretBag;
  /** Test seam, threaded through to `storeForPath`. */
  parametersStore?: Parameters<typeof storeForPath>[3]["parametersStore"];
}

/**
 * The admin store that owns this connector's namespace, or why there is none.
 *
 * `storeForPath` is the SAME resolution the parameter write-back route uses: a
 * deployment can front more than one parameter store, and the path decides which
 * console credential writes it. Picking "the first secrets server" would write a
 * Google credential with somebody else's admin key.
 */
export function connectorStore(
  deps: ConnectorDeps,
  entry: ConnectorServer,
): { store: ParameterStore } | { store: null; reason: string } {
  return storeForPath(
    deps.config,
    deps.secrets,
    refreshTokenPath(deps.config, entry),
    { parametersStore: deps.parametersStore },
  );
}

/**
 * Read the connector's state for one slug.
 *
 * Deliberately says READY rather than HEALTHY, and CONNECTED rather than
 * WORKING. A stored refresh token is evidence that a human once consented; it is
 * not evidence that Google still accepts it. Google expires a token from an app
 * in "testing" after seven days, and revokes on a password change — neither of
 * which the store can see. The only honest live signal is a call that fails, and
 * the console does not make one.
 */
export async function readConnectorState(
  deps: ConnectorDeps,
  entry: ConnectorServer,
): Promise<ConnectorState> {
  if (!connectorRedirectUri(deps.config)) return { kind: "no_redirect_uri" };

  const resolved = connectorStore(deps, entry);
  if (!resolved.store) return { kind: "no_store", reason: resolved.reason };

  const namespace = staticNamespace(deps.config.gateway.env, entry.server.slug);

  let metas: ParameterMeta[];
  try {
    metas = await resolved.store.list(namespace);
  } catch (err) {
    // The message describes the OPERATION. A store client's exception can quote
    // a rendered value, so it is classified rather than echoed.
    return {
      kind: "store_error",
      reason:
        `strad could not list ${namespace}, so it cannot tell whether this ` +
        `connector is set up. ${err instanceof Error ? err.name : "The store"} ` +
        `did not answer.`,
    };
  }

  const presence = presenceFrom(entry, namespace, metas);

  // THE OAUTH APPLICATION IS THE HUMAN'S TO SEED, AND IT IS SEEDED PER SLUG.
  // A client id present only under /gateway/static/, or under a sibling slug,
  // does not make this connector ready — nothing here ever looked anywhere else.
  const missing: string[] = [];
  if (!presence.clientId) missing.push(entry.oauth.clientIdVariable);
  if (!presence.clientSecret) missing.push(entry.oauth.clientSecretVariable);
  if (missing.length > 0) return { kind: "incomplete", missing };

  return presence.refreshToken
    ? { kind: "connected", presence }
    : { kind: "ready", presence };
}

/**
 * The metadata strad records beside a stored refresh token.
 *
 * Safe by construction, and short enough to read in a table cell: who consented,
 * what was granted, and when. No token, no fingerprint, no length — the note is
 * rendered into HTML on a page a human screenshots, so the rule is that nothing
 * derived from the secret may reach it.
 */
export function connectionNote(
  email: string,
  grantedScopes: readonly string[],
  at: Date,
): string {
  return (
    `connected as ${email} via the strad console on ${at.toISOString()}; ` +
    `granted: ${grantedScopes.join(" ")}`
  );
}

/**
 * Capability scopes Google granted that this slug did not ask for.
 *
 * A grant WIDER than the config is not refused, and that is a deliberate
 * choice rather than an oversight: Google substitutes its own spellings for the
 * identity scopes (`email` comes back as
 * `https://www.googleapis.com/auth/userinfo.email`), so a strict "nothing extra"
 * rule would refuse correct consents on a technicality. Refusing a NARROWER
 * grant is the check that matters, and `exchangeCode` does it.
 *
 * What must not happen is the console going on calling a slug `read-only` over a
 * stored credential Google will honour writes for. So the widening is computed,
 * recorded in the note, and said out loud on the page.
 *
 * Identity scopes are excluded under every spelling strad has seen, because they
 * are not capability and listing them as a surprise would cry wolf on every
 * single connect.
 */
const IDENTITY_SCOPE_SPELLINGS = new Set([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]);

export function unexpectedScopes(
  requested: readonly string[],
  granted: readonly string[],
): string[] {
  const asked = new Set(requested);
  return granted
    .filter((g) => !asked.has(g) && !IDENTITY_SCOPE_SPELLINGS.has(g))
    .sort();
}

/**
 * Write the refresh token, creating the parameter or rotating it.
 *
 * `create()` and `rotate()` are the console's own, unchanged: they apply the
 * base64url envelope, write a secret value to Secret Manager rather than to
 * Parameter Manager, and grant the parameter's own principal
 * `secretmanager.secretAccessor` so `:render` can dereference it. A second
 * implementation here would be a second chance to get all three wrong.
 *
 * ATOMIC IN THE ONLY SENSE AVAILABLE: the caller has already exchanged the code,
 * verified the identity and checked the grant, so by the time this runs the only
 * remaining failure is the store's own. `rotate()` adds a new version and the
 * previous one stays until it succeeds — a failed rotate leaves the old
 * credential current, which is exactly the behaviour a reconnect needs.
 *
 * The note is written SECOND, and its failure is not the write's failure: a
 * connector holding the right token and a stale note is a cosmetic problem, and
 * refusing the whole operation over it would throw away a credential the human
 * cannot easily mint again.
 */
export async function storeRefreshToken(
  store: ParameterStore,
  path: string,
  exists: boolean,
  value: string,
  note: string,
): Promise<void> {
  if (exists) {
    await store.rotate(path, value);
    await store.setNote(path, note).catch(() => undefined);
    return;
  }
  await store.create({ path, secret: true, value, note });
}
