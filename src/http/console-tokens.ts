import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import {
  StoreFull,
  TOKEN_SESSION_COOKIE,
  TOKEN_SESSION_TTL_MS,
  type ConsoleTokenRecord,
  type ConsoleTokenStore,
} from "../auth/console-tokens.ts";
import type { Principal } from "../auth/index.ts";
import type { ConsoleSessions } from "../auth/session.ts";
import type { StradConfig } from "../config/schema.ts";
import { event } from "../telemetry/index.ts";
import { burnFromUrl, standingPrincipal } from "../ui/console-auth.ts";

/**
 * The three console login token routes. See src/auth/console-tokens.ts for what
 * the token is and why the compare-and-set is sound.
 *
 *   POST /console/tokens              mint     — a standing credential
 *   POST /console/token-login         exchange — the token, in a JSON BODY
 *   POST /console/tokens/:jti/revoke  revoke   — a standing credential, or the
 *                                                token itself
 *
 * Mounted only when `consoleTokenLoginStatus()` says so. On a deployment where
 * it does not — every production one — these paths are the same 404 as any
 * path strad never heard of, which says nothing about the feature existing.
 *
 * JSON, and only JSON, wherever a cookie could be what authenticates the
 * request or what the response sets. A cross-origin page can POST a form or
 * `text/plain` with the browser's cookies attached, but it cannot send
 * `application/json` without a CORS preflight, and strad answers none. That is
 * what stops a sibling-subdomain page from minting with a human's session, or
 * planting its own token session in a human's browser.
 *
 * Every answer is `cache-control: no-store`: the mint's body is a credential,
 * and the exchange's Set-Cookie is one.
 */

export const TOKEN_LOGIN_PATH = "/console/token-login";

export interface ConsoleTokenRouteDeps {
  config: StradConfig;
  env: NodeJS.ProcessEnv;
  sessions: ConsoleSessions | null;
  store: ConsoleTokenStore;
}

/**
 * The exchange path's URL check, for EVERY method, registered ahead of the body
 * parser (src/http/app.ts).
 *
 * NEVER a query string. A URL is written to access logs and sent onward in
 * `Referer`, so a token that has been in one is burned — revoked, if it is real
 * and still active — whatever the method, whatever the body, and before a
 * malformed body can make the parser answer first and leave it live.
 */
export function tokenLoginUrlGuard(store: ConsoleTokenStore): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.query.token === undefined) {
      next();
      return;
    }
    noStore(res);
    const { burned, seen } = burnFromUrl(store, req.query.token);
    if (seen === 0) refused("token_in_query");
    res.status(400).json({
      error: "token_in_query",
      message:
        "The token goes in the POST body, never the URL. " +
        (burned > 0
          ? "It has been in a URL, so it is now revoked; mint another."
          : seen > 0
            ? "It had already been exchanged or revoked."
            : "Nothing was exchanged."),
    });
  };
}

