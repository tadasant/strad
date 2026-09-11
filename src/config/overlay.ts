import { z } from "zod";
import { parseYamlDocument } from "./load.ts";
import { StradConfig, type ServerConfig } from "./schema.ts";
import { unknownKeysIn, formatUnknownKey, type UnknownKey } from "./strict.ts";

/**
 * The mutable layer over the checked-in config.
 *
 * ## What it is
 *
 * strad's config is one document, validated at boot, changed by a deploy. That
 * is the right shape for everything in it EXCEPT the server roster, which is
 * the one part a human wants to change at the speed of a thought — add a
 * connector, point it somewhere, use it. This module is the second layer: a
 * small document holding only the DIFFERENCES to the roster, merged over the
 * checked-in one before the schema ever sees it.
 *
 * A diff rather than a replacement, deliberately. An overlay that held the
 * whole document would make the checked-in file decorative the moment anyone
 * pressed Save, and a deployment's YAML would stop describing what it runs.
 * Holding only upserts and removals keeps the file authoritative for everything
 * nobody has touched, makes "what did the console change?" a question with a
 * short answer, and makes an ABSENT overlay byte-for-byte identical to no
 * overlay at all — which is what keeps this off the existing path.
 *
 * ## Where the merge happens
 *
 * At the DOCUMENT level, before Zod. The overlay carries raw entries as they
 * were written, not parsed ones, so defaults are applied exactly once — by the
 * root schema, to the merged document — and a stored entry can never carry a
 * default baked in by the image version that wrote it. An older image reading
 * an overlay written by a newer one therefore applies its OWN defaults, which
 * is what a rollback needs.
 *
 * ## Where validation happens
 *
 * On the WRITE path, strictly, including unknown keys. `src/config/strict.ts`
 * argues that boot must be lenient (a rollback must not become an outage) and
 * that a deploy must be strict (a stripped key did nothing, silently). A console
 * write is the second of those: the human is right here, the error is legible,
 * and nothing is served until they fix it. Boot keeps the lenient rule, and a
 * stored overlay that no longer merges cleanly is DROPPED with a loud event
 * rather than failing the boot — see `mergeOverlay`'s callers.
 */

/** The one parameter the overlay is stored under. */
export function configNamespace(env: string): string {
  return `/strad/${env}/gateway/config/`;
}

/** `/strad/{env}/gateway/config/SERVERS` — the whole overlay, one parameter. */
export function overlayPath(env: string): string {
  return `${configNamespace(env)}${OVERLAY_VARIABLE}`;
}

export const OVERLAY_VARIABLE = "SERVERS";

/**
 * A ceiling on the stored document, in bytes of UTF-8 JSON.
 *
 * Parameter Manager's own payload ceiling is not documented in this repo and
 * the bytes are wrapped in a strad envelope that is itself JSON — so a stored
 * document pays JSON-in-JSON escaping on top of its own size. 64 KiB is the
 * bound the parameter write-back route already applies to a value arriving over
 * the private network (src/secrets/param-route.ts), and matching it keeps one
 * number in the deployment rather than two. A roster large enough to reach it
 * is a roster that belongs in the checked-in document.
 */
export const MAX_OVERLAY_BYTES = 64 * 1024;

/**
 * A server entry, held exactly as it was written.
 *
 * `z.record(z.unknown())` rather than `ServerConfig`: this schema's job is to
 * read the CONTAINER, and the entries inside it are validated by the root
 * schema against the merged document, where the cross-field rules that make a
 * roster coherent (unknown roles, duplicate slugs, a bundle nobody declared)
 * can actually run. Validating an entry twice, once alone and once in context,
 * would mean two answers to "is this legal" and one of them would be wrong.
 *
 * `slug` is the exception, because the merge is keyed by it.
 */
const OverlayEntry = z
  .object({ slug: z.string().min(1) })
  .catchall(z.unknown());

