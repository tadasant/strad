import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { presenceResponse } from "../secrets/presence.ts";

/**
 * `POST /_strad/presence` — one component answering for its own environment.
 *
 * Mounted on the strad image in BUNDLE mode (see http/app.ts). This file is the
 * express half and nothing else: the route itself is `presenceResponse` in
 * `secrets/presence.ts`, vendored into the bundle host tree, so the two
 * components serve one implementation rather than two that merely agree.
 *
 * ## Why this surface exists at all
 *
 * The console runs on core. A supplementary server's `env:` and a `params: true`
 * server's managed parameters are resolved at render time and baked onto their
 * own component — `appspec.ts` deliberately does not broadcast them, because the
 * broadcast is what would put a credential in every container. The correct
 * scoping is exactly what makes the value invisible to the page that reports on
 * it, and the page's honest answer was "this could not be checked", for most of
 * the fleet, forever.
 *
 * The alternative designs, and why not:
 *
 *   - Derive it from `render-spec`. That is a claim about the last DEPLOY, not
 *     about the process running now. A container can predate the render, a
 *     rollback re-runs an older spec, and App Platform can drop a var. It would
 *     have said "plumbed" about a process holding nothing, which is the exact
 *     failure the console exists to catch.
 *   - Probe the upstream with the credential. That is an oracle by construction
 *     — it confirms a specific secret is valid — it spends third-party calls on
 *     a page load, and it cannot tell "credential rejected" from "upstream down".
 *     strad's whole posture is that seeded is not working; a liveness probe
 *     blurs the two rather than separating them.
 *   - Read the deployed app spec from the DigitalOcean API. Needs a new cloud
 *     credential in core, and still describes the spec rather than the process.
 *
 * ## What a caller learns, and what it does not
 *
 * Presence, source and freshness for names it names. Never a value, a length, a
 * prefix or a hash — `secrets/presence.ts` is where that line is drawn and
 * `test/presence.test.ts` is what holds it.
 *
 * The credential is this component's own `STRAD_INTERNAL_TOKEN`, which core
 * already presents to proxy `/mcp` to it. Each component holds only its own
 * (src/auth/internal-token.ts), so a sibling container cannot ask this one.
 * That is deliberate: the token is strictly stronger than this surface, so mounting it widens nothing. Without
 * the token configured the route answers 503 rather than serving anonymously —
 * "on the private network" is a reachability property, not an authorization one.
 */
export interface PresenceHandlerOptions {
  /**
   * The environment this component answers ABOUT, and also the one it answers
   * AS: `presenceResponse` reads `STRAD_COMPONENT`, `STRAD_BUNDLE` and
   * `STRAD_VERSION` out of it for the provenance line. Core supplies no
   * fallback for either, where the host image knows its own package version.
   */
  env: NodeJS.ProcessEnv;
  /** Injected in tests so boot time is not the clock under test. */
  bootedAt?: Date;
  now?: () => Date;
}

export function createPresenceHandler(
  opts: PresenceHandlerOptions,
): RequestHandler {
  const bootedAt = opts.bootedAt ?? new Date();

  return (req: Request, res: Response) => {
    const answer = presenceResponse({
      authorization: req.get("authorization"),
      body: req.body,
      env: opts.env,
      bootedAt,
      now: opts.now,
      // The shared module stays import-free so it can be vendored; this caller
      // has node:crypto, so it passes the real constant-time compare in.
      timingSafeEqual,
    });
    res.status(answer.status).set(answer.headers).json(answer.body);
  };
}
