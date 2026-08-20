import {
  decodeStoredValue,
  isSecretRef,
  SECRET_VALUE_ENCODING,
  type ParameterEnvelope,
} from "./wire.ts";

/**
 * The canonical namespace scheme.
 *
 * Everything strad manages is addressed by ONE path:
 *
 *     /strad/{env}/mcp/{server-slug}/{kind}/{VARIABLE_NAME}
 *
 * `kind` is `static` for now (an `oauth` kind is a future ticket). A "namespace"
 * is a prefix of that path — the secrets server is scoped to one (e.g.
 * `/strad/staging/mcp/`) and refuses to operate outside it.
 *
 * This module composes and validates those paths, and codes the envelope stored
 * at one. How a path becomes a GCP resource id, and how a value is encoded into
 * the envelope, live in `wire.ts` — that half is vendored into `servers/secrets`
 * and checked by `test/parameter-wire.ownership.test.ts`, because all three roles that
 * touch it (the MCP viewer, the console admin, the runtime resolver) must address
 * the same underlying resources.
 */

/** Build the static-kind namespace for a server slug, e.g. `/strad/staging/mcp/gcs/static/`. */
export function staticNamespace(env: string, slug: string): string {
  return `/strad/${env}/mcp/${slug}/static/`;
}

/**
 * The GATEWAY namespace: `/strad/{env}/gateway/static/`.
 *
 * `/mcp/{slug}/` addresses a parameter that belongs to ONE server. This one
 * addresses the deployment itself — the `${NAME}` references a config makes
 * outside any single server (a remote-http bearer token, a builtin option), plus
 * the gateway's own keys (`STRAD_TOKENS`, `GOOGLE_CLIENT_SECRET`, …).
 *
 * It sits beside `mcp/` rather than above it so the two never collide: no server
 * slug can be `gateway`-shaped into this path, because the segment after `{env}`
 * is a literal, not a slug.
 */
export function gatewayNamespace(env: string): string {
  return `/strad/${env}/gateway/static/`;
}

/** Build a full parameter path for one gateway-level variable. */
export function gatewayParameterPath(env: string, variable: string): string {
  return `${gatewayNamespace(env)}${variable}`;
}

/** Build a full parameter path for one variable under a server's static kind. */
export function parameterPath(
  env: string,
  slug: string,
  variable: string,
): string {
  return `${staticNamespace(env, slug)}${variable}`;
}

/**
 * The envelope CODEC. The envelope's shape is the wire contract (`wire.ts`); the
 * validating read of one is core's alone — `servers/secrets` casts a bare
 * `JSON.parse` at its two parse sites, which is why its unknown-encoding refusal
 * lives in `decodeStoredValue` instead.
 */
export function encodeEnvelope(env: ParameterEnvelope): string {
  return JSON.stringify(env);
}

export function decodeEnvelope(payload: string): ParameterEnvelope {
  const parsed = JSON.parse(payload) as Partial<ParameterEnvelope>;
  if (
    typeof parsed.path !== "string" ||
    typeof parsed.secret !== "boolean" ||
    typeof parsed.value !== "string"
  ) {
    throw new Error("parameter payload is not a strad envelope");
  }
  // An encoding this reader does not know is a HARD failure, not an absent one.
  // Falling back to "literal" would hand the caller an encoded blob dressed as a
  // value — a wrong secret injected into a child process, silently, which is
  // strictly worse than a parameter that does not resolve.
  if (
    parsed.encoding !== undefined &&
    parsed.encoding !== SECRET_VALUE_ENCODING
  ) {
    throw new Error(
      `parameter payload declares an unknown value encoding: ${JSON.stringify(String(parsed.encoding))}`,
    );
  }
  return {
    path: parsed.path,
    secret: parsed.secret,
    note: typeof parsed.note === "string" ? parsed.note : undefined,
    value: parsed.value,
    ...(parsed.encoding === undefined ? {} : { encoding: parsed.encoding }),
  };
}

/**
 * The real value behind a RENDERED envelope.
 *
 * The `isSecretRef` guard is not defensive tidiness. A `:render` that could not
 * dereference hands the pointer back rather than failing, and the pointer is the
 * one string that must reach the caller UNTOUCHED — `checkStore` recognises it to
 * report "present but unrenderable", and base64url-decoding it would turn that
 * diagnosis into a shrug.
 */
export function decodeEnvelopeValue(envelope: ParameterEnvelope): string {
  if (isSecretRef(envelope.value)) return envelope.value;
  return decodeStoredValue(envelope.value, envelope.encoding, envelope.path);
}

