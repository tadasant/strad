import { describe, expect, it } from "vitest";

import {
  createWatchdog,
  processSampler,
  watchdogExitAfterMs,
  type LoopSample,
  type WatchdogState,
} from "../src/watchdog.js";

/**
 * The event-loop watchdog (tadasant/strad#458). The incident it answers is a
 * process that stays alive and answers nothing, so most cases below assert that
 * it EXITS. The other direction matters as much: a busy minute must not restart
 * a container serving 66 slugs, so a dip below the threshold has to reset the run.
 */

const MB = 2 ** 20;

function harness(samples: LoopSample[], exitAfterMs = 180_000) {
  let t = 0;
  let i = 0;
  const wedged: WatchdogState[] = [];
  const dog = createWatchdog({
    saturation: 0.9,
    unhealthyAfterMs: 60_000,
    exitAfterMs,
    onWedged: (s) => wedged.push(s),
    sample: () => samples[Math.min(i++, samples.length - 1)]!,
    now: () => t,
  });
  const step = (ms: number): WatchdogState => {
    t += ms;
    return dog.tick();
  };
  return { dog, step, wedged };
}

const busy: LoopSample = { utilization: 1, heapUsed: 537 * MB, heapLimit: 560 * MB };
const idle: LoopSample = { utilization: 0.01, heapUsed: 500 * MB, heapLimit: 1120 * MB };

describe("bundle event-loop watchdog", () => {
  it("exits once, after the loop has been saturated for the exit window: the #458 shape", () => {
    const { step, wedged } = harness([busy]);
    // The first saturated tick starts the run.
    expect(step(5_000).saturatedMs).toBe(0);
    let state = step(55_000);
    expect(state.unhealthy).toBe(false);
    state = step(5_000); // 60s in
    expect(state.unhealthy).toBe(true);
    expect(state.wedged).toBe(false);
    expect(wedged).toHaveLength(0);
    state = step(120_000); // 180s in
    expect(state.wedged).toBe(true);
    expect(wedged).toHaveLength(1);
    expect(wedged[0]!.heapRatio).toBeCloseTo(537 / 560);
    // Still wedged on the next tick, but `onWedged` is not called twice.
    step(5_000);
    expect(wedged).toHaveLength(1);
  });

  it("counts a long gap between ticks as saturated time: a thrashing loop runs its timers late", () => {
    const { step, wedged } = harness([busy]);
    step(5_000);
    // One tick delayed by three minutes, the way a 9.4s-p99 loop delays it.
    expect(step(180_000).wedged).toBe(true);
    expect(wedged).toHaveLength(1);
  });

  it("resets the run when any interval drops below the threshold", () => {
    const { step, wedged } = harness([busy, busy, busy, idle, busy, busy, busy]);
    step(5_000);
    step(50_000);
    step(50_000); // 100s saturated
    expect(step(5_000).saturatedMs).toBe(0); // idle interval
    step(5_000); // the run starts again here
    const state = step(100_000);
    expect(state.saturatedMs).toBe(100_000);
    expect(state.wedged).toBe(false);
    expect(wedged).toHaveLength(0);
  });

  it("never exits a healthy process, however long it runs", () => {
    const { step, wedged } = harness([idle]);
    for (let i = 0; i < 1000; i++) expect(step(5_000).unhealthy).toBe(false);
    expect(wedged).toHaveLength(0);
  });

  it("exit window 0 disables the exit and keeps the 503", () => {
    const { step, wedged } = harness([busy], 0);
    step(5_000);
    const state = step(3_600_000);
    expect(state.unhealthy).toBe(true);
    expect(state.wedged).toBe(false);
    expect(wedged).toHaveLength(0);
  });

  it("reads the exit window from STRAD_BUNDLE_WATCHDOG_EXIT_SECONDS, falling back on junk", () => {
    expect(watchdogExitAfterMs({})).toBe(180_000);
    expect(watchdogExitAfterMs({ STRAD_BUNDLE_WATCHDOG_EXIT_SECONDS: "300" })).toBe(300_000);
    expect(watchdogExitAfterMs({ STRAD_BUNDLE_WATCHDOG_EXIT_SECONDS: "0" })).toBe(0);
    expect(watchdogExitAfterMs({ STRAD_BUNDLE_WATCHDOG_EXIT_SECONDS: "soon" })).toBe(180_000);
    expect(watchdogExitAfterMs({ STRAD_BUNDLE_WATCHDOG_EXIT_SECONDS: "-1" })).toBe(180_000);
  });

  it("the real sampler sees a loop held busy, and V8's real ceiling", () => {
    const sample = processSampler();
    const until = Date.now() + 200;
    while (Date.now() < until) {
      // spin: the loop is busy for the whole interval
    }
    const s = sample();
    expect(s.utilization).toBeGreaterThan(0.9);
    expect(s.heapLimit).toBeGreaterThan(s.heapUsed);
  });
});
