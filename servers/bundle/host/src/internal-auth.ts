/**
 * The internal-token gate in front of this image's MCP mounts.
 *
 * A bundle component sits on the private network with `internal_ports: [8080]`
 * and no public route. That is a REACHABILITY property, not an authorization
 * one — anything else that got into the VPC could reach these mounts, and every
 * upstream credential behind them. The strad image says so in as many words
 * (`authenticateInternal` in `src/gateway/router.ts`); this image mounted every
 * server with no gate at all, which is `HACKS.md` #13.
 *
 * The decision is `authorizePresence`, unchanged, from the module vendored out
 * of core (`npm run presence:sync`). Reusing it rather than writing a second
 * constant-time compare is the point: `/_strad/presence` and every `/mcp` mount
 * on this host answer the same token the same way, with the same fail-closed
 * rule and the same two statuses.
 *
 *   - `STRAD_INTERNAL_TOKEN` unset → **503**, and NOTHING is served. Fail closed:
 *     a process that cannot tell core from anything else in the VPC must not
 *     guess. The deploy path already refuses to ship without the name
 *     (`src/deploy/preflight.ts` counts it non-optional, and `bootEnvGaps` in
 *     `src/deploy/appspec.ts` fails a render whose supplementary component would
 *     boot without it), so 503 is a bug in the deployment, not a state to serve
 *     through.
 *   - token absent or wrong → **401**.
 *
 * The strad image's gate refuses both cases as one `Unauthenticated`, which
 * `serve()` renders as 401. Same rule — nothing is served without the token —
 * and one more bit of detail in the answer, because this host already drew that
 * distinction on `/_strad/presence` and a mount answering the same credential
 * differently from the route beside it would be the odd thing.
 *
 * `/healthz` deliberately stays OPEN. App Platform polls it from outside this
 * process with no credential; gating it would take the component down as
 * unhealthy — the one way to make an authorization fix cost availability.
 */
import type { NextFunction, Request, Response } from "express";

import { authorizePresence, constantTimeEquals } from "./presence.js";

/** `timingSafeEqual`, injected — `presence.ts` is import-free by construction. */
export type TimingSafeEqual = (a: Uint8Array, b: Uint8Array) => boolean;

/**
 * The decision, without express in the way, so it can be asserted directly.
 *
 * Returns `undefined` when the request may proceed.
 */
export function internalAuthRefusal(
  authorization: string | undefined,
  env: NodeJS.ProcessEnv,
  timingSafeEqual: TimingSafeEqual,
): { status: number; error: string } | undefined {
  const auth = authorizePresence(
    authorization,
    env.STRAD_INTERNAL_TOKEN,
    (a, b) => constantTimeEquals(a, b, timingSafeEqual),
  );
  return auth.ok ? undefined : { status: auth.status, error: auth.error };
}

/**
 * The express middleware, for the routes that carry a mount.
 *
 * Built once and shared by every mount rather than per route: one env read per
 * request, one decision, and no chance of two mounts disagreeing about what a
 * token is. The env is read PER CALL for the same reason core's is — it keeps
 * every door on one code path even though a deploy-injected value cannot rotate
 * without a redeploy of the pair.
 */
export function requireInternalToken(
  env: NodeJS.ProcessEnv,
  timingSafeEqual: TimingSafeEqual,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const refusal = internalAuthRefusal(
      req.get("authorization"),
      env,
      timingSafeEqual,
    );
    if (!refusal) {
      next();
      return;
    }
    // `no-store` for the same reason the presence route sets it: the answer
    // changes on a deploy, and a cached 401 outlives the redeploy that fixed it.
    res
      .status(refusal.status)
      .set({ "cache-control": "no-store" })
      .json({ error: refusal.error });
  };
}
