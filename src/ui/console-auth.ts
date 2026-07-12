import type { NextFunction, Request, Response } from "express";
import { authenticateConsoleBypass, devBypassStatus } from "../auth/dev.ts";
import type { Principal } from "../auth/index.ts";
import type { StradConfig } from "../config/schema.ts";
import { renderSignIn } from "./render.ts";

/**
 * The SSO gate for the human console UI.
 *
 * It is the SAME gate as /console, and deliberately so: the resource browser is
 * a human surface on the open internet, exactly like /console, and must never be
 * a softer door than it. Today that means the console dev bypass (present
 * ADMIN_BOOTSTRAP_TOKEN); the day Google Workspace OAuth credentials land it
 * becomes real OAuth, with no change to what /ui is allowed to assume — the
 * middleware only ever trusts a resolved Principal.
 *
 * /mcp is untouched by any of this. That endpoint accepts static system tokens
 * and nothing else (src/auth/index.ts). There is no code path from this bypass
 * to /mcp — same invariant HACKS.md #2 states for /console.
 *
 * One convenience over /console: a browser is navigating between pages, so once
 * the bootstrap token is presented as `?token=`, it is moved into an HttpOnly
 * cookie and stripped from the URL. Subsequent navigation and its screenshots
 * carry no secret in the address bar. The cookie is the whole "session" for now;
 * a real signed session replaces it with Google OAuth (see HACKS.md).
 */

const COOKIE = "strad_console";

export interface ConsoleAuthDeps {
  config: StradConfig;
  env: NodeJS.ProcessEnv;
}

export function requireConsoleUi(deps: ConsoleAuthDeps) {
  const { config, env } = deps;

  return function gate(req: Request, res: Response, next: NextFunction): void {
    const fromQuery =
      typeof req.query.token === "string" && req.query.token
        ? req.query.token
        : undefined;
    const fromHeader = bearer(req.headers.authorization);
    const fromCookie = readCookie(req.headers.cookie, COOKIE);

    // The `?token=` drives the sign-in flow: a valid one is upgraded to an
    // HttpOnly cookie and the URL is cleaned, so the secret does not linger in
    // history, bookmarks or screenshots. Do this ONLY when it actually
    // authenticates — a stale/wrong `?token=` in a shared URL must not shadow an
    // otherwise-valid session cookie and force a spurious sign-in wall.
    if (fromQuery) {
      const p = authenticateConsoleBypass(fromQuery, config, env);
      if (p) {
        res.locals.principal = p;
        setSessionCookie(res, fromQuery, env);
        res.redirect(302, cleanUrl(req));
        return;
      }
    }

    // Established session: a cookie (browser) or a bearer header (curl). Each is
    // re-validated against ADMIN_BOOTSTRAP_TOKEN on every request.
    const sessionToken = fromCookie ?? fromHeader;
    const principal = sessionToken
      ? authenticateConsoleBypass(sessionToken, config, env)
      : null;

    if (principal) {
      res.locals.principal = principal;
      next();
      return;
    }

    // Not authenticated. When Google OAuth is configured, that is the front
    // door — send them to /console to begin it. Until then, explain the bypass.
    if (config.auth.google?.enabled) {
      res.redirect(302, "/console");
      return;
    }

    const status = devBypassStatus(config, env);
    res.status(401).type("html").send(renderSignIn(status.reason));
  };
}

export function signedInLabel(res: Response): string | undefined {
  const p = res.locals.principal as Principal | undefined;
  return p?.label;
}

function setSessionCookie(
  res: Response,
  value: string,
  env: NodeJS.ProcessEnv,
): void {
  res.cookie(COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    // Staging runs NODE_ENV=production behind TLS; require Secure there.
    secure: env.NODE_ENV === "production",
    path: "/ui",
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

function bearer(header: string | undefined): string | undefined {
  const m = header?.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ? m[1].trim() : undefined;
}

function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}
