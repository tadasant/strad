import { z } from "zod";
import { parseYamlDocument } from "./load.ts";
import { StradConfig, type ServerConfig } from "./schema.ts";
import { unknownKeysIn, formatUnknownKey, type UnknownKey } from "./strict.ts";
import {
  INSTANCE_PATH_PREFIX,
  INSTANCE_TREES,
  isInstancePath,
  parseInstancePath,
} from "../secrets/param-route.ts";

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

/**
 * Fields on a `supplementary-image` that only the CHECKED-IN config may set,
 * on create or edit, for a reason other than delivery.
 *
 * `confirmations:` hands a caller's approval URL to a mount, and
 * `confirmationHeaders:` sends a value core resolves out of the store to that
 * URL, a path the caller picks under `gateway.elicitation.allowedUrlPrefixes`.
 * A roster write could otherwise aim any `${NAME}` the namespace or the shared
 * layer resolves off the box. Where a stored credential is sent is a decision
 * for a reviewed change to the checked-in config, not for a roster write.
 */
export const CHECKED_IN_ONLY_FIELDS = [
  "confirmations",
  "confirmationHeaders",
] as const;

/** Set to anything but its default. */
function isDeclared(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return value !== false;
}

/**
 * The deploy-only fields a runtime write MAY declare on a store-served instance
 * — `path: /_instance/{tree}/{its own slug}` — because the instance honours them
 * without a deploy.
 *
 * Only `params`. On an instance it means what it means everywhere — "this
 * server's environment is its own namespace" — delivered when the bundle host
 * asks core rather than baked at render. The other six still describe delivery
 * through the render (`env:`, `consoleEnv:`), a write-back no instance tree
 * performs (`paramsWritable:`), a poll every sync already subsumes
 * (`paramsRefresh:`), or the secrets server's own stores.
 */
