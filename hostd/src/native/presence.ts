import { CAPABILITIES } from "../capabilities.js";
import { screenText } from "../consent/display.js";
import type { ConsentGate } from "../consent/gate.js";
import type { KillSwitch } from "../killswitch.js";
import type { HelperClient } from "./client.js";

/** How many running calls (or background commands) a grant shows. */
const IN_FLIGHT_SHOWN = 3;

type BannerCall = {
  tool: string;
  summary: string;
  started_at: number;
};

/** What `set_state` carries. The helper ignores what it does not know. */
export type BannerState = {
  disabled: boolean;
  control_url?: string;
  grants: {
    id: string;
    server: string;
    purpose: string;
    foreground: boolean;
    started_at: number;
    expires_at: number;
    calls: number;
    session?: string;
    session_url?: string;
    /** How many calls are running; `in_flight` is the oldest few of them. */
    in_flight_count: number;
    in_flight: BannerCall[];
    background_count: number;
    /** Shell commands still running after the call that started them returned. */
    background: string[];
    recent: (BannerCall & { ended_at: number; ok: boolean })[];
  }[];
};

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
      /** The shell commands a grant has running, in full. */
      running?: (grantId: string) => string[];
      /**
       * How a call summary is redacted for the screen. The daemon passes the
       * audit's, so the banner matches what the in-flight summaries carry.
       */
      scrub?: (summary: string) => string;
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

  /**
   * Everything the banner draws. Times are epoch milliseconds, so the helper
   * counts "running for" on its own clock between pushes. Every string a
   * caller authored is already normalised (purpose) or scrubbed for the screen
   * (call summaries, the session); the helper only lays it out.
   */
  state(): BannerState {
    return {
      disabled: this.deps.killSwitch.isDisabled(),
      ...(this.deps.controlUrl ? { control_url: this.deps.controlUrl } : {}),
      grants: this.deps.gate.grants.active().map((g) => {
        // A command whose run_command is still waiting on it is already an
        // in-flight call; the rest outlived the call that started them. One
        // in-flight summary accounts for one command, so two identical
        // commands are not folded into one.
        const waiting = g.inFlight.map((f) => f.summary);
        const background = (this.deps.running?.(g.id) ?? [])
          .map((c) => (this.deps.scrub ?? screenText)(`run_command: ${c}`))
          .filter((s) => {
            const i = waiting.indexOf(s);
            if (i === -1) return true;
            waiting.splice(i, 1);
            return false;
          });
        return {
          id: g.id,
          server: g.server,
          purpose: g.purpose,
          foreground: CAPABILITIES[g.capability].mode === "foreground",
          started_at: g.createdAt,
          expires_at: g.expiresAt,
          calls: g.calls,
          ...(g.session ? { session: g.session.label } : {}),
          ...(g.session?.url ? { session_url: g.session.url } : {}),
          in_flight_count: g.inFlight.length,
          in_flight: g.inFlight.slice(0, IN_FLIGHT_SHOWN).map((c) => ({
            tool: c.tool,
            summary: c.summary,
            started_at: c.startedAt,
          })),
          background_count: background.length,
          background: background.slice(0, IN_FLIGHT_SHOWN),
          recent: g.recent.map((c) => ({
            tool: c.tool,
            summary: c.summary,
            started_at: c.startedAt,
            ended_at: c.endedAt,
            ok: c.ok,
          })),
        };
      }),
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
