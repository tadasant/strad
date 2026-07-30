import express, { type Express } from "express";
import { authenticateConsoleBypass, devBypassStatus } from "../auth/dev.ts";
import {
  googleProviderFromEnv,
  AuthError,
  type GoogleIdentity,
  type PendingAuth,
} from "../auth/google.ts";
import {
  clearOauthTxCookie,
  clearSessionCookie,
  consoleSessionsFromEnv,
  issueOauthTxCookie,
  issueSessionCookie,
  OAUTH_TX_COOKIE,
  sanitizeNext,
  sessionKeyProblem,
  stateMatches,
  unsealCookie,
  type ConsoleSessions,
  type OauthTxPayload,
} from "../auth/session.ts";
import type { TokenStore } from "../auth/tokens.ts";
import { BYPASS_COOKIE, googlePrincipal } from "../ui/console-auth.ts";
import type { StradConfig } from "../config/schema.ts";
import { createMcpHandler } from "../gateway/router.ts";
import type { Mode, Registry } from "../gateway/registry.ts";
import type { SecretBag } from "../secrets/index.ts";
import { mountConsoleUi } from "../ui/index.ts";
import type { GcsLister } from "../ui/gcs-client.ts";
import type { ConsoleUiOptions } from "../ui/index.ts";

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
  /**
   * The runtime secret provider, for the Secrets Console at `/secrets`.
   *
   * Optional, and the fallback is not a degradation under the default `env`
   * provider — the bag IS process.env there. It matters for a store-backed
   * deployment, where a referenced name lives in the parameter store and appears
   * in no bag, so presence can only be established by asking the provider.
   */
  secretProvider?: ConsoleUiOptions["secretProvider"];
  /** Test seam: substitute the GCS listing surface behind the console UI. */
  gcsList?: GcsLister;
  /** Test seam: substitute the parameter store behind the console UI. */
  parametersStore?: ConsoleUiOptions["parametersStore"];
  /** Test seam: override the console's capability probe. See ConsoleUiOptions. */
  capabilities?: ConsoleUiOptions["capabilities"];
  /**
   * Test seam: substitute the Google OAuth provider. A real round-trip needs
   * accounts.google.com, so the callback→session→gate path is exercised with a
   * stub that returns an already-verified identity.
   */
  googleProvider?: ConsoleOAuthProvider | null;
}

/** The slice of GoogleOAuthProvider the console actually drives. */
export interface ConsoleOAuthProvider {
  beginAuth(): PendingAuth;
  completeAuth(code: string, codeVerifier: string): Promise<GoogleIdentity>;
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
    // Resolved ONCE and shared: /console begins the login and mints the session,
    // /ui verifies it. Two independent readings of "is Google usable?" is how
    // you get a gate that redirects into a flow that cannot complete.
    const auth = resolveConsoleAuth(opts, env);
    mountConsole(app, opts, env, auth);
    // The human, SSO-gated surfaces: the landing page at "/" and the resource
    // browser at /ui. Same gate as /console; not /mcp.
    mountConsoleUi(app, {
      config: opts.config,
      secrets: opts.secrets ?? {},
      secretProvider: opts.secretProvider,
      env,
      gcsList: opts.gcsList,
      parametersStore: opts.parametersStore,
      capabilities: opts.capabilities,
      sessions: auth.sessions,
      googleReady: auth.ready,
    });
  }

  return app;
}

export interface ConsoleAuth {
  google: ConsoleOAuthProvider | null;
  sessions: ConsoleSessions | null;
  /** Google sign-in can complete end to end: provider AND session key exist. */
  ready: boolean;
  redirectUri: string;
}

/**
 * Decide, once, what the human door is.
 *
 * `ready` is deliberately narrower than `auth.google.enabled`. If the flag alone
 * flipped the gate, enabling it without seeding the OAuth client would make the
 * console STRICTLY less reachable: the honest 401 becomes a redirect into a flow
 * that cannot complete, and a console reachable by nobody has nothing to point
 * at. Both halves must be present, and a half-configured deployment says so at
 * boot rather than at 3am.
 */
export function resolveConsoleAuth(
  opts: AppOptions,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void = console.warn,
): ConsoleAuth {
  const cfg = opts.config;
  const publicUrl = cfg.gateway.publicUrl ?? "";
  const redirectUri = `${publicUrl.replace(/\/$/, "")}/console/oauth/callback`;
  const enabled = cfg.auth.google?.enabled === true;

  const google =
    opts.googleProvider !== undefined
      ? opts.googleProvider
      : enabled && cfg.auth.google
        ? googleProviderFromEnv(cfg.auth.google.hostedDomain, redirectUri, env)
        : null;

  const sessions = consoleSessionsFromEnv(env);
  // Without publicUrl the redirect URI is the relative string
  // "/console/oauth/callback", which Google rejects with invalid_request. That
  // is a dead end with no fallback, so it fails the readiness check like any
  // other missing half.
  const ready =
    enabled && google !== null && sessions !== null && publicUrl !== "";

  if (ready) {
    // The one detail that cannot be verified from inside the process: whether
    // the OAuth client registered in Google's console names THIS URI. A
    // mismatch is a redirect_uri_mismatch at sign-in, so print the exact string
    // to compare against.
    log(
      `[strad] Google console sign-in is live. The OAuth client's authorized ` +
        `redirect URI must be exactly: ${redirectUri}`,
    );
  }

  if (enabled && !ready) {
    // Both env vars are optional in scripts/render-spec.ts, so a typo'd secret
    // name is otherwise a SILENT no-op: the provider comes back null and the
    // console quietly has no front door.
    const why =
      google === null
        ? "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not both set"
        : (sessionKeyProblem(env) ??
          (publicUrl === ""
            ? "gateway.publicUrl is unset, so there is no redirect URI to send Google"
            : "unknown"));
    log(
      `[strad] auth.google.enabled is true but Google sign-in cannot complete: ${why}. ` +
        "The console falls back to the dev bypass.",
    );
  }

  return { google, sessions, ready, redirectUri };
}

