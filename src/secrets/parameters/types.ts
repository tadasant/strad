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

/** `listDetailed()`'s answer. See `ParameterAdmin.listDetailed`. */
export interface ParameterListing {
  parameters: ParameterMeta[];
  /**
   * Parameters that exist and whose current version could not be read, by
   * store id — the path is inside the envelope nobody could read. The error is
   * carried unclassified, as `ConsoleReadGrant.error` is: the caller that
   * shows it reduces it to a sentence with the same function it uses for every
   * other store failure, so the two cannot disagree about what a `429` means.
   */
  unreadable: { id: string; error: unknown }[];
  /** When the reading this came from was taken, epoch ms. */
  readAt?: number;
}

export interface CreateParameterInput {
  path: string;
  secret: boolean;
  value: string;
  note?: string;
  /**
   * Also let the CONSOLE'S OWN credential read this secret back — on this one
   * secret, never at project level.
   *
   * Off by default, because §1 of docs/operate/secrets-iam.md runs the console
   * write-without-read on purpose. The ONE value that has to be exempt is a
   * declared `oauth:` connector's OAuth client: the consent flow reveals the
   * client id before it redirects and both halves at the callback, with the
   * console's credential, so a client the console cannot read is a **Connect**
   * that 403s after a human has already consented.
   *
   * WHETHER A PATH QUALIFIES IS THE CALLER'S TO DECIDE, FROM CONFIG. This
   * interface speaks paths and values; it has no idea what a connector is, and
   * a store that took the question from a request would let a request name the
   * secret the console may read. `isConnectorClientPath` (src/connectors) is the
   * one derivation, and both the create form and the repair button go through it.
   */
  consoleReadable?: boolean;
}

/**
 * What binding the console's own credential to one secret actually achieved.
 *
 * `readable` is the whole point, and it is MEASURED rather than assumed: an IAM
 * deny policy (docs/operate/secrets-iam.md §1 recommends one) is evaluated
 * before any allow and cannot be granted around, so a `setIamPolicy` that
 * returns 200 proves nothing about whether the value can be read. The store
 * writes the binding and then reads the value back, and reports what happened.
 *
 * `error` is the read's own rejection, carried unclassified: the console turns
 * it into a sentence with the same `clientReadFailure` that writes the refusal,
 * so the button and the 403 it repairs cannot disagree about what a 403 means.
 * The VALUE that was read is never carried — it is read and dropped.
 */
export interface ConsoleReadGrant {
  /** True when the policy was actually written; false when it already said this. */
  changed: boolean;
  /** Did a read of the value succeed AFTER the write? */
  readable: boolean;
  /** Why it did not, when it did not. Never a value. */
  error?: unknown;
}

/**
 * The admin surface: read + write, both kinds. Every method is a human action
 * behind the console SSO gate.
 */
export interface ParameterAdmin {
  /** The backend name, e.g. "gcp". For display only. */
  readonly backend: string;
  /**
   * Every parameter whose path starts with `namespace`. Metadata, no secret value.
   *
   * STRICT: a parameter the store could not read fails the call, because it may
   * be one of this namespace's and a caller deciding what exists must not be
   * told it does not.
   */
  list(namespace: string): Promise<ParameterMeta[]>;
  /**
   * The same listing for a human to look at: what could be read, plus the
   * parameters that could not and may belong here.
   *
   * Optional because it is a presentation of `list()`, not a capability; the
   * console falls back to `list()` where it is absent. What it buys where it
   * exists is a page that shows ninety-nine parameters and names the hundredth,
   * instead of an empty namespace because one read was throttled.
   */
  listDetailed?(namespace: string): Promise<ParameterListing>;
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
  /**
   * Give this console's OWN credential read access to one secret parameter, and
   * report whether the value can now actually be read.
   *
   * The REPAIR half of `CreateParameterInput.consoleReadable`: a connector
   * seeded before strad made that grant is stuck, and this is the click that
   * unsticks it. Same binding, same one secret, same verification.
   *
   * Optional because it is a statement about per-resource IAM, which not every
   * backend has. A store without it makes the console say so rather than offer
   * a button that does nothing — see `resolveDetailed` for the same shape.
   *
   * THE CALLER DECIDES WHICH PATHS ARE ELIGIBLE. Nothing here knows a connector
   * from any other parameter, so a caller that passed an arbitrary path would
   * be handing the console read access to an arbitrary secret.
   */
  grantConsoleRead?(path: string): Promise<ConsoleReadGrant>;
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
  /**
   * Drop whatever reading of the store this resolver holds, so the next read
   * reaches it.
   *
   * Optional because a resolver that holds nothing has nothing to drop. Where
   * it exists it is the runtime provider's `invalidate()` and its miss-driven
   * refresh — the two signals, besides the TTL, on which a running gateway
   * re-reads the store. See `snapshot()` in gcp.ts.
   */
  forget?(): void;
  /**
   * How old the held reading is, in ms; `Infinity` when nothing is held.
   *
   * What lets a caller chasing a miss tell "the store was read a moment ago
   * and the name is not there" from "the name may have been added since".
   */
  snapshotAgeMs?(): number;
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
  unrenderable: {
    variable: string;
    hard: boolean;
    reason: string;
    /**
     * The failure was a moment — a throttle, a server error, a timeout — and
     * not the store's settled answer about the parameter. A resolver holding a
     * snapshot does not remember a render that carries one.
     */
    transient?: boolean;
  }[];
  /**
   * When the reading these values came from was taken, epoch ms.
   *
   * A resolver that holds a snapshot answers from it, so a value is a claim
   * about the store AS OF this moment rather than as of the call. Absent from a
   * resolver that reads live.
   */
  readAt?: number;
}

/** A store that provides both admin and resolver surfaces. */
export type ParameterStore = ParameterAdmin & ParameterResolver;

/** A backend error carrying an HTTP status, so callers can explain a 403/404/409. */
export class ParameterStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * The delay the API itself named in `Retry-After`, in ms, when it sent one.
     *
     * Carried on the error rather than handled where the `Response` was, so the
     * one place that decides whether to try again decides it from one shape.
     * Absent on every locally-constructed error — nothing local knows when the
     * store will next answer.
     */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ParameterStoreError";
  }
}

/**
 * The stored payload would not decode into a strad envelope.
 *
 * A `ParameterStoreError` subclass rather than a class of its own so that every
 * existing caller keeps treating it as one — including `errorSummary`
 * (`src/util/error-text.ts`), which decides by `err.name`. The name is
 * DELIBERATELY inherited: the message this carries is method plus resource, the
 * one shape on a store path that is known not to hold a value, and renaming the
 * class would reduce it to a bare word on the console page that shows it.
 *
 * What the subclass buys is the `instanceof` the console keys on to write the
 * operator a sentence about what to do next — see `describe()` in
 * `src/ui/index.ts`. The parse error that provoked it is DROPPED at the throw
 * site and is not chained as a `cause`: `JSON.parse` embeds a window of its
 * input in its `SyntaxError`, and here that input is the stored payload.
 */
export class UnreadablePayloadError extends ParameterStoreError {
  constructor(resource: string) {
    super(
      `GET ${resource} failed: the stored payload is not a readable strad envelope`,
      502,
    );
  }
}
