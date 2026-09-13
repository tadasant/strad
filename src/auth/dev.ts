import type { StradConfig } from "../config/schema.ts";
import { secretEquals } from "./credential.ts";
import type { Principal } from "./index.ts";

/**
 * The console dev bypass.
 *
 * Google OAuth credentials do not exist yet, so /console needs some way in.
 * This is it — and it is deliberately hemmed in:
 *
 *   - It can ONLY authenticate /console. There is no code path from here to
 *     /mcp; /mcp calls authenticateMcp(), which only knows about static tokens.
 *   - It still requires a secret: ADMIN_BOOTSTRAP_TOKEN. The console is not
 *     freely browsable just because OAuth is missing.
 *   - It is hard-disabled under NODE_ENV=production unless
 *     ALLOW_DEV_AUTH_IN_PRODUCTION is explicitly "true" as well. Fail closed: a
 *     missing/garbled env var disables it.
 *   - It shouts at boot whenever it is live.
 *
 * Delete this file the day Google OAuth credentials land. See HACKS.md.
 */

export interface DevBypassStatus {
  active: boolean;
  reason: string;
}

export function devBypassStatus(
  cfg: StradConfig,
  env: NodeJS.ProcessEnv = process.env,
): DevBypassStatus {
  if (!cfg.auth.consoleDevBypass.enabled) {
    return { active: false, reason: "auth.consoleDevBypass.enabled is false" };
  }

  // Note the shape: we require the literal string "true". Anything else — unset,
  // "1", "TRUE ", garbage — is off.
  if (env.ALLOW_DEV_AUTH !== "true") {
    return { active: false, reason: "ALLOW_DEV_AUTH is not 'true'" };
  }

  // The copy-staging-spec-to-prod hole: staging runs NODE_ENV=production with
  // ALLOW_DEV_AUTH=true (that's fine — staging WANTS the bypass). If that spec
  // is duplicated to real prod, ALLOW_DEV_AUTH comes along for the ride. So in
  // production we demand a SEPARATE acknowledgement that names production; a
  // staging spec never carries it, so the bypass fails closed on the copy.
  if (
    env.NODE_ENV === "production" &&
    env.ALLOW_DEV_AUTH_IN_PRODUCTION !== "true"
  ) {
    return {
      active: false,
      reason:
        "NODE_ENV=production requires ALLOW_DEV_AUTH_IN_PRODUCTION=true as well",
    };
  }

  if (!env.ADMIN_BOOTSTRAP_TOKEN) {
    return { active: false, reason: "ADMIN_BOOTSTRAP_TOKEN is not set" };
  }

  // "active", not "enabled": this reason is surfaced to a caller who was just
  // turned away, and "enabled" reads like the config flag — one guard of the
  // triple guard — rather than the verdict that every guard passed.
  return { active: true, reason: "active" };
}

/** Why a console request was refused, in the two shapes an operator acts on. */
export interface ConsoleDenial {
  /** The two states, as a machine-readable code. */
  error: "invalid_bootstrap_token" | "console_unavailable";
  message: string;
  /** `devBypassStatus().reason` — "active", or the guard that is holding. */
  devBypass: string;
}

