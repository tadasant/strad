import type { StradConfig } from "../config/schema.ts";
import type { ParameterMeta } from "../secrets/parameters/types.ts";
import { staticNamespace } from "../secrets/parameters/namespace.ts";
import { refsIn } from "../secrets/provider/resolve.ts";
import { isSecretRef } from "../secrets/parameters/wire.ts";

/**
 * PER-SERVER SUBSTITUTION: where a supplementary server's `${NAME}` comes from.
 *
 * A supplementary image's `env:` map is resolved at render time, and for a long
 * while it was resolved out of exactly one place — `/strad/{env}/gateway/static/`
 * — keyed on the NAME alone. That made a name a deployment-wide singleton: two
 * servers that both write `${TELEGRAM_API_HASH}` necessarily got the same value,
 * and there was no way to say otherwise. Meanwhile `/strad/{env}/mcp/{slug}/
 * static/` already existed for `params: true` servers, so the obvious place to
 * put a per-server credential was a path nothing read for `env:`.
 *
 * So resolution is LAYERED, and the layering is the whole feature:
 *
 *     1. /strad/{env}/mcp/{slug}/static/{NAME}   — this server's own namespace
 *     2. /strad/{env}/gateway/static/{NAME}      — the shared one
 *
 * The server's own namespace WINS. Nothing else would be useful: the shared
 * namespace is where every existing deployment's names already are, so a
 * gateway-first order would mean a per-server value could never take effect for
 * a name that is already shared, which is precisely the case someone seeds a
 * per-server namespace to fix.
 *
 * It is UNCONDITIONAL — there is no flag to turn it on — and that costs nothing,
 * because layer 1 is empty for a server nobody seeded. Every deployment that
 * works today has an empty layer 1 for every server, resolves entirely out of
 * layer 2, and renders byte for byte what it rendered before. A flag would only
 * have recreated the trap this fixes: seed the values, forget the flag, watch a
 * green deploy inject nothing.
 *
 * It is NOT `params: true`, and does not change what that flag means. `params:`
 * injects a namespace WHOLESALE — every variable in it becomes an env var,
 * named by the store rather than by the config. This substitutes values into
 * `${NAME}` references the config already makes, and injects nothing the config
 * does not name. A server may use either, or both from one namespace.
 *
 * ## One container is still one environment
 *
 * Two servers that SHARE a bundle share a `process.env`, so per-server
 * substitution cannot give them different values for the same key — it can only
 * make the collision visible. `renderAppSpec` throws when it happens (see
 * appspec.ts); different values for one name means different bundles.
 *
 * ## What this does not cover
 *
 * `builtin` and `remote-http` servers resolve their `${NAME}` refs IN-PROCESS at
 * runtime, out of the gateway namespace, and are untouched here — their
 * per-server path is `params: true`, which is resolved by the registry. Nor does
 * it cover `consoleEnv:`, which is read from the deploy environment only and
 * lands on core, or a supplementary server's `headers:` — those are the headers
 * CORE sends when it proxies, resolved in core's own process from the gateway
 * namespace, and moving one into a container's environment would not even be the
 * same thing.
 */

/** The prefix every per-server namespace sits under: `/strad/{env}/mcp/`. */
export function mcpNamespace(env: string): string {
  return `/strad/${env}/mcp/`;
}

/**
 * Group a listing of `/strad/{env}/mcp/` by slug: `slug -> VARIABLE[]`.
 *
 * ONE listing, not one per server. `list()` enumerates the project and filters
 * by prefix, so asking it per slug would re-enumerate the whole store 27 times
 * on a staging render. Reading the slug back out of the path is what makes a
 * single call enough.
 *
 * Metadata only — `ParameterMeta` carries no value, and a secret parameter's
 * payload is a `__REF__` pointer. Values are read later, and only for the slugs
 * that turn out to need one.
 */
export function seededByServer(
  env: string,
  metas: readonly ParameterMeta[],
): Map<string, string[]> {
  return groupByServer(env, metas).seeded;
}

