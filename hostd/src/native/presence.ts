import { CAPABILITIES } from "../capabilities.js";
import type { ConsentGate } from "../consent/gate.js";
import type { KillSwitch } from "../killswitch.js";
import type { HelperClient } from "./client.js";

/**
 * The banner and the menu-bar state, kept true.
 *
 * The daemon owns the grants; the helper only draws them. So the whole
 * protocol is one idempotent message, `set_state`, carrying every grant in
 * force, sent when the set changes and again on a slow clock. The clock is
 * what makes the banner honest against a caller holding a shell: it can kill
 * the helper (its LaunchAgent restarts it), and the next tick puts the banner
 * back. It cannot reach the daemon's grant table from a command.
 *
 * Buttons come back as events, and the daemon ends the grant.
 */
export class Presence {
  private lastSent?: string;
  private timer?: NodeJS.Timeout;

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
    this.timer = setInterval(() => void this.sync(true), everyMs);
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
   * Push the state. `onlyIfChanged` is the timer's mode; a change to the
   * grants sends unconditionally. Sending never throws: a helper that is not
   * there is a banner that is not there, and the notification still is.
   */
  async sync(onlyIfChanged = false): Promise<void> {
    const state = this.state();
    const encoded = JSON.stringify(state);
    if (
      onlyIfChanged &&
      encoded === this.lastSent &&
      this.deps.helper.connected
    )
      return;
    // Nothing to show and never connected: do not start a helper just to say so.
    if (
      !this.deps.helper.connected &&
      state.grants.length === 0 &&
      !this.lastSent
    )
      return;
    try {
      await this.deps.helper.call("set_state", state, 5000);
      this.lastSent = encoded;
    } catch (err) {
      this.lastSent = undefined;
      this.deps.log?.(`banner not shown: ${(err as Error).message}`);
    }
  }
}
