/**
 * stderr only, and never the token.
 *
 * In the bundle, stdout is a stream strad deliberately does not ship, so a line
 * here is for a human reading container output. Most of the text that reaches
 * an error path was written by DigitalOcean rather than by this server, so
 * `redact` runs over every error a TOOL returns (see tools/shared.ts).
 */

const PREFIX = "[digitalocean]";

/**
 * Anything shaped like a credential. A BACKSTOP — the exact rule (scrub the
 * literal token) lives in client.ts, the only module holding the value.
 *
 * A DigitalOcean token is `dop_v1_` followed by 64 hex characters; the generic
 * run catches one with the prefix stripped and anything else of that shape. The
 * threshold sits above every identifier this server prints: a droplet id is an
 * integer, and an app, database or action UUID is 36 characters with dashes.
 * `/` is deliberately NOT in the run: error messages quote the request path,
 * and `/apps/{uuid}/deployments/{uuid}` joined into one run would redact the
 * very ids a caller needs to see which call failed.
 */
const SECRET_SHAPES: RegExp[] = [
  /\bdo[opr]_v1_[A-Za-z0-9]+/g,
  /[A-Za-z0-9+=_-]{48,}/g,
];

export function redact(message: string): string {
  return SECRET_SHAPES.reduce(
    (text, shape) => text.replace(shape, "[redacted]"),
    message,
  );
}

export function logWarning(message: string): void {
  console.error(`${PREFIX} WARN ${redact(message)}`);
}
