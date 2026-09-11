import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  TOKEN_SESSION_COOKIE,
  type ConsoleTokenStore,
  type LiveTokenSession,
} from "../auth/console-tokens.ts";
import { authenticateConsoleBypass, consoleDenial } from "../auth/dev.ts";
import type { Principal } from "../auth/index.ts";
import {
  principalFromSession,
  readCookies,
  unsealCookie,
  SESSION_COOKIE,
  type ConsoleSessionPayload,
  type ConsoleSessions,
} from "../auth/session.ts";
import type { StradConfig } from "../config/schema.ts";
import { event } from "../telemetry/index.ts";
import { renderSignIn } from "./render.ts";

/**
 * The SSO gate for the human console UI.
 *
 * It is the SAME gate as /console, and deliberately so: the resource browser is
 * a human surface on the open internet, exactly like /console, and must never be
 * a softer door than it.
 *
 * Three credentials resolve to a Principal here, and the middleware only ever
 * trusts the Principal, never the credential:
 *
 *   1. A Google session — a signed, expiring cookie minted by
 *      /console/oauth/callback from a verified Workspace identity
 *      (src/auth/session.ts). This is the real door.
 *   2. A token session — the cookie POST /console/token-login sets when a
 *      single-use login token is exchanged (src/auth/console-tokens.ts). The
 *      automated actor's door: 30 minutes, the minter's roles, never in prod.
 *      It lives here rather than beside the bypass because it has to outlive
 *      the bypass (tadasant/strad#6).
 *   3. The console dev bypass — ADMIN_BOOTSTRAP_TOKEN, itself triple-guarded
 *      (src/auth/dev.ts). It is what keeps staging and an unprovisioned prod
 *      enterable, and it goes away once Google sign-in is verified in prod.
 *
 * /mcp is untouched by any of this. That endpoint accepts static system tokens
 * and nothing else (src/auth/index.ts). There is no code path from any console
 * credential to /mcp — the invariant HACKS.md #2 states for /console.
 *
 * One convenience for the bypass: a browser is navigating between pages, so once
 * the bootstrap token is presented as `?token=`, it is moved into an HttpOnly
 * cookie and stripped from the URL. Subsequent navigation and its screenshots
 * carry no secret in the address bar.
 */

/** The dev bypass's cookie. Exported so /console/logout can drop it too. */
export const BYPASS_COOKIE = "strad_console";

export interface ConsoleAuthDeps {
  config: StradConfig;
  env: NodeJS.ProcessEnv;
  /**
   * The session sealers, when key material exists. Null means no Google session
   * can be verified — and, with `googleReady` false, that the gate must not
   * offer a sign-in it cannot finish.
   */
  sessions?: ConsoleSessions | null;
  /**
   * True only when Google sign-in can actually complete end to end: the config
   * enables it, the OAuth client credentials are present, and there is a session
   * key. Enabling `auth.google` without credentials must NOT turn the honest 401
   * into a redirect that dead-ends at Google.
   */
  googleReady?: boolean;
  /**
   * The console login token store, when token login is live on this
   * deployment. Null means no token session can exist here — in production it
   * always is (src/auth/console-tokens.ts).
   */
  consoleTokens?: ConsoleTokenStore | null;
}

