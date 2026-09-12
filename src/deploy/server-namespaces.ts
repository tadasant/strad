import { isUnhosted, unhostedRefFields } from "../config/schema.ts";
import type { ServerConfig, StradConfig } from "../config/schema.ts";
import type { ParameterMeta } from "../secrets/parameters/types.ts";
import {
  isServerParamKind,
  serverKindNamespace,
  SERVER_PARAM_KINDS,
  type ServerParamKind,
} from "../secrets/parameters/namespace.ts";
import { refsIn } from "../secrets/provider/resolve.ts";
import { isSecretRef } from "../secrets/parameters/wire.ts";

/**
 * PER-SERVER SUBSTITUTION: where a server's `${NAME}` comes from.
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
 *     1. /strad/{env}/mcp/{slug}/oauth/{NAME}    — this server's own, minted
 *     2. /strad/{env}/mcp/{slug}/static/{NAME}   — this server's own, typed
 *     3. /strad/{env}/gateway/static/{NAME}      — the shared one
 *
 * Layers 1 and 2 are the two KINDS one server's namespace is divided into, and
 * the order between them is decided in src/secrets/parameters/namespace.ts: a
 * value strad minted through a console consent beats one a human typed months
 * ago. Every layered read walks `serverNamespaces()` rather than naming a kind,
 * so a kind is read by all of them or by none.
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
 * ## The other half, and where it lives
 *
 * This module is the RENDER-TIME half: a supplementary image's `env:`, resolved
 * into a document. The refs strad resolves in its OWN process — every `url:`,
 * every `headers:` map, every builtin `options:` value, for every kind — are
 * layered the same way at runtime by `ServerSecretProviders.forServer()` in
 * src/secrets/provider. Same order, same precedence, same reason. They are two
 * implementations because they happen at different times against different
 * inputs (a bag of values here, a live provider there), not because they are
 * two policies.
 *
 * That matters most for an UNHOSTED server (`remote-http`, `local-tunnel`).
 * strad runs no container for one, so `params: true` and this renderer are both
 * closed to it, and its own namespace is reachable only through the runtime
 * layer. `runtimeRefsBySlug` below is what lets the deploy gates see it.
 *
 * `consoleEnv:` is covered by neither: it is read from the deploy environment
 * only and lands on core.
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
 * The same fold, keeping what it DROPPED and which KIND each name came from.
 *
 * A path under `mcp/` that is not `{slug}/{kind}/…` for a kind some resolver
 * reads is read by nothing at all — a typo'd kind (`{slug}/statik/VAR`), a bare
 * `{slug}/VAR`. Dropping it silently would be the same silent no-op this module
 * exists to end, one shape further out, so the caller gets it back and warns.
 *
 * `kinds` is what lets a caller resolve only the namespaces that hold anything.
 * `resolve()` renders every parameter in a namespace, so asking for an empty
 * `oauth/` on every slug would be a round trip per server for nothing — and on a
 * render of thirty-odd servers that is the burst Parameter Manager's per-project
 * read quota already refused once.
 */
export function groupByServer(
  env: string,
  metas: readonly ParameterMeta[],
): {
  seeded: Map<string, string[]>;
  /** slug -> the kinds whose namespace actually holds a value. */
  kinds: Map<string, Set<ServerParamKind>>;
  unroutable: string[];
} {
  const prefix = mcpNamespace(env);
  const out = new Map<string, string[]>();
  const kinds = new Map<string, Set<ServerParamKind>>();
  const unroutable: string[] = [];
  for (const meta of metas) {
    if (!meta.hasValue) continue;
    if (!meta.path.startsWith(prefix)) continue;
    // {slug}/{kind}/{…}/{VARIABLE}. The variable is the LAST segment, not the
    // third one: `resolve()` lists everything under `{slug}/{kind}/` and keys
    // the result by the last segment (gcp.ts `variableOf`), so
    // `{slug}/static/extra/TOKEN` really does arrive as `TOKEN`. Reading only
    // three segments here would call a path unread that the resolver reads —
    // the more dangerous direction, and the one the console's SLUG_KIND
    // already refuses to take.
    const segments = meta.path.slice(prefix.length).split("/");
    const [slug, kind] = segments;
    const variable = segments[segments.length - 1];
    if (
      segments.length < 3 ||
      !slug ||
      !kind ||
      !isServerParamKind(kind) ||
      !variable
    ) {
      unroutable.push(meta.path);
      continue;
    }
    const held = out.get(slug) ?? [];
    if (!held.includes(variable)) held.push(variable);
    out.set(slug, held);
    const heldKinds = kinds.get(slug) ?? new Set<ServerParamKind>();
    heldKinds.add(kind);
    kinds.set(slug, heldKinds);
  }
  for (const held of out.values()) held.sort();
  unroutable.sort();
  return { seeded: out, kinds, unroutable };
}

