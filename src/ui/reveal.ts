import type { Capabilities } from "../secrets/parameters/index.ts";

/**
 * Whether this console offers REVEAL, and if not, why not.
 *
 * Two independent inputs, and that is the design rather than an accident:
 *
 *   - the FLAG (`SECRETS_REVEAL_ENABLED`) is the product decision — what this
 *     deployment's console should put in front of a human.
 *   - the PROBE (`secretmanager.versions.access` on the console's service
 *     account) is the boundary — what that identity is permitted to do at all.
 *
 * The flag is convenience and clarity; the IAM grant is the thing that cannot be
 * bypassed. Neither substitutes for the other, so both must say yes and the
 * narrower one always wins. A flag alone would be a UI decision dressed up as a
 * security property; a grant alone would offer a button in an environment that
 * had decided not to have one.
 *
 * WHERE THEY DISAGREE we fail closed, and we say which way they disagree —
 * because the two directions call for opposite fixes:
 *
 *   flag ON, credential CANNOT   → the deployment intends to offer reveal and
 *                                  cannot. Reveal is withheld; the fix is an IAM
 *                                  grant. Surfacing this as a button that 403s
 *                                  is how a human ends up debugging Google.
 *   flag OFF, credential CAN     → the deployment intends NOT to offer reveal
 *                                  and the credential could anyway. Reveal is
 *                                  withheld, and this is reported as DRIFT: the
 *                                  UI decision is holding, the boundary is not.
 *                                  The fix is to narrow the service account.
 *
 * The second case is the interesting one, and it is the state prod sits in until
 * its admin SA is downgraded. Hiding the button is worth something — but the
 * page says plainly that the capability is still there, because a reader who
 * believes otherwise has a false model of their own blast radius.
 */

export type RevealPosture =
  | { allowed: true; note?: string }
  | {
      allowed: false;
      /** Short label for the disabled control. */
      label: string;
      /** One sentence naming the cause and the fix. */
      detail: string;
      /** True when the flag and the credential disagree. */
      drift: boolean;
    };

export function revealPosture(
  flagEnabled: boolean,
  caps: Capabilities,
): RevealPosture {
  if (!flagEnabled) {
    if (caps.readSecretValues) {
      return {
        allowed: false,
        label: "reveal off",
        drift: true,
        detail:
          "Reveal is switched off for this deployment, and the console's service account can " +
          "still read secret values — so this is a UI decision, not yet a boundary. Removing " +
          "`secretmanager.versions.access` from that service account is what makes it one.",
      };
    }
    return {
      allowed: false,
      label: "reveal off",
      drift: false,
      detail: caps.probed
        ? "Reveal is switched off for this deployment, and the console's service account holds " +
          "no `secretmanager.versions.access` — so it is off by configuration and impossible by " +
          "IAM. Values are write-only here."
        : "Reveal is switched off for this deployment. The console's service account was not " +
          `probed, so its capability is unverified (${caps.reason ?? "no reason given"}).`,
    };
  }

  // Flag on. The credential decides.
  if (caps.readSecretValues) {
    return {
      allowed: true,
      note: caps.probed ? undefined : "capability not verified",
    };
  }

  if (!caps.probed) {
    return {
      allowed: false,
      label: "unverified",
      drift: false,
      detail:
        "Reveal is enabled for this deployment, but whether the console's service account may " +
        `read a secret value could not be established (${caps.reason ?? "no reason given"}). ` +
        "Reveal is withheld rather than offered and failed.",
    };
  }

  return {
    allowed: false,
    label: "not permitted",
    drift: true,
    detail:
      "Reveal is enabled for this deployment, but the console's service account holds no " +
      "`secretmanager.versions.access`, so Google would refuse it. Grant that permission to the " +
      "console's admin identity, or switch the flag off — offering a control that cannot work is " +
      "worse than either.",
  };
}