/**
 * Which of the two refusals this deployment owes the caller.
 *
 * They are opposite diagnoses with opposite fixes, and answering both with one
 * body costs real time: `invalid_bootstrap_token` means the door is there and
 * the key is wrong, `console_unavailable` means there is no door on this
 * deployment at all. Both surfaces — the `/console` JSON and the console's
 * sign-in wall — resolve it here so they cannot drift into disagreeing.
 *
 * **The disclosure this makes, deliberately.** Naming the first case tells an
 * unauthenticated caller that a dev bypass is live here. That is acceptable,
 * and the reason is the condition itself: the answer only ever differs on a
 * deployment that clears the triple guard in `devBypassStatus()` — the config
 * flag, `ALLOW_DEV_AUTH`, the production acknowledgement that `NODE_ENV`
 * demands — and has a token set. An operator who cleared all of that has
 * already accepted a console door held by one shared secret, loudly, at boot.
 * What leaks is the existence of a door whose credential is no weaker for being
 * known about — and a refusal has always carried the guard state in `devBypass`
 * anyway, so this makes an existing signal honest and machine-readable rather
 * than moving the boundary. A deployment that has NOT cleared it — real prod, which fails
 * closed on a copied staging spec — answers `console_unavailable` and names the
 * guard that is holding, which carries no more than the same refusal always did.
 *
 * It is NOT gated on `NODE_ENV`, because that would withhold it from the exact
 * person it is for: staging runs `NODE_ENV=production` with both dev-auth
 * acknowledgements set, so a production gate would blind the one environment
 * where the bypass is the only way in. The gate is "is the bypass live", which
 * is the operator's own deliberate, loudly-logged decision.
 *
 * This is a narrower rule than `/mcp`'s, which answers every failure with one
 * opaque 401 (`src/auth/index.ts`) because there the distinctions are halves of
 * a credential — which token, which field was right. Here the distinction is
 * whether a door exists, not how close an attempt came to opening it, so
 * nothing about the token itself is disclosed: not its length, not a prefix,
 * not whether the caller's own attempt was close. `/mcp` keeps its opaque 401.
 */
export function consoleDenial(
  cfg: StradConfig,
  env: NodeJS.ProcessEnv = process.env,
): ConsoleDenial {
  const status = devBypassStatus(cfg, env);

  if (status.active) {
    return {
      error: "invalid_bootstrap_token",
      message:
        "The console dev bypass is active on this deployment, and the " +
        "ADMIN_BOOTSTRAP_TOKEN presented is missing or does not match. " +
        "Present it as ?token=… or as an Authorization: Bearer header.",
      devBypass: status.reason,
    };
  }

  return {
    error: "console_unavailable",
    message:
      "Google OAuth is not configured and the console dev bypass is not active.",
    devBypass: status.reason,
  };
}

/**
 * Boot-time guard. Called from src/index.ts before the server listens.
 *
 * The double-acknowledgement that prevents a staging spec from carrying the
 * bypass into prod lives in devBypassStatus() (ALLOW_DEV_AUTH_IN_PRODUCTION).
 * This function's job is to make an active bypass IMPOSSIBLE to miss in the
 * logs — especially under NODE_ENV=production, where it should never be.
 */
export function assertDevBypassAllowed(
  cfg: StradConfig,
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.warn,
): void {
  const status = devBypassStatus(cfg, env);
  if (!status.active) return;

  const isProd = env.NODE_ENV === "production";

  log(
    [
      "",
      "  ############################################################",
      "  #  CONSOLE DEV BYPASS IS ACTIVE                            #",
      "  #                                                          #",
      "  #  /console can be entered with ADMIN_BOOTSTRAP_TOKEN,     #",
      "  #  without Google OAuth. This is a temporary stand-in      #",
      "  #  until GOOGLE_CLIENT_ID/SECRET are provisioned.          #",
      "  #                                                          #",
      "  #  /mcp is NOT affected: it still requires a static        #",
      "  #  system token. Set ALLOW_DEV_AUTH=false to kill this.    #",
      "  ############################################################",
      "",
    ].join("\n"),
  );

  if (isProd) {
    log(
      "  !! NODE_ENV=production WITH THE DEV BYPASS ON. This is not a drill.\n",
    );
  }
}

/**
 * Authenticate a console request via the bypass.
 *
 * Returns null when the bypass is off (so the caller falls through to Google
 * OAuth, or to a 401 if that is not configured either).
 */
export function authenticateConsoleBypass(
  presentedToken: string | undefined,
  cfg: StradConfig,
  env: NodeJS.ProcessEnv = process.env,
): Principal | null {
  const status = devBypassStatus(cfg, env);
  if (!status.active) return null;

  const expected = env.ADMIN_BOOTSTRAP_TOKEN;
  if (!expected || !presentedToken) return null;
  if (!secretEquals(presentedToken, expected)) return null;

  return {
    kind: "console-bypass",
    id: "dev-bypass",
    label: "console dev bypass",
    roles: cfg.auth.consoleDevBypass.roles,
  };
}