/**
 * The human path.
 *
 * Google OAuth when credentials exist; otherwise the bootstrap-token bypass.
 * Either way it is authenticated — strad is on the open internet and there is
 * no network perimeter behind it, so an unauthenticated console is not an
 * option even in "dev mode".
 *
 * Routes:
 *   GET /console                — status JSON, or the start of a Google login
 *   GET /console/login          — start a Google login, with `?next=`
 *   GET /console/oauth/callback — finish it: verify, mint the session, redirect
 *   GET /console/logout         — drop the session
 */
function mountConsole(
  app: Express,
  opts: AppOptions,
  env: NodeJS.ProcessEnv,
  auth: ConsoleAuth,
) {
  const cfg = opts.config;
  const { google, sessions } = auth;

  /**
   * Begin a login.
   *
   * The PKCE verifier, the CSRF `state` and the return path all travel in ONE
   * signed, short-lived, HttpOnly cookie rather than a server-side map. That is
   * what makes the console horizontally scalable: any replica can finish a login
   * any other replica began, and a redeploy mid-login is not a failed login.
   */
  function beginLogin(res: express.Response, next: string): void {
    if (!google || !sessions) {
      res.status(404).json({ error: "google_oauth_not_configured" });
      return;
    }
    const pending = google.beginAuth();
    issueOauthTxCookie(
      res,
      sessions.tx,
      {
        // The provider's state, sealed verbatim: it is the value Google echoes
        // back, so it has to be the value we compare against.
        state: pending.state,
        verifier: pending.codeVerifier,
        next: sanitizeNext(next),
      },
      env,
    );
    res.redirect(302, pending.url);
  }

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

    // Already signed in with Google: report it rather than looping them back
    // through consent.
    const signedIn = googlePrincipal(req.headers.cookie, sessions, cfg);
    if (signedIn) {
      res.json({
        signedInAs: signedIn.label,
        via: "google",
        hd: cfg.auth.google?.hostedDomain,
        roles: signedIn.roles,
        servers: cfg.servers.map((s) => ({
          slug: s.slug,
          kind: s.kind,
          enabled: s.enabled,
        })),
      });
      return;
    }

    if (auth.ready) {
      beginLogin(res, sanitizeNext(req.query.next));
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

  // The gate sends people here with the page they were trying to reach. Always
  // a fresh login, so a stale session cookie cannot wedge someone out.
  app.get("/console/login", (req, res) => {
    beginLogin(res, sanitizeNext(req.query.next));
  });

  app.get("/console/oauth/callback", async (req, res) => {
    if (!google || !sessions) {
      res.status(404).json({ error: "google_oauth_not_configured" });
      return;
    }

    const tx = unsealCookie<OauthTxPayload>(
      sessions.tx,
      req.headers.cookie,
      OAUTH_TX_COOKIE,
    );
    // Spend the transaction, whatever happens next. This is a Set-Cookie on the
    // RESPONSE, so it binds a browser and not a script that kept the value —
    // what actually stops a replayed callback is Google's authorization code
    // being single-use. Clearing it is still right: it keeps a stale tab from
    // re-entering the flow and bounds how long the verifier lives.
    clearOauthTxCookie(res, env);

    // No transaction cookie is a stale tab, a cross-origin forgery, or a login
    // begun more than ten minutes ago. None of them is a sign-in.
    if (!tx) {
      res.status(400).json({ error: "unknown_state" });
      return;
    }
    // The state in the URL must be the state we sealed for THIS browser. The
    // signature proves the cookie is ours; this proves the callback is its
    // partner, which is the CSRF check.
    if (!stateMatches(String(req.query.state ?? ""), tx.state)) {
      res.status(400).json({ error: "state_mismatch" });
      return;
    }

    try {
      const identity = await google.completeAuth(
        String(req.query.code ?? ""),
        tx.verifier,
      );
      issueSessionCookie(res, sessions.session, identity, env);
      // Back to the page they asked for, as a human expects — not JSON.
      res.redirect(302, sanitizeNext(tx.next));
    } catch (err) {
      const message = err instanceof AuthError ? err.message : "sign-in failed";
      res.status(403).json({ error: "forbidden", message });
    }
  });

  app.get("/console/logout", (_req, res) => {
    clearSessionCookie(res, env);
    clearOauthTxCookie(res, env);
    // The bypass cookie too, or "sign out" leaves every human who entered with
    // the bootstrap token — which is all of staging — still signed in.
    res.clearCookie(BYPASS_COOKIE, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      path: "/",
    });
    res.redirect(302, "/");
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
