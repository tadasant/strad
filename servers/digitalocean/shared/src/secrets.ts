/**
 * Credential material DigitalOcean puts in ordinary READ results, removed from
 * every result this server returns.
 *
 * THIS IS NOT HYPOTHETICAL. `GET /v2/databases/{id}` answers with
 * `connection.password` and a `connection.uri` that embeds it, the same again
 * under `private_connection`, `standby_connection` and
 * `standby_private_connection`, and `users[].password` for every user;
 * `GET /v2/databases/{id}/users` lists every password; a Kafka user carries
 * `access_cert` / `access_key`. A read-only slug that passed those through would
 * hand the agent — and its transcript — the keys to every database on the
 * account. So the rule is: the agent may see that a database exists and how to
 * reach it (host, port, user, database, ssl), never what authenticates it.
 *
 * FOUR RULES, ALL STRUCTURAL rather than per-endpoint, so a field DO adds under
 * a familiar name or a URI in a place nobody listed is still caught:
 *
 *   1. A value under a key whose NAME ends in a credential word (SECRET_KEY_NAME:
 *      `password`, `token`, `api_key`, `access_cert`, `client_secret`,
 *      `registry_credentials`, …) becomes "[redacted]", wherever in the document
 *      it sits — a database's `ui_connection` and `schema_registry_connection`,
 *      a Kafka user's `access_cert`, an app spec's log destination `api_key` or
 *      `token`, an image's `registry_credentials`.
 *   2. An app spec env var — `{key, value, type}` — whose `key` matches the same
 *      pattern, or whose `type` is SECRET, loses its `value`. A plaintext
 *      GENERAL `STRIPE_SECRET` is a credential whatever its type says.
 *   3. Any string carrying `scheme://user:password@` loses the password and
 *      keeps the rest, so the URI still says where and as whom.
 *   4. Any `?password=` / `&token=` / `;pwd=`-style query parameter loses its
 *      value, because a connection string can carry the password there instead.
 *
 * A value DigitalOcean has already encrypted (`EV[…]`) is not a credential and
 * passes through all four, so a SECRET env var read with apps-get-info can be
 * sent back to apps-update unchanged.
 *
 * Applied in tools/shared.ts to every successful payload, not just the database
 * tools: an app spec, a log line or a future endpoint can carry a connection
 * string too, and the cost of walking a result is nothing next to the cost of
 * one leaked.
 *
 * WHAT THIS COSTS A WRITE. A redacted value is a value an agent can no longer
 * send back. apps-update refuses any spec that still carries the marker (see
 * `findRedactionMarkers`) — otherwise the full replace would store the literal
 * text "[redacted]" as the app's database password.
 */

export const REDACTED = "[redacted]";

/**
 * A key whose value is a credential. Anchored at the END and at a `_` (or the
 * start), so `access_token` and `DATABASE_PASSWORD` match and `token_type`,
 * `tokens_count` and `password_expires_at` do not.
 */
export const SECRET_KEY_NAME =
  /(^|_)(password|passwd|secret|token|api_key|apikey|access_key|access_cert|private_key|secret_key|registry_credentials|client_secret)$/i;

/** DigitalOcean's own encrypted form, `EV[1:…:…]` — safe to show and to send back. */
const ENCRYPTED = /^EV\[[^\]]*\]$/;

/**
 * `scheme://user:password@host`. The password run is GREEDY up to the LAST `@`
 * before the host, so `postgres://u:p@ss@h/db` loses `p@ss` rather than leaking
 * `ss`. It stops at `/`, `?`, `#`, whitespace and quotes, which keeps one URI in
 * a JSON log line from running into an `@` further along the line.
 */
const URI_USERINFO =
  /([a-z][a-z0-9+.-]*:\/\/[^\s:@/?#"'<>]*):([^\s/?#"'<>]*)@/gi;

/**
 * `?password=…`, `&token=…`, `;pwd=…` (JDBC and ODBC strings use `;`). The
 * value runs to the next `&`, `;`, whitespace or quote.
 */
const QUERY_SECRET =
  /([?&;](?:password|pwd|sslpassword|token|secret|api_key)=)([^&;\s"']+)/gi;

/** Strip the password out of every `scheme://user:password@` and credential query parameter in a string. */
export function redactUriPasswords(text: string): string {
  return text
    .replace(URI_USERINFO, `$1:${REDACTED}@`)
    .replace(QUERY_SECRET, `$1${REDACTED}`);
}

/** A deep copy of `value` with every credential removed. */
export function redactSecrets<T>(value: T): T {
  return walk(value) as T;
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

function encrypted(value: unknown): boolean {
  return typeof value === "string" && ENCRYPTED.test(value);
}

/** An app spec env var, `{key, value, type?, scope?}`, whose value is a credential. */
function secretEnv(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.key === "string" &&
    "value" in obj &&
    (SECRET_KEY_NAME.test(obj.key) || obj.type === "SECRET")
  );
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return redactUriPasswords(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const env = secretEnv(obj);
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(obj)) {
      const credential = SECRET_KEY_NAME.test(key) || (env && key === "value");
      out[key] =
        credential && present(inner) && !encrypted(inner)
          ? REDACTED
          : walk(inner);
    }
    return out;
  }
  return value;
}

/**
 * Every place in `value` that still carries the REDACTED marker, as a path
 * (`spec.services[0].envs[1].value`). In a string value or in a key, at any
 * depth, anywhere in the string — a URI with `:[redacted]@` in it counts.
 */
export function findRedactionMarkers(value: unknown, path = ""): string[] {
  if (typeof value === "string") return value.includes(REDACTED) ? [path] : [];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findRedactionMarkers(v, `${path}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, inner]) => {
      const at = path === "" ? key : `${path}.${key}`;
      return [
        ...(key.includes(REDACTED) ? [at] : []),
        ...findRedactionMarkers(inner, at),
      ];
    });
  }
  return [];
}