export const ServerOverlay = z.object({
  /** The overlay document's own format version, not strad's config version. */
  version: z.literal(1),
  /**
   * Bumped by one on every write, and echoed back by the form that rendered it.
   *
   * This is the console's optimistic-concurrency check: two tabs open on the
   * same roster, the second Save is refused rather than silently discarding the
   * first. It is NOT a lock on the store — the parameter itself has no
   * compare-and-swap — so two writes landing inside one read-modify-write
   * window can still lose one. Bounded by there being one writer in practice
   * (a human in a console), and stated here rather than implied away.
   */
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().optional(),
  /** The console identity that wrote it. Never a credential, never a value. */
  updatedBy: z.string().optional(),
  servers: z
    .object({
      /** Entries to add, or to replace a checked-in entry of the same slug. */
      upserts: z.array(OverlayEntry).default([]),
      /** Slugs in the checked-in document to drop from the roster. */
      removals: z.array(z.string().min(1)).default([]),
    })
    .default({ upserts: [], removals: [] }),
});

export type ServerOverlay = z.infer<typeof ServerOverlay>;

export const EMPTY_OVERLAY: ServerOverlay = Object.freeze({
  version: 1 as const,
  revision: 0,
  servers: Object.freeze({
    upserts: Object.freeze([]) as never[],
    removals: Object.freeze([]) as never[],
  }),
}) as ServerOverlay;

/** Where a roster entry came from, for the console to say so. */
export type EntrySource = "file" | "store";

/**
 * Parse a stored overlay payload. Throws with a legible message; the caller
 * decides whether that is fatal (a write) or a dropped layer (a boot).
 */
export function parseOverlay(payload: string): ServerOverlay {
  let doc: unknown;
  try {
    doc = JSON.parse(payload);
  } catch {
    throw new Error("the stored server overlay is not JSON");
  }
  const result = ServerOverlay.safeParse(doc);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`the stored server overlay is malformed:\n${problems}`);
  }
  return result.data;
}

export function serialiseOverlay(overlay: ServerOverlay): string {
  return JSON.stringify(overlay);
}

/** `{...}` and nothing else. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The merged DOCUMENT: the checked-in one with removals dropped and upserts
 * applied, keyed by slug and preserving position for a replacement.
 *
 * Position matters more than it looks. `registry.slugs` is "in config order",
 * the console roster sorts from it, and `resolveSelection` reports a selection
 * in it — so an edit that moved an entry to the bottom of the list would
 * reshuffle a page nobody asked to reshuffle. A replacement lands where the
 * original was; only a genuinely new slug is appended.
 *
 * Returns a fresh document. The input is never mutated: the caller still holds
 * the checked-in one, and a failed merge must leave it exactly as it was.
 */
export function mergeOverlay(
  baseDoc: unknown,
  overlay: ServerOverlay,
): unknown {
  if (!isPlainObject(baseDoc)) return baseDoc;

  const base = Array.isArray(baseDoc.servers) ? baseDoc.servers : [];
  const removals = new Set(overlay.servers.removals);

  const kept = base.filter(
    (entry) => !(isPlainObject(entry) && removals.has(String(entry.slug))),
  );

  const merged = [...kept];
  for (const upsert of overlay.servers.upserts) {
    const at = merged.findIndex(
      (entry) => isPlainObject(entry) && entry.slug === upsert.slug,
    );
    if (at >= 0) merged[at] = upsert;
    else merged.push(upsert);
  }

  return { ...baseDoc, servers: merged };
}

/** Which slugs in a merged roster came from the overlay rather than the file. */
export function sourcesFor(
  baseDoc: unknown,
  overlay: ServerOverlay,
): Map<string, EntrySource> {
  const out = new Map<string, EntrySource>();
  if (isPlainObject(baseDoc) && Array.isArray(baseDoc.servers)) {
    for (const entry of baseDoc.servers) {
      if (isPlainObject(entry) && typeof entry.slug === "string") {
        out.set(entry.slug, "file");
      }
    }
  }
  for (const slug of overlay.servers.removals) out.delete(slug);
  for (const upsert of overlay.servers.upserts) out.set(upsert.slug, "store");
  return out;
}

export interface MergeSuccess {
  ok: true;
  config: StradConfig;
  document: unknown;
}

export interface MergeFailure {
  ok: false;
  /** One problem per line, already formatted for a human. */
  problems: string[];
}

export type MergeResult = MergeSuccess | MergeFailure;

