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
 *   - `STRAD_INTERNAL_TOKEN` core <-> bundle auth; both sides must agree, so a
 *                            live rotation would need a coordinated rollout
 *   - `ADMIN_BOOTSTRAP_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
 *     `CONSOLE_SESSION_SECRET`  console sign-in and the key that signs its
 *                            session cookie, read when the auth layer is built
 *   - `OTEL_EXPORTER_OTLP_HEADERS`  read by the OpenTelemetry SDK, from env, on
 *                            the SDK's own terms
 *
 * Hydrating these from the provider is what lets the deploy renderer stop baking
 * them, which is what leaves the app spec holding one credential for the gateway
 * itself: the one that reaches the store.
 *
 * ## What is deliberately NOT hydrated
 *
 * A server's `consoleEnv:` — the SSO console's store-ADMIN credential, which can
 * write and reveal. It stays deploy-time baked, onto the core component only
 * (see deploy/appspec.ts `consoleEnvVars`). Two reasons, and both are load
 * bearing:
 *
 *   1. Hydration runs in every strad process, bundles included. The whole point
 *      of `consoleEnv:` is that the admin key never enters the container an agent
 *      talks to. Hydrating it would put it there.
 *   2. It is a credential FOR the store, not a secret managed BY it. Filing it
 *      inside the store would let the weaker resolver credential read the
 *      stronger admin one, and the three-role IAM split would be theatre.
 *
 * The trade is stated plainly rather than hidden: **a hydrated value is read
 * once, at boot.** Rotating one of these names takes effect on the next restart,
 * not within the TTL. That is not a shortcut — a token store and a shared
 * internal token are boot-scoped by nature, and pretending otherwise would mean
 * claiming a rotation had landed when half the fleet still trusted the old value.
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
  "OTEL_EXPORTER_OTLP_HEADERS",
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
 */
export const BUNDLE_BOOT_ENV_KEYS = [
  "STRAD_INTERNAL_TOKEN",
  "OTEL_EXPORTER_OTLP_HEADERS",
] as const;

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
