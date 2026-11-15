/**
 * Restore `STRAD_ENV_COPIES` into `process.env`, as a side effect of being
 * imported. It is the FIRST import of `index.ts`, so its body runs before any
 * other module of this host is evaluated, before any mount is built and before
 * any child process is spawned.
 *
 * The renderer bakes a per-slug value once and lists every other per-slug name
 * that holds it (`foldEnvCopies` in strad's src/deploy/appspec.ts). Restoring
 * them here gives every reader the environment an unfolded render would have
 * produced: `slugEnvView`, the per-slug instance discovery, the one-name reads
 * like `<SLUG>__OP_ELICITATION_WRITE`, and every tree's own `process.env`.
 *
 * A malformed list is fatal. It is written by the renderer and nothing else, so
 * one this cannot read is a renderer/host skew, and guessing which per-slug
 * credentials it meant to name is how a slug ends up holding a sibling's.
 */
import { applyEnvCopies } from "./env-prefix.js";
import { log, logWarn } from "./log.js";

const result = applyEnvCopies(process.env);
if (result.copied > 0) {
  log(`env: restored ${result.copied} per-slug variable(s) from STRAD_ENV_COPIES`);
}
if (result.missingSources.length > 0) {
  logWarn(
    `env: STRAD_ENV_COPIES names ${result.missingSources.join(", ")} as a source, ` +
      `and the environment does not hold it; the per-slug names copied from it are unset`,
  );
}
if (result.alreadySet.length > 0) {
  logWarn(
    `env: STRAD_ENV_COPIES lists ${result.alreadySet.join(", ")}, which the ` +
      `environment already held; the spec's copy replaced it, as a baked value would have`,
  );
}