/**
 * The namespaces one slug is worth resolving, in precedence order.
 *
 * Filtered by what the listing found, so a slug with nothing under `oauth/`
 * costs exactly the read it cost before this kind existed.
 */
export function seededNamespaces(
  env: string,
  slug: string,
  kinds: ReadonlySet<ServerParamKind> | undefined,
): string[] {
  return SERVER_PARAM_KINDS.filter((kind) => kinds?.has(kind)).map((kind) =>
    serverKindNamespace(env, slug, kind),
  );
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

/**
 * `slug -> the ${NAME}s that server's RUNTIME fields reference`.
 *
 * The other half of the same question `envRefsBySlug` asks, for the refs strad
 * resolves IN ITS OWN PROCESS rather than baking into a container: a `url:`, a
 * `headers:` map, a remote-http's `oauthRefresh:`, a builtin's `options:`. Those
 * go through
 * `ServerSecretProviders.forServer()` (src/secrets/provider), which reads the
 * server's own namespace before the shared one — so a name seeded here is read,
 * and a deploy gate that demanded it from the gateway namespace would refuse a
 * deployment that works.
 *
 * NAMED FIELDS, not a walk of the whole object. `collectSecretRefs` walks
 * everything, which is right for "what might this deployment need" and wrong
 * here: a `${...}`-looking string in a `description` would invent a per-server
 * ref and let a gate pass a name nothing resolves. Same reasoning, and the same
 * field list, as `requirementsOf` in src/ui/secret-status.ts.
 *
 * A supplementary image's `headers:` counts. Those are the headers CORE sends
 * when it proxies, resolved in core's process — a different mechanism from that
 * server's `env:`, reading the same namespace.
 */
export function runtimeRefsBySlug(
  config: StradConfig,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const server of config.servers) {
    if (!server.enabled) continue;
    const refs = new Set<string>();
    const add = (raw: string): void => {
      for (const name of refsIn(raw)) refs.add(name);
    };
    if (isUnhosted(server)) {
      for (const value of unhostedRefFields(server)) add(value);
    } else if (server.kind === "builtin") {
      for (const value of Object.values(server.options)) {
        if (typeof value === "string") add(value);
      }
    } else {
      for (const value of Object.values(server.headers)) add(value);
    }
    if (refs.size > 0) out.set(server.slug, refs);
  }
  return out;
}

/**
 * Both halves at once: every `${NAME}` a server can resolve from its OWN
 * namespace, whether at render time (`env:`) or at runtime (`url:`, `headers:`,
 * `options:`).
 *
 * This is the set a coverage check wants. Splitting it is what let the two
 * mechanisms drift: `checkStore` knew about the render-time half and reported the
 * runtime half as missing from a namespace it does not have to be in.
 */
export function ownNamespaceRefsBySlug(
  config: StradConfig,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const source of [envRefsBySlug(config), runtimeRefsBySlug(config)]) {
    for (const [slug, refs] of source) {
      const held = out.get(slug) ?? new Set<string>();
      for (const name of refs) held.add(name);
      out.set(slug, held);
    }
  }
  return out;
}

/**
 * The three variables ONE server's `oauth:` connector owns, or [] for a server
 * that declares none.
 *
 * They are read from that server's own namespaces — `oauth/` ahead of
 * `static/`, the same layering everything else here applies — and INJECTED — they are never
 * `${NAME}` references, and the config gate refuses one written by hand (see the
 * `superRefine` in src/config/schema.ts). That is the whole deploy-ordering
 * answer: the refresh token cannot exist until a human completes the console
 * consent flow, and a reference to a name the store does not hold fails the
 * WHOLE render, so one unconnected slug would take every other server's deploy
 * with it. An injected variable is simply absent until it is there.
 */
