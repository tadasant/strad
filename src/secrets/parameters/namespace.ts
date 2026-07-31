import { createHash } from "node:crypto";

/**
 * The canonical namespace scheme, and the wire encoding that backs it.
 *
 * Everything strad manages is addressed by ONE path:
 *
 *     /strad/{env}/mcp/{server-slug}/{kind}/{VARIABLE_NAME}
 *
 * `kind` is `static` for now (an `oauth` kind is a future ticket). A "namespace"
 * is a prefix of that path — the secrets server is scoped to one (e.g.
 * `/strad/staging/mcp/`) and refuses to operate outside it.
 *
 * This module is the SINGLE SOURCE OF TRUTH for how a path maps onto the GCP
 * two-store backend, so the three roles that touch it — the MCP viewer (its own
 * copy, in servers/secrets, kept identical on purpose), the console admin, and
 * the runtime resolver — all address the same underlying resources.
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

/** The trailing `{VARIABLE_NAME}` of a canonical path. */
export function variableOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Encode a canonical path into a legal Parameter Manager / Secret Manager
 * resource id.
 *
 * GCP resource ids are flat and length-bounded (<= 63), so the hierarchical path
 * cannot be the id. This is a deterministic one-way encoding; the exact path is
 * stored in the parameter's payload envelope, so listing never needs to decode
 * an id back into a path. The one property that MUST hold is that the same path
 * always yields the same id — otherwise the admin, the viewer and the resolver
 * would each address a different resource.
 *
 * The same function is reimplemented byte-for-byte in servers/secrets (a separate
 * npm tree that cannot import this one). If you change it here, change it there.
 */
export function parameterId(path: string): string {
  let id = path
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(id)) id = `p-${id}`;
  if (id.length > 63) {
    const hash = createHash("sha256").update(path).digest("hex").slice(0, 8);
    id = `${id.slice(0, 54).replace(/-+$/, "")}-${hash}`;
  }
  return id;
}

/**
 * The Secret Manager reference embedded in a secret parameter's Parameter
 * Manager payload. `:render` dereferences it — for a caller whose credential can
 * reach Secret Manager. The viewer's cannot, which is the whole point.
 */
export function secretRef(projectId: string, secretId: string): string {
  return `__REF__("//secretmanager.googleapis.com/projects/${projectId}/secrets/${secretId}/versions/latest")`;
}

/**
 * Is this value still a POINTER rather than a value?
 *
 * A resolved parameter should never carry one: `:render` is what turns the
 * pointer into the secret. Getting one back means the dereference did not
 * happen — the caller rendered, and the parameter's own principal could not
 * reach the secret behind the ref. A caller that cannot tell the difference
 * reports an un-dereferenced pointer as a value, which is worse than an error,
 * because the pointer is a perfectly good non-empty string.
 */
export function isSecretRef(value: string): boolean {
  return /^__REF__\("\/\/secretmanager\.googleapis\.com\/[^"]+"\)$/.test(value);
}

/**
 * Characters a rendered secret must not contain — the rule the whole encoding
 * below exists to satisfy.
 *
 * A strad parameter is created with `parameter-format=JSON` and its payload is a
 * JSON object. `:render` does NOT rebuild that object: it substitutes the secret's
 * raw bytes into the payload TEXT where the `__REF__(…)` token sits, then checks
 * the result for structural damage. A value carrying a `"` closes the string it
 * landed in; a `\` starts an escape; a raw newline is illegal inside a JSON
 * string; a brace or bracket reads as structure. Any of them and Parameter
 * Manager answers `400 INVALID_ARGUMENT … injection detected`, which is what a
 * `STRAD_TOKENS` JSON array of token records does, every time.
 *
 * This set is a LOWER BOUND on Google's strictness, established from the two
 * things actually known: values containing `"` fail (reproduced against the live
 * API), and the five names seeded in prod render fine — one of which
 * (`OTEL_EXPORTER_OTLP_HEADERS`) carries `,` and `=`, so those are not flagged.
 * Braces, brackets, backslashes and control characters are assumed unsafe rather
 * than demonstrated so.
 *
 * Nothing depends on the boundary being drawn in exactly the right place.
 * `encodeSecretValue` emits `[A-Za-z0-9_-]` only, so it is safe under any
 * detector at least as permissive as "letters, digits, dash and underscore" —
 * comfortably above the strictest rule Parameter Manager could plausibly apply.
 * The predicate exists so the in-memory double can refuse what Google refuses
 * (see `src/secrets/parameters/fake.ts`), and so that refusal and this encoding
 * are derived from ONE statement of the rule.
 */
