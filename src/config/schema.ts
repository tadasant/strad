import { RESERVED_AUTHORIZE_PARAMS } from "../connectors/oauth-flow.ts";
import { z } from "zod";
import { MAX_VARIABLE_LENGTH, isEnvName, secretRefsIn } from "./env-name.ts";
import { refsIn } from "../secrets/provider/resolve.ts";
import { normaliseNamespace } from "../secrets/parameters/namespace.ts";

/**
 * The strad configuration interface.
 *
 * This file is the contract between the OSS core and whoever is deploying it.
 * Attaching an MCP server to a strad deployment is ONE entry in `servers`.
 *
 * The core ships with ZERO servers. Everything below is opt-in.
 */

/**
 * A server's identity: in tool names (`<slug>__<tool>`), in `?servers=`, in its
 * parameter namespace — and, since the renderer names a supplementary server's
 * variables after it, on the container itself.
 *
 * DASHES MAY NOT DOUBLE UP, and may not lead or trail. That is not tidiness; it
 * is what makes the box name of a variable unambiguous. `slugEnvPrefix` uppercases
 * the slug and turns `-` into `_`, then joins to the variable name with `__`, so a
 * slug carrying `--` would put the separator INSIDE the prefix: `a--b` + `C` and
 * `a` + `B__C` become the same variable, and one server's credential silently
 * becomes another's. A trailing `-` does the same against a variable name that
 * starts with `_`. Neither shape has ever appeared in a strad config; forbidding
 * them is what lets src/secrets/env-prefix.ts promise injectivity rather than hope
 * for it.
 */
export const SLUG = z
  .string()
  .max(63, "slug must be at most 63 characters")
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "slug must be lowercase alphanumeric with single dashes between segments " +
      "(no leading, trailing or doubled dash — a doubled dash would make two " +
      "different servers' environment variables collide on the container)",
  );

/**
 * A reference to a secret value.
 *
 * `${FOO}` resolves against the secret bag returned by `loadSecrets()`
 * (see src/secrets). A bare string is used literally — fine for non-secret
 * values, but never put a real credential in the config file.
 */
const SecretRef = z.string();

const HeaderMap = z.record(SecretRef).default({});

/** Roles a principal can hold. A role grants access to a set of servers. */
export const Role = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "role must be lowercase alphanumeric");

// ---------------------------------------------------------------------------
// Servers — the four kinds
// ---------------------------------------------------------------------------

/**
 * Which tools of this server the gateway will expose and invoke.
 *
 * This is where CAPABILITY lives. It used to live in the container (a
 * `*_ENABLED_TOOLGROUPS` env var built a process with no write tools in it),
 * which meant a read-only and a read-write variant of one upstream could never
 * share a container — each variant cost its own billed component. Here, one
 * container runs the upstream at FULL capability and the gateway decides what a
 * given slug may do, so `gmail-ro` and `gmail-rw` are two entries pointing at
 * the same container.
 *
 *   - slug: gmail-ro
 *     tools:
 *       allow: [list_email_conversations, get_email_conversation, ...]
 *
 * `allow` is exhaustive (a tool must be on it). `deny` subtracts, and wins over
 * `allow`. Omit `tools:` entirely for "every tool this server offers".
 *
 * Enforced on tools/call, not just tools/list — see gateway/toolPolicy.ts.
 */
