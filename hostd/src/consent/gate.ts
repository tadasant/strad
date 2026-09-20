import type { AuditLog } from "../audit.js";
import type { CapabilityId } from "../capabilities.js";
import type { Config } from "../config.js";
import type { KillSwitch } from "../killswitch.js";
import { GrantStore, type Grant } from "./grants.js";
import type { Notifier } from "./notifier.js";
import type { Prompter } from "./prompter.js";
import { normalizePurpose } from "./purpose.js";

export type GateDecision =
  | {
      ok: true;
      grant: Grant;
      how: "allowed" | "timeout-allow" | "no-consent-mode";
    }
  | { ok: false; code: DenyCode; reason: string };

export type DenyCode =
  | "disabled"
  | "bad_purpose"
  | "cooldown"
  | "too_many_grants"
  | "dialog_busy"
  | "rejected"
  | "timeout"
  | "no_display";

/**
 * The one decision point between "a request arrived" and "a grant exists".
 *
 * Order matters and is the security argument: the kill switch is consulted
 * FIRST and again AFTER the dialog (the owner may have thrown it while the
 * dialog was up), a rejected capability goes quiet for a cooldown so a caller
 * cannot wear the owner down with dialogs, and every path that did not end in a
 * human saying yes — or an owner's standing `onTimeout: allow` — is a denial.
 */
export class ConsentGate {
  readonly grants: GrantStore;
  private readonly cooldownUntil = new Map<CapabilityId, number>();
  /** Requests whose dialog is on screen right now, for the status page. */
  readonly pending = new Map<
    number,
    { server: string; purpose: string; since: number }
  >();
  private seq = 0;