const RENDER_UNSAFE = /["\\{}[\]]/;

/**
 * Would substituting this value into a JSON parameter payload survive
 * Parameter Manager's injection detection?
 */
export function isRenderSafe(value: string): boolean {
  if (RENDER_UNSAFE.test(value)) return false;
  // Control characters, by code point rather than by a regex literal holding raw
  // control characters — the latter is both unreadable and lint-flagged. A raw
  // byte below 0x20 is illegal INSIDE a JSON string, so a newline or a tab in a
  // secret breaks the payload just as surely as a quote does.
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) return false;
  }
  return true;
}

/**
 * How a parameter version's `value` is encoded.
 *
 * `undefined` — the literal bytes. Every parameter written before strad encoded
 * anything is this, and so is every non-secret parameter: a non-secret value is
 * never substituted by `:render`, so it has nothing to survive, and encoding it
 * would only make the console and the `secrets` MCP viewer display base64 to a
 * human who asked for a value.
 *
 * `base64url` — the value is base64url of the real bytes. This is what every
 * SECRET parameter written from now on carries. Absent is not "unknown": it is a
 * documented state with a documented meaning, which is what lets the five names
 * already seeded in prod keep resolving without being re-seeded.
 */
export type ValueEncoding = "base64url";

/** The encoding every secret value is written with. */
export const SECRET_VALUE_ENCODING: ValueEncoding = "base64url";

/**
 * Encode a secret's bytes for Secret Manager.
 *
 * base64url rather than plain base64, and unpadded: the alphabet is exactly
 * `[A-Za-z0-9_-]`, so the rendered payload contains no `+`, `/` or `=` either.
 * None of those three is JSON-structural, so this is not a correctness argument
 * — it is that the value we substitute into someone else's parser should be the
 * most inert string available, and the cheapest way to never revisit this is to
 * emit nothing that any detector could have an opinion about.
 */
export function encodeSecretValue(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * The JSON envelope stored as a parameter version's payload.
 *
 * A non-secret parameter carries its literal value here. A secret parameter
 * carries a `secretRef()` in `value`; the real value lives in Secret Manager and
 * only a `:render` (with Secret Manager access) resolves it. The envelope also
 * carries the canonical path, the secret flag and the note, so a single
 * version read tells the reader everything about the parameter EXCEPT, for a
 * secret one, its value.
 */
export interface ParameterEnvelope {
  path: string;
  secret: boolean;
  note?: string;
  /** Literal value (non-secret) or a `secretRef()` string (secret). */
  value: string;
  /**
   * How the value behind this envelope is encoded. Absent means the literal
   * bytes. See `ValueEncoding` — the envelope declares it so a reader never has
   * to guess, and so an existing parameter does not have to be rewritten.
   */
  encoding?: ValueEncoding;
}

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
 * Invert `encodeSecretValue` for one raw value, given the encoding its envelope
 * declares. `label` names the parameter in an error; it is never the value.
 */
export function decodeStoredValue(
  value: string,
  encoding: ValueEncoding | undefined,
  label: string,
): string {
  if (encoding === undefined) return value;
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  // Node's base64 decoders are LENIENT — garbage in, garbage out, no error — and
  // the garbage would go straight into a child process's environment as its
  // credential. Re-encode and compare, so a value that is not what its envelope
  // claims fails loudly. The comparison canonicalises the input's alphabet and
  // padding first: a value seeded by hand with standard base64 decodes correctly
  // and must not be rejected for its spelling.
  const canonical = value
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== canonical) {
    throw new Error(
      `parameter "${label}" is labelled ${encoding} but its stored value is not`,
    );
  }
  return decoded;
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
