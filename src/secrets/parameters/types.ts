/**
 * The pluggable parameter-store abstraction.
 *
 * A "parameter" is a named value strad manages for one MCP server, addressed by
 * the canonical namespace path (see namespace.ts). It is EITHER non-secret (its
 * value is safe to read back) OR secret (its value is write-and-inject-only).
 *
 * GCP is the FIRST implementation (Parameter Manager as the index of everything,
 * Secret Manager backing the secret parts — see gcp.ts). Nothing about this
 * interface is GCP-specific: it speaks paths, values and notes, not projects,
 * secret ids or `__REF__` strings. A second backend (AWS SSM + Secrets Manager,
 * a self-hosted store) implements the same interface and the console, the MCP
 * server and the resolver do not change.
 *
 * THREE roles touch a store, and they are DIFFERENT credentials on purpose:
 *
 *   - viewer  (the MCP `secrets` server): list parameters, read notes, read
 *             NON-SECRET values. Never a secret value. Lives in servers/secrets
 *             with its own minimal client — it is not built from this interface,
 *             because "the agent's credential physically cannot read a secret" is
 *             a stronger statement than "the code declines to".
 *   - admin   (the SSO-gated console): everything below. A human, behind auth.
 *   - resolver (the runtime injector): read the RESOLVED value of every parameter
 *             in a namespace, to build a child server's environment. Reads secret
 *             values too — but only ever to hand them to a child process, never
 *             to return them over strad's own MCP channel.
 *
 * This file is the ADMIN + RESOLVER surface. The viewer is elsewhere.
 */

/** What the console shows for one parameter. Never a secret value. */
export interface ParameterMeta {
  /** Canonical path, e.g. `/strad/staging/mcp/gcs/static/GCS_BUCKET`. */
  path: string;
  /** The trailing `{VARIABLE_NAME}`. */
  variable: string;
  secret: boolean;
  note?: string;
  /** True once the parameter has a value (non-secret: set; secret: SM has one). */
  hasValue: boolean;
  latestVersion?: string;
  updatedAt?: string;
}

export interface CreateParameterInput {
  path: string;
  secret: boolean;
  value: string;
  note?: string;
}

/**
 * The admin surface: read + write, both kinds. Every method is a human action
 * behind the console SSO gate.
 */
export interface ParameterAdmin {
  /** The backend name, e.g. "gcp". For display only. */
  readonly backend: string;
  /** Every parameter whose path starts with `namespace`. Metadata, no secret value. */
  list(namespace: string): Promise<ParameterMeta[]>;
  create(input: CreateParameterInput): Promise<ParameterMeta>;
  /** Rotate: set a new value. Non-secret → new PM version; secret → new SM version. */
  rotate(path: string, value: string): Promise<void>;
  setNote(path: string, note: string): Promise<void>;
  /**
   * The reveal. Returns the current value of ANY parameter — the admin credential
   * can read Secret Manager. It is never reachable from /mcp.
   *
   * Two callers, both on core. A human behind SSO having clicked reveal, and the
   * parameter write-back route (src/http/params.ts), which reads ONE name for a
   * booting container — a name that server's own `paramsWritable:` allowlist
   * names, in a namespace `params: true` already bakes onto that same container.
   * The second caller learns nothing it did not already hold; what it gains is
   * the value as of NOW rather than as of the last render.
   */
  reveal(path: string): Promise<string>;
  destroy(path: string): Promise<void>;
}

/**
 * The resolver surface: read the resolved values of a whole namespace, to inject
 * as a child server's environment. Secret values are dereferenced here — this is
 * the one backend path that legitimately reads them, because it hands them to a
 * child PROCESS, not to an MCP tool result.
 */
export interface ParameterResolver {
  /**
   * VARIABLE_NAME -> value, for every parameter under `namespace`.
   *
   * FAIL FAST: one parameter that cannot be rendered fails the whole call. That
   * is correct for the injection path — a child started with half its
   * environment looks up and then fails on its first real call — and it is
   * exactly why a diagnostic caller needs `resolveDetailed` instead.
   */
  resolve(namespace: string): Promise<Record<string, string>>;
  /**
   * The same read, with the failures kept apart from the values.
   *
   * Optional because it is a diagnostic, not part of what makes a server run:
   * a backend that cannot separate the two is still a usable resolver, and the
   * console degrades to "the store did not answer" rather than refusing to
   * render. What it buys where it exists is the difference between "this ONE
   * parameter cannot be dereferenced — rotate it" and "the secret backend is
   * down", which are the same symptom and opposite responses.
   */
  resolveDetailed?(namespace: string): Promise<ResolvedNamespace>;
}

export interface ResolvedNamespace {
  /** VARIABLE_NAME -> value, for every parameter that rendered. */
  values: Record<string, string>;
  /**
   * Parameters that EXIST and whose value could not be produced, with a reason
   * describing the failure's shape. Never a body: a `:render` failure's payload
   * is the dereferenced secret.
   *
   * `hard` marks the ones `resolve()` throws on — the failures that propagated
   * out of it before this method existed. A versionless parameter is reported
   * (it resolves to nothing, which the console should say) but is NOT hard,
   * because `resolve()` has always skipped it and returned the rest.
   */
  unrenderable: { variable: string; hard: boolean; reason: string }[];
}

/** A store that provides both admin and resolver surfaces. */
export type ParameterStore = ParameterAdmin & ParameterResolver;

/** A backend error carrying an HTTP status, so callers can explain a 403/404/409. */
export class ParameterStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ParameterStoreError";
  }
}
