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
  return {
    path: parsed.path,
    secret: parsed.secret,
    note: typeof parsed.note === "string" ? parsed.note : undefined,
    value: parsed.value,
  };
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
