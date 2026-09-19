import type { SecretProvider } from "./types.ts";

/**
 * Boot-time hydration: the bridge between a runtime provider and the parts of
 * strad that can only read an environment variable.
 *
 * Most secrets are `${NAME}` references resolved on the request path, and those
 * rotate live. A handful are not references at all — they are env vars read once,
 * by code that has no provider in scope and no meaningful way to change its mind
 * later:
 *
 *   - `STRAD_TOKENS`        the static token store, built once at boot
 *   - `STRAD_INTERNAL_TOKEN` the ROOT core derives every component's internal
 *                            token from (src/auth/internal-token.ts); both sides
 *                            must agree, so a live rotation would need a
 *                            coordinated rollout
 *   - `ADMIN_BOOTSTRAP_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
 *     `CONSOLE_SESSION_SECRET`  console sign-in and the key that signs its
 *                            session cookie, read when the auth layer is built
 *   - `OTEL_EXPORTER_OTLP_HEADERS`  read by the OpenTelemetry SDK, from env, on
 *                            the SDK's own terms
 *   - `SENTRY_DSN`          the GlitchTip ingest credential, read once when the
 *                            exception reporter starts (telemetry/errors.ts)
 *
 * Hydrating these from the provider is what lets the deploy renderer stop baking
 * them, which is what leaves the app spec holding one credential for the gateway
 * itself: the one that reaches the store.
 *
 * ## Where this runs, and where it CANNOT
 *
 * In the strad image: the core, and a bundle component running that image in
 * `STRAD_MODE=bundle`. Both hold the resolver credential (see
 * `STRAD_IMAGE_ONLY_SECRET_KEYS` in deploy/appspec.ts), and holding it is what
 * makes hydration possible at all.
 *
 * NOT in a `supplementary-image` component. That is a third-party container: it
 * does not run strad, it deliberately holds no store credential, and giving it
 * one would not help because nothing in it knows how to ask. Its share of these
 * names — `BUNDLE_BOOT_ENV_KEYS` — is read from the store by the RENDERER and
 * baked onto that component, which is the only place it can come from. Assuming
 * otherwise is what took a store-backed bundle off telemetry 44 seconds after a
 * green deploy; see `bundleBootEnvVars` in deploy/appspec.ts.
 *
 * ## What is deliberately NOT hydrated
 *
 * A server's `consoleEnv:` — the SSO console's store-ADMIN credential, which can
 * write and reveal. It stays deploy-time baked, onto the core component only
 * (see deploy/appspec.ts `consoleEnvVars`). Two reasons, and both are load
 * bearing:
 *
 *   1. Hydration runs in every process running the strad image, bundles
 *      included. The whole point of `consoleEnv:` is that the admin key never
 *      enters the container an agent talks to. Hydrating it would put it there.
 *   2. It is a credential FOR the store, not a secret managed BY it. Filing it
 *      inside the store would let the weaker resolver credential read the
 *      stronger admin one, and the three-role IAM split would be theatre.
 *
 * The trade is stated plainly rather than hidden: **a hydrated value is read
 * once, at boot.** Rotating one of these names takes effect on the next restart,
 * not within the TTL — and on a component that was BAKED instead, on the next
 * deploy. That is not a shortcut — a token store and an internal-token root are
 * boot-scoped by nature, and pretending otherwise would mean claiming a rotation
 * had landed when half the fleet still trusted the old value. The consequence
 * that follows: rotating `STRAD_INTERNAL_TOKEN` is a REDEPLOY, not a restart,
 * because core hydrates the root and every other component is baked the token
 * derived from it — and a restart of core alone would leave the two
 * disagreeing. The table in
 * docs/operate/secrets.md says which names land where.
 *
 * An existing env var is never overwritten. A value injected by the platform is
 * the more specific instruction, and this must not fight it.
 */

/**
 * Keys the CORE gateway reads directly from `process.env`.
 *
 * If you add an env var that holds a credential and is read at boot, add it
 * here, or a store-backed deployment will not have it.
 */
export const CORE_BOOT_ENV_KEYS = [
  "STRAD_TOKENS",
  "STRAD_INTERNAL_TOKEN",
  "ADMIN_BOOTSTRAP_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "CONSOLE_SESSION_SECRET",
  "STRAD_OAUTH_KEY",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "SENTRY_DSN",
] as const;

