import type { NextFunction, Request, Response } from "express";
import { bearerToken } from "../auth/credential.ts";
import { authenticateConsoleBypass, consoleDenial } from "../auth/dev.ts";
import type { Principal } from "../auth/index.ts";
import {
  principalFromSession,
  readCookies,
  renewSessionIfDue,
  sessionWindows,
  SESSION_COOKIE,
  type ConsoleSessionPayload,
  type ConsoleSessions,
} from "../auth/session.ts";
import type { StradConfig } from "../config/schema.ts";
import { renderSignIn } from "./render.ts";

/**
 * The SSO gate for the human console UI.
 *
 * It is the SAME gate as /console, and deliberately so: the resource browser is
 * a human surface on the open internet, exactly like /console, and must never be
 * a softer door than it.
 *
 * Two credentials resolve to a Principal here, and the middleware only ever
 * trusts the Principal, never the credential:
 *
 *   1. A Google session — a signed, expiring cookie minted by
 *      /console/oauth/callback from a verified Workspace identity
 *      (src/auth/session.ts). This is the real door, and the gate is where it
 *      slides: a session past half its window is re-issued on the way through.
 *   2. The console dev bypass — ADMIN_BOOTSTRAP_TOKEN, itself triple-guarded
 *      (src/auth/dev.ts). It is what keeps staging and an unprovisioned prod
 *      enterable, and it goes away once Google sign-in is verified in prod.
 *
 * /mcp is untouched by any of this. That endpoint accepts static system tokens
 * and nothing else (src/auth/index.ts); neither console credential is ever read
 * there — the invariant HACKS.md #2 states for /console.
 *
 * What a console session CAN do is mint one, on a deployment that configures
 * `auth.staticTokens.store: parameter-store` (src/ui/tokens.ts). That is a
 * console-gated write to the roster, not a second way to authenticate — but it
 * does mean "no path from here to /mcp" is about authentication rather than
 * about reach. HACKS.md #2 says so in full.
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
}

export function requireConsoleUi(deps: ConsoleAuthDeps) {
  const { config, env } = deps;
  const sessions = deps.sessions ?? null;
  const googleReady = deps.googleReady ?? false;

  return function gate(req: Request, res: Response, next: NextFunction): void {
    const fromQuery =
      typeof req.query.token === "string" && req.query.token
        ? req.query.token
        : undefined;
    const fromHeader = bearerToken(req.headers.authorization) ?? undefined;
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

    // A Google session, first: it is the real credential.
    const google = googleSession(cookies, sessions, config);
    const principal =
      google?.principal ?? bypassPrincipal(cookies, fromHeader, config, env);

    if (principal) {
      // An active human is not signed out on a fixed clock: past half its
      // window, the session is re-sealed with a fresh `exp` and the same
      // sign-in time, so the absolute cap still counts from Google.
      if (google && sessions) {
        renewSessionIfDue(
          res,
          sessions.session,
          google.payload,
          sessionWindows(config),
          env,
        );
      }
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
  return googleSession(cookieHeader, sessions, config)?.principal ?? null;
}

/**
 * The first Google session cookie that is live under the CURRENT config, with
 * the payload it came from, so the gate can renew the one it accepted.
 *
 * Every value is tried all the way through `principalFromSession`, not just the
 * MAC: a cookie strad sealed can still be past this config's cap or for another
 * Workspace, and it must not stop a later one that is neither from counting.
 */
export function googleSession(
  cookieHeader: string | undefined,
  sessions: ConsoleSessions | null,
  config: StradConfig,
  now: number = Date.now(),
): { principal: Principal; payload: ConsoleSessionPayload } | null {
  if (!sessions) return null;
  for (const value of readCookies(cookieHeader, SESSION_COOKIE)) {
    const payload = sessions.session.unseal<ConsoleSessionPayload>(value, now);
    if (!payload) continue;
    const principal = principalFromSession(payload, config, now);
    if (principal) return { principal, payload };
  }
  return null;
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
    // and never reads cookies (HACKS.md #2). It stays HttpOnly, SameSite=Lax,
    // and Secure in production.
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
