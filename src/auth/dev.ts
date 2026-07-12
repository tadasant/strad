import type { StradConfig } from "../config/schema.ts";
import { secretEquals, type Principal } from "./index.ts";

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
 *   - It is hard-disabled under NODE_ENV=production unless ALLOW_DEV_AUTH is
 *     explicitly "true". Fail closed: a missing/garbled env var disables it.
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

  return { active: true, reason: "enabled" };
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
