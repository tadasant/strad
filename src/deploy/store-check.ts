import type { StradConfig } from "../config/schema.ts";
import {
  bakedSecretNames,
  consoleEnvNames,
  requiredSecretNames,
} from "./preflight.ts";
import { gatewayNamespace } from "../secrets/parameters/namespace.ts";
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
 * Put together on a real config: a namespace holding 3 of 31 names deploys green.
 * This module counts all 31.
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
 * A `consoleEnv:` name is the one exclusion, and it is not an oversight: it
 * carries the console's store-ADMIN credential, `render-spec` reads it from the
 * deploy environment ONLY, and filing it inside the store would let the weaker
 * resolver credential read the stronger admin one. Finding one IN the store is
 * therefore a finding of its own, reported rather than counted as present.
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
  /** Expected names the store does not hold. The finding. */
  missing: string[];
  /** `consoleEnv:` names — deploy-environment only, never expected here. */
  environmentOnly: string[];
  /**
   * `consoleEnv:` names found IN the namespace anyway. Not a missing-name
   * failure; a privilege inversion worth a human's attention, because the
   * resolver credential can read whatever is filed here.
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
  const consoleOnly = new Set(consoleEnvNames(config));
  const names = new Set<string>(requiredSecretNames(config));
  for (const name of bakedSecretNames(config)) {
    if (!consoleOnly.has(name)) names.add(name);
  }
  return [...names].sort();
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

type Store = Pick<ParameterAdmin, "list"> & Partial<ParameterResolver>;

/** Enumerate, compare, report. Reads no value unless `resolve` is set. */
export async function checkStore(
  store: Store,
  config: StradConfig,
  opts: StoreCheckOptions = {},
): Promise<StoreCheckResult> {
  const namespace = opts.namespace ?? gatewayNamespace(config.gateway.env);
  const metas = await store.list(namespace);
  const held = new Set(metas.filter((m) => m.hasValue).map((m) => m.variable));

  const expected = expectedStoreNames(config);
  const present = expected.filter((name) => held.has(name));
  const missing = expected.filter((name) => !held.has(name));

  const environmentOnly = consoleEnvNames(config);
  const adminCredentialsInStore = environmentOnly.filter((name) =>
    held.has(name),
  );

  const result: StoreCheckResult = {
    namespace,
    expected,
    present,
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
  if (!store.resolve) {
    return {
      rendered: [],
      unrendered: [...present],
      error: "this store client cannot resolve",
    };
  }
  try {
    const values = await store.resolve(namespace);
    const rendered = present.filter((name) => values[name] !== undefined);
    const unrendered = present.filter((name) => values[name] === undefined);
    return { rendered, unrendered };
  } catch (err) {
    // A 403 here is the missing accessor role, and it is the failure this whole
    // change exists to make visible. Everything else — an outage, a deadline —
    // arrives the same way and is reported the same way: by summary, never by
    // raw message, because a `:render` error can embed a rendered payload.
    return { rendered: [], unrendered: [...present], error: errorSummary(err) };
  }
}
