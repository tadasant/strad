/**
 * What a supplementary server's variable is CALLED on the container, and how the
 * container reads it back.
 *
 * THE PROBLEM. A bundle is a component is a container is one `process.env`. Two
 * servers on one bundle that both write `${TELEGRAM_API_HASH}` want one name to
 * hold two values, and no environment can do that. src/deploy/server-namespaces.ts
 * (the layer under this one) decides which NAMESPACE a value is read FROM; this
 * decides what it is CALLED once it lands. They are different axes and both are
 * needed: a per-server namespace gives you two values, a per-server box name gives
 * you somewhere to put them.
 *
 * THE RULE. Uppercase the slug, turn `-` into `_`, join with `__`:
 *
 *   telegram-ro + TELEGRAM_API_HASH -> TELEGRAM_RO__TELEGRAM_API_HASH
 *
 * INJECTIVITY, which is the whole reason the separator is two characters. A slug
 * cannot contain `_`, so a mangled slug contains `_` only where the slug had `-` —
 * and it contains `__` only where the slug had `--`. Ban `--` in a slug (the SLUG
 * regex in src/config/schema.ts does) and the FIRST `__` in a box name is always
 * the separator, so no two (slug, name) pairs can collide. Without that ban,
 * `a--b` + `C` and `a` + `B__C` are the same variable and one credential silently
 * becomes another. A slug that is a PREFIX of another is fine either way:
 * `telegram` + `RO__X` is `TELEGRAM__RO__X`, `telegram-ro` + `X` is
 * `TELEGRAM_RO__X`.
 *
 * BOTH NAMES ARE EMITTED, FOR EVERY SERVER, and the container prefers the
 * prefixed one. There is no condition on the naming: given a config you can work
 * out what a server's variables are called from that server's own entry, without
 * looking at any other server. The trees migrated to an injected env view read
 * `PREFIX__NAME`; the eight that have not keep reading the bare `NAME` they
 * always read. See `slugEnvView`.
 *
 * This module is IMPORT-FREE on purpose: it is vendored into the bundle host tree
 * across an npm boundary (`npm run envprefix:sync`). The renderer names the
 * variable and the host reads it; a drift between the two halves is a credential
 * that is present on the box and invisible to the server that needs it, with
 * nothing in any log. `test/vendored.sync.test.ts` is what stands between us and
 * a drift in the RULE, and `test/env-prefix.markers.test.ts` between us and the
 * other way in: the host and a server tree spelling a marker variable
 * differently.
 */

/** Separates a slug's mangled prefix from the variable name. Two characters, deliberately — see above. */
export const SLUG_ENV_SEPARATOR = "__";

/**
 * A name POSIX, App Platform and Docker all accept for an environment variable.
 * The SLUG regex permits a leading digit (`1password`), which mangles to `1PASSWORD`
 * and is not a portable variable name — such a slug simply gets no prefixed alias
 * rather than an unusable one, and keeps working on the bare names.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The box-name prefix for a slug, or null when the slug cannot have one.
 *
 * Null is not an error: it means "this slug is served by its bare names alone",
 * which is exactly what every deployment did before per-slug names existed.
 */
export function slugEnvPrefix(slug: string): string | null {
  // `--` would put the separator inside the prefix and destroy injectivity. The
  // config schema rejects it; this is the half of the guard that travels with the
  // rule, so a caller outside the schema cannot mint an ambiguous name.
  if (slug.includes("--")) return null;
  const prefix = slug.toUpperCase().split("-").join("_");
  return ENV_NAME.test(prefix) ? prefix : null;
}

/** Reverse of {@link slugEnvPrefix}. Exact, because a slug holds no `_`. */
export function envPrefixSlug(prefix: string): string {
  return prefix.toLowerCase().split("_").join("-");
}

/** What `name` is called on the box when it belongs to `slug`. Null when the slug has no prefix. */
export function prefixedEnvName(slug: string, name: string): string | null {
  const prefix = slugEnvPrefix(slug);
  return prefix === null ? null : `${prefix}${SLUG_ENV_SEPARATOR}${name}`;
}

/**
 * The environment as ONE SLUG sees it: `PREFIX__NAME` first, bare `NAME` second.
 *
 * A snapshot, not a live view — a component's environment is baked at deploy time
 * and does not change under a running process, and a snapshot is what makes two
 * instances of one tree in one process independent of each other.
 *
 * The fallback is the entire backward-compatibility argument. A server nobody has
 * given a per-slug name resolves out of the bare names exactly as it did, so this
 * lands with no flag and no transition.
 */
export function slugEnvView(
  env: Readonly<Record<string, string | undefined>>,
  slug: string,
): Record<string, string | undefined> {
  const view: Record<string, string | undefined> = { ...env };
  const prefix = slugEnvPrefix(slug);
  if (prefix === null) return view;

  const head = prefix + SLUG_ENV_SEPARATOR;
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(head)) continue;
    const name = key.slice(head.length);
    // `PREFIX__` with nothing after it names no variable. Dropping it is not the
    // same as setting "" — an empty name would land under the key "".
    if (name === "") continue;
    view[name] = value;
  }
  return view;
}

/**
 * Which slugs the environment carries a COMPLETE per-slug set of `names` for.
 *
 * This is how the bundle host learns that a tree needs a SECOND instance without
 * being handed strad's config: it never sees the server list, only the variables
 * the renderer baked.
 *
 * EVERY name must be present, not any one, and that is the whole filter. The
 * names are a tree's REQUIRED variables, so a partial set is not a server —
 * whereas "any one" would let a single unrelated variable conjure a mount. The
 * renderer names EVERY supplementary server's `env:`, and these names are
 * ordinary variables rather than reserved words, so a server that happens to
 * declare one of them (`TELEGRAM_API_ID` belongs to nobody) would otherwise stand
 * up a live, credentialed instance at a path nobody asked for.
 *
 * A prefix is also required to round-trip through {@link slugEnvPrefix}, which
 * rejects a head that is not a mangled slug at all — `FOO__BAR__X` does not
 * invent a slug called `foo--bar`.
 *
 * Returned sorted, so the mount order a boot log reports is stable.
 */
export function slugsWithPrefixedNames(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string[] {
  if (names.length === 0) return [];
  const seen = new Map<string, Set<string>>();
  for (const key of Object.keys(env)) {
    for (const name of names) {
      const suffix = SLUG_ENV_SEPARATOR + name;
      if (!key.endsWith(suffix)) continue;
      const head = key.slice(0, key.length - suffix.length);
      if (head === "") continue;
      const slug = envPrefixSlug(head);
      if (slugEnvPrefix(slug) !== head) continue;
      (seen.get(slug) ?? seen.set(slug, new Set()).get(slug)!).add(name);
    }
  }
  return [...seen]
    .filter(([, held]) => held.size === names.length)
    .map(([slug]) => slug)
    .sort();
}
