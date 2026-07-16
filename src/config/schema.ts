import { z } from "zod";

/**
 * The strad configuration interface.
 *
 * This file is the contract between the OSS core and whoever is deploying it.
 * Attaching an MCP server to a strad deployment is ONE entry in `servers`.
 *
 * The core ships with ZERO servers. Everything below is opt-in.
 */

const SLUG = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    "slug must be lowercase alphanumeric with dashes",
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
// Servers — the three kinds
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
  SupplementaryImageServer,
  BuiltinServer,
]);

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
 * its 26 slugs. The same fleet is 25 slugs in ONE bundle today.)
 *
 * Sizing: a bundle that hosts a browser server runs a real Chromium (~1.06s per
 * launch, ~545MB peak RSS) and CPU — not RAM — is what binds it, because 1 vCPU
 * serialises page rendering. Co-locating everything in one bundle means that box
 * also runs `op` and 14 upstream servers (which the config names as 23 slugs), so
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
       * Where token records live. `env` reads a JSON array from STRAD_TOKENS.
       * A real datastore is the obvious next step — see HACKS.md.
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
      })
      .default({ name: "strad", env: "dev" }),

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

    // Bundle occupancy rules.
    const byBundle = new Map<string, typeof cfg.servers>();
    for (const s of cfg.servers) {
      if (s.kind === "remote-http") continue;
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
export type SupplementaryImageServer = z.infer<typeof SupplementaryImageServer>;
export type BuiltinServer = z.infer<typeof BuiltinServer>;
export type BundleConfig = z.infer<typeof BundleConfig>;
