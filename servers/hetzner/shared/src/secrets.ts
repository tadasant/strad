/**
 * Credentials Hetzner hands back in a result, removed before the result leaves
 * this server.
 *
 * WHAT CARRIES ONE. Creating a server without an SSH key, and rebuilding one,
 * answer with `root_password` — the root login of a machine on the public
 * internet. The two calls that mint one on purpose (`reset_password`,
 * `enable_rescue`) and the one that opens a console (`request_console`, a
 * `wss_url` plus `password`) are not tools here at all; the walk is the
 * backstop for the two that return one as a side effect, and for any field
 * Hetzner adds later under a credential name.
 *
 * THE RULE. Any field whose name ends in a credential word becomes
 * `"[redacted]"`, at any depth. The pattern is anchored at the end, so
 * `password_set` or `token_type` is left alone. A field that is `null` stays
 * `null`: "no password was generated" is information, not a secret.
 */

export const REDACTED = "[redacted]";

const CREDENTIAL_KEY =
  /(^|_)(password|passwd|secret|token|private_key|wss_url)$/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] =
        CREDENTIAL_KEY.test(key) && inner !== null && inner !== undefined
          ? REDACTED
          : redactSecrets(inner);
    }
    return out;
  }
  return value;
}