export function mountConsoleTokens(
  app: Express,
  deps: ConsoleTokenRouteDeps,
): void {
  const { env, store } = deps;

  app.post("/console/tokens", (req, res) => {
    noStore(res);
    const minter = standingPrincipal(
      req.headers.cookie,
      req.headers.authorization,
      deps,
    );
    if (!minter) {
      res.status(401).json({
        error: "standing_credential_required",
        message:
          "Minting a console login token takes a standing console credential: " +
          "ADMIN_BOOTSTRAP_TOKEN as an Authorization: Bearer header, or a " +
          "Google session. A token session cannot mint.",
      });
      return;
    }
    if (!jsonIfCookie(req, res)) return;

    const body = jsonObject(req, res, ["roles"]);
    if (!body) return;

    let roles = minter.roles;
    if (body.roles !== undefined) {
      const requested = body.roles;
      if (
        !Array.isArray(requested) ||
        requested.length === 0 ||
        !requested.every((r) => typeof r === "string")
      ) {
        res.status(400).json({
          error: "invalid_roles",
          message: "`roles`, when given, is a non-empty array of role names.",
        });
        return;
      }
      // Narrow, never widen. The minter's roles are the ceiling.
      const beyond = requested.filter((r) => !minter.roles.includes(r));
      if (beyond.length > 0) {
        res.status(403).json({
          error: "roles_exceed_minter",
          message:
            "A token cannot carry a role its minter does not hold. " +
            `The minter holds: ${minter.roles.join(", ") || "(none)"}.`,
        });
        return;
      }
      roles = [...new Set(requested as string[])];
    }

    let minted;
    try {
      minted = store.mint(minter, roles);
    } catch (err) {
      if (!(err instanceof StoreFull)) throw err;
      res.status(429).json({
        error: "too_many_tokens",
        message:
          "Too many console login tokens are held. Revoke or exchange some, " +
          "or wait for them to expire.",
      });
      return;
    }

    event({
      evt: "console.token_minted",
      jti: minted.record.jti,
      minted_by: minter.kind,
    });
    res.status(201).json({
      token: minted.token,
      jti: minted.record.jti,
      roles: minted.record.roles,
      expiresAt: new Date(minted.record.expiresAt).toISOString(),
      sessionTtlSeconds: TOKEN_SESSION_TTL_MS / 1000,
      mintedBy: minter.label,
    });
  });

  app.post(TOKEN_LOGIN_PATH, (req, res) => {
    noStore(res);
    // JSON only: the response sets a session cookie, and a form a cross-site
    // page submitted would set it in somebody else's browser.
    if (!req.is("application/json")) {
      refused("not_json");
      res.status(415).json({
        error: "json_required",
        message: 'POST {"token": "<jti>.<secret>"} as application/json.',
      });
      return;
    }

    const presented = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof presented !== "string" || presented === "") {
      refused("missing_token");
      res.status(400).json({
        error: "missing_token",
        message: 'POST {"token": "<jti>.<secret>"} as application/json.',
      });
      return;
    }

    // THE compare-and-set. Synchronous: nothing below can interleave with
    // another exchange of the same token.
    const result = store.exchange(presented);

    if (!result.ok) {
      if (result.record) tripwire(result.record, result.reason);
      else refused(result.reason);
      // 409 for a real token in the wrong state, 401 for anything else. A
      // caller only ever learns the state of a token whose secret it holds.
      const status =
        result.reason === "token_consumed" || result.reason === "token_revoked"
          ? 409
          : 401;
      res.status(status).json({
        error: result.reason,
        message: REFUSAL_TEXT[result.reason],
      });
      return;
    }

    // Max-Age is the session's own lifetime, counted from the exchange, so the
    // browser drops the cookie when the server stops honouring it.
    res.cookie(TOKEN_SESSION_COOKIE, result.cookie, {
      httpOnly: true,
      sameSite: "lax",
      // Staging runs NODE_ENV=production behind TLS; require Secure there.
      secure: env.NODE_ENV === "production",
      // "/" for the same reason as the Google session: the gate covers the
      // landing page too. It rides along to /mcp, which is inert — /mcp reads
      // the Authorization header against the static token store and never a
      // cookie (HACKS.md #2).
      path: "/",
      maxAge: TOKEN_SESSION_TTL_MS,
    });
    event({ evt: "console.token_exchanged", jti: result.record.jti });
    res.json({
      ok: true,
      jti: result.record.jti,
      roles: result.record.roles,
      expiresAt: new Date(result.expiresAt).toISOString(),
    });
  });

  /**
   * Revoke, by a standing credential OR by possession of the token itself.
   *
   * Possession is what makes the tripwire something the actor can act on. The
   * actor holds the token and nothing standing, so when its exchange comes back
   * `token_consumed` it posts the same token here: the record stays consumed,
   * and the session somebody else opened with it ends. Anyone who could do this
   * could also have spent the token, so it grants nothing new.
   */
  app.post("/console/tokens/:jti/revoke", (req, res) => {
    noStore(res);
    const jti = String(req.params.jti ?? "");
    const actor: Principal | null = standingPrincipal(
      req.headers.cookie,
      req.headers.authorization,
      deps,
    );
    const presented = req.is("application/json")
      ? (req.body as { token?: unknown } | undefined)?.token
      : undefined;
    const byPossession =
      typeof presented === "string" && store.possessed(presented) === jti;

    if (!actor && !byPossession) {
      res.status(401).json({
        error: "standing_credential_required",
        message:
          "Revoking a console login token takes a standing console credential, " +
          'or the token itself as {"token": "<jti>.<secret>"}.',
      });
      return;
    }
    if (!byPossession && !jsonIfCookie(req, res)) return;

    const result = store.revoke(jti);
    if (!result.found) {
      // Honest rather than idempotent-looking: a 200 here would claim a
      // revocation that did not happen. The usual cause is a restart since the
      // mint, and then the token is dead anyway — see src/auth/console-tokens.ts.
      res.status(404).json({
        error: "unknown_token",
        message:
          "No such token here. It was never minted, has expired and been " +
          "forgotten, or was minted before core last restarted — in every one " +
          "of those cases it cannot be exchanged.",
      });
      return;
    }

    event({
      evt: "console.token_revoked",
      jti: result.record.jti,
      state: result.record.status,
    });
    res.json({
      jti: result.record.jti,
      status: result.record.status,
      sessionEnded: result.endedSession,
    });
  });
}

