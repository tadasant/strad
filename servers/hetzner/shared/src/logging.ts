/**
 * Never the token. Most of the text that reaches an error path was written by
 * Hetzner rather than by this server, so `redact` runs over every error a TOOL
 * returns (see tools/shared.ts).
 */

/**
 * Anything shaped like a credential. A BACKSTOP — the exact rule (scrub the
 * literal token) lives in client.ts, the only module holding the value.
 *
 * A Hetzner Cloud token is 64 alphanumeric characters with no prefix. The
 * threshold sits above every identifier this server prints: a server, image,
 * firewall or action id is an integer, and an SSH key fingerprint is short
 * hex pairs joined by colons. `/` is deliberately NOT in the run: error
 * messages quote the request path, and `/servers/{id}/actions/poweroff` joined
 * into one run would redact the very ids a caller needs to see which call
 * failed.
 */
const SECRET_SHAPES: RegExp[] = [/[A-Za-z0-9+=_-]{48,}/g];

export function redact(message: string): string {
  return SECRET_SHAPES.reduce(
    (text, shape) => text.replace(shape, "[redacted]"),
    message,
  );
}
