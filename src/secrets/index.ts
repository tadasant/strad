/**
 * The boot-time secret BAG, and `${NAME}` resolution against it.
 *
 * This module reads the process environment ONCE into a flat frozen record, and
 * resolves `${NAME}` references against that snapshot synchronously. Two
 * callers want exactly that shape. Boot (`src/index.ts`) needs a bag before
 * anything can serve a request, and backs the console's `consoleEnv:`
 * resolution with it. The App Platform spec render (`src/deploy/appspec.ts`)
 * resolves references in CI, at deploy time, and bakes the results onto the
 * spec as SECRET env vars — which is why changing one of those means a
 * redeploy. `SecretBag`, `loadSecrets` and `resolveMap` are those two paths.
 * `resolveRefs`, the single-value resolver `resolveMap` is built on, stays
 * private to this module: nothing outside it resolves one string against a bag,
 * and its behaviour is asserted through `resolveMap`.
 *
 * The bag is every string-valued entry of the environment, read at the moment
 * `loadSecrets` is called. App Platform SECRET env vars are indistinguishable
 * from plain ones at runtime, which is exactly what this wants, and boot calls
 * it after hydration, so a store-backed deployment's bag carries what the store
 * supplied.
 *
 * A snapshot cannot notice a rotation. The read path a running gateway takes for
 * a server's `${NAME}` is `src/secrets/provider/` — one name in, one value or
 * `null` out, per request. Which backend that path reads is
 * `gateway.secrets.provider: env | gcp-parameter-store` in the config
 * (`src/config/schema.ts`), validated by Zod and checked by
 * `npm run config:check`: the container's own environment, or a parameter store
 * reached through `src/secrets/parameters/`, which speaks Google Cloud
 * **Parameter** Manager. `docs/operate/secrets.md` is the prose for all of it.
 *
 * The name `SecretSource` belongs to the `"GSM" | "ENV"` badge type in
 * `src/ui/secret-status.ts`, which describes where the console says a value
 * came from. Nothing in this module chooses a backend.
 */

import { secretRefRe } from "../config/env-name.ts";

export type SecretBag = Readonly<Record<string, string>>;

/** Snapshot every string-valued entry of `env` into a frozen bag. */
export function loadSecrets(env: NodeJS.ProcessEnv = process.env): SecretBag {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.freeze(out);
}

/**
 * Resolve `${NAME}` references in a config value against the secret bag.
 *
 * Throws on an unresolved reference. A config that silently ships the literal
 * string "${GRANOLA_TOKEN}" as a bearer token is worse than a boot failure.
 */
function resolveRefs(value: string, secrets: SecretBag): string {
  return value.replace(secretRefRe(), (_match, name: string) => {
    const found = secrets[name];
    if (found === undefined) {
      throw new Error(
        `unresolved secret reference \${${name}}: no such key in the secret bag`,
      );
    }
    return found;
  });
}

/** Resolve every `${NAME}` in a string-valued map. */
export function resolveMap(
  map: Record<string, string>,
  secrets: SecretBag,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[k] = resolveRefs(v, secrets);
  return out;
}
