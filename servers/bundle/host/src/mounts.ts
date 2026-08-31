/**
 * The decisions `buildMounts()` makes that are decidable from the environment
 * alone: which capability variables to scrub, which slugs the environment has
 * asked for a second instance of, and whether a mount that CAN be built is
 * nevertheless too under-configured to serve.
 *
 * They live beside `index.ts` rather than in it because `index.ts` calls
 * `main()` at import time — importing it starts a server, binds a port and
 * reaches into `/app/trees` — so nothing in that file can be reached by a test.
 * Everything here is a pure function of the environment it is handed, and
 * `test/mounts.test.ts` is what exercises it.
 */
import { slugsWithPrefixedNames } from "./env-prefix.js";
import { log, logWarn } from "./log.js";

/**
 * Capability is the gateway's job now. Any surviving container-side toggle would
 * silently narrow EVERY slug served from this process — including the read-write
 * ones — so it does not merely get ignored, it gets removed.
 */
export function scrubCapabilityEnv(env: NodeJS.ProcessEnv = process.env): void {
  const SHAPE =
    /(^|_)(ENABLED_TOOLGROUPS|ENABLED_TOOL_GROUPS|TOOL_GROUPS|ENABLED_TOOLS|DISABLED_TOOLS)$/;
  for (const key of Object.keys(env)) {
    if (!SHAPE.test(key)) continue;
    logWarn(
      `ignoring ${key}: capability is enforced by the strad gateway now ` +
        `(tools.allow / tools.deny in the server config), not by this container. ` +
        `Leaving it set would strip tools from the read-write slugs too.`,
    );
    delete env[key];
  }
}

/**
 * Which slugs to mount a tree under: its conventional path, plus every slug the
 * environment carries per-slug values for.
 *
 * THIS PROCESS NEVER SEES strad's CONFIG. It knows the server list only through
 * the variables the renderer baked onto the container, so "is there a second
 * telegram?" is answered by looking for `<SLUG>__TELEGRAM_API_ID` and nothing
 * else. src/secrets/env-prefix.ts (vendored here) owns the name shape on both
 * sides of that.
 *
 * THE DEFAULT SLUG IS ALWAYS MOUNTED, even when per-slug values exist. A config
 * that points several slugs at the conventional path — which is every strad
 * deployment today — must keep resolving without editing that config first, so
 * this only ever ADDS mounts.
 */
export function extraSlugs(
  defaultSlug: string,
  markerNames: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const discovered = slugsWithPrefixedNames(env, markerNames).filter(
    (slug) => slug !== defaultSlug,
  );
  if (discovered.length > 0) {
    log(
      `${defaultSlug}: per-slug environment found for ${discovered.join(", ")} — ` +
        `mounting ${discovered.length + 1} instance(s)`,
    );
  }
  return discovered;
}

/**
 * remote-filesystem, degraded rather than unmounted.
 *
 * The tools must still LIST so an agent can see what this deployment would
 * offer, and so the console shows the slug at all. Every call then fails with an
 * error naming the variable. The bucket is what the whole server is FOR, so its
 * absence degrades everything; the viewer domain only decides what happens to a
 * sensitive upload, so its absence degrades that alone — and the bucket is
 * reported first, because a deployment missing both is missing the bucket.
 *
 * `envPrefix` is passed rather than imported: `index.ts` owns
 * `REMOTE_FS_ENV_PREFIX` (it is half of the marker name
 * `test/env-prefix.markers.test.ts` greps that file for) and this only composes
 * with it.
 */
export function remoteFilesystemDegraded(
  env: Readonly<Record<string, string | undefined>>,
  envPrefix: string,
): string | null {
  if (!env[`${envPrefix}_GCS_BUCKET`]) {
    return `${envPrefix}_GCS_BUCKET is not set; every tool will fail`;
  }
  if (!env[`${envPrefix}_SENSITIVE_VIEWER_DOMAIN`]) {
    return `${envPrefix}_SENSITIVE_VIEWER_DOMAIN is not set; is_sensitive=true uploads will be refused`;
  }
  return null;
}

/**
 * A mount whose tree reports its own missing credentials — telegram and
 * google-sheets — degraded rather than unmounted, same posture, same reason.
 *
 * Each tree owns WHAT its credential is (`missingCredentials()`); this owns only
 * the sentence. The message names EVERY missing variable, not the first: three
 * absent Telegram variables are one un-seeded login, and a deployment should
 * learn that in one line rather than three deploys.
 */
export function missingCredentialsDegraded(
  missing: readonly string[],
): string | null {
  if (missing.length === 0) return null;
  return `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set; every tool will fail`;
}
