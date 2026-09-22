import { CAPABILITIES } from "../capabilities.js";
import type { ConsentGate } from "../consent/gate.js";
import type { KillSwitch } from "../killswitch.js";
import type { HelperClient } from "./client.js";

/**
 * The banner and the menu-bar state, kept true.
 *
 * The daemon owns the grants; the helper only draws them. So the whole
 * protocol is one idempotent message, `set_state`, carrying every grant in
 * force, sent when the set changes and again on a clock, unconditionally. The
 * clock is what puts the banner back after the helper restarts, and it keeps
 * the daemon the helper's controller: the helper honours ONE connection at a
 * time, and refuses every op that acts on the machine unless it comes from
 * that connection and the state it last sent carries a grant that covers it.
 *
 * What that does not do, and the docs say so: a process running as the owner
 * — a shell-slug command is one — can stop this daemon, edit its config or
 * replace the helper. The gate closes the cheap path; it is not a privilege
 * boundary.
 *
 * Buttons come back as events, and the daemon ends the grant.
 */
export class Presence {
  private timer?: NodeJS.Timeout;
  /** How many times the state has been pushed. Tests. */
  sends = 0;
  private closing = false;

  constructor(
    private readonly deps: {
      helper: HelperClient;
      gate: ConsentGate;
      killSwitch: KillSwitch;
      controlUrl?: string;
      log?: (line: string) => void;
    },
  ) {}

  start(everyMs = 2000): void {
    this.timer = setInterval(() => void this.sync(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  state(): {
    disabled: boolean;
    control_url?: string;
    grants: {
      id: string;
      server: string;
      purpose: string;
      foreground: boolean;
    }[];
  } {
    return {
      disabled: this.deps.killSwitch.isDisabled(),
      ...(this.deps.controlUrl ? { control_url: this.deps.controlUrl } : {}),
      grants: this.deps.gate.grants.active().map((g) => ({
        id: g.id,
        server: g.server,
        purpose: g.purpose,
        foreground: CAPABILITIES[g.capability].mode === "foreground",
      })),
    };
  }

  /**
   * Push the state. Sending never throws: a helper that is not there is a
   * banner that is not there, and the notification still is.
   */
  async sync(): Promise<void> {
    if (this.closing) return;
    const state = this.state();
    // Nothing to show and never connected: do not start a helper just to say so.
    if (
      !this.deps.helper.connected &&
      state.grants.length === 0 &&
      this.sends === 0
    )
      return;
    try {
      await this.deps.helper.call("set_state", state, 5000);
      this.sends += 1;
    } catch (err) {
      if (!this.closing)
        this.deps.log?.(`banner not shown: ${(err as Error).message}`);
    }
  }

  /** The last push before the daemon stops; nothing after it is logged. */
  async close(): Promise<void> {
    this.stop();
    await this.sync();
    this.closing = true;
  }
}
