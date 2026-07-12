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
  /** Deployment group. A supplementary image always owns its bundle. */
  bundle: SLUG,
  /** Path the image serves MCP on, inside the container. */
  path: z.string().startsWith("/").default("/mcp"),
  /** Env passed to the component. Values may be `${SECRET_REF}`. */
  env: z.record(SecretRef).default({}),
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
 *   - a bundle holding a `supplementary-image` server holds ONLY that server
 *   - `builtin` servers may share a bundle freely (that's the $0-marginal win)
 *   - browser/Chromium servers want their own bundle: 1 vCPU serialises
 *     rendering, and peak RSS is ~545MB, so budget 1GB.
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
      if (images.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `bundle "${bundle}" has ${images.length} supplementary images; one component runs one image`,
          path: ["bundles"],
        });
      }
      if (images.length === 1 && servers.length > 1) {
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