  constructor(
    private readonly deps: {
      config: Config;
      prompter: Prompter;
      killSwitch: KillSwitch;
      audit: AuditLog;
      /** Told when a grant starts and ends. Optional: stdio with consent off has no use for it. */
      notifier?: Notifier;
      /** Where the owner can see and kill grants, for the notification text. */
      controlUrl?: string;
      now?: () => number;
    },
  ) {
    const { consent } = deps.config;
    this.grants = new GrantStore({
      idleMs: consent.idleMinutes * 60_000,
      now: deps.now,
      onEnd: (g, reason) => {
        deps.audit.record({
          kind:
            reason === "killed" || reason === "disabled"
              ? "killed"
              : reason === "ended"
                ? "ended"
                : "expired",
          capability: g.capability,
          grantId: g.id,
          detail: `grant ${reason} after ${g.calls} call(s)`,
        });
        deps.notifier?.notify(
          `${g.server} no longer has control`,
          `Grant ${reason} after ${g.calls} call${g.calls === 1 ? "" : "s"}.`,
        );
      },
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async request(input: {
    capability: CapabilityId;
    server: string;
    purpose: unknown;
    minutes?: number;
    signal?: AbortSignal;
  }): Promise<GateDecision> {
    const { config, killSwitch, audit, prompter } = this.deps;
    const { consent } = config;
    const deny = (code: DenyCode, reason: string): GateDecision => {
      audit.record({
        kind: "denied",
        capability: input.capability,
        detail: `${code}: ${reason}`,
      });
      return { ok: false, code, reason };
    };

    if (killSwitch.isDisabled()) {
      return deny(
        "disabled",
        `remote control of ${config.machine} is switched off by its owner`,
      );
    }
    const purpose = normalizePurpose(input.purpose);
    if (!purpose.ok) return deny("bad_purpose", purpose.reason);

    const cooling =
      (this.cooldownUntil.get(input.capability) ?? 0) - this.now();
    if (cooling > 0) {
      return deny(
        "cooldown",
        `the owner rejected a request for this server moments ago; it accepts new requests in ${Math.ceil(cooling / 1000)}s. Do not retry in a loop — a rejection is an answer`,
      );
    }
    // ONE dialog on screen at a time, machine-wide. The cooldown below is only
    // written after a rejection comes back, so without this a caller firing N
    // requests at once gets N dialogs up before the first "no" can land — and
    // wearing the owner down with dialogs is what the cooldown exists to stop.
    // Checked and claimed with no `await` between, so it cannot be raced.
    if (consent.mode !== "none" && this.pending.size > 0) {
      return deny(
        "dialog_busy",
        `another request's consent dialog is on ${config.machine}'s screen right now; ask again in ${consent.windowSeconds + 1}s`,
      );
    }
    if (
      this.grants.active().length + this.pending.size >=
      consent.maxActiveGrants
    ) {
      return deny(
        "too_many_grants",
        `${consent.maxActiveGrants} grants are already active or pending on this machine`,
      );
    }

    audit.record({
      kind: "request",
      capability: input.capability,
      detail: `${input.server}: ${purpose.purpose}`,
    });

    let how: "allowed" | "timeout-allow" | "no-consent-mode";
    if (consent.mode === "none") {
      how = "no-consent-mode";
    } else {
      const ticket = ++this.seq;
      this.pending.set(ticket, {
        server: input.server,
        purpose: purpose.purpose,
        since: this.now(),
      });
      let answer;
      try {
        answer = await prompter.prompt({
          server: input.server,
          purpose: purpose.purpose,
          seconds: consent.windowSeconds,
          onTimeout: consent.onTimeout,
          signal: input.signal,
        });
      } finally {
        this.pending.delete(ticket);
      }
      if (answer === "rejected") {
        this.cooldownUntil.set(
          input.capability,
          this.now() + consent.rejectCooldownSeconds * 1000,
        );
        return deny(
          "rejected",
          `the person at ${config.machine} rejected the request`,
        );
      }
      if (answer === "unavailable") {
        return deny(
          "no_display",
          `${config.machine} could not show the consent dialog (nobody is logged in to its desktop), so nobody could agree to this`,
        );
      }
      if (answer === "timeout" && consent.onTimeout === "deny") {
        return deny(
          "timeout",
          `nobody at ${config.machine} answered the consent dialog within ${consent.windowSeconds}s, and this machine denies unanswered requests. Its owner has to be at the screen`,
        );
      }
      how = answer === "allowed" ? "allowed" : "timeout-allow";
      // Thrown while the dialog was up.
      if (killSwitch.isDisabled()) {
        return deny(
          "disabled",
          `remote control of ${config.machine} is switched off by its owner`,
        );
      }
    }

    const minutes = Math.min(
      Math.max(1, Math.floor(input.minutes ?? consent.grantMinutes)),
      consent.maxGrantMinutes,
    );
    const grant = this.grants.create({
      capability: input.capability,
      server: input.server,
      purpose: purpose.purpose,
      ttlMs: minutes * 60_000,
    });
    audit.record({
      kind: "granted",
      capability: input.capability,
      grantId: grant.id,
      detail: `${how}, ${minutes} min: ${purpose.purpose}`,
    });
    this.deps.notifier?.notify(
      `${input.server} has control of ${config.machine}`,
      `${how === "timeout-allow" ? "Nobody answered the dialog, so it was allowed. " : ""}${purpose.purpose}${
        this.deps.controlUrl
          ? ` — see or kill it at ${this.deps.controlUrl}`
          : ""
      }`,
    );
    return { ok: true, grant, how };
  }

  /**
   * Bring the grants into line with the switch, and expire what has run out.
   *
   * The switch is a FILE so that `touch` works with everything else broken. A
   * file thrown that way calls nothing, so something has to notice it: the
   * daemon runs this every couple of seconds. Without it, new calls were
   * refused but a command already running kept running.
   */
  enforce(): number {
    const ended = this.deps.killSwitch.isDisabled()
      ? this.grants.endAll("disabled")
      : 0;
    this.grants.sweep();
    return ended;
  }

  /** The kill switch: no new grants, and every grant in force ends now. */
  disableAll(reason?: string): number {
    this.deps.killSwitch.disable(reason);
    this.deps.audit.record({
      kind: "disabled",
      detail: reason ?? "disabled by owner",
    });
    return this.grants.endAll("disabled");
  }

  enable(): void {
    this.deps.killSwitch.enable();
    this.deps.audit.record({ kind: "enabled", detail: "re-enabled by owner" });
  }
}