/**
 * The boot keys a deployment cannot function without.
 *
 * Under the `env` provider these are `secret(key, required)` in the renderer, so
 * a missing one fails the deploy. The store-backed path must hold the same line
 * or it is a fail-closed regression wearing a preflight: without `STRAD_TOKENS`
 * the gateway comes up with `/mcp` rejecting every request, and without
 * `STRAD_INTERNAL_TOKEN` core cannot authenticate to its own bundles. Both are
 * silent at deploy time and obvious only in production.
 *
 * Everything else in `CORE_BOOT_ENV_KEYS` is genuinely optional — a deployment
 * with no console has no `GOOGLE_CLIENT_SECRET`, and demanding one would fail
 * deploys that are correct. `CONSOLE_SESSION_SECRET` is optional twice over: the
 * session key falls back to deriving from `GOOGLE_CLIENT_SECRET`, which is
 * hydrated here, so a store-backed console signs people in without it.
 * `STRAD_OAUTH_KEY` is optional on the same terms and for the same reason — the
 * `/mcp` authorization server derives its keys from `CONSOLE_SESSION_SECRET`,
 * else `GOOGLE_CLIENT_SECRET`, when it is absent (src/auth/mcp-oauth/keys.ts).
 * Seed it when you want to invalidate every OAuth grant without signing every
 * human out of the console.
 */
export const REQUIRED_BOOT_ENV_KEYS = [
  "STRAD_TOKENS",
  "STRAD_INTERNAL_TOKEN",
] as const;

/**
 * The subset a BUNDLE component reads.
 *
 * A bundle answers the core over the private network and serves no console and
 * no public route. It has no use for the token store or the OAuth client, so it
 * is not given them — the same reasoning that keeps `consoleEnv:` off it. Least
 * privilege is cheap here; it is one array.
 *
 * It has a second reader: `deploy/appspec.ts` hands exactly these names to a
 * `supplementary-image` component, which cannot hydrate them — baked from the
 * store under the store provider, let through the broadcast under `env`. Same
 * list, because it is the same question — what a bundle needs and nothing more
 * — answered for a container that has to be handed it rather than fetching it.
 * Adding a name here therefore widens what a third-party image is given, under
 * EITHER provider; that is the review this array deserves.
 *
 * `STRAD_INTERNAL_TOKEN` is NOT here, though every bundle holds a variable by
 * that name. What a bundle holds under it is its OWN token, derived from the
 * root by the renderer (`componentTokenEnv` in deploy/appspec.ts); the root
 * itself is core's alone. Hydrating it here would put the root — every
 * component's token — into a bundle process, and it would never be used: the
 * baked derived value is already set, and hydration does not overwrite.
 */
export const BUNDLE_BOOT_ENV_KEYS = ["OTEL_EXPORTER_OTLP_HEADERS"] as const;

/**
 * The boot keys that stop at strad's own process: every `CORE_BOOT_ENV_KEYS`
 * name a bundle does not read.
 *
 * Derived rather than listed, because it is the array above answered from the
 * other side, and a second hand-written answer can drift from the first without
 * anything failing. Under the `env` provider every boot key is a SECRET in the
 * broadcast, so this set is what keeps the token store, the console's bypass
 * token, its OAuth client and its cookie-signing key out of every third-party
 * container. `deploy/appspec.ts` keeps it off every `supplementary-image`
 * component under both providers. So a name added to `CORE_BOOT_ENV_KEYS` is
 * core-only by default, and the one edit that puts it inside a third-party
 * image is adding it to `BUNDLE_BOOT_ENV_KEYS`.
 *
 * `SENTRY_DSN` is the member most likely to be mistaken for telemetry that
 * should travel with the OTLP header. It should not: only strad's own process
 * reports exceptions (telemetry/errors.ts), a supplementary image runs someone
 * else's code, and a DSN is a write credential for the ingestor — a third-party
 * container holding one could write into strad's issue tracker.
 */
export const CORE_ONLY_BOOT_ENV_KEYS: readonly string[] =
  CORE_BOOT_ENV_KEYS.filter(
    (k) => !(BUNDLE_BOOT_ENV_KEYS as readonly string[]).includes(k),
  );

export function bootEnvNames(mode: "core" | "bundle"): readonly string[] {
  return mode === "bundle" ? BUNDLE_BOOT_ENV_KEYS : CORE_BOOT_ENV_KEYS;
}

/**
 * Fill in missing boot env vars from the provider.
 *
 * Returns the NAMES that were hydrated, for the boot log. Names only — a log
 * line saying which secrets a process found is operationally useful; one saying
 * what they are is a breach.
 *
 * A provider failure here is not fatal. Every key is optional at this layer, and
 * the components that need one fail loudly on their own terms (no `STRAD_TOKENS`
 * already logs a warning and leaves /mcp a wall with no door). Turning a store
 * blip into a crash-loop would be strictly worse.
 */
export async function hydrateBootEnv(
  provider: SecretProvider,
  mode: "core" | "bundle",
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const hydrated: string[] = [];

  await Promise.all(
    bootEnvNames(mode).map(async (name) => {
      if (typeof env[name] === "string" && env[name] !== "") return;
      let value: string | null;
      try {
        value = await provider.get(name);
      } catch {
        // The provider already warns on a failed read. Nothing here can carry a
        // value into a log, and the caller must not be handed one either.
        return;
      }
      if (value === null) return;
      env[name] = value;
      hydrated.push(name);
    }),
  );

  return hydrated.sort();
}