/**
 * Validate a merged document the way a deploy would: the full schema, every
 * cross-field rule, AND unknown keys.
 *
 * `strict` is what separates a write from a boot. A console write is a human
 * standing in front of the answer, so a key the schema does not know is an
 * error they can fix in the next five seconds — the same trade
 * `scripts/check-config.ts` makes at deploy time. A boot passes `strict: false`
 * because an older image reading an overlay a newer one wrote must not refuse
 * to start over a key it has not learned yet.
 */
export function validateMerged(
  document: unknown,
  opts: { strict: boolean } = { strict: true },
): MergeResult {
  const result = StradConfig.safeParse(document);
  if (!result.success) {
    return {
      ok: false,
      problems: result.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    };
  }

  if (opts.strict) {
    const unknown: UnknownKey[] = unknownKeysIn(document, result.data);
    if (unknown.length > 0) {
      return {
        ok: false,
        problems: unknown.map((u) => `unknown key: ${formatUnknownKey(u)}`),
      };
    }
  }

  return { ok: true, config: result.data, document };
}

/**
 * Read one server entry from the YAML (or JSON — YAML is a superset) a human
 * typed into the console's advanced field.
 *
 * Returns the raw document, NOT a parsed `ServerConfig`: the entry only means
 * something inside a roster, and `validateMerged` is where it is judged.
 */
export function parseEntryDocument(raw: string): Record<string, unknown> {
  const doc: unknown = parseYamlDocument(raw);
  if (!isPlainObject(doc)) {
    throw new Error("a server entry must be a mapping of fields.");
  }
  return doc;
}

/**
 * The overlay with one entry upserted and `revision` advanced.
 *
 * `previousSlug` is the slug the entry had BEFORE the edit, when a rename is in
 * play. Without it a rename leaves the old slug behind — as a store upsert that
 * nothing shows, or, worse, as a checked-in entry the rename was meant to
 * replace. With it, the rename is a removal plus an upsert, which is what it is.
 */
export function withUpsert(
  overlay: ServerOverlay,
  entry: Record<string, unknown>,
  opts: { previousSlug?: string; fileSlugs: ReadonlySet<string>; by?: string },
): ServerOverlay {
  const slug = String(entry.slug);
  let next = overlay;
  if (opts.previousSlug && opts.previousSlug !== slug) {
    next = withRemoval(next, opts.previousSlug, opts);
  }

  const upserts = next.servers.upserts.filter((u) => u.slug !== slug);
  upserts.push(entry as ServerOverlay["servers"]["upserts"][number]);

  return {
    version: 1,
    revision: next.revision + 1,
    updatedAt: new Date().toISOString(),
    ...(opts.by === undefined ? {} : { updatedBy: opts.by }),
    servers: {
      upserts,
      // An upsert of a slug previously REMOVED un-removes it: the roster is
      // whatever the merge produces, and leaving a slug in both lists would
      // make the result depend on which list the merge reads second.
      removals: next.servers.removals.filter((s) => s !== slug),
    },
  };
}

/**
 * The overlay with one slug gone, and `revision` advanced.
 *
 * Two different deletions wear one verb here. A slug the console ADDED is
 * deleted by dropping its upsert — the roster returns to what the file says,
 * which for a slug the file never named is nothing. A slug the FILE declares
 * cannot be dropped that way, so it is recorded as a removal: a standing
 * instruction to subtract it from the checked-in roster, which survives until
 * someone deletes it from the file or re-adds it here.
 */
export function withRemoval(
  overlay: ServerOverlay,
  slug: string,
  opts: { fileSlugs: ReadonlySet<string>; by?: string },
): ServerOverlay {
  const upserts = overlay.servers.upserts.filter((u) => u.slug !== slug);
  const removals = new Set(overlay.servers.removals);
  if (opts.fileSlugs.has(slug)) removals.add(slug);

  return {
    version: 1,
    revision: overlay.revision + 1,
    updatedAt: new Date().toISOString(),
    ...(opts.by === undefined ? {} : { updatedBy: opts.by }),
    servers: { upserts, removals: [...removals] },
  };
}

/**
 * The overlay with one removal lifted, and `revision` advanced.
 *
 * The inverse of `withRemoval` for a FILE slug: drop the standing instruction
 * to subtract it, and the checked-in entry serves again. A slug that was not
 * removed is left alone rather than erroring, so the operation is idempotent.
 */