export const ToolPolicySchema = z
  .object({
    allow: z.array(z.string().min(1)).min(1).optional(),
    deny: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine((p) => p.allow !== undefined || p.deny !== undefined, {
    message:
      "tools: must set `allow` and/or `deny` (omit `tools:` for no restriction)",
  });

/**
 * The names of the three variables one Google connector owns, all defaulted to
 * the Google Sheets set (the first — and so far only — server that consumes them).
 *
 * They are VARIABLE NAMES, never paths. Core composes
 * `/strad/{env}/mcp/{slug}/{kind}/{VARIABLE}` from the slug, one of the two
 * KINDS, and these strings — and from nothing else, so there is no spelling of
 * one that addresses another server's namespace or another deployment. That is
 * the same fence `paramsWritable:` stands behind, and it is why the console's
 * callback can take a slug from sealed state and still never let a browser
 * choose a target.
 *
 * These are GOOGLE's defaults, and they are defaulted only on the `google`
 * variant. A `generic` connector must name all three: a Linear credential
 * silently landing in `GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN` is a wrong answer that
 * renders, deploys and looks right.
 */
const OAUTH_DEFAULTS = {
  clientIdVariable: "GOOGLE_SHEETS_OAUTH_CLIENT_ID",
  clientSecretVariable: "GOOGLE_SHEETS_OAUTH_CLIENT_SECRET",
  refreshTokenVariable: "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN",
} as const;

/**
 * `oauth:` — this server authenticates as a PERSON, and strad's console is where
 * that person consents.
 *
 * A refresh token is not a credential an operator can seed from a terminal
 * without first handing it to something: the OAuth Playground shows it on a web
 * page, a local script prints it to a shell, and either way the value has been
 * somewhere before it reaches the store. This block is what lets the whole
 * exchange happen inside strad instead — the console redirects to Google, Google
 * returns to the console, and the refresh token goes from the token endpoint
 * straight into the parameter store without ever being rendered, returned or
 * logged.
 *
 *   - slug: google-sheets-tadas412-ro
 *     kind: supplementary-image
 *     ...
 *     oauth:
 *       provider: google
 *       account: tadas412@gmail.com
 *       scopes:
 *         - https://www.googleapis.com/auth/spreadsheets.readonly
 *
 * ## THE SLUG FIXES THE ACCOUNT AND THE SCOPE
 *
 * Everything the flow needs is here, and the browser supplies none of it. The
 * expected email, the exact scopes, and the variable the token lands in are read
 * out of this block on the way OUT (to build the consent URL) and again on the
 * way BACK (to validate what Google returned). A callback carries an
 * authorization code and an opaque state and nothing else that is trusted, so
 * there is no request a human can craft that installs one account's token into
 * another account's slug, or a read-write consent into a `-ro` slug.
 *
 * ## THE TOKEN IS NEVER A `${NAME}`, AND THAT IS THE DEPLOY-ORDERING ANSWER
 *
 * `render-spec` exits 1 on the first `${NAME}` it cannot resolve, and it renders
 * the WHOLE app spec — so one slug declaring `${GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN}`
 * before that token exists fails every other server's deploy too. But the token
 * cannot exist until a human completes the console flow, and the human cannot
 * reach the console flow until the slug is deployed. That is a cycle, and this
 * block breaks it: the three variables are INJECTED from this server's own
 * namespace by the renderer (src/deploy/appspec.ts), each one only if the store
 * holds it. An unconnected slug deploys with two variables and no third, mounts,
 * lists its tools, and reports itself degraded — which is exactly the state the
 * Google Sheets server is built to survive.
 *
 * Writing the same names into `env:` as `${NAME}` refs would put the cycle back,
 * so the `superRefine` below refuses it by name.
 */
/**
 * The three variable names, shared by both variants.
 *
 * A factory rather than a spread constant because the DEFAULTS differ: Google
 * gets the Sheets set (the first server that consumed them, and the reason they
 * exist), and a generic provider gets none.
 */
function connectorVariableFields(defaults: {
  clientIdVariable?: string;
  clientSecretVariable?: string;
  refreshTokenVariable?: string;
}) {
  const named = (fallback: string | undefined) =>
    fallback === undefined
      ? z.string().min(1)
      : z.string().min(1).default(fallback);
  return {
    /** The variable holding the OAuth client id, in THIS slug's own namespace. */
    clientIdVariable: named(defaults.clientIdVariable),
    /** The variable holding the OAuth client secret, in THIS slug's own namespace. */
    clientSecretVariable: named(defaults.clientSecretVariable),
    /**
     * The variable the consent flow WRITES, under this slug's `oauth` kind.
     * Created on connect, rotated on reconnect.
     */
    refreshTokenVariable: named(defaults.refreshTokenVariable),
  };
}

const GoogleConnector = z.object({
  provider: z.literal("google"),
  /**
   * The Google account this slug is pinned to, e.g. `tadas412@gmail.com`.
   *
   * Checked against the verified `email` claim on the ID token Google returns,
   * NOT against whichever account the browser happened to be signed into. A
   * mismatch is refused and its token is never written, because a slug is one
   * account by construction: the refresh token IS the account, and installing
   * the wrong one gives an agent entitled to `tadas412` a view of `tadasant`.
   */
  account: z.string().email(),
  /**
   * The exact authorization scopes to request. At least one.
   *
   * Requested verbatim, and checked against what Google says it GRANTED before
   * anything is written — a consent screen where the human unticked a box comes
   * back with a narrower `scope` than was asked for, and storing that token
   * would leave a slug that looks connected and fails on its first real call.
   *
   * strad adds `openid` and `email` itself. Those are the minimum needed to
   * learn WHICH account consented, they are not capability, and leaving them to
   * the config would mean a slug could be configured unable to prove its own
   * identity.
   */
  scopes: z.array(z.string().min(1)).min(1),
  ...connectorVariableFields(OAUTH_DEFAULTS),
});

/**
 * `provider: generic` — plain RFC 6749 authorization code + PKCE, against
 * endpoints the config names.
 *
 * ## What it does NOT do, said first
 *
 * There is no identity proof and therefore no `account:`. OpenID Connect is what
 * makes Google's account pinning possible, and a provider that does not issue an
 * ID token gives strad nothing to check a consent against. A generic connector
 * stores whatever account the human was signed in as at the provider, and the
 * console says so above the button rather than implying a check it cannot make.
 * If that matters for a given provider, the answer is a first-class variant like
 * `google`, not a field here.
 *
 * There is also no refresh. The durable credential is stored and injected; see
 * `oauthRefresh:` for the upstream that mints bearers from one.
 *
 *   - slug: linear-ro
 *     kind: supplementary-image
 *     ...
 *     oauth:
 *       provider: generic
 *       label: Linear
 *       authorizeUrl: https://linear.app/oauth/authorize
 *       tokenUrl: https://api.linear.app/oauth/token
 *       scopes: [read]
 *       clientIdVariable: LINEAR_OAUTH_CLIENT_ID
 *       clientSecretVariable: LINEAR_OAUTH_CLIENT_SECRET
 *       refreshTokenVariable: LINEAR_OAUTH_TOKEN
 */
const GenericConnector = z.object({
  provider: z.literal("generic"),
  /**
   * What the console calls this provider above the button, e.g. `Linear`.
   * Defaults to the authorize URL's host, which is always something a human
   * recognises and never something strad has to be told twice.
   */
  label: z.string().min(1).optional(),
  /**
   * The provider's authorization endpoint — where the human's browser is sent.
   *
   * Required, and https-only (checked in the `superRefine`). strad appends
   * `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state` and the
   * PKCE `code_challenge`; anything else the provider needs goes in
   * `authorizeParams:`.
   */
  authorizeUrl: z.string().url(),
  /**
   * The provider's token endpoint — where the authorization code is exchanged,
   * server to server. Required, https-only.
   */
  tokenUrl: z.string().url(),
  /**
   * The scopes to request, space-delimited per RFC 6749 §3.3. May be empty: a
   * provider whose tokens carry a fixed grant has nothing to ask for.
   *
   * Every one of them is checked against what the token response says it
   * GRANTED — but only when the response says anything at all. A provider that
   * omits `scope` is taken at its word, because the alternative is refusing
   * every consent from a spec-compliant provider that exercises its right to
   * leave the field out.
   */
  scopes: z.array(z.string().min(1)).default([]),
  /**
   * Extra query parameters for the authorization URL — the escape hatch for the
   * one thing every provider spells differently: how to ask for offline access.
   * `access_type: offline` for Google-shaped providers, `duration: permanent`
   * for Reddit, `prompt: consent` to force a fresh grant.
   *
   * The parameters strad sets itself cannot be overridden here; the
   * `superRefine` refuses each by name. That is not tidiness — `redirect_uri`
   * and `code_challenge` are the two controls that keep an authorization code
   * from leaving the building, and a config key that could rewrite either would
   * make them advisory.
   */
  authorizeParams: z.record(z.string()).default({}),
  /**
   * How the client credentials reach the token endpoint: `post` puts them in the
   * form body (RFC 6749 §2.3.1's second option, what most providers document),
   * `basic` puts them in an `Authorization: Basic` header (the first option,
   * which the RFC says a server MUST support and several require).
   *
   * There is no "try one then the other". A failed exchange burns the
   * authorization code — it is single-use at the provider — so a retry with the
   * other method exchanges a code that is already spent and reports the wrong
   * cause.
   */
  clientAuth: z.enum(["post", "basic"]).default("post"),
  /**
   * WHICH FIELD OF THE TOKEN RESPONSE IS THE DURABLE CREDENTIAL.
   *
   * `refresh_token` is the usual answer and the default. `access_token` is for
   * the providers whose access tokens simply do not expire and which issue no
   * refresh token at all (Slack bot tokens, Linear, Notion) — for those,
   * demanding a `refresh_token` would refuse every correct consent they can
   * produce.
   *
   * It is declared rather than sniffed. "Take the refresh token if there is one,
   * else the access token" would store an hour-long credential the moment a
   * provider changed its mind, and the symptom would be a slug that worked all
   * afternoon and was dead by morning.
   */
  credential: z
    .enum(["refresh_token", "access_token"])
    .default("refresh_token"),
  ...connectorVariableFields({}),
});

/**
 * `oauth.provider`: which consent flow strad drives, and therefore which fields
 * the block carries.
 *
 * Two, and they are not two spellings of one thing. `google` is an
 * IMPLEMENTATION — strad knows Google's endpoints, asks for an ID token, and
 * refuses a consent that came back from the wrong account. `generic` is a
 * DECLARATION — the config names the endpoints, and strad runs plain RFC 6749
 * authorization-code-with-PKCE against them, proving nothing about who consented
 * because there is nothing standard to prove it with.
 *
 * DISCRIMINATED, rather than one object with optional halves, and that is the
 * whole answer to the failure this block is most exposed to. Zod STRIPS an
 * unknown key, so an optional `authorizeUrl:` misspelled once would render
 * clean, deploy clean, and send a human to `accounts.google.com` for a
 * credential they asked Linear for. Under a discriminated union the field is
 * REQUIRED on the variant that has it, so the same typo is a
 * missing-required-field error at parse time, on the config gate, before
 * anything is written.
 */
const OAuthConnector = z.discriminatedUnion("provider", [
  GoogleConnector,
  GenericConnector,
]);

/**
 * ONE parameter store the SSO console can browse: a GCP project, the namespaces
 * it manages, and the admin credential that reaches it.
 *
 * PER-STORE CREDENTIALS ARE THE POINT. Two stores on one page is two projects,
 * and one identity granted on both is a strictly larger blast radius than the
 * two identities it replaces — a leaked key for project A would become a leaked
 * key for project B. `adminKeyVar` is required on every entry for that reason,
 * and there is no way to say "use the same service account for all of these".
 *
 * WHAT THAT IS AND IS NOT. Naming one `adminKeyVar` twice is REFUSED, and so is
 * an `adminKeyVar` whose `${REF}` any server's `env:` carries. Two different
 * names resolving to one `${REF}` is the same collapse and is only WARNED
 * about, because it is sometimes correct — one service account on
 * `strad-secrets-prod` and `strad-secrets-staging` is two projects in one
 * system. The `superRefine` below says why the `mcpStores:` twin goes the other
 * way, and `sharedConsoleAdminCredential` in src/deploy/appspec.ts emits it.
 *
 * PER-STORE BOUNDS, likewise. `namespacesStrict` and `reveal` live HERE and not
 * on the page, because a page-level union is a bound that does not bind: a
 * union namespace list checked against whichever project happens to be selected
 * would wave through a namespace belonging to a sibling store, and a page-level
 * reveal flag would either offer reveal on a production store or withhold it
 * from a staging one.
 */
const ConsoleStore = z.object({
  /**
   * The GCP project id. Also the store's ADDRESS: the console selects with
   * `?project=<id>`, so it must be unique within one server's list.
   */
  project: z.string().min(1),
  /** What the picker calls it. Defaults to the project id. */
  label: z.string().min(1).optional(),
  /** Parameter Manager location. `global` unless this store overrides it. */
  location: z.string().min(1).optional(),
  /**
   * The canonical-path prefixes this store manages. The first is the default
   * namespace for new parameters, and the whole list seeds the picker.
   *
   * At least one is required, for the same reason the MCP half refuses to mount
   * without one (servers/secrets/shared/src/config.ts): an empty prefix matches
   * every parameter the credential can see.
   *
   * Two stores on one server may not declare OVERLAPPING prefixes — the
   * `superRefine` below refuses it, because a path both could claim is a write
   * whose project depends on declaration order, and `storeForPath` would refuse
   * it at request time rather than at config time.
   */
  namespaces: z.array(z.string().min(1)).min(1),
  /**
   * The `consoleEnv:` KEY holding this store's admin service-account key JSON.
   *
   * A NAME, not a `${REF}` — see `consoleStores:` on the supplementary server
   * for why the credential travels by the existing console-only scope instead of
   * a second route of its own.
   */
  adminKeyVar: z.string().min(1),
  /**
   * Make `namespaces` a hard LIMIT on this store rather than a set of
   * suggestions. Off by default, matching `SECRETS_NAMESPACES_STRICT`.
   *
   * It bounds CREATE and not rotate/note/delete — those address an existing
   * parameter by its canonical path, and the store the console reads them out of
   * is already the fence. That asymmetry is the pre-existing behaviour of the
   * single-store flag and is preserved verbatim.
   */
  namespacesStrict: z.boolean().default(false),
  /**
   * Whether the console OFFERS reveal for this store. Off by default.
   *
   * Not the boundary — IAM is (src/secrets/parameters/capabilities.ts). This
   * decides what the UI offers; the credential decides what is possible, and
   * both must say yes.
   */
  reveal: z.boolean().default(false),
});

/**
 * ONE parameter store the `/mcp` server can address: a GCP project, the
 * namespaces it manages, and the VIEWER credential that reaches it.
 *
 * The agent-facing twin of `ConsoleStore` above, and it is deliberately a
 * separate type rather than the same one wearing a different name. The two
 * differ on the only thing that matters about them:
 *
 *   - a console store names an `adminKeyVar`, a `consoleEnv:` key, resolved onto
 *     CORE alone. It can add, rotate, reveal and delete.
 *   - an mcp store names a `viewerKeyVar`, an `env:` key, baked onto the BUNDLE.
 *     What it can do is whatever IAM granted that key — and on production, that
 *     is a viewer that cannot dereference a secret.
 *
 * There is no `reveal`, because there is nothing to offer: `/mcp` has no UI, and
 * whether a secret value can be read is decided by a probe against THIS store's
 * project (servers/secrets/shared/src/capabilities.ts) rather than by a flag.
 * And there is no `namespacesStrict`, because the MCP half has no lax mode to
 * turn off: `storeForPath` refuses every path no store's namespace claims,
 * always, and `loadConfig` refuses a configuration in which two stores could
 * claim one path. The console's per-store `namespacesStrict` exists because its
 * namespaces are otherwise a set of suggestions on a free-text field; here they
 * ARE the binding.
 *
 * There is no `location` either, and that one is an ABSENCE rather than a
 * decision: the MCP tree addresses `locations/global` as a constant
 * (parameter-manager.ts, write-client.ts). A console store on another location
 * therefore has no MCP twin, and pointing an entry here at one would report
 * "has no value yet" for every parameter in it — a wrong answer rather than a
 * refusal. Give `/mcp` a location before giving it such a store.
 */
const McpStore = z.object({
  /**
   * The GCP project id, and the store's ADDRESS. It is what a refusal names and
   * what `list_managed_namespaces` reports capabilities under, so it must be
   * unique within one server's list.
   */
  project: z.string().min(1),
  /** What a human reading a tool result calls it. Defaults to the project id. */
  label: z.string().min(1).optional(),
  /**
   * The canonical-path prefixes THIS store manages.
   *
   * They are what BINDS a parameter path to a project, a credential and a
   * capability, so two stores on one server may not declare overlapping
   * prefixes — the `superRefine` below refuses it, and the server refuses it
   * again at boot.
   */
  namespaces: z.array(z.string().min(1)).min(1),
  /**
   * The `env:` KEY holding this store's VIEWER service-account key JSON.
   *
   * A NAME, not a `${REF}`, for the reason `adminKeyVar` is one: the credential
   * travels by the scope that already exists for it, so there is one place to
   * get the scoping right rather than two. `env:` is the scope that lands on the
   * bundle, which is the component that answers `/mcp`.
   *
   * NEVER AN ADMIN KEY, and that is not a convention here — it is a consequence.
   * `viewerKeyVar` must be a key of this server's own `env:`, and the
   * `consoleStores:` rules above already refuse an `adminKeyVar` whose key OR
   * whose `${REF}` appears in any server's `env:` under any name. So a console
   * admin credential cannot be reached through this field without failing one of
   * those first.
   */
  viewerKeyVar: z.string().min(1),
});

const ServerBase = z.object({
  /** Stable identifier. Tools are namespaced `<slug>__<tool>`. */
  slug: SLUG,
  /** Human label shown in the UI / errors. Defaults to the slug. */
  title: z.string().optional(),
  description: z.string().optional(),
  /** Roles permitted to use this server. Empty = nobody (fail closed). */
  entitlements: z.array(Role).default([]),
  /** Set false to keep the entry but stop serving it. */
  enabled: z.boolean().default(true),
  /** Capability: the tools this slug may list AND call. Omit for all of them. */
  tools: ToolPolicySchema.optional(),
  /** Per-request upstream timeout in ms. The MCP SDK defaults to 60s at
   *  every hop, which silently kills long tool calls; make it explicit. */
  timeoutMs: z.number().int().positive().default(120_000),
  /**
   * This server authenticates as a person, and the console runs the consent.
   * Omit it for every server that does not. See {@link OAuthConnector}.
   */
  oauth: OAuthConnector.optional(),
  /**
   * `${NAME}`s this server may deploy WITHOUT, staying inactive until they land.
   *
   *   - slug: apify
   *     kind: remote-http
   *     url: https://mcp.apify.com/mcp
   *     headers:
   *       Authorization: "Bearer ${APIFY_TOKEN}"
   *     mayBeUnseeded: [APIFY_TOKEN]
   *
   * It does NOT mean "this server works without the value" — it means the
   * DEPLOY may proceed without it. Adding a slug whose credential nobody has
   * seeded yet used to red the whole deploy (`scripts/render-spec.ts` exits 1 on
   * the first `${NAME}` held in neither namespace), so onboarding a server
   * carried a human gate: seed the secret before the PR merges, or take the
   * fleet's deploy down with it. Named here, that name warns instead, this slug
   * alone comes up `unconfigured` (see gateway/unconfigured.ts), and every other
   * server deploys normally.
   *
   * PER NAME, and not a flag on the server, because the flag would give away the
   * thing the gate is for. `mayBeUnseeded: true` beside a typo'd
   * `${APIFY_TOKN}` degrades forever in silence; a LIST names the credential a
   * human decided to defer, so the typo is a name nobody listed and still fails
   * the deploy loudly. The deploy gate also rejects an entry this server
   * references nowhere — a waiver for a name that is not used is itself the typo
   * (see src/deploy/unseeded.ts).
   *
   * A name is only waived when EVERY enabled server referencing it waives it.
   * One server deferring a token another server needs to boot is not a deferral.
   *
   * HOW FAST IT ACTIVATES depends on where the value is read, and the two are
   * not close:
   *   - a `url:`, `headers:` or builtin `options:` ref under
   *     `gcp-parameter-store` is resolved on the request path, so seeding the
   *     value activates the slug within `gateway.secrets.negativeTtlSeconds`
   *     (shared namespace) or `ttlSeconds` (the server's own) — no redeploy.
   *   - a `supplementary-image`'s `env:` is baked onto a container strad does
   *     not run, and under the `env` provider so is everything else. Those need
   *     a redeploy after seeding — not a PR, but not a TTL either.
   */
  mayBeUnseeded: z.array(z.string().min(1)).default([]),
});

/**
 * `oauthRefresh:` — this upstream takes short-lived OAuth access tokens, and
 * strad holds the refresh token that mints them.
 *
 *   - slug: granola
 *     kind: remote-http
 *     url: https://mcp.granola.ai/mcp
 *     oauthRefresh:
 *       tokenUrl: https://mcp-auth.granola.ai/oauth2/token
 *       clientId: ${GRANOLA_CLIENT_ID}
 *       refreshToken: ${GRANOLA_REFRESH_TOKEN}
 *       resource: https://mcp.granola.ai/mcp
 *
 * strad sends `Authorization: Bearer <access token>` itself, minting a new one
 * before the old one expires or when the upstream answers 401. A provider that
 * rotates refresh tokens on use has the new one written back to the parameter
 * store through core's admin credential, so a restart reads the live one. See
 * src/gateway/adapters/oauth-refresh.ts.
 *
 * Every field is resolved per operation like `url:` and `headers:`, through the
 * server's own namespace first. `refreshToken` and `clientSecret` must each be
 * exactly one `${NAME}` — a literal is a credential committed to the config, and
 * the write-back needs a NAME to write to. The `superRefine` below enforces it.
 */
const OAuthRefreshSchema = z.object({
  /** The token endpoint. https, or http to a loopback host. May be a `${NAME}`. */
  tokenUrl: z.string().min(1),
  /** The OAuth client id. A literal, or a `${NAME}`. */
  clientId: z.string().min(1),
  /** The client secret, for a confidential client. Omit for a public (PKCE) one. */
  clientSecret: z.string().min(1).optional(),
  /**
   * How a client secret is sent: `basic` (HTTP Basic, RFC 6749's default) or
   * `post` (in the form body). Ignored without a `clientSecret` — a public
   * client sends its `client_id` in the body either way.
   */
  clientAuth: z.enum(["basic", "post"]).default("basic"),
  /** The refresh token, as exactly one `${NAME}`. */
  refreshToken: z.string().min(1),
  /** `scope`, sent on every refresh. Omit to keep what was granted. */
  scope: z.string().min(1).optional(),
  /**
   * RFC 8707 `resource`, sent on every refresh. An MCP-spec authorization
   * server expects it and binds the token to it: set it to the server's `url`.
   * Omit for a provider that does not know the parameter.
   */
  resource: z.string().min(1).optional(),
});

/**
 * kind: remote-http
 *
 * Proxy an MCP server that already exists somewhere on the internet.
 * strad holds the credential and forwards over Streamable HTTP.
 *
 *   - slug: granola
 *     kind: remote-http
 *     url: https://mcp.granola.ai/mcp
 *     headers:
 *       Authorization: "Bearer ${GRANOLA_TOKEN}"
 *
 * A static bearer is the simple case. An upstream whose access tokens expire
 * takes `oauthRefresh:` instead — see {@link OAuthRefreshSchema}.
 */
const RemoteHttpServer = ServerBase.extend({
  kind: z.literal("remote-http"),
  url: z.string().url(),
  headers: HeaderMap,
  oauthRefresh: OAuthRefreshSchema.optional(),
});

/**
 * kind: local-tunnel
 *
 * Proxy an MCP server running on a machine a HUMAN owns — a laptop, a desktop —
 * reached over a tunnel that machine dials out to (Cloudflare, ngrok, Tailscale
 * Funnel). On the wire it is Streamable HTTP, exactly like `remote-http`.
 *
 *   - slug: anki
 *     kind: local-tunnel
 *     url: https://anki.example.trycloudflare.com/
 *
 * WHY IT IS ITS OWN KIND, when the transport is identical to remote-http.
 *
 * Because the two differ on the only question anything downstream asks about a
 * failure: WHOSE PROBLEM IS IT? A `remote-http` that stops answering is a third
 * party's outage — rare, unplanned, worth a look. A `local-tunnel` that stops
 * answering is a laptop that got closed, which is the NORMAL STATE of this kind
 * and the entire point of it: reachable while the machine is up, cleanly gone
 * while it is not.
 *
 * Encoding that as a flag on remote-http would leave every consumer — the
 * reachability monitor, `/healthz`, the deploy gate, the console — unable to
 * tell a broken vendor from a closed lid. As its own `kind` the distinction is
 * carried, once, to all of them.
 *
 * The behavioural consequences live in three places:
 *   - `connectTimeoutMs` below: a bounded handshake, so an offline machine is a
 *     seconds-long failure rather than a minute-long hang.
 *   - gateway/adapters/http.ts: an offline machine is reported as such, in
 *     strad's own words, rather than as a generic upstream fault.
 *   - gateway/mcpServer.ts: an offline machine does not fail a `?servers=`
 *     listing that also named servers which ARE up.
 */
const LocalTunnelServer = ServerBase.extend({
  kind: z.literal("local-tunnel"),
  /** The tunnel's public URL. The machine dials out; strad never dials in. */
  url: z.string().url(),
  headers: HeaderMap,
  /**
   * How long to wait for the machine to complete an MCP handshake.
   *
   * SEPARATE from `timeoutMs`, and much shorter, because they bound different
   * things. `timeoutMs` is how long a tool may take to RUN once the machine has
   * answered — and for this kind of server that can be genuinely long (driving a
   * browser, taking a screenshot). This is how long to wait to find out whether
   * anyone is home at all, which should be fast whatever the answer.
   *
   * Without it the handshake inherits the MCP SDK's 60s default and a closed
   * laptop costs a full minute per request. Five seconds is comfortably more
   * than a tunnel's round trip and comfortably less than a human's patience.
   */
  connectTimeoutMs: z.number().int().positive().default(5_000),
  /**
   * How to bring this machine back — the answer to the only question an
   * unreachable local-tunnel raises.
   *
   * When the machine is not answering, strad replaces this slug's tools with a
   * single `troubleshoot_host` tool (see gateway/troubleshoot.ts) and hands
   * whatever is here to whoever calls it. It is also appended to the error a
   * real tool call raises while the machine is down.
   *
   *   recovery:
   *     machine: "Tadas's MacBook"
   *     commands:
   *       - "launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared"
   *     notes: "Anki itself must be open — the MCP server lives inside the app."
   *
   * OPTIONAL, and the surface exists without it: strad falls back to generic
   * guidance built from what it knows (the slug, the tunnel hostname) plus a
   * link to the docs. It will not GUESS a command — a tunnel name inferred from
   * a hostname is right often enough to be trusted and wrong often enough to
   * waste an afternoon — so an entry with no `commands:` gets an honest generic
   * answer rather than a confident wrong one.
   *
   * WHAT NOT TO PUT HERE: this text is returned to every client entitled to the
   * slug. It is for commands and machine names, not for credentials, internal
   * hostnames, or anything a `${REF}` would be the right home for. Nothing here
   * is secret-resolved, deliberately — a `${NAME}` written in this block reaches
   * a caller verbatim as those six characters, not as a value.
   */
  recovery: z
    .object({
      /** Whose machine it is, for a human reading a tool result. */
      machine: z.string().min(1).optional(),
      /** Exact commands to run ON THAT MACHINE, in order. */
      commands: z.array(z.string().min(1)).default([]),
      /** Anything else its owner needs to know (a GUI app to open, ...). */
      notes: z.string().min(1).optional(),
    })
    .default({}),
});

/**
 * kind: supplementary-image
 *
 * An MCP server that ships as its own container image, published separately
 * from strad. strad deploys it as its own App Platform component (its own
 * `bundle`) on the private network and proxies to it. Adding one is one entry:
 *
 *   - slug: good-eggs
 *     kind: supplementary-image
 *     image: ghcr.io/tadasant/strad-server-good-eggs:latest
 *     bundle: bundle-good-eggs
 *
 * The component is internal-only: it gets `internal_ports: [8080]` and NO
 * `http_port`, so App Platform never mints a public route for it.
 */
const SupplementaryImageServer = ServerBase.extend({
  kind: z.literal("supplementary-image"),
  image: z.string().min(1),
  /**
   * Deployment group. A supplementary image owns its bundle — but several
   * servers backed by the SAME image may share one bundle, each on its own
   * `path` (e.g. bundle-google serves gmail, calendar and docs from one image).
   */
  bundle: SLUG,
  /** Path the image serves MCP on, inside the container. Must be unique among
   *  servers sharing a bundle. */
  path: z.string().startsWith("/").default("/mcp"),
  /** Env passed to the component. Values may be `${SECRET_REF}`. */
  env: z.record(SecretRef).default({}),
  /**
   * Opt this server into PARAMETER RESOLUTION. When true, everything under
   * `/strad/{env}/mcp/{slug}/static/*` in the secrets system (non-secret values
   * from Parameter Manager, secret values from Secret Manager) is resolved and
   * injected as this server's environment — see src/secrets/parameters. For a
   * supplementary image that resolution happens at DEPLOY time (render-spec, with
   * the resolver credential, scoped onto the bundle); the container itself holds
   * no cloud credential. It is the modern alternative to hand-writing `${REF}`
   * entries in `env:`.
   */
  params: z.boolean().default(false),
  /**
   * Variables this server may WRITE BACK to its own managed parameter.
   *
   * The case is a credential that rotates ON USE — X's OAuth refresh tokens are
   * the shape: every refresh returns a new one and kills the previous. Without
   * this the process rotates in memory, the container restarts, and it comes
   * back holding a value the upstream invalidated. See src/secrets/param-route.ts
   * for the mechanism and src/http/params.ts for the routes.
   *
   * An ALLOWLIST BY NAME, never a blanket write: a server may rewrite only names
   * it already holds. Enforced in the `superRefine` below — it requires
   * `params: true` (the flag that injects the namespace this writes into) and a
   * legal environment-variable name, which is what confines the write to this
   * server's own `/{slug}/static/` namespace. A name is a variable, not a path:
   * there is no spelling of one that escapes the namespace, because core
   * composes the path from the slug and the name and never from a URL.
   */
  paramsWritable: z.array(z.string().min(1)).default([]),
  /**
   * Variables this server re-reads AT RUNTIME, so a rotation reaches the running
   * container without a redeploy.
   *
   * THE GAP THIS CLOSES. Three of strad's four credential paths already resolve
   * at runtime: a gateway `${NAME}` (within `gateway.secrets.ttlSeconds`), a
   * `builtin`'s `params:` (per tool call, gateway/registry.ts), and an unhosted
   * server's `${NAME}` (per request). A SUPPLEMENTARY image's `params:` is the
   * one that does not — `renderAppSpec` bakes it onto the component as a SECRET
   * env var, and process environment is fixed at spawn. Rotating the credential
   * behind such a slug therefore meant redeploying the fleet by hand.
   *
   * WHAT BOUNDS IT IS THIS LIST, and that is what keeps the deployment
   * auditable. Only a name written here can move under a running process, so the
   * rendered spec still names every variable this component may ever hold — a
   * parameter created under this slug that nobody listed here changes nothing
   * until the next deploy. What is no longer pinned by the spec is the VALUE.
   *
   * A listed name that is not seeded yet is included on purpose. It bakes no env
   * var (there is nothing to bake), and the first poll after somebody seeds it
   * is what puts it on the container — so "seed a credential after the deploy"
   * stops needing a redeploy too, not just "rotate one".
   *
   * AN ALLOWLIST BY NAME, exactly like `paramsWritable:` above, and for the same
   * structural reason: core composes the store path from the CONFIG's slug and
   * the CONFIG's own copy of this string, never from the URL a caller sent (see
   * src/http/params.ts). Requiring `params: true` is what makes this disclose
   * nothing new — that flag already bakes this entire namespace onto this
   * component, so the container holds these values already. It just holds STALE
   * ones.
   *
   * WHAT IT CANNOT DO. The refresh updates the container's environment; whether
   * the upstream server NOTICES is a property of that server. One that reads
   * `process.env` when it builds a client per request (strad-fetch) picks the
   * new value up on the next call. One that snapshots its credential at mount
   * and memoises a connection (telegram's MTProto session, a Grafana client)
   * does not, and keeps the boot value until the next restart. The bundle host
   * says so at boot rather than leaving it silent — see HACKS.md #71.
   */
  paramsRefresh: z.array(z.string().min(1)).default([]),
  /**
   * Env for the CORE gateway only — the human console's half of this server.
   * It is NOT injected into the server's container, and that asymmetry is the
   * whole point.
   *
   * `env:` above lands on the component that answers /mcp. Anything in it is a
   * credential the AGENT path holds. `consoleEnv:` lands on core, which serves
   * the SSO-gated /ui and nothing an agent can reach.
   *
   * The `secrets` server is why this exists: its MCP container runs as a viewer
   * with `roles/secretmanager.viewer` (list/describe — no `versions.access`), so
   * no tool, no bug and no prompt injection can pull a secret VALUE through
   * /mcp, because the credential it would have to use cannot. The console needs
   * a second, stronger service account to add/reveal/delete values — and that
   * one must never reach the MCP container, or the IAM split is theatre.
   *
   * (A plain broadcast SECRET env var would NOT do: appspec.ts forwards every
   * SECRET-typed broadcast var to every component, supplementary images
   * included. `consoleEnv:` is the only scope that reaches core and stops.)
   */
  consoleEnv: z.record(SecretRef).default({}),
  /**
   * The parameter STORES this server's console page can switch between.
   *
   * One console page, N GCP projects. Absent (the default) the page resolves a
   * SINGLE store the old way, out of `SECRETS_PROJECT_ID` / `SECRETS_NAMESPACES`
   * / `SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON` — so every config written before
   * this field keeps working unchanged. Present, it REPLACES that reading
   * entirely: the console renders a store picker and every list, create, rotate,
   * note, reveal and delete is scoped to the selected entry.
   *
   * WHY IT IS `console`-PREFIXED, and not merely `stores:`. This field is read by
   * the SSO console and by nothing else; `mcpStores:` below is the `/mcp` half,
   * and the two are separate because the credential each carries is separate —
   * an admin key that lands on core alone, and a viewer key that lands on the
   * bundle. A deployment may declare either, both, or neither, and their
   * namespace lists need not match: the console's may be wider.
   *
   * WHAT THE TWO SHARE IS ONE ENTITLEMENT. There is nowhere in strad to say
   * "role X may call list_parameters, but only for namespace Y": entitlements
   * name SLUGS (gateway/entitlements.ts) and the `tools:` policy names TOOL
   * NAMES (gateway/toolPolicy.ts). So a slug whose `mcpStores:` names several
   * projects IS one entitlement spanning all of them, and everyone entitled to
   * that slug reaches every store on it. That is a deliberate posture decision
   * and not an oversight — what it does NOT do is level the stores' capability,
   * because each store is probed and called with its own credential.
   *
   * WHY THE CREDENTIAL IS NAMED AND NOT INLINED. `adminKeyVar` names a
   * `consoleEnv:` KEY rather than carrying a `${REF}` of its own. `consoleEnv:`
   * is the one scope appspec.ts lands on core and stops (see `consoleEnvVars`),
   * and it is already what preflight, store-check, seed-scope and the secret
   * roster understand a console-only name to be. A second, parallel route for
   * store-ADMIN credentials would be a second thing to get the scoping right in
   * — and the failure mode of getting it wrong is an admin key on a bundle,
   * which is the whole IAM split. The `superRefine` below makes the indirection
   * load-bearing: an `adminKeyVar` MUST be a key of this server's `consoleEnv:`,
   * and MUST NOT be a key of any server's `env:`.
   */
  consoleStores: z.array(ConsoleStore).default([]),
  /**
   * The parameter STORES this server's `/mcp` half can address.
   *
   * One container, N GCP projects. Absent (the default) the secrets tree resolves
   * a SINGLE store the old way, out of `SECRETS_PROJECT_ID` / `SECRETS_NAMESPACES`
   * / `SECRETS_SERVICE_ACCOUNT_KEY_JSON` in its own `env:` — so every config
   * written before this field keeps working unchanged. Present, `renderAppSpec`
   * emits a `SECRETS_STORES` descriptor onto this server's bundle and the tree
   * reads THAT instead, entirely: a config that says what its stores are does
   * not also get an env-derived one under whichever `SECRETS_PROJECT_ID` was
   * left lying around. Declaring both is refused below rather than resolved.
   *
   * THE DESCRIPTOR CARRIES NO CREDENTIAL. It carries project ids, namespaces and
   * the NAME of the `env:` key each store's viewer credential arrives under, so
   * a rendered app spec is readable and a deploy diff shows which store gained
   * or lost a namespace. The keys themselves are ordinary `env:` refs.
   *
   * WHAT MAKES IT SAFE TO PUT SEVERAL PROJECTS BEHIND ONE MCP SERVER. A
   * capability is a property of ONE credential on ONE project, and the secrets
   * tree keys it that way: one `projects:testIamPermissions` probe per store,
   * memoised per project id, and every gate — `get_secret_value`, all three
   * writes, the delete — consults the capability of the store the requested PATH
   * resolves to. The tool LIST is the union across stores, because an MCP listing
   * is static per container and there is no way to offer a tool for one store and
   * withhold it for another; the enforcement is not. See
   * servers/secrets/shared/src/capabilities.ts.
   */
  mcpStores: z.array(McpStore).default([]),
  /** Headers strad sends when proxying to it (e.g. a shared internal token). */
  headers: HeaderMap,
});

/**
 * kind: builtin
 *
 * An MCP server compiled into a strad image — the escape hatch for private,
 * internal servers (tadasant-internal registers its own here). Builtins are
 * cheap: several colocate in one bundle component at $0 marginal cost.
 *
 *   - slug: hello
 *     kind: builtin
 *     module: "@tadasant/strad-server-hello"
 *     bundle: core           # run in the gateway process itself
 */
const BuiltinServer = ServerBase.extend({
  kind: z.literal("builtin"),
  /** Module specifier resolved at boot. Must default-export a BuiltinModule. */
  module: z.string().min(1),
  /**
   * Which component hosts it. `core` = in the gateway process (default).
   * Any other value = a bundle component running the strad image in bundle
   * mode; the gateway proxies to it over the private network.
   */
  bundle: SLUG.default("core"),
  /** Options handed to the builtin's factory. May contain `${SECRET_REF}`. */
  options: z.record(z.unknown()).default({}),
  /**
   * Opt into PARAMETER RESOLUTION. When true, everything under
   * `/strad/{env}/mcp/{slug}/static/*` is resolved from the secrets system and
   * merged into this builtin's `options` at launch (see gateway/registry.ts). For
   * a `core` builtin this happens in-process, at runtime — the concrete
   * "resolve, then inject into the child" path. See src/secrets/parameters.
   */
  params: z.boolean().default(false),
});

export const ServerConfig = z.discriminatedUnion("kind", [
  RemoteHttpServer,
  LocalTunnelServer,
  SupplementaryImageServer,
  BuiltinServer,
]);

/**
 * The kinds strad runs no container for: somebody else's server, at a URL.
 *
 * `remote-http` is a third party's; `local-tunnel` is the operator's own
 * machine. Neither gets a component, a bundle, an image or a deploy-time env,
 * so every part of the deploy and console layer that asks "is this one of ours
 * to run?" asks it here rather than naming a kind — which is what keeps a fifth
 * kind from having to be added to a dozen scattered comparisons.
 */
const UNHOSTED_KINDS = ["remote-http", "local-tunnel"] as const;

export function isUnhosted(
  server: ServerConfig,
): server is Extract<ServerConfig, { kind: (typeof UNHOSTED_KINDS)[number] }> {
  return (UNHOSTED_KINDS as readonly string[]).includes(server.kind);
}

/**
 * Every field of an unhosted server that strad resolves a `${NAME}` from, in its
 * own process: the `url:`, each `headers:` value, and — for a `remote-http` that
 * mints its bearer — each `oauthRefresh:` field.
 *
 * NAMED FIELDS, not a walk of the whole object, so a `${...}`-looking string in
 * a `description` or a `recovery:` note cannot invent a requirement. One list,
 * so the deploy gate, the per-server namespace layer and the console roster
 * cannot disagree about which names a server reads.
 */
export function unhostedRefFields(
  server: Extract<ServerConfig, { kind: (typeof UNHOSTED_KINDS)[number] }>,
): string[] {
  const out = [server.url, ...Object.values(server.headers)];
  if (server.kind === "remote-http" && server.oauthRefresh) {
    const o = server.oauthRefresh;
    out.push(o.tokenUrl, o.clientId, o.refreshToken);
    for (const optional of [o.clientSecret, o.scope, o.resource]) {
      if (optional !== undefined) out.push(optional);
    }
  }
  return out;
}

/**
 * An https URL, or an http one to a loopback host. The runtime twin is
 * `tokenUrlAllowed` in src/gateway/adapters/oauth-refresh.ts, which also covers
 * a `tokenUrl` that only resolves at request time.
 */
function loopbackOrHttps(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

/**
 * The NAME in a value that is exactly one `${NAME}` and nothing else, or null.
 *
 * What `oauthRefresh.refreshToken` must be: the write-back composes a store path
 * from this name, and a value with anything around the reference — or no
 * reference at all — has no single name to write a rotated token back to.
 */
export function soleRefName(value: string): string | null {
  const names = secretRefsIn(value);
  return names.length === 1 && value === `\${${names[0]}}` ? names[0]! : null;
}

// ---------------------------------------------------------------------------
// Bundles — deployment groups
// ---------------------------------------------------------------------------

/**
 * A bundle is one App Platform component.
 *
 * `core` is implicit: the public gateway. Every other bundle is internal-only
 * and reached over the private network via ${bundle-name.PRIVATE_URL}.
 *
 * Rules (enforced below):
 *   - a bundle holding a `supplementary-image` server holds ONLY supplementary
 *     images, and they must all be the SAME image
 *   - `builtin` servers may share a bundle freely (that's the $0-marginal win)
 *
 * Two servers in one bundle MAY share a `path`. That is the capability-variant
 * case and it is the point of the whole design: `gmail-ro` and `gmail-rw` are
 * the same upstream at the same path in the same container, differing only in
 * their `tools:` policy, which the GATEWAY enforces. (Before capability moved to
 * the gateway, they could not even share a container — each needed its own
 * `*_ENABLED_TOOLGROUPS` value, and a component's env is the union of its
 * servers' env maps. That constraint is what made the fleet cost 12 bundles for
 * its 26 slugs. The staging fleet is 28 slugs in ONE bundle; the two other
 * non-core slugs are the `echo` builtin and the `deepwiki` remote-http, which
 * need no container of their own. A 29th supplementary slug, `zimmer-secrets`,
 * has its own bundle — for a reason capability cannot cause: it fronts a second
 * parameter store, and a store is `process.env`.)
 *
 * Sizing: a bundle that hosts a browser server runs a real Chromium (~1.06s per
 * launch, ~545MB peak RSS) and CPU — not RAM — is what binds it, because 1 vCPU
 * serialises page rendering. Co-locating everything in one bundle means that box
 * also runs `op` and 20 other upstream servers (which the config names as 28 slugs), so
 * size it up, not down.
 */
const BundleConfig = z.object({
  name: SLUG,
  /**
   * An App Platform compute plan, e.g. `apps-s-1vcpu-2gb`.
   *
   * A plain string HERE and a closed set at the deploy gate
   * (`src/deploy/instance-size.ts`), which is the same split as the strict
   * config parse and for the same reason: this parse runs at BOOT, in every
   * container, and the config versions independently of the image, so a schema
   * that rejected a plan it had not heard of would make an older image refuse
   * the config a newer one wrote. Nothing at runtime reads this field — only
   * the renderer does — and a field with no runtime meaning must not be able to
   * stop a container from starting.
   *
   * `check-config` and `render-spec` are strict about it, so a name
   * DigitalOcean does not sell fails on the pull request that writes it rather
   * than at `doctl apps update`, weeks later, after the merge.
   */
  instanceSizeSlug: z.string().default("apps-s-1vcpu-1gb"),
  instanceCount: z.number().int().positive().default(1),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * strad is on the open internet. There is no network perimeter — no tailnet,
 * no VPN, no IP allowlist. Auth is the ONLY gate. Two doors:
 *
 *   /mcp      — machines and interactive MCP clients. A static system token, or
 *               an access token strad's own authorization server issued
 *               (`mcpOAuth`, below). Never unauthenticated, never
 *               dev-bypassable, and never a console session — which of those
 *               two credentials it takes is enforced in code, not config.
 *   /console  — humans. Google OAuth (Workspace `hd` claim), with a dev bypass
 *               that itself still requires ADMIN_BOOTSTRAP_TOKEN, and — outside
 *               prod — a single-use login token either one can mint for an
 *               automated actor.
 */
const AuthConfig = z.object({
  google: z
    .object({
      enabled: z.boolean().default(false),
      /**
       * Google Workspace hosted domain. Verified against the `hd` claim on the
       * ID token — NOT the email suffix. A personal Google account can set its
       * email to `someone@tadasant.com`; only `hd` proves Workspace membership.
       */
      hostedDomain: z.string().min(1),
      /** Roles granted to any verified member of `hostedDomain`. */
      roles: z.array(Role).default([]),
    })
    .optional(),

  staticTokens: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * Where token records live.
       *
       *   `env`              a JSON array in the STRAD_TOKENS environment
       *                      variable, read ONCE at boot. Minting or revoking is
       *                      an edit to the secret and a redeploy.
       *   `parameter-store`  the SAME JSON array, in the SAME variable, as a
       *                      parameter at `/strad/{env}/gateway/static/STRAD_TOKENS`
       *                      — read on the request path and written by the
       *                      console at `/tokens`. Mint and revoke take effect on
       *                      a running gateway.
       *
       * The migration is this flip and nothing else: one name, one payload
       * shape, and a deployment whose parameter does not exist yet has it seeded
       * from what the gateway is already serving at the first mint. See
       * `src/auth/token-admin.ts` and `docs/operate/secrets.md`.
       */
      store: z.enum(["env", "parameter-store"]).default("env"),
    })
    .default({ enabled: true, store: "env" }),

  /**
   * strad's OWN OAuth 2.1 authorization server, in front of `/mcp`.
   *
   * This is what lets an interactive MCP client — claude.ai's custom-connector
   * dialog is the one it was built for — be handed a URL and nothing else, and
   * arrive at a working connection through a sign-in rather than through a
   * token somebody pasted out of band. strad issues the tokens; Google
   * authenticates the human behind them.
   *
   * It is ADDITIVE. `staticTokens` is untouched by it: `/mcp` accepts either
   * credential, and a machine client holding a long-lived
   * `strad_<env>_<pubid>_<secret>` is unaffected whether this is on or off.
   *
   * Enabling it is not enough on its own, for the same reason `auth.google` is
   * not (see `resolveMcpOAuth` in src/auth/mcp-oauth/index.ts): the Google
   * OAuth client and a signing key must also exist, and a half-configured
   * deployment says so at boot rather than redirecting a human into a flow that
   * cannot finish.
   */
  mcpOAuth: z
    .object({
      enabled: z.boolean().default(false),
      /**
       * The Google Workspace domain a token holder must belong to, verified
       * against the ID token's `hd` claim AND the email suffix — on every
       * authorization and on every refresh.
       *
       * Optional, and it falls back to `auth.google.hostedDomain`: the two
       * doors of one deployment answer to one Workspace, and making this
       * mandatory would be asking an operator to write the same string twice.
       * Set it only to point `/mcp` at a different Workspace from the console's.
       * A deployment that enables this with neither is refused by the
       * superRefine below — the alternative is a gateway that would accept the
       * first Google account to arrive.
       */
      hostedDomain: z.string().min(1).optional(),
      /**
       * Roles granted to a verified member of the domain.
       *
       * Deliberately NOT defaulted from `auth.google.roles`. That grant is the
       * console's, and an OAuth login at `/mcp` inheriting it would mean
       * enabling this flag silently widened what `/mcp` hands out. `[]` is the
       * fail-closed default: the flow completes, the token verifies, and every
       * `?servers=` gets the ordinary 424. Boot warns when it is empty.
       */
      roles: z.array(Role).default([]),
      /**
       * Access-token lifetime, seconds. One hour is the conventional default
       * and what an MCP client expects to refresh against.
       *
       * The floor is five minutes because an access token is verified with no
       * lookup: it cannot be revoked before it expires, so a short life IS the
       * revocation window. The ceiling is a day because the same sentence read
       * the other way is a reason not to let one run long.
       */
      accessTokenTtlSeconds: z
        .number()
        .int()
        .min(300)
        .max(86_400)
        .default(3600),
    })
    .default({ enabled: false, roles: [], accessTokenTtlSeconds: 3600 }),

  /**
   * Console dev bypass: sign in to /console without Google OAuth, by presenting
   * ADMIN_BOOTSTRAP_TOKEN. For use until Google OAuth credentials exist.
   *
   * Three independent locks, all of which must be open (see src/auth/dev.ts):
   *   1. this flag
   *   2. ALLOW_DEV_AUTH=true
   *   3. NODE_ENV !== production, OR ALLOW_DEV_AUTH explicitly set anyway
   *   ...and ADMIN_BOOTSTRAP_TOKEN must be set and presented.
   *
   * It grants a console session and nothing else. It CANNOT authenticate /mcp.
   */
  consoleDevBypass: z
    .object({
      enabled: z.boolean().default(false),
      roles: z.array(Role).default([]),
    })
    .default({ enabled: false, roles: [] }),

  /**
   * Console token login: a standing console credential mints a short-lived,
   * single-use token, and an automated actor exchanges it for a 30-minute
   * console session that can view the console and not act through it
   * (src/auth/console-tokens.ts).
   *
   * Two locks: this flag, and a `gateway.env` in `TOKEN_LOGIN_ENVS` (`dev`,
   * `local`, `test`, `staging`). In production the three routes are never
   * mounted, whatever this says — there is no acknowledgement that turns them
   * on there.
   *
   * No `roles:` of its own, on purpose. A token's roles are its minter's (or a
   * subset the minter asks for), so enabling this grants nobody anything that a
   * standing credential did not already hold. It CANNOT authenticate /mcp.
   */
  consoleTokenLogin: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({ enabled: false }),
});

// ---------------------------------------------------------------------------
// Secrets — where `${NAME}` is read from, and when
// ---------------------------------------------------------------------------

/**
 * The deployment's secret posture. There is exactly ONE per deployment, on
 * purpose: two ways to manage secrets is the problem this block exists to end.
 *
 * `env` (the default) — `${NAME}` resolves from the process environment. Nothing
 * cloud-specific is involved, `npm run dev` works, and a deployment that injects
 * secrets as container env vars at deploy time keeps behaving exactly as it did.
 * This is the OSS default and it must stay that way: strad bakes in no vendor.
 *
 * `gcp-parameter-store` — `${NAME}` resolves AT RUNTIME from the parameter store
 * (see src/secrets/parameters), under `/strad/{env}/gateway/static/`. Adding or
 * rotating a secret in the store takes effect on the running gateway inside the
 * TTLs below, with no redeploy. The deploy renderer then bakes NO per-secret env
 * vars at all — only the single bootstrap credential the container needs to
 * reach the store.
 *
 * Timings are honest, not aspirational (see src/secrets/provider/store.ts):
 * a rotation lands within `ttlSeconds`; a newly ADDED name lands within
 * `negativeTtlSeconds`; a change written through strad's own console is instant
 * on the process that wrote it.
 *
 * The defaults are long on purpose. A process holds ONE reading of the whole
 * store (src/secrets/parameters/gcp.ts) and re-reads it only when that reading
 * has aged past `ttlSeconds`, when a console write drops it, or when a `${NAME}`
 * it does not hold is asked for. Every read of the store is billed per
 * parameter, secrets change a few times a month, and the production bill for
 * re-reading them once a minute was the largest line on the account. An hour
 * is the trade: a rotation made outside strad's console lands within it; one
 * made through the console lands at once.
 */
const SecretsConfig = z
  .object({
    provider: z.enum(["env", "gcp-parameter-store"]).default("env"),
    /**
     * How long one reading of the store is reused, per process. Bounds how long
     * a ROTATION made outside strad's console can go unnoticed.
     *
     * Also the age the console's and `/api/secrets/readiness`'s store
     * DIAGNOSIS may carry: it is answered from the same reading, and prints how
     * old that reading is. See src/secrets/store-diagnostics.ts.
     */
    ttlSeconds: z.number().int().positive().max(86_400).default(3600),
    /**
     * Minimum interval between re-reads triggered by a MISS. Bounds how long a
     * newly ADDED secret can go unnoticed, and stops an unknown `${REF}` on a
     * hot path — or a slug deployed ahead of its credential — from re-reading
     * the store once per request.
     */
    negativeTtlSeconds: z.number().int().positive().max(86_400).default(600),
    /**
     * Keep the process environment as a FALLBACK behind the store.
     *
     * True (the default) makes the migration off deploy-time baking reversible
     * and non-atomic: a name not yet moved into the store still resolves. Set it
     * false once the move is complete to make "the store is the only source"
     * enforceable rather than merely intended.
     */
    envFallback: z.boolean().default(true),
    /**
     * How often a supplementary component re-reads the parameters its servers
     * listed under `paramsRefresh:`. Seconds.
     *
     * Deliberately NOT `ttlSeconds`. That one bounds a cache in front of a read
     * the gateway was going to do anyway, so a short value costs nothing when
     * nothing asks. This one drives a POLL, and a poll's cost is paid whether or
     * not anybody is using the credential: one store read per listed variable
     * per component per interval, forever. The floor is what keeps a config
     * typo (`5`) from turning three variables into a permanent 2000-reads-an-
     * hour load on a store that has already 429'd a deploy three times.
     *
     * It has no effect at all unless some server sets `paramsRefresh:`, which no
     * server does by default.
     */
    paramRefreshSeconds: z.number().int().min(30).max(86_400).default(300),
  })
  .default({
    provider: "env",
    ttlSeconds: 3600,
    negativeTtlSeconds: 600,
    envFallback: true,
    paramRefreshSeconds: 300,
  });

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export const StradConfig = z
  .object({
    version: z.literal(1),

    gateway: z
      .object({
        name: z.string().default("strad"),
        /** Public base URL. Used for OAuth redirects and authorize_url hints. */
        publicUrl: z.string().url().optional(),
        /** staging | prod | dev — also the middle segment of static tokens. */
        env: z.string().default("dev"),
        secrets: SecretsConfig,
      })
      .default({ name: "strad", env: "dev", secrets: {} }),

    auth: AuthConfig,

    /** Role definitions. `servers: ["*"]` means every configured server. */
    roles: z
      .record(
        Role,
        z.object({
          servers: z.array(z.string()).default([]),
        }),
      )
      .default({}),

    bundles: z.array(BundleConfig).default([]),

    /** The core ships empty. This is the one place you attach servers. */
    servers: z.array(ServerConfig).default([]),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const s of cfg.servers) {
      if (seen.has(s.slug)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate server slug: ${s.slug}`,
          path: ["servers"],
        });
      }
      seen.add(s.slug);
    }

    // THE OAUTH DOMAIN CONSTRAINT MUST NAME A DOMAIN.
    //
    // `auth.mcpOAuth.hostedDomain` falls back to `auth.google.hostedDomain`, so
    // most deployments write it once. A deployment that enables the flow and
    // declares NEITHER has no domain to enforce, and a flow with no domain to
    // enforce admits the first Google account that arrives at it. Refusing here
    // is the difference between a config error at `npm run config:check` and a
    // gateway that hands `/mcp` to the internet.
    if (
      cfg.auth.mcpOAuth.enabled &&
      cfg.auth.mcpOAuth.hostedDomain === undefined &&
      cfg.auth.google?.hostedDomain === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "auth.mcpOAuth.enabled is true but no hosted domain is declared. " +
          "Set auth.mcpOAuth.hostedDomain, or auth.google.hostedDomain, to the " +
          "Google Workspace domain whose members may hold a token for /mcp.",
        path: ["auth", "mcpOAuth", "hostedDomain"],
      });
    }

    // A ROLE NAMED THERE MUST EXIST, on the same reasoning as a server's
    // entitlements below: an OAuth login carrying a role no `roles:` block
    // defines is a sign-in that completes and then gets a 424 for every slug,
    // with nothing anywhere saying why.
    for (const role of cfg.auth.mcpOAuth.roles) {
      if (!cfg.roles[role]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `auth.mcpOAuth.roles grants unknown role "${role}"`,
          path: ["auth", "mcpOAuth", "roles"],
        });
      }
    }

    // A TOKEN STORE STRAD CANNOT READ IS A GATEWAY WITH NO DOOR.
    //
    // `auth.staticTokens.store: parameter-store` files the records at
    // `/strad/{env}/gateway/static/STRAD_TOKENS` and reads them through the
    // runtime secret provider. Under `gateway.secrets.provider: env` that
    // provider IS `process.env`, so the flip would change nothing about the
    // read and everything about the write: the console would offer mint and
    // revoke forms backed by a store that does not exist. Refused here rather
    // than at the first click, because `npm run config:check` runs in CI and the
    // first click does not.
    if (
      cfg.auth.staticTokens.store === "parameter-store" &&
      cfg.gateway.secrets.provider !== "gcp-parameter-store"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'auth.staticTokens.store is "parameter-store" but ' +
          `gateway.secrets.provider is "${cfg.gateway.secrets.provider}". The ` +
          "records are a parameter, so there has to be a parameter store to " +
          'read and write them in. Set the provider to "gcp-parameter-store", ' +
          'or leave the token store as "env".',
        path: ["auth", "staticTokens", "store"],
      });
    }

    // Every referenced role must be defined, or entitlement checks silently
    // deny forever and the operator has no idea why.
    for (const s of cfg.servers) {
      for (const role of s.entitlements) {
        if (!cfg.roles[role]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `server "${s.slug}" grants unknown role "${role}"`,
            path: ["servers"],
          });
        }
      }
    }

    // PARAMS-WRITABLE, AND PARAMS-REFRESH.
    //
    // Two allowlists, one rule set, because they fence the same thing: core
    // composes a parameter path out of the server's slug and the CONFIG's own
    // copy of one of these strings (src/http/params.ts), never out of the URL a
    // caller sent. A name that is not a legal variable would compose a path
    // pointing somewhere else entirely, so what may appear in either list is
    // checked here rather than at the route. It is the SAME rule the console
    // applies when a human creates a parameter (`validateVariableName`), because
    // both come from src/config/env-name.ts — a zero-import module, so this file
    // pays nothing for importing it and the two gates cannot drift apart.
    //
    // `params: true` is REQUIRED for both, and not merely for tidiness. That
    // flag is what injects `/strad/{env}/mcp/{slug}/static/` onto this component
    // in the first place. Without it `paramsWritable:` would write a namespace
    // the server does not read — a credential going nowhere, the silent no-op
    // src/deploy/server-namespaces.ts exists to stop shipping — and
    // `paramsRefresh:` would re-read a namespace nothing injected, which is the
    // same no-op arrived at from the other end. It is also what makes the read
    // side disclose nothing: the value is already baked on this component, and
    // the refresh only replaces a stale copy of it.
    for (const s of cfg.servers) {
      if (s.kind !== "supplementary-image") continue;
      const lists = [
        { field: "paramsWritable", verb: "write", entries: s.paramsWritable },
        { field: "paramsRefresh", verb: "re-read", entries: s.paramsRefresh },
      ].filter((l) => l.entries.length > 0);

      for (const { field, verb, entries } of lists) {
        if (!s.params) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" sets ${field}: but not params: true. ` +
              `${field} names variables in this server's own ` +
              `/strad/{env}/mcp/${s.slug}/static/ namespace, and params: true is ` +
              `what makes that namespace this server's environment. Without it ` +
              `the server would ${verb} values nothing injects.`,
            path: ["servers"],
          });
        }
        const seenVars = new Map<string, string>();
        for (const variable of entries) {
          // The same two rules `validateVariableName` applies when a human
          // creates a parameter in the console, from the same module. The length
          // cap is Parameter Manager's, and a name past it addresses a parameter
          // that cannot exist.
          if (!isEnvName(variable) || variable.length > MAX_VARIABLE_LENGTH) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                `server "${s.slug}" lists "${variable}" under ${field}:, ` +
                `which is not a legal environment variable name (letters, digits ` +
                `and underscores; not starting with a digit; at most 200 ` +
                `characters). A ${field} entry is a VARIABLE, not a path — ` +
                `it addresses /strad/{env}/mcp/${s.slug}/static/{VARIABLE} and ` +
                `nothing else.`,
              path: ["servers"],
            });
          }
          // DUPLICATES ARE COMPARED CASE-INSENSITIVELY, because `parameterId`
          // folds case before it hashes: `X_TOKEN` and `x_token` name ONE
          // resource in the store but two different environment variables in the
          // container. Listing both is a config where one name works and its twin
          // 404s forever, which is the least diagnosable outcome available here.
          const fold = variable.toLowerCase();
          const first = seenVars.get(fold);
          if (first !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                first === variable
                  ? `server "${s.slug}" lists "${variable}" twice under ${field}:`
                  : `server "${s.slug}" lists both "${first}" and "${variable}" ` +
                    `under ${field}:. A parameter path folds case, so those ` +
                    `are ONE parameter under two variable names — one of them ` +
                    `would resolve and the other would never be found.`,
              path: ["servers"],
            });
          }
          seenVars.set(fold, variable);
        }
      }
    }

    // OAUTH REFRESH on a remote-http server.
    //
    // Four rules. The first two keep a credential out of the config and give
    // the write-back a name to write to. The third keeps two principals off one
    // header. The fourth keeps one refresh token in one minter: a provider that
    // rotates on use kills the token each exchange spends, so two servers
    // sharing one would each invalidate the other's on every refresh.
    const refreshOwners = new Map<string, string>();
    for (const s of cfg.servers) {
      if (s.kind !== "remote-http" || !s.oauthRefresh) continue;
      const o = s.oauthRefresh;
      const issue = (message: string): void =>
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `server "${s.slug}" ${message}`,
          path: ["servers"],
        });

      const variable = soleRefName(o.refreshToken);
      if (variable === null) {
        issue(
          `sets oauthRefresh.refreshToken to something other than exactly one ` +
            `\${NAME}. A refresh token is a credential: it lives in the store ` +
            `and is referenced, e.g. refreshToken: "\${GRANOLA_REFRESH_TOKEN}". ` +
            `The reference is also the name a rotated token is written back to.`,
        );
      }
      if (
        o.clientSecret !== undefined &&
        soleRefName(o.clientSecret) === null
      ) {
        issue(
          `sets oauthRefresh.clientSecret to something other than exactly one ` +
            `\${NAME}. A client secret is a credential: reference it from the ` +
            `store rather than writing it into the config.`,
        );
      }
      if (
        Object.keys(s.headers).some((h) => h.toLowerCase() === "authorization")
      ) {
        issue(
          `declares both oauthRefresh: and an Authorization header. With ` +
            `oauthRefresh: strad sends the minted access token as the bearer; ` +
            `delete the header.`,
        );
      }
      if (refsIn(o.tokenUrl).length === 0 && !loopbackOrHttps(o.tokenUrl)) {
        issue(
          `sets oauthRefresh.tokenUrl to "${o.tokenUrl}". It must be an https ` +
            `URL (plain http is allowed only for a loopback host): the refresh ` +
            `token travels in the request body.`,
        );
      }
      if (variable !== null && s.enabled) {
        const owner = refreshOwners.get(variable);
        if (owner !== undefined) {
          issue(
            `and server "${owner}" both mint from \${${variable}}. One refresh ` +
              `token belongs to one server: a provider that rotates on use ` +
              `invalidates the token each refresh spends, so the two would ` +
              `revoke each other's. Give each its own name.`,
          );
        } else {
          refreshOwners.set(variable, s.slug);
        }
      }
    }

    // OAUTH CONNECTORS.
    //
    // Three rules, and the third is the one that keeps a fleet deployable.
    //
    // The variable names are checked the same way `paramsWritable:` entries are,
    // and for the same reason: core composes a store path out of the slug and
    // these strings, so a name that is not a legal variable composes a path
    // pointing somewhere else. The case-insensitive distinctness check is
    // `parameterId`'s doing — a path folds case before it hashes, so
    // `..._CLIENT_ID` and `..._client_id` are ONE parameter under two variable
    // names, and a connector that wrote its token over its own client id would
    // be unrecoverable from the console that caused it.
    //
    // The third rule refuses the deploy-ordering trap. See {@link OAuthConnector}:
    // the connector's variables are injected by the renderer, never referenced,
    // and a `${NAME}` written by hand puts a whole-fleet render failure back in
    // front of a token that cannot exist until after the deploy.
    for (const s of cfg.servers) {
      const oauth = s.oauth;
      if (!oauth) continue;

      // ONLY A KIND THE RENDERER INJECTS FOR.
      //
      // `oauth:` lives on ServerBase so the type stays one shape, but only a
      // supplementary image's environment is built by `renderAppSpec`, which is
      // what puts the three variables on a container. On any other kind the
      // console would run a real consent, write a real refresh token, and
      // nothing would ever read it — a credential minted into a drawer.
      if (s.kind !== "supplementary-image") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `server "${s.slug}" declares oauth: on kind "${s.kind}". A ` +
            `connector's variables are injected onto a container by the app-spec ` +
            `renderer, and only a supplementary-image has one — the consent would ` +
            `succeed and the credential would reach nothing.`,
          path: ["servers"],
        });
      }

      // IT MUST BE THE ONLY SERVER ON ITS OWN PATH, and the path must be its own
      // slug. This is not tidiness; it is what makes the credential deliverable.
      //
      // The bundle host mounts a per-slug instance only at `/<slug>`, and a
      // connector's variables are emitted under the per-slug name ALONE (see
      // src/deploy/appspec.ts). A connector on any other path would have its
      // variables baked onto the box under a name nothing reads, and — because
      // the host falls back to bare names — would come up holding whatever a
      // sibling was seeded. Refusing here is what makes that unrepresentable
      // rather than merely unlikely.
      if (s.kind === "supplementary-image" && s.path !== `/${s.slug}`) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `server "${s.slug}" declares oauth: but serves path "${s.path}". A ` +
            `connector's credential is delivered under this slug's own variable ` +
            `names, and the bundle host reads those only for the server that is ` +
            `alone on path: /${s.slug}. Set path: /${s.slug}.`,
          path: ["servers"],
        });
      }

      // THE ENDPOINTS A GENERIC CONNECTOR NAMES.
      //
      // https, or http to a loopback host, checked with the SAME predicate
      // `oauthRefresh.tokenUrl` uses — an authorization code and a client secret
      // travel over these, so a plain-http endpoint on a real host would put both
      // on the wire. `loopbackOrHttps` is reused rather than re-expressed because
      // two spellings of one rule is how one of them ends up weaker.
      if (oauth.provider === "generic") {
        for (const field of ["authorizeUrl", "tokenUrl"] as const) {
          if (loopbackOrHttps(oauth[field])) continue;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" sets oauth.${field} to "${oauth[field]}". It ` +
              `must be an https URL (plain http is allowed only for a loopback ` +
              `host): an authorization code and a client secret travel over it.`,
            path: ["servers"],
          });
        }

        // THE PARAMETERS STRAD OWNS ARE NOT CONFIGURABLE.
        //
        // `redirect_uri` and `code_challenge` are the two controls that keep an
        // authorization code from leaving the building, and `client_id`, `scope`
        // and `state` are the terms a human is shown before consenting. A config
        // key that could rewrite any of them would make the whole "the browser
        // supplies nothing" story advisory. The builder skips a reserved key
        // anyway; this is what makes the attempt LOUD rather than ignored.
        for (const key of Object.keys(oauth.authorizeParams)) {
          if (!(RESERVED_AUTHORIZE_PARAMS as readonly string[]).includes(key))
            continue;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" sets oauth.authorizeParams.${key}, which is ` +
              `one of the authorization parameters strad composes itself ` +
              `(${RESERVED_AUTHORIZE_PARAMS.join(", ")}). They carry the terms ` +
              `of the grant and the PKCE challenge; a config cannot rewrite ` +
              `them. Delete this key.`,
            path: ["servers"],
          });
        }
      }

      const named: { field: string; variable: string }[] = [
        { field: "clientIdVariable", variable: oauth.clientIdVariable },
        { field: "clientSecretVariable", variable: oauth.clientSecretVariable },
        { field: "refreshTokenVariable", variable: oauth.refreshTokenVariable },
      ];

      for (const { field, variable } of named) {
        if (!isEnvName(variable) || variable.length > MAX_VARIABLE_LENGTH) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" sets oauth.${field} to "${variable}", which ` +
              `is not a legal environment variable name (letters, digits and ` +
              `underscores; not starting with a digit; at most 200 ` +
              `characters). It addresses /strad/{env}/mcp/${s.slug}/{kind}/` +
              `{VARIABLE} and nothing else.`,
            path: ["servers"],
          });
        }
      }

      // A CONNECTOR VARIABLE MAY NOT ALSO BE A `paramsWritable:` OR
      // `paramsRefresh:` ENTRY.
      //
      // Those two name variables in this slug's `static/` namespace and nowhere
      // else (src/http/params.ts composes `parameterPath`), while a connector's
      // credential lives under `oauth/` and outranks `static/` for the same
      // name. Allowing both would make the container re-read a stale hand-typed
      // copy over the credential a human just consented to, and write a rotation
      // back to a path the `oauth/` copy permanently shadows — silently, in both
      // directions. Refusing the combination is what keeps the two mechanisms
      // from addressing one name through different kinds.
      if (s.kind === "supplementary-image") {
        const owned = new Set(
          named.map(({ variable }) => variable.toLowerCase()),
        );
        for (const field of ["paramsWritable", "paramsRefresh"] as const) {
          for (const variable of s[field]) {
            if (!owned.has(variable.toLowerCase())) continue;
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                `server "${s.slug}" lists "${variable}" under ${field}: and ` +
                `names it on its oauth: connector. ${field} addresses ` +
                `/strad/{env}/mcp/${s.slug}/static/, and a connector's ` +
                `credential is written to the oauth/ kind, which outranks it — ` +
                `so the two would address one name through different kinds and ` +
                `disagree without failing. Drop it from ${field}:.`,
              path: ["servers"],
            });
          }
        }
      }

      const claimed = new Map<string, string>();
      for (const { field, variable } of named) {
        const fold = variable.toLowerCase();
        const first = claimed.get(fold);
        if (first !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" points oauth.${field} and oauth.${first} at ` +
              `the same parameter ("${variable}"). A parameter path folds case, ` +
              `so two spellings of one name are ONE stored value — connecting ` +
              `would overwrite one of this connector's own inputs.`,
            path: ["servers"],
          });
        }
        claimed.set(fold, field);
      }

      // strad requests `openid` and `email` itself; see GoogleConnector.scopes.
      // Listing one here is not wrong so much as a claim about capability that
      // the identity scopes do not make, and the deploy gate is where a config
      // gets told.
      //
      // GOOGLE'S RULE, AND ONLY GOOGLE'S. A generic provider gets no identity
      // scopes added — strad has no standard proof to ask one for — so `profile`
      // there is an ordinary capability scope whose name happens to collide, and
      // refusing it would refuse a correct config.
      const IDENTITY = new Set(
        oauth.provider === "google" ? ["openid", "email", "profile"] : [],
      );
      const seenScopes = new Set<string>();
      for (const scope of oauth.scopes) {
        if (IDENTITY.has(scope)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" lists the identity scope "${scope}" under ` +
              `oauth.scopes:. strad requests openid and email itself, to learn ` +
              `WHICH account consented; oauth.scopes: is for capability.`,
            path: ["servers"],
          });
        }
        if (seenScopes.has(scope)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `server "${s.slug}" lists the scope "${scope}" twice under oauth.scopes:`,
            path: ["servers"],
          });
        }
        seenScopes.add(scope);
      }

      // Every field this server resolves a `${NAME}` from. A reference to the
      // connector's own target is the deploy-ordering trap; a reference to its
      // client id or secret is merely redundant, and silently competes with the
      // injection for the same box name, so both are refused.
      const referenced = new Set<string>();
      const scan = (raw: string): void => {
        for (const name of secretRefsIn(raw)) referenced.add(name);
      };
      if (s.kind === "supplementary-image") {
        for (const value of Object.values(s.env)) scan(value);
        // `consoleEnv:` too. Its names are resolved from the DEPLOY ENVIRONMENT
        // rather than from the store (see scripts/render-spec.ts), so a
        // `${REFRESH_TOKEN}` written here reintroduces the whole-fleet render
        // failure this rule exists to prevent, by a quieter door.
        for (const value of Object.values(s.consoleEnv)) scan(value);
      }
      if (isUnhosted(s)) {
        for (const value of unhostedRefFields(s)) scan(value);
      } else if (s.kind === "builtin") {
        for (const value of Object.values(s.options)) {
          if (typeof value === "string") scan(value);
        }
      } else {
        for (const value of Object.values(s.headers)) scan(value);
      }
      for (const { field, variable } of named) {
        if (!referenced.has(variable)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `server "${s.slug}" references \${${variable}} in its config AND ` +
            `names it under oauth.${field}. A connector's variables are ` +
            `INJECTED from /strad/{env}/mcp/${s.slug}/{oauth,static}/, not referenced` +
            (field === "refreshTokenVariable"
              ? `: the refresh token does not exist until a human completes the ` +
                `console consent flow, and render-spec exits 1 on the first ` +
                `unresolvable \${NAME} — so this one reference would fail every ` +
                `server's deploy until the very thing it is waiting for arrives.`
              : `. Delete the reference; the injection already puts it on the ` +
                `container.`),
          path: ["servers"],
        });
      }
    }

    // CONSOLE STORES: the credential may only travel by `consoleEnv:`.
    //
    // This is the rule that keeps a multi-store console from becoming a way to
    // put a store-ADMIN key somewhere an agent can reach. `consoleStores:` names
    // its credential rather than carrying it, and the name it may use is fenced
    // on both sides:
    //
    //   - it MUST be a key of this server's `consoleEnv:`, which appspec.ts
    //     resolves onto the CORE component alone (`consoleEnvVars`). That is the
    //     only scope in strad that reaches core and stops.
    //   - it MUST NOT be a key of ANY server's `env:`, because `env:` is baked
    //     onto a bundle — the component that answers /mcp. A name in both places
    //     is a console admin key on an agent-reachable container, which is the
    //     entire IAM split of the secrets server undone by one line of YAML.
    //
    // Neither is checkable at runtime from inside the console (by then the value
    // is just a string in an environment), so it is checked here, where
    // `scripts/check-config.ts` runs it over every config in the repo.
    const envKeyOwners = new Map<string, string>();
    // The same fence, by REF rather than by name. `consoleEnv:` carries
    // `${SECRETS_ADMIN_KEY_JSON}` and `env:` could carry the same ref under a
    // DIFFERENT key — `GOOGLE_APPLICATION_CREDENTIALS_JSON`, say — which a
    // name-only check waves through while `renderAppSpec` happily bakes the
    // resolved admin key onto that server's bundle. The key name is the
    // variable; the ref is the credential, and it is the credential this rule
    // is about.
    const envRefOwners = new Map<string, string>();
    for (const s of cfg.servers) {
      if (!s.enabled) continue;
      if (s.kind !== "supplementary-image") continue;
      for (const [key, value] of Object.entries(s.env)) {
        if (!envKeyOwners.has(key)) envKeyOwners.set(key, s.slug);
        for (const ref of refsIn(value)) {
          if (!envRefOwners.has(ref)) envRefOwners.set(ref, s.slug);
        }
      }
    }
    for (const s of cfg.servers) {
      if (s.kind !== "supplementary-image") continue;
      if (s.consoleStores.length === 0) continue;

      const seen = new Set<string>();
      const seenAdminKeyVar = new Map<string, string>();
      /** `ns` is normalised for comparison; `written` is what to quote back. */
      const claimed: { ns: string; written: string; project: string }[] = [];
      for (const store of s.consoleStores) {
        // The `?project=` selector addresses a store by its project id. Two
        // entries with the same id is one store the page can never reach, and
        // which of them a write lands in would depend on declaration order.
        if (seen.has(store.project)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" declares the project "${store.project}" twice ` +
              `under consoleStores:. The console selects a store with ` +
              `?project=<id>, so the ids must be unique.`,
            path: ["servers"],
          });
        }
        seen.add(store.project);

        if (!(store.adminKeyVar in s.consoleEnv)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" store "${store.project}" names ` +
              `adminKeyVar: ${store.adminKeyVar}, but that key is not declared ` +
              `under this server's consoleEnv:. A store's admin credential may ` +
              `only arrive by consoleEnv:, which is the one scope rendered onto ` +
              `the core component alone.`,
            path: ["servers"],
          });
        }

        // ONE ADMIN KEY PER STORE, and this is what makes that inexpressible
        // rather than merely discouraged. Two entries naming one adminKeyVar is
        // one service account granted on two projects — a strictly larger blast
        // radius than the two identities it replaces, and the exact
        // simplification `consoleStores:` exists to refuse.
        const twin = seenAdminKeyVar.get(store.adminKeyVar);
        if (twin) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" stores "${twin}" and "${store.project}" both ` +
              `name adminKeyVar: ${store.adminKeyVar}, so one service account ` +
              `would reach both projects. Each store carries its OWN admin ` +
              `credential: give them separate consoleEnv: keys.`,
            path: ["servers"],
          });
        }
        seenAdminKeyVar.set(store.adminKeyVar, store.project);

        const envOwner = envKeyOwners.get(store.adminKeyVar);
        if (envOwner) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" store "${store.project}" names ` +
              `adminKeyVar: ${store.adminKeyVar}, and server "${envOwner}" ` +
              `declares that same key under env:. env: is baked onto a bundle — ` +
              `the component that answers /mcp — so the console's store-admin ` +
              `credential would reach an agent-facing container. Rename one of ` +
              `them.`,
            path: ["servers"],
          });
        }

        // And the same check by REF: a different `env:` KEY carrying the same
        // `${NAME}` puts the identical credential on the identical container.
        for (const ref of refsIn(s.consoleEnv[store.adminKeyVar] ?? "")) {
          const refOwner = envRefOwners.get(ref);
          if (!refOwner) continue;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" store "${store.project}" resolves its admin ` +
              `credential from \${${ref}}, and server "${refOwner}" declares ` +
              `that same reference under env:. env: is baked onto a bundle — ` +
              `the component that answers /mcp — so the console's store-admin ` +
              `credential would reach an agent-facing container under a ` +
              `different variable name. Use a separate credential for one of ` +
              `them.`,
            path: ["servers"],
          });
        }

        // TWO STORES MAY NOT CLAIM ONE PATH — the console's version of the
        // `mcpStores:` rule below, refused here for the same reason and one
        // worse consequence. On `/mcp` an ambiguous path is a path whose
        // CAPABILITY depends on declaration order; on the console it is a
        // WRITE — create, rotate, delete — and the two candidate stores are two
        // different GCP projects holding two different credentials.
        //
        // `storeForPath` (src/http/params.ts) does refuse it at request time,
        // and that refusal is the reason this is not merely cosmetic: without
        // this rule the first symptom of an overlapping config is a console
        // write failing on a path a human just typed, in a deployment that
        // rendered, deployed and looked healthy. `namespacesStrict` does not
        // change it either way — it bounds CREATE within a store and says
        // nothing about which store a path selects.
        //
        // COMPARED AS `storeForPath` COMPARES THEM, i.e. normalised. A raw
        // prefix test on the written strings answers a different question:
        // `/strad/prod` and `/strad/production/` share a string prefix and
        // share no PATH, because the trailing slash is what ends a segment.
        // Refusing that pair would be this rule rejecting a config the console
        // resolves perfectly well — the failure mode a new hard error can least
        // afford. `storeForPath` normalises before it matches; so does this.
        //
        // THE `mcpStores:` VERSION BELOW COMPARES RAW, AND THAT IS CORRECT
        // THERE. Each mirrors its own runtime: the console normalises
        // (src/http/params.ts), and the secrets tree does not
        // (servers/secrets/shared/src/config.ts). The difference is
        // load-bearing — do not unify them.
        //
        // AND IT IS ONLY WITHIN ONE SERVER. `storeForPath` flattens every
        // enabled secrets slug's stores into one candidate list, so the same
        // ambiguity is reachable across two slugs; that half is a WARNING
        // (`crossServerNamespaceOverlap` in src/deploy/appspec.ts), because a
        // cross-slug overlap on a path nobody writes to could be sitting in a
        // config that works today.
        for (const ns of store.namespaces) {
          const here = normaliseNamespace(ns);
          for (const prior of claimed) {
            if (prior.project === store.project) continue;
            if (!here.startsWith(prior.ns) && !prior.ns.startsWith(here)) {
              continue;
            }
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                `server "${s.slug}": namespace "${ns}" ("${store.project}") and ` +
                `"${prior.written}" ("${prior.project}") overlap under consoleStores:, ` +
                `so a parameter path could address either store. The console ` +
                `refuses such a path at write time (storeForPath), so the first ` +
                `symptom would be a console write failing rather than a config ` +
                `error. Narrow one of them.`,
              path: ["servers"],
            });
          }
          claimed.push({ ns: here, written: ns, project: store.project });
        }
      }

      // AND THE SAME CHECK BY REF IS DELIBERATELY *NOT* HERE.
      //
      // Two `consoleEnv:` keys may carry one `${NAME}`, which is one service
      // account on two projects — the very thing the by-name rule above calls
      // "the exact simplification `consoleStores:` exists to refuse". The
      // `mcpStores:` half DOES refuse that by ref (`seenViewerRef` below), and
      // the difference between the two is a decision rather than an oversight:
      //
      //   - a shared VIEWER key collapses the per-store capability probe, so
      //     production's "you may not read a secret value" gets answered by
      //     staging's key. There is no correct form of it.
      //   - a shared ADMIN key costs blast radius, and blast radius is
      //     sometimes an acceptable price. One service account granted on
      //     `strad-secrets-prod` and `strad-secrets-staging` — two projects
      //     inside ONE system — is a shape production deliberately runs, and a
      //     ban here would refuse a config that is deployed today.
      //
      // So the console side REPORTS it instead, on the `onWarning` channel, and
      // lets a reviewer say "yes, both strad projects" or "no, that crosses a
      // system boundary": see `sharedConsoleAdminCredential` in
      // src/deploy/appspec.ts. Do not "fix" the inconsistency by promoting it to
      // an error here.
      //
      // That warning also spans the WHOLE deployment, where the by-name rule
      // above is per server — a bundle carries one secrets slug, so two stores
      // sharing a credential across the strad/Zimmer boundary arrive as two
      // slugs and no per-server rule can see them. And it skips DISABLED
      // servers, where this one does not: a name collision is wrong whether or
      // not the server is switched on today, while the renderer that carries
      // the warning has no disabled server to render.
    }

    // MCP STORES: the credential may only travel by THIS server's `env:`, and no
    // two stores may share one.
    //
    // The `/mcp` twin of the `consoleStores:` block above, and the rules are the
    // same shape for the same reason: none of them is checkable at runtime, by
    // which point the value is just a string in an environment.
    //
    // What is different is what a violation COSTS. A collapsed console
    // credential is one admin identity on two projects. A collapsed MCP
    // credential is that AND a collapsed capability: the secrets tree probes
    // `projects:testIamPermissions` once per store and gates every read, write
    // and delete on the answer for the store the path resolved to, so two stores
    // behind one service account is two stores whose answers cannot differ. The
    // production guarantee — that this server cannot return a production secret
    // value — is exactly that answer being "no" for the production project. It
    // must not be possible to write a config in which staging's "yes" is
    // production's answer too.
    //
    // `SECRETS_STORES` IS DERIVED, AND ONLY DERIVED.
    //
    // `renderAppSpec` composes it from `mcpStores:`, which is what subjects it to
    // every rule below. Written by hand under `env:` it reaches the container
    // unchanged and the tree reads it — skipping the viewerKeyVar-must-be-an-
    // `env:`-key rule, and with it the reason an `adminKeyVar` cannot be borrowed
    // as a viewer key. Refused whether or not the server also declares
    // `mcpStores:`, because "only when the typed field is absent" is a fence with
    // a door in it. (A server that declares both would additionally have the
    // hand-written value silently overwritten by the derived one.)
    //
    // ONE SECRETS MOUNT PER BUNDLE, likewise. A bundle is a container is one
    // `process.env`, the bundle host calls the secrets tree's `loadConfig()`
    // against the bare environment, and the renderer's bare-name pass is
    // first-wins — so two servers on one bundle both declaring `mcpStores:` and
    // sitting on DIFFERENT paths would put one of them's store list on the
    // container under both slugs, with nothing reporting it. Two slugs on ONE
    // path already throw at render time; this closes the other half.
    //
    // A DISABLED server is skipped for the BUNDLE claim alone, and checked for
    // everything else. It renders no component, so it collides with nothing —
    // but a typo'd `viewerKeyVar` or a shared credential inside its own entry is
    // wrong whether or not it is switched on today, and a rule that goes quiet
    // when a server is disabled is a rule that lies dormant until somebody
    // re-enables it.
    const storesByBundle = new Map<string, string>();
    for (const s of cfg.servers) {
      if (s.kind !== "supplementary-image") continue;

      if ("SECRETS_STORES" in s.env) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `server "${s.slug}" declares SECRETS_STORES under env:. That variable ` +
            `is DERIVED from mcpStores: by renderAppSpec, and writing it by hand ` +
            `bypasses every rule this config gate applies to a store — the ` +
            `viewerKeyVar must-be-an-env:-key check, and with it the only thing ` +
            `keeping a console admin key out of the /mcp container. Declare ` +
            `mcpStores: instead.`,
          path: ["servers"],
        });
      }

      if (s.mcpStores.length === 0) continue;

      const twinOnBundle = s.enabled ? storesByBundle.get(s.bundle) : undefined;
      if (twinOnBundle) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `servers "${twinOnBundle}" and "${s.slug}" both declare mcpStores: on ` +
            `bundle "${s.bundle}". A bundle is one container is one process.env, ` +
            `and the secrets tree reads SECRETS_STORES out of it by the BARE name ` +
            `— so one of these two store lists would answer under both slugs. ` +
            `Give one of them its own bundle, or fold its stores into the other's ` +
            `mcpStores: list.`,
          path: ["servers"],
        });
      }
      if (s.enabled) storesByBundle.set(s.bundle, s.slug);

      // ONE SHAPE OR THE OTHER, never both. The tree reads `SECRETS_STORES` and
      // ignores the single-store variables when it is present, so a leftover
      // `SECRETS_PROJECT_ID` under `env:` is a project a reader would reasonably
      // believe this server fronts and which it does not. MOVED rather than
      // deleted, though: the console resolves its single-store fallback from
      // this name in `env:` and `consoleEnv:` alike (src/ui/resolve.ts), so
      // "delete it" would take the console page with it.
      for (const legacy of ["SECRETS_PROJECT_ID", "SECRETS_NAMESPACES"]) {
        if (!(legacy in s.env)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `server "${s.slug}" declares mcpStores: AND ${legacy} under env:. ` +
            `mcpStores: REPLACES the single-store reading — the container would ` +
            `ignore ${legacy} entirely, so leaving it names a store this server ` +
            `does not front. MOVE it to consoleEnv:, or declare consoleStores: — ` +
            `the console reads this name out of env: and consoleEnv: alike, so ` +
            `deleting it outright takes the console page with it.`,
          path: ["servers"],
        });
      }

      const seenProject = new Set<string>();
      const seenViewerKeyVar = new Map<string, string>();
      /** `${NAME}` -> the project already reading its credential from it. */
      const seenViewerRef = new Map<string, string>();
      const claimed: { ns: string; project: string }[] = [];
      for (const store of s.mcpStores) {
        if (seenProject.has(store.project)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" declares the project "${store.project}" twice ` +
              `under mcpStores:. A store is addressed by its project id — in a ` +
              `refusal, in the capability report — so the ids must be unique.`,
            path: ["servers"],
          });
        }
        seenProject.add(store.project);

        if (!(store.viewerKeyVar in s.env)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" store "${store.project}" names ` +
              `viewerKeyVar: ${store.viewerKeyVar}, but that key is not declared ` +
              `under this server's env:. env: is the scope rendered onto this ` +
              `server's bundle — the component that answers /mcp — and it is the ` +
              `only way a credential reaches that container.`,
            path: ["servers"],
          });
        }

        // ONE VIEWER KEY PER STORE. See the block comment above: sharing one
        // makes two stores' capabilities identical by construction, which is
        // the collapse the per-project probe exists to prevent.
        const twin = seenViewerKeyVar.get(store.viewerKeyVar);
        if (twin) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" stores "${twin}" and "${store.project}" both ` +
              `name viewerKeyVar: ${store.viewerKeyVar}, so one service account ` +
              `would reach both projects — and both stores would probe the same ` +
              `capability. Each store carries its OWN viewer credential: give ` +
              `them separate env: keys.`,
            path: ["servers"],
          });
        }
        seenViewerKeyVar.set(store.viewerKeyVar, store.project);

        // AND THE SAME CHECK BY REF, which is the one that matters. The key name
        // is the variable; the `${NAME}` behind it is the CREDENTIAL, and two
        // `env:` keys may carry one ref — `SECRETS_SERVICE_ACCOUNT_KEY_JSON` and
        // `PROD_VIEWER_KEY_JSON` both `${ONE_KEY}`. A name-only check waves that
        // through, and it is precisely the collapse: one identity, two projects,
        // two probes that ask Google about the SAME service account. The
        // per-store gate then works perfectly and reports staging's answer for
        // production, because it genuinely is production's answer for that key.
        // `consoleStores:` above learned this the same way; see `envRefOwners`.
        for (const ref of refsIn(s.env[store.viewerKeyVar] ?? "")) {
          const twinByRef = seenViewerRef.get(ref);
          if (twinByRef) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                `server "${s.slug}" stores "${twinByRef}" and "${store.project}" ` +
                `both resolve their viewer credential from \${${ref}}, under ` +
                `different env: keys, so one service account would reach both ` +
                `projects and both stores would probe the SAME capability. Each ` +
                `store carries its own viewer credential: use a separate one.`,
              path: ["servers"],
            });
          }
          seenViewerRef.set(ref, store.project);
        }

        // TWO STORES MAY NOT CLAIM ONE PATH. The namespace is what binds a call
        // to a project, a credential and a capability; a path both could claim
        // is a path whose capability depends on declaration order.
        for (const ns of store.namespaces) {
          for (const prior of claimed) {
            if (prior.project === store.project) continue;
            if (!ns.startsWith(prior.ns) && !prior.ns.startsWith(ns)) continue;
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                `server "${s.slug}": namespace "${ns}" ("${store.project}") and ` +
                `"${prior.ns}" ("${prior.project}") overlap under mcpStores:, so a ` +
                `parameter path could address either store. The path is what ` +
                `selects the project, the credential and the capability; it must ` +
                `select exactly one.`,
              path: ["servers"],
            });
          }
          claimed.push({ ns, project: store.project });
        }
      }
    }

    // ENV COLLISIONS.
    //
    // A component's environment is ONE flat namespace, and both merges that
    // build it are last-wins:
    //
    //   `env:`        -> per BUNDLE  (appspec.ts: `{...prev.env, ...server.env}`)
    //   `consoleEnv:` -> onto CORE   (appspec.ts: `Object.assign(merged, ...)`)
    //
    // THE SCOPES ARE NOT THE SAME, and the asymmetry is the whole rule. A bundle
    // is a component is a container is one `process.env`, so `env:` may safely
    // use BARE names — `SECRETS_PROJECT_ID` on two bundles is two containers
    // reading their own. `consoleEnv:` has no such fence: every enabled server's
    // map merges into the single `core` component, so a name there must be
    // SLUG-NAMESPACED or the last declaration wins and the other server's console
    // silently runs as the wrong identity.
    //
    // That is not hypothetical in either direction. Two secrets slugs in one
    // bundle renders `/ui/secrets` showing strad's project while holding the
    // OTHER store's admin service account, and hands the `/mcp` container the
    // wrong store under strad's slug — and before this check, both shapes parsed
    // and rendered with zero validation errors. `remote-filesystem-tmp-public`
    // had to be moved off the bare `GCS_BUCKET` name for the same reason, by
    // hand, in the bundle host, after the fact.
    //
    // Same key with the SAME value is legal and stays legal: that is the
    // capability-variant pattern. `gmail-ro` and `gmail-rw` repeat their whole
    // `env:` on purpose, because putting the credential on only one of them means
    // disabling THAT one strips it from its sibling.
    const flagCollisions = (
      entries: { slug: string; key: string; value: string }[],
      field: "env" | "consoleEnv",
      why: string,
    ): void => {
      const claimed = new Map<string, { slug: string; value: string }>();
      for (const { slug, key, value } of entries) {
        const first = claimed.get(key);
        if (!first) {
          claimed.set(key, { slug, value });
          continue;
        }
        if (first.value === value) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `servers "${first.slug}" and "${slug}" both declare ${key} under ` +
            `${field}: with different values, and ${why}. One silently ` +
            `overwrites the other. Give one of them a slug-namespaced name ` +
            `(e.g. ${slug.toUpperCase().replace(/-/g, "_")}_${key}).`,
          path: ["servers"],
        });
      }
    };

    const consoleEntries: { slug: string; key: string; value: string }[] = [];
    const envByBundle = new Map<
      string,
      { slug: string; key: string; value: string }[]
    >();
    for (const s of cfg.servers) {
      // A server strad does not mount collides with nothing: its env reaches no
      // component, and render-spec skips it too.
      if (!s.enabled) continue;
      if (s.kind !== "supplementary-image") continue;
      for (const [key, value] of Object.entries(s.consoleEnv)) {
        consoleEntries.push({ slug: s.slug, key, value });
      }
      const list = envByBundle.get(s.bundle) ?? [];
      for (const [key, value] of Object.entries(s.env)) {
        list.push({ slug: s.slug, key, value });
      }
      envByBundle.set(s.bundle, list);
    }
    flagCollisions(
      consoleEntries,
      "consoleEnv",
      "consoleEnv: is merged into the core component's one environment " +
        "whatever bundle each server is on",
    );
    for (const [bundle, entries] of envByBundle) {
      flagCollisions(
        entries,
        "env",
        `they share the "${bundle}" bundle — one bundle is one container with ` +
          `one environment, which is the union of its servers' env: maps`,
      );
    }

    // Bundle occupancy rules.
    const byBundle = new Map<string, typeof cfg.servers>();
    for (const s of cfg.servers) {
      // A server strad runs no container for occupies no bundle. Skipping it is
      // not cosmetic: it has no `bundle` field at all, so counting it would key
      // the map on `undefined` and invent a phantom component.
      if (isUnhosted(s)) continue;
      const list = byBundle.get(s.bundle) ?? [];
      list.push(s);
      byBundle.set(s.bundle, list);
    }
    for (const [bundle, servers] of byBundle) {
      const images = servers.filter((s) => s.kind === "supplementary-image");

      // One component runs ONE image. Several supplementary-image servers may
      // still share a bundle — but only when they are the SAME image serving
      // different paths (a bundle-google container hosting gmail, calendar and
      // docs on /gmail, /google-calendar, /google-docs). Distinct images cannot
      // colocate.
      const distinctImages = new Set(images.map((s) => s.image));
      if (distinctImages.size > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `bundle "${bundle}" has ${distinctImages.size} distinct images; one component runs one image`,
          path: ["bundles"],
        });
      }

      // NOTE: servers sharing a bundle MAY share a `path`. Two slugs on one path
      // is exactly a capability pair — `gmail-ro` and `gmail-rw` proxying to the
      // same upstream, told apart by their `tools:` policy, not by their route.
      // Requiring distinct paths here is what used to force a component per
      // capability tier.

      // A supplementary-image bundle holds ONLY supplementary images (all the
      // same one). A builtin mixed in would run a DIFFERENT image — the strad
      // image in bundle mode — which is "one component, one image" again.
      if (images.length >= 1 && servers.length > images.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `bundle "${bundle}" mixes a supplementary image with other servers; give the image its own bundle`,
          path: ["bundles"],
        });
      }
      if (bundle === "core" && images.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `supplementary image cannot live in the "core" bundle`,
          path: ["bundles"],
        });
      }
      if (bundle !== "core" && !cfg.bundles.some((b) => b.name === bundle)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `bundle "${bundle}" is used by a server but not declared under bundles:`,
          path: ["bundles"],
        });
      }
    }
  });

export type StradConfig = z.infer<typeof StradConfig>;
export type ServerConfig = z.infer<typeof ServerConfig>;
/**
 * The discriminant of the server union, derived from the schema that defines
 * it. Anything that needs to name the kinds derives from this rather than
 * writing the union out again, so a kind added to the schema is added once.
 */
export type ServerKind = ServerConfig["kind"];
export type RemoteHttpServer = z.infer<typeof RemoteHttpServer>;
export type OAuthRefresh = z.infer<typeof OAuthRefreshSchema>;
export type LocalTunnelServer = z.infer<typeof LocalTunnelServer>;
export type SupplementaryImageServer = z.infer<typeof SupplementaryImageServer>;
export type BuiltinServer = z.infer<typeof BuiltinServer>;
export type BundleConfig = z.infer<typeof BundleConfig>;