export function requireConsoleUi(deps: ConsoleAuthDeps) {
  const { config, env } = deps;
  const sessions = deps.sessions ?? null;
  const googleReady = deps.googleReady ?? false;
  const consoleTokens = deps.consoleTokens ?? null;

  return function gate(req: Request, res: Response, next: NextFunction): void {
    const fromQuery =
      typeof req.query.token === "string" && req.query.token
        ? req.query.token
        : undefined;
    const fromHeader = bearer(req.headers.authorization);
    const cookies = req.headers.cookie;

    // The `?token=` drives the bypass sign-in flow: a valid one is upgraded to
    // an HttpOnly cookie and the URL is cleaned, so the secret does not linger
    // in history, bookmarks or screenshots. Do this ONLY when it actually
    // authenticates — a stale/wrong `?token=` in a shared URL must not shadow an
    // otherwise-valid session and force a spurious sign-in wall.
    if (fromQuery) {
      const p = authenticateConsoleBypass(fromQuery, config, env);
      if (p) {
        res.locals.principal = p;
        setSessionCookie(res, fromQuery, env);
        res.redirect(302, cleanUrl(req));
        return;
      }
    }
    // A console LOGIN token in the URL is never a credential here — and it is
    // now in an access log, so it is burned. `?token=` is the bypass's sign-in,
    // which makes this the most likely place for one to be pasted by mistake.
    burnFromUrl(consoleTokens, req.query.token);

    // A Google session, first: it is the real credential.
    const principal =
      googlePrincipal(cookies, sessions, config) ??
      tokenSession(cookies, consoleTokens)?.principal ??
      bypassPrincipal(cookies, fromHeader, config, env);

    if (principal) {
      res.locals.principal = principal;
      next();
      return;
    }

    // Not authenticated. When Google sign-in can actually complete, that is the
    // front door — begin it, and come back to the page they asked for.
    if (googleReady) {
      res.redirect(302, `/console/login?next=${encodeURIComponent(here(req))}`);
      return;
    }

    // The same two-state refusal /console answers with, rendered for a human:
    // "your token is wrong" and "there is no door here" need different next
    // steps from whoever is reading it. See consoleDenial() in src/auth/dev.ts.
    res
      .status(401)
      .type("html")
      .send(renderSignIn(consoleDenial(config, env)));
  };
}

export function signedInLabel(res: Response): string | undefined {
  const p = res.locals.principal as Principal | undefined;
  return p?.label;
}

/**
 * The console identity the gate resolved. A request that reached a handler has
 * one — `requireConsoleUi` answers 401 or a redirect otherwise.
 *
 * One reading of `res.locals`, because two console surfaces consume the roles on
 * it (the playground, and the index that links to it) and a second cast is a
 * second place for them to drift apart.
 */
export function consolePrincipal(res: Response): Principal {
  return res.locals.principal as Principal;
}

/** A verified Google session cookie, or null. */
export function googlePrincipal(
  cookieHeader: string | undefined,
  sessions: ConsoleSessions | null,
  config: StradConfig,
): Principal | null {
  if (!sessions) return null;
  const payload = unsealCookie<ConsoleSessionPayload>(
    sessions.session,
    cookieHeader,
    SESSION_COOKIE,
  );
  if (!payload) return null;
  return principalFromSession(payload, config);
}

/** The first token session cookie that is live, or null. */
export function tokenSession(
  cookieHeader: string | undefined,
  consoleTokens: ConsoleTokenStore | null,
): LiveTokenSession | null {
  if (!consoleTokens) return null;
  for (const value of readCookies(cookieHeader, TOKEN_SESSION_COOKIE)) {
    const live = consoleTokens.session(value);
    if (live) return live;
  }
  return null;
}

/**
 * Burn every console login token in a URL's `token` parameter — one value, or
 * several (`?token=a&token=b` arrives as an array). A token that has been in a
 * URL has been in an access log, so it must not be exchangeable afterwards.
 *
 * A verified token is reported as a tripwire whether or not this call was what
 * burned it: somebody holding the real secret put it in a URL. Anything that
 * does not verify is ignored — it is not a login token, or not one this
 * process holds, and the caller's own refusal covers it.
 */
export function burnFromUrl(
  consoleTokens: ConsoleTokenStore | null,
  raw: unknown,
): { burned: number; seen: number } {
  if (!consoleTokens || raw === undefined) return { burned: 0, seen: 0 };
  const values = (Array.isArray(raw) ? raw : [raw]).filter(
    (v): v is string => typeof v === "string",
  );
  let burned = 0;
  let seen = 0;
  for (const value of values) {
    const result = consoleTokens.burn(value);
    if (!result) continue;
    seen++;
    if (result.burned) burned++;
    event({
      evt: "console.token_exchange_failed",
      jti: result.record.jti,
      state: result.burned
        ? "burned_in_query"
        : `token_${result.record.status}`,
    });
  }
  return { burned, seen };
}

