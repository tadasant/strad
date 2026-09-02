import { z } from "zod";

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
const SLUG = z
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
const Role = z
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
const ToolPolicySchema = z
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
 * kind: the ONE OAuth provider strad can drive a consent flow for.
 *
 * A literal rather than an enum with one member: a second provider is a second
 * implementation (a different token endpoint, a different identity proof, a
 * different notion of "scope"), and a config that could NAME one strad has no
 * code for would be a promise nothing keeps.
 */
const OAuthProvider = z.literal("google");

/**
 * The names of the three variables one Google connector owns, all defaulted to
 * the Google Sheets set (the first — and so far only — server that consumes them).
 *
 * They are VARIABLE NAMES, never paths. Core composes
 * `/strad/{env}/mcp/{slug}/static/{VARIABLE}` from the slug and these strings and
 * from nothing else, so there is no spelling of one that addresses another
 * server's namespace, another kind, or another deployment. That is the same fence
 * `paramsWritable:` stands behind, and it is why the console's callback can take
 * a slug from sealed state and still never let a browser choose a target.
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
const OAuthConnector = z.object({
  provider: OAuthProvider,
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
  /** The variable holding the OAuth client id, in THIS slug's own namespace. */
  clientIdVariable: z.string().min(1).default(OAUTH_DEFAULTS.clientIdVariable),
  /** The variable holding the OAuth client secret, in THIS slug's own namespace. */
  clientSecretVariable: z
    .string()
    .min(1)
    .default(OAUTH_DEFAULTS.clientSecretVariable),
  /** The variable the consent flow WRITES. Created on connect, rotated on reconnect. */
  refreshTokenVariable: z
    .string()
    .min(1)
    .default(OAUTH_DEFAULTS.refreshTokenVariable),
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
 */
const RemoteHttpServer = ServerBase.extend({
  kind: z.literal("remote-http"),
  url: z.string().url(),
  headers: HeaderMap,
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
 *     url: https://anki.example.trycloudflare.com/mcp
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
 * also runs `op` and 18 other upstream servers (which the config names as 28 slugs), so
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
 *   /mcp      — machines. Static system tokens ONLY. Never unauthenticated,
 *               never dev-bypassable. This is enforced in code, not config.
 *   /console  — humans. Google OAuth (Workspace `hd` claim), with a dev bypass
 *               that itself still requires ADMIN_BOOTSTRAP_TOKEN.
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
       * Where token records live. Reserved, and read by no code path:
       * `tokenStoreFromConfig` (src/auth/index.ts) branches on `enabled` alone
       * and always builds an `EnvTokenStore`, which reads a JSON array from
       * STRAD_TOKENS.
       *
       * It is declared so that a DB-backed `TokenStore` lands as a second enum
       * value rather than as a new key in the config contract, and it is a
       * single-value enum so no config can claim a store strad does not have.
       * See HACKS.md #6 and issue #10.
       */
      store: z.enum(["env"]).default("env"),
    })
    .default({ enabled: true, store: "env" }),

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
 */
const SecretsConfig = z
  .object({
    provider: z.enum(["env", "gcp-parameter-store"]).default("env"),
    /**
     * Snapshot freshness. Bounds how long a ROTATION can go unnoticed.
     *
     * The console's and `/api/secrets/readiness`'s store DIAGNOSIS is held for
     * the same number — capped at 60s, because that answer is a health signal
     * and this knob accepts an hour. See src/secrets/store-diagnostics.ts.
     */
    ttlSeconds: z.number().int().positive().max(3600).default(60),
    /**
     * Minimum interval between refreshes triggered by a MISS. Bounds how long a
     * newly ADDED secret can go unnoticed, and stops an unknown `${REF}` on a hot
     * path from listing the store once per request.
     */
    negativeTtlSeconds: z.number().int().positive().max(3600).default(10),
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
    ttlSeconds: 60,
    negativeTtlSeconds: 10,
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
    // checked here rather than at the route. `validateVariableName` is the same
    // rule the console applies when a human creates a parameter, restated as a
    // regex so this file stays dependency-free.
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
          // creates a parameter in the console, restated as code so this file
          // stays dependency-free. The length cap is Parameter Manager's, and a
          // name past it addresses a parameter that cannot exist.
          if (
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) ||
            variable.length > 200
          ) {
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

      const named: { field: string; variable: string }[] = [
        { field: "clientIdVariable", variable: oauth.clientIdVariable },
        { field: "clientSecretVariable", variable: oauth.clientSecretVariable },
        { field: "refreshTokenVariable", variable: oauth.refreshTokenVariable },
      ];

      for (const { field, variable } of named) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) ||
          variable.length > 200
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" sets oauth.${field} to "${variable}", which ` +
              `is not a legal environment variable name (letters, digits and ` +
              `underscores; not starting with a digit; at most 200 ` +
              `characters). It addresses /strad/{env}/mcp/${s.slug}/static/` +
              `{VARIABLE} and nothing else.`,
            path: ["servers"],
          });
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

      // strad requests `openid` and `email` itself; see OAuthConnector.scopes.
      // Listing one here is not wrong so much as a claim about capability that
      // the identity scopes do not make, and the deploy gate is where a config
      // gets told.
      const IDENTITY = new Set(["openid", "email", "profile"]);
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
        for (const m of raw.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
          if (m[1]) referenced.add(m[1]);
        }
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
        scan(s.url);
        for (const value of Object.values(s.headers)) scan(value);
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
            `INJECTED from /strad/{env}/mcp/${s.slug}/static/, not referenced` +
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
export type LocalTunnelServer = z.infer<typeof LocalTunnelServer>;
export type SupplementaryImageServer = z.infer<typeof SupplementaryImageServer>;
export type BuiltinServer = z.infer<typeof BuiltinServer>;
export type BundleConfig = z.infer<typeof BundleConfig>;
