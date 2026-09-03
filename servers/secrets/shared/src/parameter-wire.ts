// GENERATED — DO NOT EDIT.
// Vendored from src/secrets/parameters/wire.ts by `npm run wire:sync`.
// Edit the source, run the sync, and commit both. CI fails if these drift.
import { createHash } from "node:crypto";

/**
 * The parameter WIRE: everything two independent npm trees have to agree on
 * byte-for-byte in order to address, write and read the same GCP parameter.
 *
 * ## Why this file exists on its own
 *
 * `servers/secrets` is a separate npm project with its own lockfile, its own
 * compiler settings and its own image, so it cannot import this one — and it
 * writes to the SAME two-store backend the console and the runtime resolver
 * write to. Every rule below is therefore duplicated across the boundary by
 * VENDORING: `npm run wire:sync` copies this file verbatim into
 * `servers/secrets/shared/src/parameter-wire.ts`, and
 * `test/vendored.sync.test.ts` fails CI when the copy drifts.
 * `test/parameter-wire.ownership.test.ts` is the seam's other half: byte
 * identity cannot see that tree growing a SECOND implementation beside the
 * copy, and that test can.
 *
 * Edit this file. Never edit the copy.
 *
 * ## Why the check is not optional
 *
 * The rest of this subsystem is built to fail loudly, and this seam is the
 * exception (`HACKS.md` #33). A reader that does not know the `encoding` field
 * exists hands a child process base64url TEXT as its credential and reports
 * success; an id encoding that folds one character differently addresses a
 * resource the other half cannot see. Both halves keep answering, wrongly. A
 * comment asking two humans to stay in lockstep was what stood between that and
 * production, and it had already failed once.
 *
 * ## What belongs here
 *
 * Anything whose disagreement between the trees would be silent: the id fold,
 * the value encoding, the predicates that decide whether a value is safe or
 * already dereferenced, and the envelope shape that carries them. Namespace
 * composition, path validation and the envelope codec stay in `namespace.ts` —
 * `servers/secrets` has no copy of those, so they have nothing to drift against.
 */

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
 * SECRET parameter carries. Absent is not "unknown": it is a documented state
 * with a documented meaning, which is what lets the names seeded in prod before
 * the encoding keep resolving without being re-seeded.
 */
export type ValueEncoding = "base64url";

/** The encoding every secret value is written with. */
export const SECRET_VALUE_ENCODING: ValueEncoding = "base64url";

/**
 * The JSON envelope stored as a parameter version's payload — the wire contract
 * between the console writer, the runtime resolver and the `secrets` MCP viewer.
 *
 * A non-secret parameter carries its literal value here. A secret parameter
 * carries a `secretRef()` in `value`; the real value lives in Secret Manager and
 * only a `:render` (with Secret Manager access) resolves it. The envelope also
 * carries the canonical path, the secret flag and the note, so a single version
 * read tells the reader everything about the parameter EXCEPT, for a secret one,
 * its value.
 */
export interface ParameterEnvelope {
  /** The canonical path, e.g. `/strad/staging/mcp/<slug>/static/<VAR>`. */
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
 *
 * Anchored and exact: a `startsWith` would also claim a literal value that
 * merely begins `__REF__(`.
 */
export function isSecretRef(value: string): boolean {
  return /^__REF__\("\/\/secretmanager\.googleapis\.com\/[^"]+"\)$/.test(value);
}

/**
 * A stored value that cannot be trusted to be what its envelope says it is.
 *
 * Its own class rather than a bare `Error` because it is the loud half of the
 * one seam that would otherwise fail silently, and because both trees throw it:
 * a caller that wants to distinguish "the store answered something impossible"
 * from "the API said 404" can.
 */
export class ValueEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueEncodingError";
  }
}

/**
 * Invert `encodeSecretValue` for one raw value, given the encoding its envelope
 * declares. `label` names the parameter in an error; it is never the value.
 */
export function decodeStoredValue(
  value: string,
  // `string | undefined`, deliberately, rather than `ValueEncoding | undefined`.
  // This is the last gate before a value reaches a process, and what it is
  // gating is JSON out of a store that a future strad — or a hand-edit — may
  // have written. A type describes what this code emits; it cannot enforce what
  // is already in the store.
  encoding: string | undefined,
  label: string,
): string {
  if (encoding === undefined) return value;
  if (encoding !== SECRET_VALUE_ENCODING) {
    throw new ValueEncodingError(
      `parameter "${label}" declares an unknown value encoding: ${JSON.stringify(encoding)}`,
    );
  }
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
    throw new ValueEncodingError(
      `parameter "${label}" is labelled ${encoding} but its stored value is not`,
    );
  }
  return decoded;
}

/**
 * Encode a canonical path into a legal Parameter Manager / Secret Manager
 * resource id.
 *
 * GCP resource ids are constrained to `[a-z]([a-z0-9-]){0,62}` — lowercase,
 * letter-initial, at most 63 characters — which a canonical path (mixed case,
 * `/` and `_`, often long) does not satisfy, so it is folded down:
 *
 *   1. drop the leading `/`;
 *   2. lowercase;
 *   3. replace every run of characters outside `[a-z0-9]` with a single `-`;
 *   4. trim leading and trailing `-`;
 *   5. if it does not start with a letter, prefix `p-`;
 *   6. if longer than 63, keep the first 54 characters — trimmed of any trailing
 *      `-`, so the id never carries a double dash — and append `-` plus the first
 *      8 hex of sha256(path). The fold above is lossy, and two long paths can
 *      collapse onto the same 54-character head; the hash is what separates them.
 *
 * This is a deterministic one-way encoding; the exact path is stored in the
 * parameter's payload envelope, so listing never needs to decode an id back into
 * a path, and a get can verify the round trip. The one property that MUST hold is
 * that the same path always yields the same id — otherwise the admin, the viewer
 * and the resolver would each address a different resource.
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
 * The trailing `{VARIABLE_NAME}` of a canonical path: everything after the FINAL
 * `/`, whatever that is.
 *
 * A path that ends in `/` is a NAMESPACE, and a namespace has no variable — so
 * this answers `""` for one. Taking the last NON-EMPTY segment instead would
 * answer `static` for `/strad/prod/mcp/gcs/static/`, and that name would travel
 * into a tool response and onto a console row as if a variable by that name
 * existed. An empty string is visibly wrong where `static` is invisibly wrong.
 */
export function variableOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
