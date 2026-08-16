import type { StradConfig } from "../config/schema.ts";
import {
  consoleEnvNames,
  requiredSecretNames,
  supplementaryEnvNames,
} from "./preflight.ts";
import { CORE_BOOT_ENV_KEYS } from "../secrets/provider/hydrate.ts";
import { gatewayNamespace } from "../secrets/parameters/namespace.ts";
import {
  mcpNamespace,
  ownNamespaceRefsBySlug,
  seededByServer,
} from "./server-namespaces.ts";
import { isSecretRef } from "../secrets/parameters/wire.ts";
import { errorSummary } from "../secrets/provider/snapshot.ts";
import type {
  ParameterAdmin,
  ParameterResolver,
} from "../secrets/parameters/types.ts";

/**
 * Is this namespace COMPLETE — every name the config needs, not just the ones a
 * deploy would refuse to ship without?
 *
 * ## Why `preflightSecrets()` is not this
 *
 * The preflight in `render-spec` answers a narrower question on purpose: it
 * exists to preserve the one good property of deploy-time baking (a reference to
 * a secret that does not exist fails the DEPLOY), so it checks the names the
 * gateway itself resolves and forgives the ones a correct deployment may
 * legitimately lack. Both halves of that are right for a deploy gate and wrong
 * for the question "is it safe to flip the provider":
 *
 *   - It checks `requiredSecretNames()` — the config's `${NAME}` refs plus the
 *     core boot keys — and NOT a supplementary image's `env:`. Those are baked at
 *     render time, and `render-spec` fails on a missing one, so a deploy cannot
 *     ship without them. But it reads them FROM THE STORE under the store
 *     provider, so before the flip they have to be seeded, and nothing checks
 *     that until the deploy is already running.
 *   - Of the boot keys, only `STRAD_TOKENS` and `STRAD_INTERNAL_TOKEN` are
 *     counted missing. The rest are optional because a deployment with no console
 *     genuinely has no `GOOGLE_CLIENT_SECRET` — but a deployment WITH a console
 *     and `auth.google.enabled: true` that is missing it has a front door that
 *     does not open, and the preflight reports that namespace as fine.
 *
 * Put together: a namespace holding only the three names the preflight insists on
 * — `STRAD_TOKENS`, `STRAD_INTERNAL_TOKEN` and whatever `${NAME}` refs the config
 * makes — deploys green, however many the deployment actually reads. This module
 * counts all of them.
 *
 * ## What "expected" means here
 *
 * Optional-at-BOOT is not optional here, and that is the whole point. A name is
 * expected if the running deployment reads it from the store:
 *
 *   - `${NAME}` in a remote-http url/header or a builtin's options — resolved on
 *     the request path;
 *   - every `CORE_BOOT_ENV_KEYS` entry — hydrated at boot, all of them;
 *   - a `supplementary-image` server's `env:` — read from the store at RENDER
 *     time and baked onto that component.
 *
 * A `consoleEnv:`-only name is the one exclusion, and it is not an oversight: it
 * carries the console's store-ADMIN credential, `render-spec` reads it from the
 * deploy environment ONLY, and filing it inside the store would let the weaker
 * resolver credential read the stronger admin one. Finding one IN the store is
 * therefore its own kind of finding — the opposite of a missing name, and still
 * something a pre-flip gate should refuse. A name declared under both `env:` and
 * `consoleEnv:` is NOT excluded: the `env:` declaration means some component
 * genuinely reads it from the store.
 *
 * ## Two namespaces, one verdict
 *
 * A server's `${NAME}` does not resolve from the gateway namespace alone: the
 * server's own `/strad/{env}/mcp/{slug}/static/` is consulted first, and wins —
 * at render time for a supplementary `env:` (src/deploy/server-namespaces.ts)
 * and at runtime for every `url:`, `headers:` and builtin `options:` ref
 * (src/secrets/provider). So this lists that prefix too, and a name every
 * referencing server holds for itself is reported as `perServer` rather than as
 * missing — the deployment resolves it, this namespace simply is not where.
 *
 * The gateway's own BOOT keys are never covered that way. There is no server to
 * attribute `STRAD_TOKENS` to, and the process reads it for itself.
 *
 * ## It reads metadata, not values
 *
 * The default check is `list()` — paths, variables, a has-value flag. For a
 * secret parameter the payload it inspects is a `__REF__` pointer, not a secret.
 * The optional `resolve` check DOES render values, because proving the resolver
 * can render is the only way to know the credential's role is right, but it
 * keeps nothing and reports names alone.
 */

