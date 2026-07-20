import express, { type Express } from "express";
import { authenticateConsoleBypass, devBypassStatus } from "../auth/dev.ts";
import { googleProviderFromEnv, AuthError } from "../auth/google.ts";
import type { TokenStore } from "../auth/tokens.ts";
import type { StradConfig } from "../config/schema.ts";
import { createMcpHandler } from "../gateway/router.ts";
import type { Mode, Registry } from "../gateway/registry.ts";
import type { SecretBag } from "../secrets/index.ts";
import { mountConsoleUi } from "../ui/index.ts";
import { renderLanding } from "../ui/landing.ts";
import type { GcsLister } from "../ui/gcs-client.ts";

export interface AppOptions {
  config: StradConfig;
  registry: Registry;
  tokenStore: TokenStore;
  mode: Mode;
  env?: NodeJS.ProcessEnv;
  /**
   * The injected secret bag, used by the human console UI to resolve a server's
   * `${SECRET}` config refs (bucket, credentials) exactly as the registry does.
   * Optional so existing test call sites need not supply it.
   */
  secrets?: SecretBag;
  /** Test seam: substitute the GCS listing surface behind the console UI. */
  gcsList?: GcsLister;
}

export function createApp(opts: AppOptions): Express {
  const env = opts.env ?? process.env;
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "4mb" }));

  // --- health -------------------------------------------------------------
  // App Platform polls this. Keep it dependency-free: if it checked upstream
  // MCP servers, a flaky third party would make our component look unhealthy
  // and get it restarted, which helps nobody.
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      mode: opts.mode,
      bundle: env.STRAD_BUNDLE ?? "core",
      env: opts.config.gateway.env,
      servers: opts.registry.slugs,
    });
  });

  // --- the endpoint -------------------------------------------------------
  app.all(
    "/mcp",
    createMcpHandler({
      config: opts.config,
      registry: opts.registry,
      tokenStore: opts.tokenStore,
      mode: opts.mode,
      env,
    }),
  );

  if (opts.mode === "core") {
    // The front door. PUBLIC by design and by precedent: it lists the same
    // slugs /healthz already returns to anyone, and links only to surfaces that
    // enforce their own gate. See src/ui/landing.ts for what it withholds.
    // Core only — a bundle component is internal and has no front door.
    app.get("/", (_req, res) => {
      res
        .type("html")
        .send(renderLanding({ config: opts.config, consoleMounted: true }));
    });

    mountConsole(app, opts, env);
    // The human, SSO-gated resource browser. Same gate as /console; not /mcp.
    mountConsoleUi(app, {
      config: opts.config,
      secrets: opts.secrets ?? {},
      env,
      gcsList: opts.gcsList,
    });
  }

  return app;
}

/**
 * The human path.
 *
 * Google OAuth when credentials exist; otherwise the bootstrap-token bypass.
 * Either way it is authenticated — strad is on the open internet and there is
 * no network perimeter behind it, so an unauthenticated console is not an
 * option even in "dev mode".
 */
function mountConsole(app: Express, opts: AppOptions, env: NodeJS.ProcessEnv) {
  const cfg = opts.config;
  const publicUrl = cfg.gateway.publicUrl ?? "";
  const redirectUri = `${publicUrl.replace(/\/$/, "")}/console/oauth/callback`;

  const google = cfg.auth.google?.enabled
    ? googleProviderFromEnv(cfg.auth.google.hostedDomain, redirectUri, env)
    : null;

  // state -> codeVerifier. In-memory, so it does not survive a restart or span
  // replicas. Fine for a single-instance console; a real session store is the
  // upgrade (see HACKS.md).
  const pending = new Map<string, string>();

  app.get("/console", (req, res) => {
    const bypass = authenticateConsoleBypass(
      consoleToken(req.query.token, req.headers.authorization),
      cfg,
      env,
    );

    if (bypass) {
      res.json({
        signedInAs: bypass.label,
        via: "dev-bypass",
        warning:
          "Authenticated via ADMIN_BOOTSTRAP_TOKEN, not Google OAuth. " +
          "This path disappears once GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are set.",
        roles: bypass.roles,
        servers: cfg.servers.map((s) => ({
          slug: s.slug,
          kind: s.kind,
          enabled: s.enabled,
        })),
      });
      return;
    }

    if (google) {
      const { state, codeVerifier, url } = google.beginAuth();
      pending.set(state, codeVerifier);
      res.redirect(url);
      return;
    }

    const status = devBypassStatus(cfg, env);
    res.status(401).json({
      error: "console_unavailable",
      message:
        "Google OAuth is not configured and the dev bypass is not usable.",
      devBypass: status.reason,
    });
  });

  app.get("/console/oauth/callback", async (req, res) => {
    if (!google) {
      res.status(404).json({ error: "google_oauth_not_configured" });
      return;
    }

    const state = String(req.query.state ?? "");
    const code = String(req.query.code ?? "");
    const verifier = pending.get(state);

    // A callback whose state we never issued is either a stale tab or CSRF.
    // Either way it is not a login.
    if (!verifier) {
      res.status(400).json({ error: "unknown_state" });
      return;
    }
    pending.delete(state);

    try {
      const identity = await google.completeAuth(code, verifier);
      res.json({
        signedInAs: identity.email,
        via: "google",
        hd: identity.hd,
        roles: cfg.auth.google?.roles ?? [],
      });
    } catch (err) {
      const message = err instanceof AuthError ? err.message : "sign-in failed";
      res.status(403).json({ error: "forbidden", message });
    }
  });
}

/** Console credential: `?token=` for a browser, or a bearer header for curl. */
function consoleToken(
  queryToken: unknown,
  header: string | undefined,
): string | undefined {
  if (typeof queryToken === "string" && queryToken) return queryToken;
  const bearer = header?.replace(/^Bearer\s+/i, "").trim();
  return bearer || undefined;
}