const REFUSAL_TEXT: Record<string, string> = {
  invalid_token: "Not a console login token this deployment holds.",
  token_consumed:
    "This token has already been exchanged. If you minted it and did not use " +
    "it, somebody else did: revoke it — POST it to /console/tokens/<jti>/revoke, " +
    "which also ends their session — and mint a fresh one.",
  token_revoked: "This token was revoked.",
  token_expired: "This token expired before it was exchanged. Mint another.",
};

/**
 * A cookie-authenticated mint or revoke must be JSON. A bearer header is not a
 * thing a browser attaches on its own, so it needs no such check; a cookie is,
 * and this is what keeps a cross-origin page from spending it. Answers the 415
 * itself and returns false when it refuses.
 */
function jsonIfCookie(req: Request, res: Response): boolean {
  if (req.headers.authorization || req.is("application/json")) return true;
  res.status(415).json({
    error: "json_required",
    message:
      "Authenticated by a cookie, this route takes an application/json body " +
      "— `{}` will do.",
  });
  return false;
}

/**
 * The request body as a JSON object with only `allowed` keys, or null after
 * answering the refusal. No body at all is `{}`. A misspelled key is a 400
 * rather than a silent default, because the default here is the minter's FULL
 * roles and a typo'd narrowing must not quietly become that.
 */
function jsonObject(
  req: Request,
  res: Response,
  allowed: string[],
): Record<string, unknown> | null {
  // A body of another type is refused — a form would otherwise be read as `{}`.
  // An empty one is no body at all: `fetch` sends `content-length: 0` on a bare
  // POST, which `req.is()` counts as a body with no type.
  if (hasBody(req) && !req.is("application/json")) {
    res.status(415).json({
      error: "json_required",
      message: "This route takes an application/json body.",
    });
    return null;
  }
  const body: unknown = req.body ?? {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    res.status(400).json({
      error: "invalid_body",
      message: "The body is a JSON object.",
    });
    return null;
  }
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    res.status(400).json({
      error: "unknown_field",
      message: `Unknown field(s): ${unknown.join(", ")}. This route reads: ${allowed.join(", ")}.`,
    });
    return null;
  }
  return body as Record<string, unknown>;
}

function hasBody(req: Request): boolean {
  return (
    req.headers["transfer-encoding"] !== undefined ||
    Number(req.headers["content-length"] ?? "0") > 0
  );
}

/**
 * A refusal of a token whose secret VERIFIED — so presented by somebody holding
 * the real thing, which is what makes it a signal. Exported, at ERROR.
 */
function tripwire(record: ConsoleTokenRecord, state: string): void {
  event({
    evt: "console.token_exchange_failed",
    jti: record.jti,
    state,
  });
}

/** A refusal of anything else. stdout only; see NOT_EXPORTED. */
function refused(reason: string): void {
  event({ evt: "console.token_login_refused", reason });
}

function noStore(res: Response): void {
  res.setHeader("cache-control", "no-store");
}
