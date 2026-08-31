/**
 * The `/_strad/presence` route, as a function of its inputs.
 *
 * `presence.ts` is vendored from core and owns the VOCABULARY — parse, authorize,
 * report. What it does not own is the order those three run in, what a caller
 * learns when one of them refuses, and where the report's component, image and
 * environment come from. That wiring is this file, and it is the half only this
 * process has.
 *
 * It returns a response rather than writing one so that it is reachable without
 * express, a socket or a booted container: `index.ts` applies the result to
 * `res`, and `test/presence-route.test.ts` reads it.
 */
import { timingSafeEqual } from "node:crypto";

import {
  authorizePresence,
  buildPresenceReport,
  parsePresenceRequest,
  type PresenceReport,
} from "./presence.js";

/** Node's constant-time compare, wrapped so a length mismatch cannot throw. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface PresenceResponse {
  status: number;
  /** Applied verbatim. Empty on a refusal — only an answer is worth caching rules. */
  headers: Record<string, string>;
  body: PresenceReport | { error: string };
}

export interface PresenceRouteInput {
  /** The `authorization` header, as express reports it. */
  authorization: string | undefined;
  /** The parsed JSON body, whatever it turned out to be. */
  body: unknown;
  /**
   * The process environment: the thing being reported ON, and also where the
   * internal token, the component name and the image tag come from.
   */
  env: NodeJS.ProcessEnv;
  bootedAt: Date;
  /** The host's own version, reported when the deploy baked no `STRAD_VERSION`. */
  version: string;
}

/**
 * Authorize, then parse, then answer.
 *
 * THAT ORDER IS THE POINT. An unauthorized caller learns nothing about which
 * bodies this endpoint would have accepted, so a 401 comes back for a malformed
 * body just as it does for a well-formed one.
 */
export function presenceResponse(input: PresenceRouteInput): PresenceResponse {
  const auth = authorizePresence(
    input.authorization,
    input.env.STRAD_INTERNAL_TOKEN,
    // presence.ts stays import-free so it can be vendored, and falls back to a
    // JS comparator. This caller has node:crypto, so it passes the real one.
    constantTimeEquals,
  );
  if (!auth.ok) {
    return { status: auth.status, headers: {}, body: { error: auth.error } };
  }

  const parsed = parsePresenceRequest(input.body);
  if (!parsed.ok) {
    return { status: parsed.status, headers: {}, body: { error: parsed.error } };
  }

  return {
    status: 200,
    headers: { "cache-control": "no-store" },
    body: buildPresenceReport({
      component: input.env.STRAD_COMPONENT ?? "bundle",
      image: input.env.STRAD_VERSION ?? input.version,
      bootedAt: input.bootedAt,
      env: input.env,
      keys: parsed.keys,
    }),
  };
}