export function withRestore(
  overlay: ServerOverlay,
  slug: string,
  opts: { by?: string } = {},
): ServerOverlay {
  return {
    version: 1,
    revision: overlay.revision + 1,
    updatedAt: new Date().toISOString(),
    ...(opts.by === undefined ? {} : { updatedBy: opts.by }),
    servers: {
      upserts: overlay.servers.upserts,
      removals: overlay.servers.removals.filter((s) => s !== slug),
    },
  };
}

/** The slugs the checked-in document declares, for the two functions above. */
export function fileSlugs(baseDoc: unknown): Set<string> {
  const out = new Set<string>();
  if (!isPlainObject(baseDoc) || !Array.isArray(baseDoc.servers)) return out;
  for (const entry of baseDoc.servers) {
    if (isPlainObject(entry) && typeof entry.slug === "string") {
      out.add(entry.slug);
    }
  }
  return out;
}

/**
 * The raw entry for one slug in a merged document — what the edit form loads,
 * and what "copy from this one" copies.
 *
 * Raw rather than parsed, so the form shows what somebody WROTE rather than
 * what Zod filled in around it. A form prefilled with forty defaulted fields is
 * a form that writes forty fields back, and a document that no longer says
 * which of them anyone chose.
 */
export function rawEntry(
  document: unknown,
  slug: string,
): Record<string, unknown> | undefined {
  if (!isPlainObject(document) || !Array.isArray(document.servers)) {
    return undefined;
  }
  for (const entry of document.servers) {
    if (isPlainObject(entry) && entry.slug === slug) return entry;
  }
  return undefined;
}

/**
 * Which kinds may be CREATED at runtime, and why the others may not.
 *
 * This is the honest boundary of the whole feature, and it is enforced here
 * rather than explained in a doc nobody reads before pressing Save.
 *
 * `remote-http` and `local-tunnel` are `isUnhosted()` — `renderAppSpec` skips
 * them entirely, so they occupy no container, no component and no deploy-time
 * env. Everything they need is config data and a `${NAME}` the store already
 * resolves per request. Those two are addable at runtime in the full sense: the
 * registry can build an adapter for them and the next request uses it.
 *
 * `builtin` cannot be, ever: `loadBuiltin` dynamic-imports `module:` out of the
 * running image, so a builtin nobody compiled in has nothing to load.
 *
 * `supplementary-image` is the interesting one and the answer is "sometimes".
 * A NEW slug pointed at a mount that is ALREADY deployed works — that is the
 * `gmail-ro` / `gmail-rw` pattern, two entries on one `path:` differing only by
 * `tools:` — because the adapter is just an HTTP call to a container that is
 * already running. What does NOT work is anything that would have to reach that
 * container's environment: `env:`, `params:`, `consoleEnv:` and the store
 * declarations are baked at RENDER time and fixed at process spawn, so a value
 * added here would be a variable nothing on the container ever reads. So the
 * kind is creatable, and `assertCreatable` refuses the fields that would lie.
 */
export const RUNTIME_CREATABLE_KINDS = [
  "remote-http",
  "local-tunnel",
  "supplementary-image",
] as const;

/** Fields on a `supplementary-image` that only a deploy can deliver. */
export const DEPLOY_ONLY_FIELDS = [
  "env",
  "params",
  "paramsWritable",
  "paramsRefresh",
  "consoleEnv",
  "consoleStores",
  "mcpStores",
] as const;

export class NotRuntimeCreatable extends Error {}

/**
 * Refuse an entry the running process could not actually serve.
 *
 * Called on the write path, BEFORE the merge is validated, so the message names
 * the thing the human can change rather than the schema error it would
 * eventually cause.
 */
