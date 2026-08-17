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
export const UNHOSTED_KINDS = ["remote-http", "local-tunnel"] as const;

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
 * its 26 slugs. The staging fleet is 27 slugs in ONE bundle; the two other
 * non-core slugs are the `echo` builtin and the `deepwiki` remote-http, which
 * need no container of their own. A 28th supplementary slug, `zimmer-secrets`,
 * has its own bundle — for a reason capability cannot cause: it fronts a second
 * parameter store, and a store is `process.env`.)
 *
 * Sizing: a bundle that hosts a browser server runs a real Chromium (~1.06s per
 * launch, ~545MB peak RSS) and CPU — not RAM — is what binds it, because 1 vCPU
 * serialises page rendering. Co-locating everything in one bundle means that box
 * also runs `op` and 17 other upstream servers (which the config names as 27 slugs), so
 * size it up, not down.
 */
const BundleConfig = z.object({
  name: SLUG,
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
  })
  .default({
    provider: "env",
    ttlSeconds: 60,
    negativeTtlSeconds: 10,
    envFallback: true,
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

    // PARAMS-WRITABLE.
    //
    // The allowlist is the fence around a route that WRITES to the parameter
    // store, so what it may contain is checked here rather than at the route:
    // core builds the store path out of these strings and the server's slug, and
    // a name that is not a legal variable would compose a path pointing
    // somewhere else entirely. `validateVariableName` is the same rule the
    // console applies when a human creates a parameter, restated as a regex so
    // this file stays dependency-free.
    //
    // `params: true` is REQUIRED, and not merely for tidiness. That flag is what
    // injects `/strad/{env}/mcp/{slug}/static/` onto this component in the first
    // place; without it the server would be writing a namespace it does not
    // read, which is a credential going nowhere — the silent no-op
    // src/deploy/server-namespaces.ts exists to stop shipping.
    for (const s of cfg.servers) {
      if (s.kind !== "supplementary-image") continue;
      if (s.paramsWritable.length === 0) continue;
      if (!s.params) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `server "${s.slug}" sets paramsWritable: but not params: true. ` +
            `paramsWritable names variables in this server's own ` +
            `/strad/{env}/mcp/${s.slug}/static/ namespace, and params: true is ` +
            `what makes that namespace this server's environment. Without it ` +
            `the server would write values nothing injects.`,
          path: ["servers"],
        });
      }
      const seenVars = new Map<string, string>();
      for (const variable of s.paramsWritable) {
        // The same two rules `validateVariableName` applies when a human creates
        // a parameter in the console, restated as code so this file stays
        // dependency-free. The length cap is Parameter Manager's, and a name past
        // it is a write that cannot land.
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) ||
          variable.length > 200
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `server "${s.slug}" lists "${variable}" under paramsWritable:, ` +
              `which is not a legal environment variable name (letters, digits ` +
              `and underscores; not starting with a digit; at most 200 ` +
              `characters). A paramsWritable entry is a VARIABLE, not a path — ` +
              `it addresses /strad/{env}/mcp/${s.slug}/static/{VARIABLE} and ` +
              `nothing else.`,
            path: ["servers"],
          });
        }
        // DUPLICATES ARE COMPARED CASE-INSENSITIVELY, because `parameterId`
        // folds case before it hashes: `X_TOKEN` and `x_token` name ONE resource
        // in the store but two different environment variables in the container.
        // Listing both is a config where one name works and its twin 404s
        // forever, which is the least diagnosable outcome available here.
        const fold = variable.toLowerCase();
        const first = seenVars.get(fold);
        if (first !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              first === variable
                ? `server "${s.slug}" lists "${variable}" twice under paramsWritable:`
                : `server "${s.slug}" lists both "${first}" and "${variable}" ` +
                  `under paramsWritable:. A parameter path folds case, so those ` +
                  `are ONE parameter under two variable names — one of them ` +
                  `would resolve and the other would never be found.`,
            path: ["servers"],
          });
        }
        seenVars.set(fold, variable);
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
export type RemoteHttpServer = z.infer<typeof RemoteHttpServer>;
export type LocalTunnelServer = z.infer<typeof LocalTunnelServer>;
export type SupplementaryImageServer = z.infer<typeof SupplementaryImageServer>;
export type BuiltinServer = z.infer<typeof BuiltinServer>;
export type BundleConfig = z.infer<typeof BundleConfig>;