export const HONOURED_ON_AN_INSTANCE = ["params"] as const;

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

  const checkedIn = CHECKED_IN_ONLY_FIELDS.filter((f) => isDeclared(entry[f]));
  if (checkedIn.length > 0) {
    throw new NotRuntimeCreatable(
      `A supplementary server added at runtime may not declare ` +
        `${checkedIn.join(", ")}: they send a caller's approval URL, and a ` +
        `credential resolved from the store, off the box. Where that goes is ` +
        `set in the checked-in config and shipped by a deploy.`,
    );
  }

  // A STORE-SERVED INSTANCE is the one supplementary shape that brings its own
  // credential without a deploy: its path names a tree and its own slug, and
  // the bundle host reads that slug's namespace through core when it asks. So
  // `params: true` — "my environment is my namespace" — is honoured on one, and
  // is exactly what the schema requires of one. Every other deploy-only field
  // still describes delivery through the render, which an instance never gets.
  const instance = isInstancePath(String(entry.path ?? "/mcp"));
  const declared = DEPLOY_ONLY_FIELDS.filter((field) => {
    if (
      instance &&
      (HONOURED_ON_AN_INSTANCE as readonly string[]).includes(field)
    ) {
      return false;
    }
    const value = entry[field];
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (isPlainObject(value)) return Object.keys(value).length > 0;
    return value !== false;
  });
  if (declared.length > 0) {
    throw new NotRuntimeCreatable(
      instance
        ? `A store-served instance added at runtime may not declare ` +
            `${declared.join(", ")}: an instance is credentialed from its own ` +
            `namespace when the bundle asks, and nothing about it is rendered onto ` +
            `the container — so these would be baked where no instance reads ` +
            `them, or (paramsRefresh) repeat what every sync already does. Seed ` +
            `the values under this slug's own namespace and keep params: true.`
        : `A supplementary server added at runtime may not declare ` +
            `${declared.join(", ")}: those reach the container as env vars baked ` +
            `by the deploy, and a running container cannot be given a new one. ` +
            `Point this entry at a mount that is already deployed; or, for ` +
            `${INSTANCE_TREES.join(", ")}, give it credentials of its own with ` +
            `path: ${INSTANCE_PATH_PREFIX}/{tree}/{its own slug} and params: true; ` +
            `or add it to the checked-in config and deploy.`,
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
 * Fields an EDIT may not change, per kind.
 *
 * Most of them are here for the `assertCreatable` reason read from the other
 * side: a `remote-http` url may be re-pointed, because the adapter resolves it
 * per operation, and a supplementary server's `image:` may not, because the
 * image is what the App Platform component is running and only a deploy
 * changes that.
 *
 * `path:` is here for a different reason, and it is the sharper one. A
 * supplementary `path:` selects WHICH MOUNT inside an already-running container
 * the slug reaches, and the credential the mount answers with belongs to the
 * container rather than to this entry. So a re-point is not "the same server
 * somewhere else": it is this slug's `entitlements:` and this slug's `tools:`
 * pointed at a DIFFERENT upstream, whose own slug's narrower policy stays
 * attached to that slug and is inherited by nothing. A slug reachable by a
 * fleet key that could be re-pointed at `/onepassword` would put 1Password
 * within reach of whatever can write the roster. `assertNoAccessControlChange`
 * carries the other half of this, for a slug the checked-in document declares.
 *
 * Both doors read these messages — the console form and the `connectors` MCP
 * tools — so none of them names one.
 */
export function immutableFields(kind: string): readonly string[] {
  switch (kind) {
    case "supplementary-image":
      return [
        "kind",
        "image",
        "bundle",
        "path",
        ...DEPLOY_ONLY_FIELDS,
        ...CHECKED_IN_ONLY_FIELDS,
      ];
    case "builtin":
      return ["kind", "module", "bundle", "params"];
    default:
      return ["kind"];
  }
}

export class ImmutableFieldChanged extends Error {}

/** Refuse an edit that moved a field a runtime write may not move. */
export function assertEditable(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): void {
  const kind = String(before.kind ?? after.kind ?? "");
  const changed = immutableFields(kind).filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
  if (changed.length === 0) return;

  // `path:` is the one field in the list the deploy does not "deliver", so the
  // stock sentence would be a wrong explanation of it rather than a terse one.
  const checkedIn = changed.filter((field) =>
    (CHECKED_IN_ONLY_FIELDS as readonly string[]).includes(field),
  );
  const delivered = changed.filter(
    (field) => field !== "path" && !checkedIn.includes(field),
  );
  const why =
    (delivered.length > 0
      ? `The deploy is what delivers ${delivered.join(", ")}. `
      : "") +
    (changed.includes("path")
      ? `path: chooses which mount inside the container this slug reaches, and ` +
        `the credential there belongs to the container — so re-pointing it ` +
        `would reach an upstream this entry was never authorised for, under ` +
        `the entitlements: and tools: it already has. `
      : "") +
    (checkedIn.length > 0
      ? `${checkedIn.join(", ")} decide${checkedIn.length > 1 ? "" : "s"} ` +
        `where a caller's approval URL and a stored credential are sent off ` +
        `the box, which only the checked-in config may say. `
      : "");

  throw new ImmutableFieldChanged(
    `${changed.join(", ")} cannot be changed at runtime on a ` +
      `${kind} server. ${why}` +
      `Change ${changed.length > 1 ? "them" : "it"} in the checked-in config ` +
      `and deploy, or point a NEW slug at the upstream you want.`,
  );
}

/** Every slug in a parsed config. */
export function slugsIn(config: StradConfig): Set<string> {
  return new Set(config.servers.map((s: ServerConfig) => s.slug));
}

export class SlugCollision extends Error {}
export class AccessControlChanged extends Error {}

/** What each bound field decides, so the refusal can say which one moved. */
const ACCESS_FIELDS: Record<string, string> = {
  entitlements: "who reaches this server",
  tools: "which of its tools they get",
  kind: "what kind of upstream it is, and so which credential it is handed",
  bundle:
    "which container it reaches, and so which credentials are on the far end",
  path: "which mount inside the container it reaches, and so which credential",
};

/**
 * The bound fields of an entry, compared without caring about order or absence.
 *
 * Two groups. `entitlements:` and `tools:` are the access-control decisions
 * themselves. `kind:`, and for a supplementary entry `bundle:` and `path:`, are
 * the UPSTREAM IDENTITY — which credential is on the far end of this slug — and
 * they are here because `immutableFields` already freezes all three on the EDIT
 * path, so leaving them out of this comparison would mean the same move is
 * refused as one call and allowed as two (remove, then re-create).
 *
 * `withMount` is decided by the CHECKED-IN entry's kind rather than the
 * candidate's, so re-creating a supplementary slug as some other kind is
 * compared too rather than slipping out of the comparison by dropping the
 * field. `/mcp` is the schema's own default for an absent `path`, applied here
 * so that writing it explicitly is not read as a change.
 */
function accessShape(
  entry: Record<string, unknown> | undefined,
  withMount: boolean,
): Record<string, string> {
  const list = (v: unknown) =>
    JSON.stringify(Array.isArray(v) ? [...v].map(String).sort() : []);
  const tools = isPlainObject(entry?.tools) ? entry.tools : {};
  return {
    entitlements: list(entry?.entitlements),
    tools: JSON.stringify({ allow: list(tools.allow), deny: list(tools.deny) }),
    kind: String(entry?.kind ?? ""),
    ...(withMount
      ? {
          bundle: String(entry?.bundle ?? ""),
          path: String(entry?.path ?? "/mcp"),
        }
      : {}),
  };
}

/**
 * A runtime write may not change WHO reaches a server the checked-in document
 * declares, WHICH of its tools they get there, or WHICH UPSTREAM it is.
 *
 * `entitlements:` and `tools:` are strad's two access-control decisions, and
 * both are on the merge gate's permanent hold list — the ones where "the cost
 * of being wrong is a disclosure no revert reaches". A roster editor that can
 * move them is an access-control editor, and for a server the DEPLOY
 * authorised, that authority belongs to the deploy: a human wrote those lines
 * and a human reviewed them.
 *
 * The slug's UPSTREAM IDENTITY is the third, because it decides the same thing
 * from the far end: `kind:` on any entry, plus `bundle:` and `path:` on a
 * supplementary one. Several mounts share one container, each with the
 * credential the deploy baked in for it, and each fronted by its own slug with
 * its own `entitlements:` and `tools:`. Re-pointing a slug at a neighbouring
 * mount inherits NEITHER of that neighbour's protections — the narrow policy
 * stays attached to the slug that declares it, while the credential on the
 * other end does not. Since `?servers=` is a filter and not an authorization, a
 * widely-entitled slug that could be re-pointed at a narrowly-entitled mount is
 * that mount's access control undone. `kind:` carries it because a `local-tunnel`
 * the file declares, re-created as a `supplementary-image`, is that same move
 * wearing a different field: the slug name keeps the reach the deploy granted it
 * while the thing on the other end becomes a mount nobody granted.
 *
 * Keyed on the checked-in document rather than on "is this an edit", because
 * the alternative has an obvious way around it. Removing a file-declared slug
 * and re-creating it through the overlay is, structurally, a create — so a rule
 * that only bound edits would be bypassed by two calls instead of one. A slug
 * the file names is bound however the write arrives, and stays bound while a
 * removal is standing. (`immutableFields` binds all three identity fields on the
 * EDIT path, this binds them on both paths for a file-declared one, and it is
 * this one that closes remove-then-recreate.)
 *
 * A slug only the OVERLAY declares is unbound: nothing in the checked-in
 * document is being overruled, and giving a connector you just created a role
 * is the feature rather than an escalation.
 */
export function assertNoAccessControlChange(
  baseDoc: unknown,
  entry: Record<string, unknown>,
): void {
  const declared = rawEntry(baseDoc, String(entry.slug));
  assertNoReachChange(declared, entry);
  if (!declared) return;

  const withMount = declared.kind === "supplementary-image";
  const before = accessShape(declared, withMount);
  const after = accessShape(entry, withMount);
  const moved = Object.keys(before).filter((f) => before[f] !== after[f]);
  if (moved.length === 0) return;

  throw new AccessControlChanged(
    `${moved.map((f) => `${f}:`).join(", ")} cannot be changed at runtime on ` +
      `${String(entry.slug)}, because the checked-in config declares it. ` +
      `${moved.length > 1 ? "They decide" : "It decides"} ` +
      `${moved.map((f) => ACCESS_FIELDS[f]).join(", ")} — and for a server the ` +
      `deploy authorised, that stays with the deploy. Change ` +
      `${moved.length > 1 ? "them" : "it"} in the checked-in config, or point a ` +
      `NEW slug at the upstream you want.`,
  );
}

/** The flow-through fields (src/config/reach.ts), in the order a refusal names them. */
const REACH_FIELDS = ["reaches", "reachableFrom"] as const;

/**
 * A runtime write may not declare or change a FLOW-THROUGH grant, on any slug.
 *
 * Unlike `entitlements:` this binds overlay-only slugs too. A grant is standing
 * authority held by code — a server calling another slug's tools as itself —
 * and it is legal only when both halves agree, so a roster editor that could
 * write either half could write the pair. There is no "your own new connector"
 * case to preserve: a runtime-created slug has no hosted code of its own to
 * exercise a grant with. So the value a write carries must be exactly what the
 * checked-in entry declares, which for a slug the file does not name is none.
 */
function assertNoReachChange(
  declared: Record<string, unknown> | undefined,
  entry: Record<string, unknown>,
): void {
  const shape = (v: unknown) => JSON.stringify(Array.isArray(v) ? v : []);
  const moved = REACH_FIELDS.filter(
    (f) => shape(declared?.[f]) !== shape(entry[f]),
  );
  if (moved.length === 0) return;
  throw new AccessControlChanged(
    `${moved.map((f) => `${f}:`).join(", ")} cannot be written at runtime on ` +
      `${String(entry.slug)}. A flow-through grant lets one server call ` +
      `another's tools as itself, so both of its halves stay with the deploy. ` +
      `Change ${moved.length > 1 ? "them" : "it"} in the checked-in config.`,
  );
}

/**
 * Who is making a runtime write, reduced to what a bound needs of them.
 *
 * `roles` and nothing else: it is the entitlement-resolving set, the same
 * strings `entitledServers` intersects against a slug's `entitlements:`. Both
 * doors hold a full `Principal` and hand over this slice, which keeps the module
 * free of the auth layer — and keeps an identifier nothing reads out of a
 * refusal message that is rendered into an HTML page and returned over `/mcp`.
 */
export interface WritingPrincipal {
  roles: readonly string[];
}

export class ReachExceeded extends Error {}

/**
 * Every field on an entry that names a HOST strad sends a credential to.
 *
 * Not the fields that CARRY a credential — `src/config/secret-position.ts` owns
 * those, and its rule is that they must be references. These are the other half
 * of the same question: a reference resolves to a value, and the value is sent
 * somewhere. This list is where.
 *
 * Kept as data rather than as four comparisons, because the failure of missing
 * one is silent and identical each time: the write is accepted, the slug becomes
 * overlay-authored, and the next resolution posts a credential to a host the
 * write chose. `oauth:` lives on `ServerBase`, so two of these can appear on any
 * kind — including one the deploy renders a container for.
 */
export const CREDENTIAL_DESTINATIONS = [
  "url:",
  "oauthRefresh.tokenUrl:",
  "oauth.tokenUrl:",
  "oauth.authorizeUrl:",
] as const;

/** One destination's value, as a comparable string. Absent reads as empty. */
function destination(
  entry: Record<string, unknown> | undefined,
  field: (typeof CREDENTIAL_DESTINATIONS)[number],
): string {
  if (field === "url:") return String(entry?.url ?? "");
  const [block, key] = field.slice(0, -1).split(".") as [string, string];
  const held = entry?.[block];
  return isPlainObject(held) ? String(held[key] ?? "") : "";
}

/**
 * Does `principal` reach `server` under the checked-in config's two-way rule?
 *
 * The same intersection `src/gateway/entitlements.ts` computes — a role names
 * the slug (or `*`) AND the slug's `entitlements:` names the role — but WITHOUT
 * the `enabled` filter. The question a reach bound asks is "did the deploy
 * authorise this principal to this mount", which a disabled slug still answers
 * yes to: enabling it is a separate write, and a mount the deploy credentialed
 * for a role is one that role may point a second slug at.
 */
function principalReachesSlug(
  config: StradConfig,
  roles: readonly string[],
  server: ServerConfig,
): boolean {
  const roleNamesSlug = roles.some((r) => {
    // `Object.hasOwn`, for the same reason entitledServers uses it: a role named
    // "__proto__" must not resolve to Object.prototype.
    if (!Object.hasOwn(config.roles, r)) return false;
    const role = config.roles[r];
    return !!role && role.servers.some((e) => e === "*" || e === server.slug);
  });
  if (!roleNamesSlug) return false;
  return server.entitlements.some((r) => roles.includes(r));
}

/**
 * A runtime write may not reach a credential its author cannot already reach.
 *
 * This is the bound that makes granting the write tools to a NARROWER role than
 * `admin` mean something. Two mechanisms in strad#349 walk around the other
 * bounds, and both reach a mount's baked credential or tool surface through a
 * slug the checked-in config never gave the writer:
 *
 *   A. CREATE. A new `supplementary-image` slug carries no `tools:` of its own
 *      and any `entitlements:` it likes. `assertCreatable` never looks at
 *      `path:`, so one create points a narrow role at `/onepassword` and serves
 *      that mount's full surface, under the credential the deploy baked onto the
 *      container. Bound: a new supplementary slug may only land on a bundle +
 *      `path:` the writer ALREADY REACHES through a checked-in slug.
 *
 *   B. RE-POINT. No frozen set covers the fields naming a HOST this slug sends a
 *      credential to, so a checked-in entry can be pointed at one the writer
 *      chose and its credential follows. Bound: a credential destination may
 *      move only on a slug the writer is entitled to — which is exactly what
 *      re-pointing one's own quick tunnel needs, and what reaching a credential
 *      one was never granted does not have.
 *
 *      There are FOUR such fields, not one, and they are listed in
 *      `CREDENTIAL_DESTINATIONS`. `url:` is the obvious one. The other three are
 *      OAuth endpoints, and they matter for the same reason with a different
 *      credential on the wire: `oauthRefresh.tokenUrl` is POSTed the client
 *      secret AND the long-lived refresh token every time strad mints a bearer
 *      (`src/gateway/adapters/oauth-refresh.ts`), and a connector's
 *      `oauth.tokenUrl` / `oauth.authorizeUrl` carry the console's consent
 *      exchange (`src/connectors/index.ts`). A bound that watched `url:` alone
 *      would be one field wide: the same write, aimed one key over, still walks
 *      the credential off-box. `oauth:` lives on `ServerBase`, so this is NOT
 *      scoped to the unhosted kinds — a `supplementary-image` can declare one.
 *
 * Both are measured in MOUNTS, not in tools, and that boundary is deliberate. A
 * writer that already reaches a mount may still create a second slug there with
 * a WIDER tool surface than the checked-in slug it reaches it through — so a
 * role the deploy gave read-only access to a mount can give itself the write
 * tools on that same mount. Carrying the `tools:` policy along would close that,
 * and would also narrow `admin`: it would forbid creating a slug wider than the
 * widest checked-in slug the writer reaches there, which is the `gmail-ro` /
 * `gmail-rw` create on a mount whose checked-in slug is the narrow one. That is a
 * trade between a workflow and a residual widening rather than a pure
 * tightening, so it is a posture decision and not one this module makes. The
 * operator took it on 2026-09-13 and kept the workflow, and it is re-taken if a
 * `connectors` write tool is granted to a role other than `admin`. See phase 2
 * in `docs/operate/runtime-config-plan.md`.
 *
 * What IS a pure tightening is the mount bound above: `admin` reaches every mount
 * a deployment declares (its role is `["*"]` and every slug's `entitlements:`
 * names it), so neither bound fires for `admin` — the gmail-ro / gmail-rw create
 * and the quick-tunnel re-point both still work — and only a narrower writer is
 * bounded, which is the point.
 *
 * `baseConfig` is the CHECKED-IN config, not the merged one. Reach is measured
 * against what the deploy authorised; an overlay slug's own `entitlements:` were
 * themselves runtime-written and cannot vouch for reach.
 *
 * `before` present means an EDIT, and bound A does not apply to one: the mount an
 * entry serves is `bundle:` + `path:`, `immutableFields` refuses both on every
 * supplementary edit, so an edit cannot move a mount and re-asking the reach
 * question can only produce a false refusal. It would be a real one — a checked-in
 * mount that later leaves the file, or narrows, would otherwise make an overlay
 * entry created legitimately against it uneditable by anyone, including `admin`,
 * with a message about creating it. A create is where a mount is chosen, so a
 * create is where it is judged; remove-then-recreate is structurally a create and
 * is judged there too.
 */
export function assertWithinReach(
  baseConfig: StradConfig,
  entry: Record<string, unknown>,
  principal: WritingPrincipal,
  before?: Record<string, unknown>,
): void {
  const slug = String(entry.slug ?? "");
  const declared = baseConfig.servers.find((s) => s.slug === slug);

  // Bound B — moving a credential's destination on a slug the file declares.
  // Every kind, because `oauth:` lives on `ServerBase`.
  if (declared) {
    const moved = CREDENTIAL_DESTINATIONS.filter(
      (field) => destination(entry, field) !== destination(declared, field),
    );
    if (
      moved.length > 0 &&
      !principalReachesSlug(baseConfig, principal.roles, declared)
    ) {
      throw new ReachExceeded(
        `${moved.join(", ")} cannot be changed at runtime on ${slug} by this ` +
          `write: the checked-in config declares ${slug} and does not entitle you ` +
          `to reach it, and ${moved.length > 1 ? "those fields name hosts" : "that field names a host"} ` +
          `strad sends its credential to — so moving ` +
          `${moved.length > 1 ? "them" : "it"} would hand a credential the deploy ` +
          `gave somebody else to a host you chose. Re-point a slug you already ` +
          `reach, or change it in the checked-in config and deploy.`,
      );
    }
    // Nothing below applies to a slug the file declares: its mount is frozen by
    // `assertNoAccessControlChange`.
    return;
  }

  // Bound A — a NEW supplementary slug. Creates only; see the header.
  if (before || entry.kind !== "supplementary-image") return;

  const bundle = String(entry.bundle ?? "");
  const path = String(entry.path ?? "/mcp");

  // A STORE-SERVED INSTANCE ON ITS OWN PATH reaches no mount the deploy
  // credentialed. `/_instance/{tree}/{slug}` is a prefix no conventional mount
  // can have, the instance holds its own namespace and nothing from the
  // container's environment (servers/bundle/host/src/mounts.ts,
  // `instanceEnv`), and the schema refuses an instance path naming another
  // slug. So there is no baked credential for bound A to protect — and, for the
  // same reason, no checked-in slug on that path for it to measure against.
  //
  // What it still asks is that the author reach the COMPONENT: an instance runs
  // tree code inside a container, and a writer the deploy gave no slug on that
  // container has no business placing one there. That is a weaker question than
  // bound A's and it is the right one — the mount is new, the container is not.
  //
  // Why "some checked-in slug on the component" adds no reach over bound A:
  // what the instance can touch is (1) the six non-credential process names
  // `INSTANCE_PROCESS_ENV_NAMES` lets through, which a served value cannot
  // override; (2) its OWN slug's namespace, which core serves only to the
  // component the slug is on, identified by that component's own internal
  // token (`src/http/instances.ts`, HACKS.md #63); and (3) fixed tree code —
  // telegram, google-sheets or grafana — never the author's. None of the three
  // is a credential of any existing mount, so the choice of component decides
  // only which container runs it. Who may CALL it is the entitlement bound
  // above, unchanged.
  if (parseInstancePath(path)?.slug === slug) {
    const reachesComponent = baseConfig.servers.some(
      (s) =>
        s.kind === "supplementary-image" &&
        s.bundle === bundle &&
        principalReachesSlug(baseConfig, principal.roles, s),
    );
    if (!reachesComponent) {
      throw new ReachExceeded(
        `${slug} cannot be created as a store-served instance on ${bundle}: no ` +
          `slug the checked-in config authorised for you is served by that ` +
          `component, so this would run a server inside a container the deploy ` +
          `gave you no part of. Create it on a component you already reach, or ` +
          `add the entry to the checked-in config and deploy.`,
      );
    }
    return;
  }

  const mounts = baseConfig.servers.filter(
    (s) =>
      s.kind === "supplementary-image" &&
      s.bundle === bundle &&
      (s.path ?? "/mcp") === path &&
      principalReachesSlug(baseConfig, principal.roles, s),
  );
  if (mounts.length === 0) {
    throw new ReachExceeded(
      `${slug} cannot be created on ${bundle}${path}: no slug the checked-in ` +
        `config authorised for you serves that mount, so pointing a new slug at ` +
        `it would reach a credential the deploy baked in for somebody else. ` +
        `Point it at a mount you already reach, or add the entry to the ` +
        `checked-in config and deploy.`,
    );
  }
}

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