export interface StoreCheckResult {
  /** The namespace consulted, derived from `gateway.env`. */
  namespace: string;
  /** Every name the deployment reads from the store, sorted. */
  expected: string[];
  /** Expected names the store holds a value for. */
  present: string[];
  /**
   * Expected names this namespace does NOT hold and does not have to, because
   * every server that references them is served by its own
   * `/strad/{env}/mcp/{slug}/static/` namespace instead.
   *
   * Neither present nor missing: the gateway namespace is a FALLBACK for a
   * server's own `${NAME}`, so reporting these as missing would fail a
   * deployment that resolves every name it needs. They are named rather than
   * silently dropped, because "seeded somewhere else" and "seeded" are different
   * facts about a store.
   */
  perServer: string[];
  /** Expected names no namespace holds. The finding. */
  missing: string[];
  /** `consoleEnv:` names — deploy-environment only, never expected here. */
  environmentOnly: string[];
  /**
   * `consoleEnv:` names found IN the namespace anyway. Not a missing name — the
   * opposite — but a finding all the same, and one the pre-flip gate fails on:
   * the resolver credential can read whatever is filed here, and what is filed
   * here is the console's store-ADMIN credential.
   */
  adminCredentialsInStore: string[];
  /** Present only when `resolve` was requested. */
  render?: RenderCheck;
}

export interface RenderCheck {
  /** Names the resolver turned into a value. Never the values themselves. */
  rendered: string[];
  /** Present in the namespace, but the resolver got no value back. */
  unrendered: string[];
  /**
   * Set when `resolve()` threw — the credential cannot render at all, which is
   * the shape a missing `parametermanager.parameterAccessor` takes. Summarised
   * through `errorSummary()`, which is the same function `snapshot.ts` uses to
   * keep a `:render`ed payload out of an error message.
   */
  error?: string;
}

/**
 * Every name this config expects to find in the gateway namespace.
 *
 * Exported because it is the honest denominator: "N of M" is only meaningful if
 * a caller can see what M is built from.
 */
export function expectedStoreNames(config: StradConfig): string[] {
  const names = new Set<string>(requiredSecretNames(config));
  // `env:` only — never `consoleEnv:`. And `env:` WINS: one name can be declared
  // under both maps (by one server or by two), and it is still read from the
  // store for the `env:` declaration, so subtracting the console set wholesale
  // would drop a genuinely required name from the count.
  for (const name of supplementaryEnvNames(config)) names.add(name);
  return [...names].sort();
}

/**
 * `consoleEnv:` names that are ONLY that — read from the deploy environment and
 * never from the store. A name also declared under some server's `env:` is not
 * here: it belongs in `expected`, and reporting it as environment-only would tell
 * an operator to remove the very thing the check demands.
 */
function environmentOnlyNames(config: StradConfig): string[] {
  const fromEnv = new Set(supplementaryEnvNames(config));
  return consoleEnvNames(config).filter((name) => !fromEnv.has(name));
}

export interface StoreCheckOptions {
  /** Override the namespace `gateway.env` implies. */
  namespace?: string;
  /**
   * Also prove the resolver can RENDER each name, not merely that it exists.
   * Presence is not resolvability: `:render` dereferences as the parameter's own
   * principal, so a namespace can be complete and still resolve to nothing.
   */
  resolve?: boolean;
}

type Store = Pick<ParameterAdmin, "list"> & Pick<ParameterResolver, "resolve">;