/**
 * The same fold, keeping what it DROPPED.
 *
 * A path under `mcp/` that is not `{slug}/static/…` is read by no resolver at
 * all — a typo'd kind (`{slug}/statik/VAR`), a bare `{slug}/VAR`, a future
 * `oauth` kind nothing implements yet. Dropping it silently would be the same
 * silent no-op this module exists to end, one shape further out, so the caller
 * gets it back and warns.
 */
export function groupByServer(
  env: string,
  metas: readonly ParameterMeta[],
): { seeded: Map<string, string[]>; unroutable: string[] } {
  const prefix = mcpNamespace(env);
  const out = new Map<string, string[]>();
  const unroutable: string[] = [];
  for (const meta of metas) {
    if (!meta.hasValue) continue;
    if (!meta.path.startsWith(prefix)) continue;
    // {slug}/static/{…}/{VARIABLE}. The variable is the LAST segment, not the
    // third one: `resolve()` lists everything under `{slug}/static/` and keys
    // the result by the last segment (gcp.ts `variableOf`), so
    // `{slug}/static/extra/TOKEN` really does arrive as `TOKEN`. Reading only
    // three segments here would call a path unread that the resolver reads —
    // the more dangerous direction, and the one the console's SLUG_STATIC
    // already refuses to take.
    const segments = meta.path.slice(prefix.length).split("/");
    const [slug, kind] = segments;
    const variable = segments[segments.length - 1];
    if (segments.length < 3 || !slug || kind !== "static" || !variable) {
      unroutable.push(meta.path);
      continue;
    }
    const held = out.get(slug) ?? [];
    if (!held.includes(variable)) held.push(variable);
    out.set(slug, held);
  }
  for (const held of out.values()) held.sort();
  unroutable.sort();
  return { seeded: out, unroutable };
}

/**
 * `slug -> the ${NAME}s that server's `env:` map references`, for every enabled
 * supplementary server that references one.
 *
 * This is the set a per-server namespace can serve. A variable seeded beside it
 * that no `${NAME}` names is not substituted into anything — see
 * `unreadParameters`.
 */
export function envRefsBySlug(config: StradConfig): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    const refs = new Set<string>();
    for (const raw of Object.values(server.env)) {
      for (const name of refsIn(raw)) refs.add(name);
    }
    if (refs.size > 0) out.set(server.slug, refs);
  }
  return out;
}

/** A seeded parameter that no server on this render will read. */
export interface UnreadParameters {
  slug: string;
  /** The variables nothing reads, sorted. */
  variables: string[];
  /** A sentence for the deploy log. Names only — never a value. */
  message: string;
}

/**
 * Parameters that are seeded and that NOTHING WILL READ.
 *
 * This is the signal the old shape did not have. `/strad/{env}/mcp/{slug}/static/`
 * was read only for a server carrying `params: true`, and the renderer's skip for
 * a server without it was a bare `continue` — so seeding a credential there
 * produced no injected variable, no warning, and a green deploy. Somebody did
 * exactly that, twice, and had nothing to go on.
 *
 * Three shapes, all reported by name:
 *   - the slug names no enabled server on this render (a typo, or a server
 *     turned off);
 *   - the server is a kind whose namespace the RENDERER never reads (a builtin
 *     or a remote-http, which get theirs at runtime via `params: true`);
 *   - the variable is seeded under a supplementary server that neither sets
 *     `params: true` nor writes `${VARIABLE}` anywhere in its `env:`.
 */
