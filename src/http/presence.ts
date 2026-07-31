import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import {
  authorizePresence,
  buildPresenceReport,
  parsePresenceRequest,
} from "../secrets/presence.ts";

/**
 * `POST /_strad/presence` — one component answering for its own environment.
 *
 * Mounted on the strad image in BUNDLE mode (see http/app.ts). The bundle host
 * image serves the identical route from its own tree with the vendored copy of
 * `secrets/presence.ts`, so the two speak the same five words.
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
 * The credential is the shared `STRAD_INTERNAL_TOKEN`, which core already
 * presents to proxy `/mcp` to this component. That is deliberate: the token is
 * strictly stronger than this surface, so mounting it widens nothing. Without
 * the token configured the route answers 503 rather than serving anonymously —
 * "on the private network" is a reachability property, not an authorization one.
 */
export interface PresenceHandlerOptions {
  /** This component's own name for itself, for the console's provenance line. */
  component: string;
  /** The image tag it is running, when the spec told it one. */
  image?: string | null;
  env: NodeJS.ProcessEnv;
  /** Injected in tests so boot time is not the clock under test. */
  bootedAt?: Date;
  now?: () => Date;
}

/** Node's constant-time compare, wrapped so a length mismatch cannot throw. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createPresenceHandler(
  opts: PresenceHandlerOptions,
): RequestHandler {
  const bootedAt = opts.bootedAt ?? new Date();

  return (req: Request, res: Response) => {
    const auth = authorizePresence(
      req.get("authorization"),
      opts.env.STRAD_INTERNAL_TOKEN,
      constantTimeEquals,
    );
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    const parsed = parsePresenceRequest(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }

    // Never cached. The answer changes the moment a deploy lands, and a stale
    // "absent" is exactly the thing that would keep a fixed connector looking
    // broken — the failure mode the readiness endpoint refuses for the same
    // reason.
    res.set("cache-control", "no-store").json(
      buildPresenceReport({
        component: opts.component,
        image: opts.image ?? null,
        bootedAt,
        observedAt: opts.now?.(),
        env: opts.env,
        keys: parsed.keys,
      }),
    );
  };
}
