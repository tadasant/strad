import type { ServerConfig, StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import {
  oauthParameterPath,
  serverNamespaces,
  staticNamespace,
  variableOf,
  type ParameterMeta,
  type ParameterStore,
  type ServerParamKind,
} from "../secrets/parameters/index.ts";
import { storeForPath } from "../ui/store-client.ts";
import { buildAuthorizeUrl, exchangeCode, IDENTITY_SCOPES } from "./google.ts";
import { buildGenericAuthorizeUrl, exchangeGenericCode } from "./generic.ts";

export {
  ConnectorError,
  RESERVED_AUTHORIZE_PARAMS,
  type ConnectorErrorCode,
  type PendingConnectorAuth,
} from "./oauth-flow.ts";
export { IDENTITY_SCOPES } from "./google.ts";

/**
 * What the console needs to know about one server's OAuth connector, derived
 * from config and from the store — and never from a request.
 *
 * ## The three values are the SLUG's, and only the slug's
 *
 * Every lookup here composes `/strad/{env}/mcp/{slug}/{kind}/{VARIABLE}` and asks
 * the parameter store about that exact path. It does not go through
 * `ServerSecretProviders.forServer()`, and the difference matters: that provider
 * layers the deployment-wide `/gateway/static/` namespace BEHIND the slug's own,
 * which is right for resolving a `${NAME}` and wrong here. A client id seeded
 * once at the gateway would make all six Google Sheets slugs look ready while
 * none of them owned a credential, and the token this flow writes would land
 * beside a client secret that belongs to nobody in particular.
 *
 * So: this slug's namespaces, no fallback, no sibling, no gateway. A slug that is
 * not seeded reads as NOT READY, which is the honest answer and the one the
 * console can act on.
 *
 * ## TWO KINDS, AND THE FLOW WRITES ONLY ONE OF THEM
 *
 * A slug's own namespace is divided by `kind` — `oauth/` for what strad MINTED,
 * `static/` for what a human typed (see src/secrets/parameters/namespace.ts).
 * The consent flow writes its durable credential to `oauth/` and to nowhere
 * else, because that is the whole point of the kind: a value under `oauth/` is
 * one no person has ever seen, and the console is the only thing that can put it
 * there.
 *
 * READS are layered, `oauth/` ahead of `static/`, for both the credential and
 * the OAuth application's own client id and secret. That is what makes this
 * additive rather than a migration: a deployment whose connector token was
 * written under `static/` before this kind existed keeps working exactly as it
 * did, the console says where the current one lives, and the next Reconnect
 * writes to `oauth/` and takes precedence from then on. A human who prefers to
 * seed the client id and secret under `oauth/` may; nothing requires it.
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

/** One connector's `oauth:` block, whichever provider it names. */
export type ConnectorConfig = ConnectorServer["oauth"];

/**
 * The `oauth:`-declaring server for a slug, or null. Config only.
 *
 * `enabled: false` is a NO here, and that is the console's fence as much as the
 * renderer's: a disabled server is skipped by `renderAppSpec` entirely, so a
 * consent run against one would mint a real credential into a namespace no
 * render will ever read — the same "credential in a drawer" the kind check in
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
 * which is the right direction for a sentence a human reads before consenting —
 * and that is also why it is applied unchanged to a generic provider, whose
 * scopes obey no convention at all and so almost always read as read-write.
 *
 * NO SCOPES AT ALL is read-WRITE, and that is the same rule rather than an
 * exception to it. A generic connector may legitimately declare none — a
 * provider whose tokens carry a fixed grant has nothing to ask for — and in that
 * case strad knows nothing whatever about what the credential can do. `[].every()`
 * is vacuously true, so the naive reading would print the reassuring word in the
 * one case with no evidence behind it.
 */
export function connectorTier(
  scopes: readonly string[],
): "read-only" | "read-write" {
  if (scopes.length === 0) return "read-write";
  return scopes.every((s) => s.endsWith(".readonly"))
    ? "read-only"
    : "read-write";
}

/**
 * Everything strad asks the provider for.
 *
 * Google gets the identity scopes first, then the config's capability scopes,
 * deduplicated with order preserved (the config gate already refuses an identity
 * scope written by hand). A generic provider gets the config's scopes and
 * nothing else: strad has no identity scopes to add, because it has no standard
 * proof to ask for.
 */
export function requestedScopes(oauth: ConnectorConfig): string[] {
  if (oauth.provider !== "google") return [...oauth.scopes];
  return [...new Set([...IDENTITY_SCOPES, ...oauth.scopes])];
}

/**
 * The terms a human is shown before the button, provider-neutral.
 *
 * `account` is `null` for every provider that cannot prove one, and the console
 * renders that absence as a sentence rather than as a blank. Inventing a label
 * there — "the account you are signed in as" dressed up as a pinned value —
 * would be the one claim this whole flow must not make.
 */
export interface ConnectorTerms {
  provider: string;
  /** What the console calls the provider above the button. */
  label: string;
  /** The account this slug is pinned to, or null when nothing proves one. */
  account: string | null;
  /** Every scope the consent asks for, identity scopes included. */
  scopes: string[];
  /** The capability scopes the config named. */
  capabilityScopes: string[];
  tier: "read-only" | "read-write";
}

export function connectorTerms(oauth: ConnectorConfig): ConnectorTerms {
  const common = {
    provider: oauth.provider,
    scopes: requestedScopes(oauth),
    capabilityScopes: [...oauth.scopes],
    tier: connectorTier(oauth.scopes),
  };
  if (oauth.provider === "google") {
    return { ...common, label: "Google", account: oauth.account };
  }
  return {
    ...common,
    // The authorize URL's host is always something a human recognises, and never
    // something strad has to be told twice.
    label: oauth.label ?? hostOf(oauth.authorizeUrl),
    account: null,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // Unreachable through a parsed config — `z.string().url()` has already run —
    // but this function is one string away from a page heading, and a throw here
    // would turn a cosmetic problem into a 500.
    return url;
  }
}

/**
 * The exact, allowlisted redirect URI for this deployment's connector flow.
 *
 * Derived from `gateway.publicUrl` and from nothing else — never from a `Host`
 * header, never from a query parameter. Staging and production therefore have
 * DIFFERENT exact callback URIs, and each must be registered on the provider's
 * OAuth client; that is a property of the design rather than a wart, because a
 * redirect URI an attacker can influence is the classic way an authorization
 * code leaves the building.
 *
 * Null when the deployment declares no `publicUrl`: without one there is no URI
 * to register, and offering a button that redirects to a URI the provider will
 * reject is worse than saying so.
 */
export function connectorRedirectUri(config: StradConfig): string | null {
  const publicUrl = config.gateway.publicUrl;
  if (!publicUrl) return null;
  return `${publicUrl.replace(/\/$/, "")}${CONNECTOR_CALLBACK_PATH}`;
}

/**
 * One path, for every slug and every provider. Which server is being connected
 * lives in sealed state.
 */
export const CONNECTOR_CALLBACK_PATH = "/ui/oauth/callback";

/**
 * The store path this connector's durable credential is WRITTEN to: always the
 * `oauth` kind. Where the current one is READ from may be either kind — see
 * `presence.pathOf`.
 */
export function refreshTokenPath(
  config: StradConfig,
  entry: ConnectorServer,
): string {
  return oauthParameterPath(
    config.gateway.env,
    entry.server.slug,
    entry.oauth.refreshTokenVariable,
  );
}

/**
 * The two variables a connector's OAuth APPLICATION is made of — and NEVER the
 * refresh token, which is the point of naming them separately.
 *
 * These are the only values the console has any business reading back. The
 * client id goes out in every authorization URL; the client secret is one the
 * human typed in and holds a copy of. The refresh token is the one strad minted
 * and nobody has ever seen, and it stays that way.
 */
export function connectorClientVariables(
  oauth: ConnectorConfig,
): [clientId: string, clientSecret: string] {
  return [oauth.clientIdVariable, oauth.clientSecretVariable];
}

/**
 * Is this store path one of a DECLARED connector's OAuth client variables?
 *
 * The ONE derivation behind both halves of the console's read grant: the
 * `consoleReadable` flag a create sets, and the repair button that binds the
 * same access after the fact. Both ask this, so there is one answer to "which
 * secrets may the console read" and it is computed from config — the same
 * discipline `writableTarget()`/`kindsOf()` keep for `/_strad/params`. No part
 * of a request reaches it: the caller passes a path it composed itself, and a
 * path that is not one an enabled server's `oauth:` block names is a no.
 *
 * THE `static` KIND ONLY, and that is a rule rather than an oversight. `oauth/`
 * is the kind strad MINTS into — a value under it is one no person has seen —
 * and the console being unable to read it back is the whole meaning of the kind.
 * The client id and secret are what a human types, `static/` is where the
 * console's own "not seeded" message sends them, and a client hand-placed under
 * `oauth/` is not granted: it would make the refresh token's own namespace a
 * place the console can be given read access to, one variable at a time.
 *
 * A PREFIX MATCH ON THE NAMESPACE plus an exact match on the trailing variable,
 * which is `presenceFrom`'s rule and `resolve()`'s: a value at
 * `{slug}/static/extra/CLIENT_ID` really is injected as `CLIENT_ID` and really
 * is what the connector reads, so it is what the console has to be able to read.
 */
export function isConnectorClientPath(
  config: StradConfig,
  path: string,
): boolean {
  const variable = variableOf(path);
  for (const server of config.servers) {
    if (!server.enabled || !server.oauth) continue;
    const namespace = staticNamespace(config.gateway.env, server.slug);
    if (!path.startsWith(namespace)) continue;
    if (connectorClientVariables(server.oauth).includes(variable)) return true;
  }
  return false;
}

/** Both of this slug's own namespaces, `oauth/` first. */
export function connectorNamespaces(
  config: StradConfig,
  entry: ConnectorServer,
): string[] {
  return serverNamespaces(config.gateway.env, entry.server.slug);
}

/**
 * The prefix that covers both of a slug's kinds: `/strad/{env}/mcp/{slug}/`.
 *
 * ONE `list()` over this answers every presence question below, for both kinds
 * at once. Listing each kind separately would be two enumerations of the same
 * project to learn the same thing.
 */
export function connectorSlugPrefix(
  config: StradConfig,
  entry: ConnectorServer,
): string {
  return `/strad/${config.gateway.env}/mcp/${entry.server.slug}/`;
}

/**
 * Which of the three variables this slug's own namespaces hold, and WHERE.
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
   * variable name -> the exact path the winning copy sits at.
   *
   * The winner is the one the layered read would pick (`oauth/` over `static/`),
   * so this is not merely diagnostic: `readOwnVariable` reveals exactly this
   * path, and the create-versus-rotate decision asks whether the credential's
   * winner is already the `oauth` one.
   */
  pathOf: Readonly<Record<string, string>>;
  /**
   * The note strad wrote when it last connected this slug: the identity it could
   * prove, the granted scopes, and when. Safe metadata by construction — see
   * {@link connectionNote}. Absent for a token seeded by hand.
   */
  note?: string;
}

