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
  type ParamClient,
} from "./param-route.js";
import { log, logWarn } from "./log.js";

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
