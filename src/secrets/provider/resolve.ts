import { secretRefRe, secretRefsIn } from "../../config/env-name.ts";
import { SecretNotFoundError, type SecretProvider } from "./types.ts";

/**
 * Resolve `${NAME}` references against a runtime provider.
 *
 * The synchronous `resolveMap` in ../index.ts resolves against a STATIC bag and
 * is the right tool for the deploy-side renderer, which holds every value
 * in hand and produces a document. These are its runtime counterparts: they ask
 * a provider, one name at a time, at the moment the value is needed.
 *
 * That "at the moment the value is needed" is the entire point. Resolving into
 * an adapter's constructor arguments at boot is what makes a rotated secret
 * require a redeploy; resolving on the request path is what makes it not.
 *
 * An unresolved reference throws. A config that ships the literal string
 * "${GRANOLA_TOKEN}" as a bearer token is worse than a failed request.
 *
 * WHAT a `${NAME}` is lives in src/config/env-name.ts, alongside the bare-name
 * form the config schema and the console gate on. This module owns the resolving,
 * not the rule.
 */

/** Every distinct `${NAME}` in a string, in first-appearance order. */
export function refsIn(value: string): string[] {
  return secretRefsIn(value);
}

export async function resolveRefsAsync(
  value: string,
  provider: SecretProvider,
): Promise<string> {
  const names = refsIn(value);
  if (names.length === 0) return value;

  // Resolve each distinct name ONCE, concurrently. A header map that references
  // the same token twice must not read it twice.
  const resolved = new Map<string, string>();
  await Promise.all(
    names.map(async (name) => {
      const found = await provider.get(name);
      if (found === null) throw new SecretNotFoundError(name);
      resolved.set(name, found);
    }),
  );

  return value.replace(secretRefRe(), (_match, name: string) =>
    resolved.get(name)!,
  );
}

/** Resolve every `${NAME}` in a string-valued map. */
export async function resolveMapAsync(
  map: Record<string, string>,
  provider: SecretProvider,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(map).map(
      async ([k, v]) => [k, await resolveRefsAsync(v, provider)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

/**
 * Resolve every string-valued entry of an options map, leaving non-strings alone.
 *
 * A builtin's `options:` is `Record<string, unknown>` — numbers, booleans and
 * nested objects are legitimate and must survive untouched. Only a top-level
 * string can carry a `${REF}`.
 */
export async function resolveOptionsAsync(
  options: Record<string, unknown>,
  provider: SecretProvider,
): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    Object.entries(options).map(
      async ([k, v]) =>
        [
          k,
          typeof v === "string" ? await resolveRefsAsync(v, provider) : v,
        ] as const,
    ),
  );
  return Object.fromEntries(entries);
}
