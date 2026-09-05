import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_BUDGET,
  isIdempotentMethod,
  isRetryableStatus,
  parseRetryAfter,
  retryDelayMs,
} from "../src/http/retry.ts";

/**
 * The retry policy on its own, with no service behind it.
 *
 * `src/http/retry.ts` is the one place that decides what is worth trying again
 * and how long to wait, and it has two consumers that reach it over different
 * transports: the GCP parameter store (`test/parameters.retry.test.ts`) and the
 * registry walk (`test/image-tag.test.ts`). Those two assert that their callers
 * OBEY the policy; this asserts what the policy is.
 */

describe("the retry policy itself", () => {
  it("retries a transient status only where repeating the request is safe", () => {
    // Including `429`. A refusal from a fronting proxy may post-date the write,
    // and a retried `POST` that already landed comes back `409` — which is what
    // strands a versionless parameter. See `isRetryableStatus`.
    for (const s of [429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(s, true)).toBe(true);
      expect(isRetryableStatus(s, false)).toBe(false);
    }
  });

  it("never retries a status that is a real answer", () => {
    // `501` and `408` are here on purpose: they are the two that SOUND
    // transient and are not in the set. A `501` is a permanent "this server
    // does not do that", and a `408` is a request the server gave up reading —
    // repeating it would need to know the body never arrived, which nothing
    // here knows. The hand-rolled loop in `src/deploy/imageTag.ts` retried
    // `501` three times because it tested `status >= 500` instead of asking.
    for (const s of [400, 401, 403, 404, 408, 409, 412, 501]) {
      expect(isRetryableStatus(s, true)).toBe(false);
      expect(isRetryableStatus(s, false)).toBe(false);
    }
  });

  it("knows which methods may be repeated", () => {
    expect(isIdempotentMethod("GET")).toBe(true);
    expect(isIdempotentMethod("delete")).toBe(true);
    expect(isIdempotentMethod("POST")).toBe(false);
  });

  it("reads both Retry-After forms, and neither of the non-forms", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("  ")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();

    const now = Date.parse("2026-08-29T14:00:00Z");
    expect(parseRetryAfter("Sat, 29 Aug 2026 14:00:30 GMT", now)).toBe(30_000);
    // A date already past is zero, not a negative sleep.
    expect(parseRetryAfter("Sat, 29 Aug 2026 13:59:00 GMT", now)).toBe(0);
  });

  it("backs off exponentially, with jitter that never rounds to nothing", () => {
    const budget = DEFAULT_RETRY_BUDGET;
    for (const [attempt, term] of [
      [0, 400],
      [1, 800],
      [2, 1_600],
    ] as const) {
      for (const random of [0, 0.5, 0.999]) {
        const d = retryDelayMs({
          attempt,
          spentMs: 0,
          budget,
          random: () => random,
        })!;
        expect(d).toBeGreaterThanOrEqual(term / 2);
        expect(d).toBeLessThanOrEqual(term);
      }
    }
  });

  it("caps a single sleep at maxDelayMs", () => {
    const d = retryDelayMs({
      attempt: 20,
      spentMs: 0,
      budget: { ...DEFAULT_RETRY_BUDGET, attempts: 99 },
      random: () => 0.999,
    })!;
    expect(d).toBeLessThanOrEqual(DEFAULT_RETRY_BUDGET.maxDelayMs);
  });

  it("stops at the attempt ceiling and at the total-delay ceiling", () => {
    const budget = DEFAULT_RETRY_BUDGET;
    // The last permitted attempt has no successor.
    expect(
      retryDelayMs({ attempt: budget.attempts - 1, spentMs: 0, budget }),
    ).toBeUndefined();
    // And a spent budget refuses one even when attempts remain.
    expect(
      retryDelayMs({ attempt: 0, spentMs: budget.totalDelayMs, budget }),
    ).toBeUndefined();
  });

  it("bounds the default budget: three retries, ~6s of sleep at the very most", () => {
    const budget = DEFAULT_RETRY_BUDGET;
    let spentMs = 0;
    let sleeps = 0;
    for (let n = 0; ; n++) {
      const d = retryDelayMs({
        attempt: n,
        spentMs,
        budget,
        random: () => 0.999,
      });
      if (d === undefined) break;
      spentMs += d;
      sleeps++;
    }
    expect(sleeps).toBe(budget.attempts - 1);
    expect(spentMs).toBeLessThanOrEqual(budget.totalDelayMs);
  });
});