/**
 * The line a token session does not cross: it may LOOK at every console page,
 * and it may not make the console act for it.
 *
 * Mounted after `gate` on every route that reads a stored value (`reveal`),
 * writes the store (`create`, `rotate`, `note`, `delete`), begins a connector
 * consent, or calls an upstream (the playground's `tools/call`). A 403, and the
 * handler never runs.
 *
 * The reason is the token's whole premise. A login token is meant to be a
 * credential whose leak is over in minutes, and each of those routes can turn
 * minutes into forever: reveal reads ADMIN_BOOTSTRAP_TOKEN or a third party's
 * key out of the store, and rotate writes a `STRAD_TOKENS` record whose secret
 * the writer chose. Narrowing a token's roles would not help — the secret
 * actions are behind the gate alone, and read no role. So the rule is on the
 * principal's KIND, and it holds whatever roles the token carries.
 *
 * `refresh` is not on the list: it drops this process's cached store reading
 * and reads nothing back, and the playground's `tools/list` returns tool
 * metadata only. Both are looking.
 */
export const refuseTokenSession: RequestHandler = (req, res, next) => {
  const p = res.locals.principal as Principal | undefined;
  if (p?.kind !== "console-token") {
    next();
    return;
  }
  const message =
    "A console login token's session can view the console but not act " +
    "through it: it cannot reveal, write or delete a stored value, begin a " +
    "connector, or call a tool. Sign in with a standing console credential " +
    "for that.";
  if (req.is("application/json")) {
    res.status(403).json({ ok: false, error: message });
    return;
  }
  res.status(403).type("text/plain").send(message);
};

/**
 * A STANDING console credential: a Google session, or the dev bypass as a
 * cookie or a bearer header. What may mint and revoke a console login token.
 *
 * Deliberately narrower than the gate. A token session is not here, so a
 * session cannot mint its own successor and outlive its 30 minutes one hop at a
 * time. `?token=` is not here either: a credential in a URL lands in access logs,
 * and these are POST routes a script calls, not pages a browser navigates to.
 */
export function standingPrincipal(
  cookieHeader: string | undefined,
  authorization: string | undefined,
  deps: Pick<ConsoleAuthDeps, "config" | "env" | "sessions">,
): Principal | null {
  return (
    googlePrincipal(cookieHeader, deps.sessions ?? null, deps.config) ??
    bypassPrincipal(cookieHeader, bearer(authorization), deps.config, deps.env)
  );
}

/**
 * The dev bypass, as an established session: a cookie (browser) or a bearer
 * header (curl). Each is re-validated against ADMIN_BOOTSTRAP_TOKEN on every
 * request.
 */
function bypassPrincipal(
  cookieHeader: string | undefined,
  fromHeader: string | undefined,
  config: StradConfig,
  env: NodeJS.ProcessEnv,
): Principal | null {
  const candidates = readCookies(cookieHeader, BYPASS_COOKIE);
  if (fromHeader) candidates.push(fromHeader);
  for (const token of candidates) {
    const p = authenticateConsoleBypass(token, config, env);
    if (p) return p;
  }
  return null;
}

function setSessionCookie(
  res: Response,
  value: string,
  env: NodeJS.ProcessEnv,
): void {
  res.cookie(BYPASS_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    // Staging runs NODE_ENV=production behind TLS; require Secure there.
    secure: env.NODE_ENV === "production",
    // Scoped to "/" rather than "/ui" because the gate also covers the landing
    // page at "/". A cookie scoped to /ui is simply not sent to /, so a
    // signed-in human would have hit the sign-in wall on the front page.
    //
    // Widening it does mean the cookie rides along to /mcp. That is inert:
    // /mcp authenticates from the Authorization header via a static token store
    // and never reads cookies — there is no code path from this bypass to /mcp
    // (HACKS.md #2). It stays HttpOnly, SameSite=Lax, and Secure in production.
    path: "/",
    maxAge: 12 * 60 * 60 * 1000,
  });
}

/** The current URL with the `token` query param removed. */
function cleanUrl(req: Request): string {
  const url = new URL(req.originalUrl, "http://placeholder");
  url.searchParams.delete("token");
  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ""}`;
}

/**
 * Where to return after sign-in. Only GET is worth resuming — a POST cannot be
 * replayed through a redirect, and /ui's writes are the POSTs, so an expired
 * session mid-write lands the human back on the index rather than silently
 * re-submitting anything.
 */
function here(req: Request): string {
  return req.method === "GET" ? cleanUrl(req) : "/ui";
}

function bearer(header: string | undefined): string | undefined {
  const m = header?.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ? m[1].trim() : undefined;
}