export function unreadParameters(
  config: StradConfig,
  seeded: ReadonlyMap<string, string[]>,
): UnreadParameters[] {
  const byRefs = envRefsBySlug(config);
  const out: UnreadParameters[] = [];

  for (const [slug, variables] of [...seeded].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const namespace = staticNamespace(config.gateway.env, slug);
    const server = config.servers.find((s) => s.slug === slug && s.enabled);

    if (!server) {
      out.push({
        slug,
        variables: [...variables],
        message:
          `${namespace} holds ${variables.length} parameter(s) ` +
          `(${variables.join(", ")}) but no ENABLED server in this config has ` +
          `the slug "${slug}". Nothing reads them. Check the spelling of the ` +
          `path, or that the server is not disabled.`,
      });
      continue;
    }

    if (server.kind === "remote-http") {
      out.push({
        slug,
        variables: [...variables],
        message:
          `${namespace} holds ${variables.length} parameter(s) ` +
          `(${variables.join(", ")}) but "${slug}" is a remote-http server — it ` +
          `runs in someone else's infrastructure and has no environment to ` +
          `inject. Its \${NAME} refs resolve from the gateway namespace.`,
      });
      continue;
    }

    // A `params: true` server takes its WHOLE namespace, so nothing under it is
    // unread by definition.
    if (server.params) continue;

    if (server.kind === "builtin") {
      out.push({
        slug,
        variables: [...variables],
        message:
          `${namespace} holds ${variables.length} parameter(s) ` +
          `(${variables.join(", ")}) but the builtin "${slug}" does not set ` +
          `params: true, and per-server substitution covers a supplementary ` +
          `image's env: only. Set params: true to inject them.`,
      });
      continue;
    }

    const refs = byRefs.get(slug) ?? new Set<string>();
    const unread = variables.filter((v) => !refs.has(v));
    if (unread.length === 0) continue;
    out.push({
      slug,
      variables: unread,
      message:
        `${namespace} holds ${unread.length} parameter(s) nothing reads ` +
        `(${unread.join(", ")}): "${slug}" does not set params: true, and its ` +
        `env: map references no \${NAME} by that name. Reference it — ` +
        `env: { ${unread[0]}: "\${${unread[0]}}" } — or set params: true to ` +
        `inject the whole namespace.`,
    });
  }
  return out;
}

/**
 * The names a per-server namespace can supply for one server, and only those.
 *
 * The resolved namespace is filtered down to the names the server's `env:`
 * actually references. A variable that resolves but is not referenced stays out
 * of the substitution bag entirely: `params: true` is what injects a whole
 * namespace, and letting an unreferenced one ride along here would make the two
 * paths silently overlap.
 */
export function substitutionBag(
  resolved: Readonly<Record<string, string>>,
  refs: ReadonlySet<string>,
): { bag: Record<string, string>; unusable: string[] } {
  const bag: Record<string, string> = {};
  const unusable: string[] = [];
  for (const name of refs) {
    const value = resolved[name];
    if (value === undefined) continue;
    // A PARAMETER THAT EXISTS AND HAS NO USABLE VALUE MUST NOT SHADOW THE
    // SHARED ONE.
    //
    // `resolve()` does not promise a value. A `:render` that could not
    // dereference hands the `__REF__` pointer back rather than failing (that is
    // deliberate — `checkStore` recognises it to report "present but
    // unrenderable"), and an empty payload resolves to "". Taking either would
    // do the worst possible thing twice over: bake a non-credential onto the
    // container, AND suppress the fallback to a shared value that works. So
    // they are dropped here, which makes `coveredPerServer` false and puts the
    // gateway namespace back in charge — exactly what this server did before it
    // was seeded.
    if (value === "" || isSecretRef(value)) {
      unusable.push(name);
      continue;
    }
    bag[name] = value;
  }
  return { bag, unusable };
}

/**
 * Is every server that references `name` under `env:` served by its OWN
 * namespace?
 *
 * If so the gateway namespace does not have to hold it at all, and a render that
 * demanded it anyway would refuse deploys that are correct. If even one
 * referencing server is unseeded, the shared value is still load-bearing for
 * that server and its absence is still a hard error.
 */
export function coveredPerServer(
  name: string,
  refsBySlug: ReadonlyMap<string, Set<string>>,
  serverSecrets: Readonly<Record<string, Readonly<Record<string, string>>>>,
): boolean {
  let referenced = false;
  for (const [slug, refs] of refsBySlug) {
    if (!refs.has(name)) continue;
    referenced = true;
    if (serverSecrets[slug]?.[name] === undefined) return false;
  }
  return referenced;
}
