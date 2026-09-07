import type { Request, RequestHandler, Response } from "express";
import { event } from "../telemetry/index.ts";

/**
 * The guard every async Express route in this process wears.
 *
 * ## Why it has to exist
 *
 * This is Express 4. It calls a handler, IGNORES the promise the handler
 * returns, and never routes that promise's rejection to `next(err)` — and there
 * is no error-handling middleware behind these routes to catch it if it did. So
 * a rejected async handler is an unhandled rejection.
 *
 * And in this process an unhandled rejection is FATAL, deliberately and by two
 * separate mechanisms. `src/telemetry/errors.ts` registers an
 * `unhandledRejection` handler that calls `process.exit(1)`; on the path where
 * exception reporting is not configured and that handler is never registered,
 * Node 22's own `--unhandled-rejections=throw` default raises it as an uncaught
 * exception instead. Either way the container dies, and it takes every other
 * in-flight request on it with it.
 *
 * That trade — one caller's error response, or the whole component — is never
 * the right one. So the promise is awaited here, once, at the mount site, and
 * the route's own failure renderer answers the caller.
 *
 * ## Why the renderer is a parameter
 *
 * Because what a failure LOOKS like is the route's decision, not this module's.
 * `/mcp` answers an agent in JSON and says nothing about the error; the console
 * answers a human with an HTML page. The two `renderUnexpected`s in
 * `src/ui/index.ts` and `src/ui/connector.ts` differ from each other on exactly
 * that question, and keeping the renderer out here is what lets them keep
 * differing.
 */
export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
  onError: (res: Response, err: unknown) => void,
): RequestHandler {
  return (req, res) => {
    void handler(req, res).catch((err: unknown) => {
      try {
        onError(res, err);
      } catch (rendering) {
        // A renderer that throws would produce a rejected promise out of this
        // `.catch()` — the exact thing the wrapper exists to prevent, one turn
        // later. Writing to a socket the peer has already destroyed is the
        // realistic way to get here, and it is not worth a process for.
        console.error(
          `[strad] route failure renderer threw: ${
            rendering instanceof Error ? rendering.name : "unknown"
          }`,
        );
      }
    });
  };
}

/**
 * The failure answer for a machine-facing route: a 500 with a fixed body.
 *
 * `route` is one of a handful of words written down at the call sites in this
 * repo, which is what makes it exportable (see `src/telemetry/events.ts`); the
 * error is reduced to its CLASS NAME and goes no further than stderr. That is
 * the same discipline `src/telemetry/redact.ts` keeps everywhere else: an
 * exception raised under `/mcp` can quote a request body or an upstream's
 * response, and neither is text this repo authored.
 *
 * `headersSent` is checked because a handler can fail halfway through a
 * streamed response. There is no status left to set by then; the record of the
 * failure is still worth writing.
 */
export function jsonFailure(
  route: string,
  body: Record<string, unknown> = { error: "internal_error" },
): (res: Response, err: unknown) => void {
  return (res, err) => {
    event({
      evt: "strad.route_failed",
      route,
      error: err instanceof Error ? err.name : "unknown",
    });
    if (res.headersSent) return;
    res.status(500).json(body);
  };
}
