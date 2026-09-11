import express, { type Express } from "express";
import { bearerToken } from "../auth/credential.ts";
import { authenticateConsoleBypass, consoleDenial } from "../auth/dev.ts";
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
import type { ToolSurfaceSnapshot } from "../gateway/reachability.ts";
import type { SecretBag } from "../secrets/index.ts";
import { mountConsoleUi } from "../ui/index.ts";
import type { GcsLister } from "../ui/gcs-client.ts";
import type { ConsoleUiOptions } from "../ui/index.ts";
import { asyncRoute, jsonFailure } from "./async-route.ts";
import { createReadinessHandler } from "./readiness.ts";
import { createPresenceHandler } from "./presence.ts";
import { PRESENCE_ROUTE } from "../secrets/presence.ts";
import {
  createParamReadHandler,
  createParamWriteHandler,
  createStoreRefreshHandler,
} from "./params.ts";
import {
  PARAM_ROUTE_PREFIX,
  STORE_REFRESH_ROUTE,
} from "../secrets/param-route.ts";
import { errorText } from "../util/error-text.ts";

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
   * The runtime secret provider, for the secret roster on `/ui` and the
   * machine-readable one at `/api/secrets/readiness`.
   *
   * Optional, and the fallback is not a degradation under the default `env`
   * provider — the bag IS process.env there. It matters for a store-backed
   * deployment, where a referenced name lives in the parameter store and appears
   * in no bag, so presence can only be established by asking the provider.
   */
  secretProvider?: ConsoleUiOptions["secretProvider"];
  /**
   * Test seam: the transport the bundle presence probe uses. Defaults to fetch.
   *
   * The probe is how the console and the readiness report assert about secrets
   * that live on a component core is not — see src/gateway/bundle-presence.ts.
   */
  fetchImpl?: typeof fetch;
  /** Test seam: an already-probed bundle report, skipping the transport. */
  presence?: ConsoleUiOptions["presence"];
  /** Test seam: the store the four-state diagnosis reads. */
  diagnosticStore?: ConsoleUiOptions["diagnosticStore"];
  /** Test seam: the clock the store re-read route's floor is measured on. */
  now?: () => number;
  /** Test seam: substitute the GCS listing surface behind the console UI. */
  gcsList?: GcsLister;
  /** Test seam: substitute the parameter store behind the console UI. */
  parametersStore?: ConsoleUiOptions["parametersStore"];
  /**
   * Test seam: the transport a CONNECTOR's Google token exchange uses.
   *
   * Separate from `fetchImpl` (the bundle presence probe's) because they stub
   * different third parties. See src/ui/connector.ts.
   */
  connectorFetch?: ConsoleUiOptions["connectorFetch"];
  /** Test seam: override the console's capability probe. See ConsoleUiOptions. */
  capabilities?: ConsoleUiOptions["capabilities"];
  /**
   * Test seam: substitute the Google OAuth provider. A real round-trip needs
   * accounts.google.com, so the callback→session→gate path is exercised with a
   * stub that returns an already-verified identity.
   */
  googleProvider?: ConsoleOAuthProvider | null;
  /**
   * The last tool-surface observation, for `/healthz`.
   *
   * A getter rather than a value, because the monitor re-probes on an interval
   * and this route must always read the current answer. Absent (and absent from
   * the response) when nothing is monitoring — a test app, or a mode that
   * mounts no monitor. See gateway/reachability.ts.
   */
  toolSurfaces?: () => ToolSurfaceSnapshot | null;
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
  // Its own answer rather than `jsonFailure`'s default, because this route
  // RELAYS the upstream's message on purpose: the caller is a supplementary
  // container's client, the proxied hop is strad's own private network, and "why
  // could the gateway not reach it" is the only useful thing to say. 502, not
  // 500 — the failure is a hop, not this process.
  app.post(
    "/mcp-upload/:slug/:token",
    asyncRoute(
      async (req, res) => {
        const slug = req.params.slug;
        const token = req.params.token;
        const adapter = slug ? opts.registry.get(slug) : undefined;
        if (
          adapter?.kind !== "supplementary-image" ||
          !adapter.postRaw ||
          !token
        ) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        await adapter.postRaw(`/upload/${encodeURIComponent(token)}`, req, res);
      },
      jsonFailure(
        "mcp_upload",
        (err) => ({
          error: "upload_proxy_failed",
          message: errorText(err),
        }),
        502,
      ),
    ),
  );
  app.use(express.json({ limit: "4mb" }));

  // --- health -------------------------------------------------------------
  // App Platform polls this. Keep it dependency-free: if it CHECKED upstream
  // MCP servers here, a flaky third party would make our component look
  // unhealthy and get it restarted, which helps nobody.
  //
  // But listing the slugs and stopping there was its own problem: this route
  // answered 200 with all 27 names while three of them served no tools at all,
  // so nothing short of holding a token and polling `tools/list` could tell the
  // two apart. `toolSurfaces` is the last observation from the background
  // monitor (gateway/reachability.ts) — read, never taken, so this stays
  // instant — and `degraded` is the one field a deploy job needs to assert on.
  //
  // `unconfigured` sits BESIDE it rather than inside it: a slug waiting on a
  // credential a human deliberately deferred (src/deploy/unseeded.ts) is not
  // broken, and folding it into `degraded` would red the staging deploy gate on
  // a deployment that is doing exactly what was asked of it. Two lists, because
  // they call for two different actions — go and look, versus go and seed.
  // SLUGS ONLY. Which `${NAME}` is missing stays in the logs and the console;
  // this route is unauthenticated and a secret name is not a thing to publish.
  //
  // `mountDegraded` is the third list, and the other half of the picture: the
  // slugs whose BUNDLE says their mount is unwell while it lists its tools — a
  // stale login is the case that ran for weeks. Also beside `degraded` rather
  // than in it, so the deploy gate that reads the surface state never fails on
  // it; the staging deploy annotates it instead. Slugs and one of two words per
  // surface (`mount`), and never the bundle's reason — that text is dropped
  // where it is parsed (gateway/mount-health.ts). `mountUnread` names the slugs
  // no reading covered, so an unreadable bundle is never an empty, all-clear
  // `mountDegraded`.
  //
  // `ok` stays true regardless. This route is liveness; a degraded upstream is
  // not a reason to restart core.
  app.get("/healthz", (_req, res) => {
    const surfaces = opts.toolSurfaces?.() ?? null;
    res.json({
      ok: true,
      mode: opts.mode,
      bundle: env.STRAD_BUNDLE ?? "core",
      env: opts.config.gateway.env,
      servers: opts.registry.slugs,
      ...(surfaces
        ? {
            toolSurfaces: {
              observedAt: surfaces.observedAt,
              servers: surfaces.surfaces,
            },
            degraded: surfaces.degraded,
            unconfigured: surfaces.unconfigured,
            ...(surfaces.mountDegraded
              ? { mountDegraded: surfaces.mountDegraded }
              : {}),
            ...(surfaces.mountUnread
              ? { mountUnread: surfaces.mountUnread }
              : {}),
          }
        : {}),
    });
  });

  // --- the endpoint -------------------------------------------------------
  //
  // Through `asyncRoute` (src/http/async-route.ts), which is not optional here:
  // `handleMcp` is async, Express 4 drops the promise it returns, and an
  // unhandled rejection exits this process. The throw surface below the auth
  // catch is the widest in the repo — the MCP SDK driven over a caller-supplied
  // body and a caller-controlled socket — so the failure answer is a 500 to the
  // one caller rather than a restart for all of them.
  //
  // `jsonFailure` and not a renderer of its own, because the body is the point:
  // a fixed word. This endpoint says nothing to an agent about how it failed
  // (src/telemetry/redact.ts), and the class name it does record stays on
  // stderr. The metric side of the failure is the router's — it sets the
  // `internal_error` outcome on the way out.
  app.all(
    "/mcp",
    asyncRoute(
      createMcpHandler({
        config: opts.config,
        registry: opts.registry,
        tokenStore: opts.tokenStore,
        mode: opts.mode,
        env,
      }),
      jsonFailure("mcp"),
    ),
  );

  if (opts.mode === "core") {
    // The machine's read of the human console's secret roster.
    //
    // CORE ONLY, alongside the console it mirrors: the derivation reads core's
    // own environment (a `consoleEnv:` value lands under its declared key on
    // core and nowhere else), so a bundle would answer the same question with
    // strictly less information and get it wrong.
    //
    // It is a STATIC-BEARER surface, not a session one: the consumer is a
    // platform app holding one long-lived token, and it authenticates through
    // the same authenticateMcp/STRAD_TOKENS path /mcp does. See readiness.ts.
    app.get(
      "/api/secrets/readiness",
      createReadinessHandler({
        config: opts.config,
        tokenStore: opts.tokenStore,
        env,
        secrets: opts.secrets ?? {},
        secretProvider: opts.secretProvider,
        fetchImpl: opts.fetchImpl,
        presence: opts.presence,
        diagnosticStore: opts.diagnosticStore,
      }),
    );

    // The parameter write-back pair — the FIRST bundle → core call in strad.
    //
    // CORE ONLY, and for the mirror image of the presence route's reason: core
    // is the component that holds the store-admin credential, and the caller is
    // a bundle that holds none. Authenticated with the shared
    // STRAD_INTERNAL_TOKEN, and bounded — on every call, from the config rather
    // than from the URL — to the names that server's own `paramsWritable:`
    // allowlist names. See src/http/params.ts.
    const paramsOptions = {
      config: opts.config,
      env,
      secrets: opts.secrets ?? {},
      parametersStore: opts.parametersStore,
      secretProvider: opts.secretProvider,
      diagnosticStore: opts.diagnosticStore,
      now: opts.now,
    };
    const paramRoute = `${PARAM_ROUTE_PREFIX}/:slug/:variable`;
    app.get(paramRoute, createParamReadHandler(paramsOptions));
    app.post(paramRoute, createParamWriteHandler(paramsOptions));
    // The store re-read, over the same wire and the same token: what the
    // `secrets` MCP server calls so an agent's rotation reaches `/mcp` now
    // rather than within `ttlSeconds` — the counterpart of the console's
    // "Re-read the store" button. See src/http/params.ts.
    app.post(STORE_REFRESH_ROUTE, createStoreRefreshHandler(paramsOptions));

    // Resolved ONCE and shared: /console begins the login and mints the session,
    // /ui verifies it. Two independent readings of "is Google usable?" is how
    // you get a gate that redirects into a flow that cannot complete.
    const auth = resolveConsoleAuth(opts, env);
    mountConsole(app, opts, env, auth);
    // The human, SSO-gated surfaces: the landing page at "/" and the resource
    // browser at /ui. Same gate as /console; not /mcp.
    mountConsoleUi(app, {
      config: opts.config,
      registry: opts.registry,
      secrets: opts.secrets ?? {},
      secretProvider: opts.secretProvider,
      env,
      gcsList: opts.gcsList,
      parametersStore: opts.parametersStore,
      capabilities: opts.capabilities,
      fetchImpl: opts.fetchImpl,
      presence: opts.presence,
      diagnosticStore: opts.diagnosticStore,
      sessions: auth.sessions,
      googleReady: auth.ready,
      connectorFetch: opts.connectorFetch,
    });
  }

  if (opts.mode === "bundle") {
    // BUNDLE ONLY, and it is the mirror image of the readiness endpoint above.
    //
    // A bundle component holds secrets core cannot see: a supplementary
    // server's `env:` and a `params: true` server's managed parameters are
    // resolved at render time and injected onto that component alone
    // (appspec.ts). Core asking "does ${SLACK_BOT_TOKEN} resolve?" of its own
    // environment gets a true "no" about a deployment that is completely
    // healthy — which is where the console's shrug came from.
    //
    // So the component answers for itself, in the five words of
    // secrets/presence.ts. Never a value. Mounting it on core too would be
    // pointless (core already reads its own environment directly) and would put
    // a presence surface on the one component with a public route.
    //
    // The handler is `presenceResponse` in secrets/presence.ts — the same
    // function the bundle host image serves from its vendored copy, so there is
    // one route here and not two that merely agree. Everything it answers with
    // comes from `env`, including the provenance line (`STRAD_COMPONENT`,
    // `STRAD_BUNDLE`, `STRAD_VERSION`).
    app.post(PRESENCE_ROUTE, createPresenceHandler({ env }));
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

    // Two refusals, not one: a wrong bootstrap token against a live bypass is a
    // different problem from a deployment with no console door at all, and they
    // are told apart in consoleDenial() (src/auth/dev.ts), which also carries
    // the reasoning about what that distinction discloses.
    res.status(401).json(consoleDenial(cfg, env));
  });

  // The gate sends people here with the page they were trying to reach. Always
  // a fresh login, so a stale session cookie cannot wedge someone out.
  app.get("/console/login", (req, res) => {
    beginLogin(res, sanitizeNext(req.query.next));
  });

  // Wrapped, because everything down to `google.completeAuth` runs outside this
  // handler's own `try`: unsealing the transaction cookie, clearing it, the
  // state comparison and the session cookie it issues on the way out. Any of
  // them throwing on a callback a browser can reach unauthenticated would be an
  // unhandled rejection, and this process exits on one.
  app.get(
    "/console/oauth/callback",
    asyncRoute(async (req, res) => {
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
        const message =
          err instanceof AuthError ? err.message : "sign-in failed";
        res.status(403).json({ error: "forbidden", message });
      }
    }, jsonFailure("console_oauth_callback")),
  );

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
  return bearerToken(header) ?? undefined;
}
