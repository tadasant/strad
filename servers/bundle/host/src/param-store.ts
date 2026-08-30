/**
 * The mount-facing half of the parameter write-back path.
 *
 * A mount whose credential ROTATES ON USE — X's OAuth refresh token is the case
 * that drove this — needs two things this container cannot do for itself: read
 * the value that is current NOW rather than the one the last deploy baked, and
 * persist the value it just rotated to, so the next restart is not born holding
 * a dead credential.
 *
 * Neither is possible from inside this image with a cloud credential, because
 * this image deliberately holds none (`STRAD_IMAGE_ONLY_SECRET_KEYS` in strad's
 * src/deploy/appspec.ts keeps the store credential off every supplementary
 * component). So both go through CORE, which holds the store-admin credential.
 *
 * THE CLIENT ITSELF IS IN `param-route.ts`, vendored from strad's
 * `src/secrets/param-route.ts` — including its rule that a failed read degrades
 * to the baked environment while a failed write throws. That rule is the whole
 * safety story of this path, and it lives on the strad side so a test can drive
 * it against the real route. This file is the binding: this container's
 * environment, and this container's logger.
 */
import {
  CORE_URL_ENV,
  createParamClient,
  paramRefreshSeconds,
  parseParamRefreshPlan,
  refreshParamsOnce,
  type ParamClient,
  type ParamRefreshTarget,
} from "./param-route.js";
import { prefixedEnvName } from "./env-prefix.js";
import { errMessage, log, logWarn } from "./log.js";

export type { ParamClient as ParamStore } from "./param-route.js";

/** A store handle for one strad slug, bound to this container's environment. */
export function paramStoreFor(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): ParamClient {
  return createParamClient({
    slug,
    baseUrl: env[CORE_URL_ENV],
    token: env.STRAD_INTERNAL_TOKEN,
    note: (level, message) =>
      (level === "warn" ? logWarn : log)(`${slug}: ${message}`),
  });
}

/**
 * Keep the parameters a config listed under `paramsRefresh:` current in THIS
 * container's environment, without a redeploy.
 *
 * ## Why the container is the one doing it
 *
 * A supplementary component's credentials are baked as env vars by
 * `renderAppSpec`, and process environment is fixed at spawn — so core, which
 * holds the store credential, has no way to push a rotated value in. The only
 * thing that can change this process's environment is this process. So the pull
 * lives here, over the route core already serves for the boot read.
 *
 * ## What a caller gets, and what it does not
 *
 * The value lands in `process.env` under its bare name and under this slug's
 * `<SLUG>__<NAME>` alias, which is every name anything in this image looks for
 * (see env-prefix.ts). Whether the MOUNT then notices is a property of the
 * upstream, not of this file: one that reads `process.env` when it builds a
 * client per request picks it up on the next call, and one that snapshotted its
 * credential at mount time and memoised a connection does not. `liveEnv` on a
 * Mount is how this image records which is which, so the difference is a line in
 * the boot log rather than a silent no-op. See HACKS.md #71 in the strad repo.
 */

/** What `startParamRefresh` needs to know about a mount, and nothing more. */
export interface RefreshableMount {
  slug: string;
  /**
   * True when this mount reads its credential out of `process.env` late enough
   * that a refreshed value reaches it — a client built per request, rather than
   * one memoised at mount time.
   */
  liveEnv?: boolean;
}

export interface ParamRefreshHandle {
  /** Run one pass now. Exposed for tests and for a boot-time first read. */
  runOnce: () => Promise<{ slug: string; variable: string }[]>;
  stop: () => void;
}

/**
 * Start the refresh loop, or return null when this deployment asked for none.
 *
 * Null rather than a no-op handle so the caller's boot log can say nothing at
 * all in the overwhelmingly common case: no server sets `paramsRefresh:` by
 * default, so most containers running this image have no plan.
 */
export function startParamRefresh(opts: {
  mounts: readonly RefreshableMount[];
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  clientFor?: (slug: string) => ParamClient;
  timer?: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  };
}): ParamRefreshHandle | null {
  const env = opts.env ?? process.env;
  const plan: ParamRefreshTarget[] = parseParamRefreshPlan(env);
  if (plan.length === 0) return null;

  const seconds = paramRefreshSeconds(env);
  const bySlug = new Map(opts.mounts.map((m) => [m.slug, m]));
  const clientFor = opts.clientFor ?? ((slug: string) => paramStoreFor(slug, env));

  for (const target of plan) {
    const mount = bySlug.get(target.slug);
    // NOT A FAILURE, AND STILL WORTH SAYING. The refresh will do exactly what it
    // says — put the current value in this container's environment — and the
    // upstream may go on using the one it captured at boot. That is the single
    // most likely way for this feature to look broken, and it is invisible from
    // core, so it is said here, at boot, once, by name.
    if (!mount) {
      log(
        `${target.slug}: refreshing ${target.variables.join(", ")} every ` +
          `${seconds}s, but this image serves no mount at /${target.slug} — the ` +
          `values will be current in the environment and nothing here reads them`,
      );
    } else if (mount.liveEnv !== true) {
      logWarn(
        `${target.slug}: refreshing ${target.variables.join(", ")} every ` +
          `${seconds}s, but this mount is not marked as reading its credential ` +
          `per call — a rotated value will be current in the environment and ` +
          `the mount may keep using the one it captured at boot until the next ` +
          `restart`,
      );
    } else {
      log(
        `${target.slug}: refreshing ${target.variables.join(", ")} every ` +
          `${seconds}s; this mount reads its credential per call`,
      );
    }
  }

  const runOnce = () =>
    refreshParamsOnce({
      plan,
      clientFor,
      env: env as Record<string, string | undefined>,
      // Both names, so a tree reading through `slugEnvView` and one reading the
      // bare name see the same value. The alias is slug-scoped by construction,
      // so writing it can only ever touch this server's own credential.
      names: (slug, variable) => {
        const alias = prefixedEnvName(slug, variable);
        return alias === null ? [variable] : [variable, alias];
      },
      onChange: (slug, variable) =>
        log(
          `${slug}: ${variable} changed in the parameter store and is now ` +
            `current in this container's environment`,
        ),
      note: (level, message) => (level === "warn" ? logWarn : log)(message),
    });

  const timer = opts.timer ?? {
    set: (fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      // A refresh must never be the reason a container stays alive.
      t.unref?.();
      return t;
    },
    clear: (handle: unknown) => clearInterval(handle as NodeJS.Timeout),
  };

  // ONE PASS AT A TIME. A pass is `plan.length` sequential reads against core,
  // each with its own timeout, so a slow or unreachable core can make a pass
  // outrun the interval — and `setInterval` does not care, it just fires again.
  // Without this the passes pile up, and the thing they pile onto is the
  // parameter store that has already 429'd three production deploys.
  let running = false;
  const handle = timer.set(() => {
    if (running) {
      logWarn(
        `skipping a parameter refresh: the previous pass is still running ` +
          `(the interval is ${seconds}s)`,
      );
      return;
    }
    running = true;
    void runOnce()
      .catch((err: unknown) =>
        logWarn(`parameter refresh pass failed: ${errMessage(err)}`),
      )
      .finally(() => {
        running = false;
      });
  }, seconds * 1000);

  return { runOnce, stop: () => timer.clear(handle) };
}