export function presenceFrom(
  entry: ConnectorServer,
  namespaces: readonly string[],
  metas: readonly ParameterMeta[],
): ConnectorPresence {
  // Highest-precedence kind first, and `set` only on a name not already held:
  // the first namespace that holds a variable is the one that wins, which is the
  // same rule `layerNamespaces` applies to values.
  //
  // A PREFIX MATCH, NOT AN EXACT ONE, and the difference is load-bearing.
  // `resolve()` lists everything under a namespace and keys the result on the
  // path's LAST segment (gcp.ts `variableOf`), so `{slug}/static/extra/TOKEN`
  // really is injected — as `TOKEN`. Requiring `{namespace}{variable}` here would
  // report a connector INCOMPLETE over a client id that is demonstrably present
  // and working, and refuse the Connect button with it. `groupByServer` and the
  // console's own `SLUG_KIND` both honour depth for exactly this reason.
  //
  // `pathOf` still records the path as FOUND, so `readOwnVariable` reveals the
  // copy that was actually matched rather than one recomposed from a kind.
  const held = new Map<string, ParameterMeta>();
  for (const namespace of namespaces) {
    for (const meta of metas) {
      if (!meta.path.startsWith(namespace)) continue;
      if (!meta.hasValue) continue;
      if (!held.has(meta.variable)) held.set(meta.variable, meta);
    }
  }
  const token = held.get(entry.oauth.refreshTokenVariable);
  const pathOf: Record<string, string> = {};
  for (const [variable, meta] of held) pathOf[variable] = meta.path;
  return {
    clientId: held.has(entry.oauth.clientIdVariable),
    clientSecret: held.has(entry.oauth.clientSecretVariable),
    refreshToken: Boolean(token),
    pathOf,
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
 * provider credential with somebody else's admin key.
 *
 * Resolved on the WRITE path — the `oauth`-kind target — because that is the
 * operation whose store has to be right. Both kinds of one slug sit under one
 * `/strad/{env}/mcp/` namespace, so a deployment that split them across two
 * stores would have a `mcpStores:` shape the schema already refuses.
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
 * WORKING. A stored credential is evidence that a human once consented; it is
 * not evidence that the provider still accepts it. Google expires a token from
 * an app in "testing" after seven days, and revokes on a password change —
 * neither of which the store can see. The only honest live signal is a call that
 * fails, and the console does not make one.
 */
export async function readConnectorState(
  deps: ConnectorDeps,
  entry: ConnectorServer,
): Promise<ConnectorState> {
  if (!connectorRedirectUri(deps.config)) return { kind: "no_redirect_uri" };

  const resolved = connectorStore(deps, entry);
  if (!resolved.store) return { kind: "no_store", reason: resolved.reason };

  const prefix = connectorSlugPrefix(deps.config, entry);

  let metas: ParameterMeta[];
  try {
    metas = await resolved.store.list(prefix);
  } catch (err) {
    // The message describes the OPERATION. A store client's exception can quote
    // a rendered value, so it is classified rather than echoed.
    return {
      kind: "store_error",
      reason:
        `strad could not list ${prefix}, so it cannot tell whether this ` +
        `connector is set up. ${err instanceof Error ? err.name : "The store"} ` +
        `did not answer.`,
    };
  }

  const presence = presenceFrom(
    entry,
    connectorNamespaces(deps.config, entry),
    metas,
  );

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
 * Where `readOwnVariable` should reveal one of this connector's inputs from.
 *
 * The path presence FOUND, not a path recomposed from a kind — so the layering
 * is decided once, in `presenceFrom`, and a reveal can never read a copy the
 * resolver would not have picked. Falls back to the `oauth` path when presence
 * holds nothing, which is a state the callers have already refused.
 */
export function connectorVariablePath(
  config: StradConfig,
  entry: ConnectorServer,
  presence: ConnectorPresence,
  variable: string,
): string {
  return (
    presence.pathOf[variable] ??
    oauthParameterPath(config.gateway.env, entry.server.slug, variable)
  );
}

/** Is the credential's winning copy already under the `oauth` kind? */
export function credentialKind(
  config: StradConfig,
  entry: ConnectorServer,
  presence: ConnectorPresence,
): ServerParamKind | null {
  const path = presence.pathOf[entry.oauth.refreshTokenVariable];
  if (path === undefined) return null;
  return path === refreshTokenPath(config, entry) ? "oauth" : "static";
}

/**
 * The metadata strad records beside a stored credential.
 *
 * Safe by construction, and short enough to read in a table cell: who consented
 * where strad could prove it, what was granted, and when. No token, no
 * fingerprint, no length — the note is rendered into HTML on a page a human
 * screenshots, so the rule is that nothing derived from the secret may reach it.
 *
 * A generic provider passes `null`, and the note says nothing about an account
 * rather than naming one strad did not verify.
 */
export function connectionNote(
  identity: string | null,
  grantedScopes: readonly string[],
  at: Date,
): string {
  const who = identity ? `connected as ${identity}` : "connected";
  const granted =
    grantedScopes.length > 0
      ? `; granted: ${grantedScopes.join(" ")}`
      : "; the provider named no scopes";
  return `${who} via the strad console on ${at.toISOString()}${granted}`;
}

/**
 * Capability scopes the provider granted that this slug did not ask for.
 *
 * A grant WIDER than the config is not refused, and that is a deliberate
 * choice rather than an oversight: Google substitutes its own spellings for the
 * identity scopes (`email` comes back as
 * `https://www.googleapis.com/auth/userinfo.email`), so a strict "nothing extra"
 * rule would refuse correct consents on a technicality. Refusing a NARROWER
 * grant is the check that matters, and the exchange does it.
 *
 * What must not happen is the console going on calling a slug `read-only` over a
 * stored credential the provider will honour writes for. So the widening is
 * computed, recorded in the note, and said out loud on the page.
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

// ---------------------------------------------------------------------------
// The provider-neutral flow
// ---------------------------------------------------------------------------

export interface BeginInput {
  clientId: string;
  redirectUri: string;
}

/**
 * Build the consent URL for whichever provider this slug names.
 *
 * The dispatch is HERE and nowhere else: `src/ui/connector.ts` runs one flow,
 * and the two provider modules never learn about each other. A third provider is
 * a module, a variant on the config union, and two arms added to these two
 * switches.
 */
export function beginAuthorization(
  entry: ConnectorServer,
  input: BeginInput,
): ReturnType<typeof buildAuthorizeUrl> {
  const oauth = entry.oauth;
  if (oauth.provider === "google") {
    return buildAuthorizeUrl({
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      scopes: requestedScopes(oauth),
      loginHint: oauth.account,
    });
  }
  return buildGenericAuthorizeUrl({
    authorizeUrl: oauth.authorizeUrl,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    scopes: requestedScopes(oauth),
    extraParams: oauth.authorizeParams,
  });
}

export interface CompleteInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  verifier: string;
}

/**
 * What a successful consent yields, whoever granted it. The token is the only
 * secret in it, and the only caller hands it straight to the parameter store.
 */
export interface ConnectorGrant {
  /** The durable credential. */
  token: string;
  /** The identity strad PROVED, or null when the provider offers no proof. */
  identity: string | null;
  /** What the provider says it granted, sorted. Safe metadata. */
  grantedScopes: string[];
}

/** Exchange the code through whichever provider this slug names. */
export async function completeAuthorization(
  entry: ConnectorServer,
  input: CompleteInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectorGrant> {
  const oauth = entry.oauth;
  if (oauth.provider === "google") {
    const grant = await exchangeCode(
      {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        redirectUri: input.redirectUri,
        code: input.code,
        verifier: input.verifier,
        expectedAccount: oauth.account,
        requiredScopes: oauth.scopes,
      },
      fetchImpl,
    );
    return {
      token: grant.refreshToken,
      identity: grant.email,
      grantedScopes: grant.grantedScopes,
    };
  }
  const grant = await exchangeGenericCode(
    {
      tokenUrl: oauth.tokenUrl,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      redirectUri: input.redirectUri,
      code: input.code,
      verifier: input.verifier,
      clientAuth: oauth.clientAuth,
      credential: oauth.credential,
      requiredScopes: oauth.scopes,
    },
    fetchImpl,
  );
  return {
    token: grant.token,
    identity: null,
    grantedScopes: grant.grantedScopes,
  };
}

/**
 * Write the durable credential, creating the parameter or rotating it.
 *
 * `create()` and `rotate()` are the console's own, unchanged: they apply the
 * base64url envelope, write a secret value to Secret Manager rather than to
 * Parameter Manager, and grant the parameter's own principal
 * `secretmanager.secretAccessor` so `:render` can dereference it. A second
 * implementation here would be a second chance to get all three wrong.
 *
 * `exists` is about the PATH BEING WRITTEN, not about the connector: a slug
 * whose credential still sits under `static/` is `connected` and yet has nothing
 * at the `oauth/` path, and a rotate of a parameter that does not exist is a
 * failure where a create was meant. The caller passes `credentialKind(...) ===
 * "oauth"`.
 *
 * ATOMIC IN THE ONLY SENSE AVAILABLE: the caller has already exchanged the code,
 * verified whatever identity the provider offers and checked the grant, so by
 * the time this runs the only remaining failure is the store's own. `rotate()`
 * adds a new version and the previous one stays until it succeeds — a failed
 * rotate leaves the old credential current, which is exactly the behaviour a
 * reconnect needs.
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