/** Enumerate, compare, report. Reads no value unless `resolve` is set. */
export async function checkStore(
  store: Store,
  config: StradConfig,
  opts: StoreCheckOptions = {},
): Promise<StoreCheckResult> {
  const namespace = opts.namespace ?? gatewayNamespace(config.gateway.env);
  const metas = await store.list(namespace);
  const held = new Set(metas.filter((m) => m.hasValue).map((m) => m.variable));

  // The second layer. A server's `${NAME}` resolves from that server's own
  // namespace first — at render time for a supplementary `env:`, at runtime for
  // a `url:`, a `headers:` map or a builtin's `options:` — so a name every
  // referencing server holds for itself is not missing from the deployment, only
  // from this namespace.
  const refsBySlug = ownNamespaceRefsBySlug(config);
  // Only when some server references a `${NAME}` at all. `list()` enumerates the
  // whole project, so a config that cannot use the second layer must not pay for
  // a scan of it.
  const seeded =
    refsBySlug.size > 0
      ? seededByServer(
          config.gateway.env,
          await store.list(mcpNamespace(config.gateway.env)),
        )
      : new Map<string, string[]>();
  // The gateway's OWN keys, and ONLY those.
  //
  // The tempting wider exclusion is every name in `requiredSecretNames()` — the
  // boot keys plus every `${NAME}` the config references — on the grounds that a
  // reference is read in-process out of the gateway namespace whatever a server
  // was seeded. That is not how a reference resolves: `forServer(slug)` reads the
  // server's own namespace first (src/secrets/provider), so a `headers:`
  // credential filed under its own server is resolved, and calling it missing
  // would fail the gate on a store that is correct. What belongs here is the set
  // with no server to attribute it to, which the process reads for itself.
  const bootKeys = new Set<string>(CORE_BOOT_ENV_KEYS);
  const servedPerServer = (name: string): boolean => {
    if (bootKeys.has(name)) return false;
    const slugs = [...refsBySlug].filter(([, refs]) => refs.has(name));
    return (
      slugs.length > 0 &&
      slugs.every(([slug]) => (seeded.get(slug) ?? []).includes(name))
    );
  };

  const expected = expectedStoreNames(config);
  const present = expected.filter((name) => held.has(name));
  const perServer = expected.filter(
    (name) => !held.has(name) && servedPerServer(name),
  );
  const missing = expected.filter(
    (name) => !held.has(name) && !servedPerServer(name),
  );

  const environmentOnly = environmentOnlyNames(config);
  const adminCredentialsInStore = environmentOnly.filter((name) =>
    held.has(name),
  );

  const result: StoreCheckResult = {
    namespace,
    expected,
    present,
    perServer,
    missing,
    environmentOnly,
    adminCredentialsInStore,
  };

  if (opts.resolve) {
    result.render = await renderCheck(store, namespace, present);
  }
  return result;
}

/**
 * The second question: of the names that ARE there, which can the resolver
 * actually turn into a value?
 *
 * Only `present` names are candidates — an absent name has already been reported
 * once, and reporting it a second time as "did not render" would make a
 * half-seeded namespace look twice as broken as it is.
 */
async function renderCheck(
  store: Store,
  namespace: string,
  present: string[],
): Promise<RenderCheck> {
  try {
    const values = await store.resolve(namespace);
    // A value that is still a `__REF__` pointer did NOT render. The dereference
    // runs as the parameter's own principal, so a caller with `render` can be
    // handed the pointer back when that principal cannot reach the secret — and
    // a pointer is a perfectly good non-empty string, so "did I get something"
    // is the wrong question. This is the exact state issue #49 describes, and
    // reporting it as a value would make this check green on the failure it
    // exists to find.
    const resolved = (name: string): boolean => {
      const value = values[name];
      return value !== undefined && !isSecretRef(value);
    };
    return {
      rendered: present.filter(resolved),
      unrendered: present.filter((name) => !resolved(name)),
    };
  } catch (err) {
    // A 403 here is the missing accessor role, and it is the failure this whole
    // change exists to make visible. Everything else — an outage, a deadline —
    // arrives the same way and is reported the same way: by summary, never by
    // raw message, because a `:render` error can embed a rendered payload.
    return { rendered: [], unrendered: [...present], error: errorSummary(err) };
  }
}