export function connectorVariables(server: ServerConfig): string[] {
  const oauth = server.oauth;
  if (!oauth) return [];
  return [
    oauth.clientIdVariable,
    oauth.clientSecretVariable,
    oauth.refreshTokenVariable,
  ];
}

/** `slug -> the variables its connector owns`, for every enabled server with one. */
export function connectorVarsBySlug(
  config: StradConfig,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const server of config.servers) {
    if (!server.enabled) continue;
    const vars = connectorVariables(server);
    if (vars.length === 0) continue;
    out.set(server.slug, new Set(vars));
  }
  return out;
}

/**
 * Every name a server's OWN namespace serves it, by whichever mechanism.
 *
 * `ownNamespaceRefsBySlug` answers the narrower question — which `${NAME}`s
 * resolve from there — and it is the right input to the deploy gates, which are
 * about references. This adds the connector variables, which are read without
 * being referenced, and it is what "does anything read this seeded parameter"
 * has to mean once a second mechanism exists.
 */
export function ownNamespaceNamesBySlug(
  config: StradConfig,
): Map<string, Set<string>> {
  const out = ownNamespaceRefsBySlug(config);
  for (const [slug, vars] of connectorVarsBySlug(config)) {
    const held = out.get(slug) ?? new Set<string>();
    for (const name of vars) held.add(name);
    out.set(slug, held);
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
 * Two shapes, both reported by name:
 *   - the slug names no enabled server on this render (a typo, or a server
 *     turned off);
 *   - the server is enabled and references no `${VARIABLE}` by that name in any
 *     field its own namespace serves, and does not set `params: true`.
 */
export function unreadParameters(
  config: StradConfig,
  seeded: ReadonlyMap<string, string[]>,
): UnreadParameters[] {
  // The WIDER map: a connector's variables are read by the renderer without any
  // `${NAME}` naming them, so reporting them as unread would warn, on every
  // deploy, about the two parameters a human was told to seed.
  const byRefs = ownNamespaceNamesBySlug(config);
  const out: UnreadParameters[] = [];

  for (const [slug, variables] of [...seeded].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    // The slug's `/mcp/{slug}/` root rather than one kind's namespace: `seeded`
    // is the union across kinds, so naming `static/` in a message about a
    // variable that sits under `oauth/` would send a human to the wrong page.
    const namespace = `/strad/${config.gateway.env}/mcp/${slug}/`;
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

    // A `params: true` server takes its WHOLE namespace, so nothing under it is
    // unread by definition. Checked before the kind, because an unhosted server
    // cannot set it and a builtin that does is served by the registry.
    if (!isUnhosted(server) && server.params) continue;

    // ONE QUESTION, FOR EVERY KIND: does this server reference the name?
    //
    // The kind-specific answers this replaces — an unhosted server's refs come
    // from the gateway namespace, a builtin is not covered because per-server
    // substitution is an `env:` feature — describe the RENDERER, which is only
    // half the system. A server's `url:`, `headers:` and `options:` refs are
    // resolved through its own namespace first, in strad's process, whatever
    // kind it is (src/secrets/provider). So the only way a seeded variable goes
    // unread is the one that does not depend on a mechanism at all: nothing
    // names it.
    const refs = byRefs.get(slug) ?? new Set<string>();
    const unread = variables.filter((v) => !refs.has(v));
    if (unread.length === 0) continue;

    const hint = server.oauth
      ? `This server's connector reads ` +
        `${connectorVariables(server).join(", ")} from here; ${unread[0]} is ` +
        `not one of them.`
      : isUnhosted(server)
        ? `Reference it — headers: { Authorization: "Bearer \${${unread[0]}}" } — ` +
          `or delete it.`
        : server.kind === "builtin"
          ? `Reference it from options:, or set params: true to inject the whole ` +
            `namespace.`
          : `Reference it — env: { ${unread[0]}: "\${${unread[0]}}" } — or set ` +
            `params: true to inject the whole namespace.`;

    out.push({
      slug,
      variables: unread,
      message:
        `${namespace} holds ${unread.length} parameter(s) nothing reads ` +
        `(${unread.join(", ")}): the ${server.kind} "${slug}" names no ` +
        `\${NAME} by that name. ${hint}`,
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
