/**
 * What must never reach a caller: the secret access key, and a session's
 * Appium URL.
 *
 * TWO SECRETS, NOT ONE, AND THE SECOND ONE DOES NOT LOOK LIKE A SECRET. The IAM
 * secret access key is the obvious one. The other is `remoteDriverEndpoint`:
 * Device Farm's Appium URL carries its own authorisation IN THE PATH, and
 * `curl <endpoint>/status` answers to anyone holding the string, with no
 * signature and no header. Leak one into an error and the phone somebody is
 * paying for is drivable by whoever read it. So the endpoint never leaves this
 * server: `redact` scrubs it out of every message, and no tool result returns
 * it.
 */

/**
 * The shapes that must not reach a caller or a log line.
 *
 * ORDER MATTERS: the endpoint rule runs first, because the opaque token in its
 * path would otherwise be caught by the generic long-run rule and leave the
 * hostname behind — which is enough to tell a reader which service was in play
 * and not enough to say what was scrubbed.
 *
 * The generic rule is a LENGTH THRESHOLD and therefore trades false positives
 * against false negatives. An AWS secret access key is 40 characters of
 * base64-ish; a session token is longer. Device Farm's own identifiers must
 * survive it: an ARN is long but carries colons and slashes, and the UUID
 * inside one is 36 characters with dashes. 40 is exactly the key length, so the
 * threshold sits there and the ARN segments stay readable.
 */
const SECRET_SHAPES: RegExp[] = [
  // The Appium endpoint, whole: scheme, host and the credential-bearing path.
  /https?:\/\/[^\s"']*\/remote-endpoint\/[^\s"']*/gi,
  /[A-Za-z0-9+/]{40,}={0,2}/g,
];

export function redact(message: string): string {
  return SECRET_SHAPES.reduce(
    (text, shape) => text.replace(shape, "[redacted]"),
    message,
  );
}
