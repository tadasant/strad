import type { Response } from "express";
import { readCookies, type Sealer } from "../auth/session.ts";
import type { Principal } from "../auth/index.ts";

/**
 * The in-flight connector authorization, as a signed cookie.
 *
 * ## Why there is no server-side state
 *
 * Core runs behind App Platform and may run more than one replica, so a flow
 * begun on replica A is finished on replica B as a matter of routine — and a
 * redeploy mid-consent is one restart, not a lost transaction. A map in a
 * process satisfies neither. The same HMAC primitive the console session already
 * uses (src/auth/session.ts) carries the whole transaction instead: any replica
 * holding the key can verify a transaction any other replica issued, and there
 * is nothing to expire out of memory.
 *
 * ## What is bound into it, and why each one
 *
 * Everything the callback must not take from the request:
 *
 *   - `state`     the CSRF value Google echoes back. Compared constant-time.
 *   - `verifier`  PKCE. Never leaves this cookie; the URL carries the challenge.
 *   - `slug`      WHICH SERVER. A browser cannot choose one — this is the only
 *                 place the callback reads it from.
 *   - `env`       the deployment. A transaction sealed against staging cannot be
 *                 replayed at prod even if the key were shared, and the parameter
 *                 path is composed from it.
 *   - `account`   the expected email, `scopes` the exact grant, `variable` the
 *                 target. Sealed so a config edited mid-flight cannot silently
 *                 change what a consent already in progress installs, and so the
 *                 callback's checks are against the terms the human was SHOWN.
 *   - `sid`       the initiating console session. See {@link consoleSessionId}.
 *   - `next`      where to land afterwards. Always a same-origin path.
 *
 * ## Single use, and short
 *
 * Ten minutes, which is a consent screen plus a password prompt plus a second
 * factor, and no more. The callback clears the cookie before it does anything
 * else — which spends the transaction for a BROWSER, and only for a browser:
 * strad keeps no server-side nonce, so a script that kept the cookie value could
 * present it again inside the TTL. What actually stops a replay landing anything
 * is Google's authorization code, which is single-use at Google. The clear is
 * the belt: it keeps a stale tab from re-entering the flow and bounds how long
 * the verifier lives.
 */

export const CONNECTOR_TX_COOKIE = "strad_connector_tx";

/** Only the callback reads it. Narrower than the session cookie's `/`. */
export const CONNECTOR_TX_PATH = "/ui";

/** How long a human has to get through Google's consent screen and back. */
export const CONNECTOR_TX_TTL_MS = 10 * 60 * 1000;

export interface ConnectorTxPayload {
  v: 1;
  state: string;
  verifier: string;
  slug: string;
  env: string;
  account: string;
  scopes: string[];
  variable: string;
  sid: string;
  next: string;
  exp: number;
}

/**
 * A stable, non-secret identifier for the console session that began the flow.
 *
 * BOUND, not merely recorded: the callback refuses a transaction whose `sid` is
 * not the principal it authenticated. That is what makes a stolen or borrowed
 * transaction cookie useless on its own — completing the flow needs the
 * transaction AND the session that started it, in the same browser.
 *
 * `kind` is in the string because the two console credentials mint principals
 * from different id spaces: a Google `sub` and the dev bypass's fixed id. Without
 * it, a deployment that enabled Google sign-in after a bypass session began could
 * — in principle — see the two collide.
 */
export function consoleSessionId(principal: Principal): string {
  return `${principal.kind}:${principal.id}`;
}

export function issueConnectorTx(
  res: Response,
  sealer: Sealer,
  tx: Omit<ConnectorTxPayload, "v" | "exp">,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): void {
  const payload: ConnectorTxPayload = {
    v: 1,
    ...tx,
    exp: now + CONNECTOR_TX_TTL_MS,
  };
  res.cookie(CONNECTOR_TX_COOKIE, sealer.seal(payload), {
    httpOnly: true,
    // Lax, not Strict: the browser arrives back from accounts.google.com as a
    // top-level GET navigation, and Strict withholds the cookie on exactly that
    // request. Lax sends it there and still withholds it from cross-site POSTs,
    // which is what protects the connect action itself.
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: CONNECTOR_TX_PATH,
    maxAge: CONNECTOR_TX_TTL_MS,
  });
}

export function clearConnectorTx(res: Response, env: NodeJS.ProcessEnv): void {
  res.clearCookie(CONNECTOR_TX_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: CONNECTOR_TX_PATH,
  });
}

/**
 * The first transaction cookie this sealer accepts, or null.
 *
 * Every value under the name is tried, for the reason `readCookies` documents:
 * anything that can set a cookie on a sibling subdomain can shadow this one with
 * a longer path, and taking only the first would be a lockout no human could
 * clear.
 */
export function readConnectorTx(
  sealer: Sealer,
  cookieHeader: string | undefined,
  now: number = Date.now(),
): ConnectorTxPayload | null {
  for (const value of readCookies(cookieHeader, CONNECTOR_TX_COOKIE)) {
    const payload = sealer.unseal<ConnectorTxPayload>(value, now);
    if (payload) return payload;
  }
  return null;
}