export function assertCreatable(
  entry: Record<string, unknown>,
  ctx: {
    config: StradConfig;
    env: NodeJS.ProcessEnv;
    bundleUrl: (b: string) => string | undefined;
  },
): void {
  const kind = entry.kind;
  if (kind === "builtin") {
    throw new NotRuntimeCreatable(
      `A builtin server cannot be added at runtime: its module: is ` +
        `imported out of the running image, so it has to ship with a build. ` +
        `Add it to the checked-in config and deploy.`,
    );
  }
  if (
    typeof kind !== "string" ||
    !(RUNTIME_CREATABLE_KINDS as readonly string[]).includes(kind)
  ) {
    throw new NotRuntimeCreatable(
      `Unknown server kind ${JSON.stringify(String(kind))}. One of: ` +
        RUNTIME_CREATABLE_KINDS.join(", "),
    );
  }

  if (kind !== "supplementary-image") return;

  const declared = DEPLOY_ONLY_FIELDS.filter((field) => {
    const value = entry[field];
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (isPlainObject(value)) return Object.keys(value).length > 0;
    return value !== false;
  });
  if (declared.length > 0) {
    throw new NotRuntimeCreatable(
      `A supplementary server added at runtime may not declare ` +
        `${declared.join(", ")}: those reach the container as env vars baked ` +
        `by the deploy, and a running container cannot be given a new one. ` +
        `Point this entry at a mount that is already deployed, or add it to ` +
        `the checked-in config and deploy.`,
    );
  }

  const bundle = String(entry.bundle ?? "");
  if (!bundle) {
    throw new NotRuntimeCreatable("A supplementary server needs a bundle:.");
  }
  if (!ctx.config.bundles.some((b) => b.name === bundle)) {
    throw new NotRuntimeCreatable(
      `No bundle named ${JSON.stringify(bundle)} is declared under bundles:. ` +
        `A supplementary server added at runtime can only point at a component ` +
        `this deployment already runs.`,
    );
  }
  if (!ctx.bundleUrl(bundle)) {
    throw new NotRuntimeCreatable(
      `The component for bundle ${JSON.stringify(bundle)} is not reachable ` +
        `from this process — the deploy has not bound its private URL. It ` +
        `cannot be routed to until it is deployed.`,
    );
  }
}

/**
 * Fields an EDIT may not change, per kind, because the running deployment could
 * not follow the change.
 *
 * Same argument as `assertCreatable`, from the other side: a `remote-http` url
 * may be re-pointed, because the adapter resolves it per operation, and a
 * supplementary server's `image:` may not, because the image is what the App
 * Platform component is running and only a deploy changes that.
 *
 * Both doors read these messages — the console form and the `connectors` MCP
 * tools — so none of them names one.
 */
export function immutableFields(kind: string): readonly string[] {
  switch (kind) {
    case "supplementary-image":
      return ["kind", "image", "bundle", ...DEPLOY_ONLY_FIELDS];
    case "builtin":
      return ["kind", "module", "bundle", "params"];
    default:
      return ["kind"];
  }
}

export class ImmutableFieldChanged extends Error {}

/** Refuse an edit that moved a field only a deploy can move. */
export function assertEditable(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): void {
  const kind = String(before.kind ?? after.kind ?? "");
  const changed = immutableFields(kind).filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
  if (changed.length > 0) {
    throw new ImmutableFieldChanged(
      `${changed.join(", ")} cannot be changed at runtime on a ` +
        `${kind} server: the deploy is what delivers ${changed.length > 1 ? "those" : "that"}. ` +
        `Change it in the checked-in config and deploy.`,
    );
  }
}

/** Every slug in a parsed config. */
export function slugsIn(config: StradConfig): Set<string> {
  return new Set(config.servers.map((s: ServerConfig) => s.slug));
}

export class SlugCollision extends Error {}

/**
 * Refuse a write that would land on a slug belonging to a DIFFERENT entry.
 *
 * The merge is keyed by slug and replaces in place, so without this a typo in
 * the slug field is not a validation error — it is a silent overwrite. The
 * schema cannot catch it either: `mergeOverlay` dedupes before
 * `validateMerged` runs, so the duplicate-slug rule never sees two of them.
 * The result is a flash that says "saved" and a production server quietly
 * detached from the config that defined it.
 *
 * `replacing` is the slug this write is deliberately targeting — the entry
 * being edited, or, for the upsert-by-slug the MCP tool documents, the slug
 * itself. Writing onto anything else is the accident.
 */
export function assertNoCollision(
  config: StradConfig,
  slug: string,
  replacing: string | undefined,
): void {
  if (slug === replacing) return;
  if (!slugsIn(config).has(slug)) return;
  throw new SlugCollision(
    `A server called ${slug} already exists on this gateway. Edit that entry ` +
      `instead, or choose a different slug — saving this would replace it.`,
  );
}
