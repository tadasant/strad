/**
 * Human-paced sending.
 *
 * An unofficial client's ban risk is mostly about looking like a bot: bursts,
 * instant replies, volume. So every send is serialized, spaced from the last
 * one, preceded by a "typing…" indicator for a length-proportional moment, and
 * capped per minute and per hour. A caller over a cap is REFUSED with the wait,
 * never queued: a queue of sends nobody is watching is exactly the bulk
 * sending this is here to prevent.
 */

export interface PacingLimits {
  /** Minimum gap between two sends. */
  minGapMs: number;
  perMinute: number;
  perHour: number;
  /** Typing indicator: base + per character, capped. */
  typingBaseMs: number;
  typingPerCharMs: number;
  typingMaxMs: number;
}

export const DEFAULT_PACING: PacingLimits = {
  minGapMs: 3_000,
  perMinute: 6,
  perHour: 60,
  typingBaseMs: 800,
  typingPerCharMs: 25,
  typingMaxMs: 4_000,
};

export class RateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimited";
  }
}

export class Pacer {
  private readonly sent: number[] = [];
  private lastSendAt = Number.NEGATIVE_INFINITY;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly limits: PacingLimits = DEFAULT_PACING,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  typingMs(text: string): number {
    return Math.min(
      this.limits.typingMaxMs,
      this.limits.typingBaseMs + text.length * this.limits.typingPerCharMs,
    );
  }

  private checkCaps(): void {
    const now = this.clock();
    while (this.sent.length && now - this.sent[0]! >= 3_600_000) this.sent.shift();
    const lastMinute = this.sent.filter((t) => now - t < 60_000);
    if (lastMinute.length >= this.limits.perMinute) {
      const wait = Math.ceil((60_000 - (now - lastMinute[0]!)) / 1000);
      throw new RateLimited(
        `Refused: ${this.limits.perMinute} messages already sent in the last ` +
          `minute. Wait ${wait}s. This bridge sends at a human pace on purpose — ` +
          `bursts are what get an unofficial client's account banned.`,
      );
    }
    if (this.sent.length >= this.limits.perHour) {
      const wait = Math.ceil((3_600_000 - (now - this.sent[0]!)) / 60_000);
      throw new RateLimited(
        `Refused: ${this.limits.perHour} messages already sent in the last hour. ` +
          `Wait ${wait} minute(s). This is not a bulk-sending channel.`,
      );
    }
  }

  /**
   * Run `send` at a human pace. `typing` is called first and its failure is
   * ignored — an indicator that did not show is not a reason to not send.
   */
  run<T>(text: string, typing: () => Promise<void>, send: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      this.checkCaps();
      const gap = this.lastSendAt + this.limits.minGapMs - this.clock();
      if (gap > 0) await this.sleep(gap);
      await typing().catch(() => {});
      await this.sleep(this.typingMs(text));
      this.checkCaps();
      const result = await send();
      this.lastSendAt = this.clock();
      this.sent.push(this.lastSendAt);
      return result;
    });
    this.chain = next.catch(() => {});
    return next;
  }
}