/**
 * Normalise a NAMESPACE — an absolute canonical-path prefix like
 * `/strad/prod/mcp/`. Always starts and ends with exactly one `/`.
 */
export function normaliseNamespace(namespace: string): string {
  const trimmed = namespace.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "/" : `/${trimmed}/`;
}

/**
 * Validate a namespace, or return null.
 *
 * The configured `SECRETS_NAMESPACES` list is a CONVENIENCE, not the fence. A
 * human running the console may address any namespace in the project, because
 * the project IS the boundary — an IAM binding the console cannot talk its way
 * past — and a hardcoded list would only ever be a code-level guard over the
 * same credential. Adding a namespace should not require a redeploy.
 *
 * So this checks SHAPE, not membership. What it refuses is a value that would
 * make a malformed or ambiguous path: traversal, empty segments, whitespace,
 * uppercase (a slug is lowercase, and `parameterId` folds case, so an uppercase
 * spelling names a path no resolver matches while colliding with one that does).
 */
export function validateNamespace(namespace: string): string | null {
  const trimmed = namespace.trim();
  if (trimmed === "") return "A namespace is required.";
  if (!trimmed.startsWith("/")) {
    return 'A namespace is an absolute path prefix — it must start with "/", e.g. "/strad/prod/mcp/".';
  }
  if (trimmed.length > 200) {
    return "A namespace may be at most 200 characters.";
  }
  const normalised = normaliseNamespace(trimmed);
  if (normalised === "/") {
    return 'A namespace of "/" would cover every parameter in the project. Name one, e.g. "/strad/prod/mcp/".';
  }
  for (const segment of normalised.slice(1, -1).split("/")) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(segment)) {
      return (
        "A namespace is slash-separated segments of LOWERCASE letters, digits, dots, " +
        'dashes and underscores — e.g. "/strad/prod/mcp/".'
      );
    }
  }
  return null;
}

/**
 * Normalise the PATH PREFIX — the segments between a namespace and the variable
 * name. `""` stays `""`; `"/gcs/static"` becomes `"gcs/static/"`.
 *
 * A namespace is where a parameter is allowed to live; the prefix is where
 * inside it the parameter actually sits, and for a server parameter that prefix
 * (`{slug}/static/`) is what decides which server resolves it. Composing the two
 * separately is what lets the console write a full canonical path without the
 * human typing the namespace again.
 */
export function normalisePathPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "" : `${trimmed}/`;
}

/**
 * Validate a path prefix, or return null.
 *
 * Prefix segments become part of a GCP resource id (see `parameterId`) and part
 * of a path the resolver matches on, so they are bounded to the same alphabet a
 * slug and a `kind` use. `.` and `..` are excluded by the leading-character rule:
 * a segment must start with a lowercase letter or a digit.
 *
 * LOWERCASE IS LOAD-BEARING, not tidiness. A resolver builds the path it reads
 * from the server's slug, which the schema constrains to lowercase, so `GCS/`
 * could never match one. `parameterId` meanwhile lowercases before it hashes, so
 * `GCS/Static/FOO` and `gcs/static/FOO` collapse onto ONE resource id: the
 * uppercase spelling is a path no server reads that collides with the path a
 * server does. Rejecting it is cheaper than explaining it.
 */
export function validatePathPrefix(prefix: string): string | null {
  const trimmed = prefix.trim();
  if (trimmed === "") return null;
  if (trimmed.length > 200) {
    return "A path prefix may be at most 200 characters.";
  }
  const normalised = normalisePathPrefix(trimmed);
  for (const segment of normalised.slice(0, -1).split("/")) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(segment)) {
      return (
        "A path prefix is slash-separated segments of LOWERCASE letters, digits, dots, " +
        'dashes and underscores — e.g. "gcs/static/". A server slug is lowercase, and an ' +
        "uppercase prefix names a path no server resolves."
      );
    }
  }
  return null;
}

/**
 * Validate a variable name for a new parameter.
 *
 * A parameter's variable is injected as an ENVIRONMENT VARIABLE into a server's
 * process, so it must be a legal env var name: it is not free-form. This is the
 * console's first gate; it turns "GCP rejected your id" into a sentence.
 */
export function validateVariableName(variable: string): string | null {
  if (!variable) return "A variable name is required.";
  if (variable.length > 200) {
    return "A variable name may be at most 200 characters.";
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
    return "A variable name must be a valid environment variable name (letters, digits and underscores; not starting with a digit).";
  }
  return null;
}
