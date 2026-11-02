import { getHeapStatistics } from "node:v8";
import { performance } from "node:perf_hooks";

/**
 * The bundle's event-loop watchdog: one wedged loop must not hold every slug on
 * this component down until a human notices.
 *
 * ## The failure this closes (tadasant/strad#458)
 *
 * On 2026-11-02 prod's bundle sat with its V8 heap pinned at the ceiling (heap
 * used 537 MB of a 548 MB heap total), the garbage collector running back to
 * back, and event-loop utilization at 1.0 for over an hour. The process was
 * alive. It pushed metrics and held its port, so the kernel still accepted TCP
 * connections. It answered nothing, and core marked 66 slugs unreachable. A
 * process in that state never exits on its own: each collection frees just
 * enough to avoid "heap out of memory", so it can thrash indefinitely.
 *
 * ## What this does
 *
 * Every few seconds it measures what fraction of the interval the loop was busy
 * (`performance.eventLoopUtilization`, the same figure the
 * `strad.eventloop.utilization` gauge exports) and how full the heap is against
 * `heap_size_limit`, the ceiling V8 will actually enforce.
 *
 * - SATURATED: the loop was busy for at least `saturation` of every interval
 *   since `saturatedSince`. A streamable-HTTP proxy whose CPU-heavy work runs in
 *   worker threads (image-tools) or in other processes (Chromium, mcp-grafana)
 *   has no legitimate reason to keep its main loop that busy for long.
 * - UNHEALTHY: saturated for `unhealthyAfterMs`. `/healthz` answers 503, and the
 *   rendered `liveness_health_check` restarts the container after enough failed
 *   probes. A probe that times out because the loop never got to it fails the
 *   same way, which is the case this module cannot handle by itself.
 * - WEDGED: saturated for `exitAfterMs`. `onWedged` is called once, and the host
 *   exits non-zero so App Platform restarts the container. This half needs no
 *   platform setting, so it works under any deploy, including one whose spec
 *   predates the liveness check.
 *
 * The timer callback is itself delayed by a saturated loop. That does not skew
 * the measurement: utilization is computed over the real elapsed interval, however
 * long it turned out to be. It only means the exit fires late. It does not mean
 * the exit never fires. A loop blocked by one synchronous call that never returns
 * runs no timers at all, and only the liveness check can catch that.
 */

export interface LoopSample {
  /** Busy fraction of the loop since the previous sample, 0..1. */
  utilization: number;
  heapUsed: number;
  /** V8's `heap_size_limit`: the ceiling it enforces, not what it has allocated. */
  heapLimit: number;
}

export interface WatchdogOptions {
  /** Busy fraction at or above which an interval counts as saturated. */
  saturation: number;
  /** Continuous saturation before `/healthz` answers 503. */
  unhealthyAfterMs: number;
  /** Continuous saturation before `onWedged` fires. 0 disables the exit. */
  exitAfterMs: number;
  onWedged: (state: WatchdogState) => void;
  sample?: () => LoopSample;
  now?: () => number;
}

export interface WatchdogState {
  utilization: number;
  heapUsed: number;
  heapLimit: number;
  /** heapUsed / heapLimit, 0..1. */
  heapRatio: number;
  /** How long the loop has been continuously saturated, 0 when it is not. */
  saturatedMs: number;
  unhealthy: boolean;
  wedged: boolean;
}

/** Busy fraction of the loop since the last call, from the platform's own counter. */
export function processSampler(): () => LoopSample {
  let last = performance.eventLoopUtilization();
  return () => {
    const delta = performance.eventLoopUtilization(last);
    last = performance.eventLoopUtilization();
    const heap = getHeapStatistics();
    return {
      utilization: delta.utilization,
      heapUsed: heap.used_heap_size,
      heapLimit: heap.heap_size_limit,
    };
  };
}

export function createWatchdog(opts: WatchdogOptions) {
  const sample = opts.sample ?? processSampler();
  const now = opts.now ?? Date.now;
  let saturatedSince: number | null = null;
  let fired = false;
  let state: WatchdogState = {
    utilization: 0,
    heapUsed: 0,
    heapLimit: 0,
    heapRatio: 0,
    saturatedMs: 0,
    unhealthy: false,
    wedged: false,
  };

  const tick = (): WatchdogState => {
    const s = sample();
    const at = now();
    if (s.utilization >= opts.saturation) {
      // The interval that just ended was saturated from its start, so the run
      // began no later than the previous tick. Recording the time of THIS tick
      // understates the run by one interval, which errs toward a late exit
      // rather than an early one.
      saturatedSince ??= at;
    } else {
      saturatedSince = null;
    }
    const saturatedMs = saturatedSince === null ? 0 : at - saturatedSince;
    const wedged = opts.exitAfterMs > 0 && saturatedMs >= opts.exitAfterMs;
    state = {
      utilization: s.utilization,
      heapUsed: s.heapUsed,
      heapLimit: s.heapLimit,
      heapRatio: s.heapLimit > 0 ? s.heapUsed / s.heapLimit : 0,
      saturatedMs,
      unhealthy: saturatedMs >= opts.unhealthyAfterMs,
      wedged,
    };
    if (wedged && !fired) {
      fired = true;
      opts.onWedged(state);
    }
    return state;
  };

  return {
    tick,
    state: (): WatchdogState => state,
    /** Sample on an interval. Unref'd, so the watchdog never keeps a process alive. */
    start(intervalMs: number): () => void {
      const timer = setInterval(tick, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

/** Defaults, and the one env knob: `STRAD_BUNDLE_WATCHDOG_EXIT_SECONDS` (0 disables the exit). */
export const WATCHDOG_DEFAULTS = {
  intervalMs: 5_000,
  saturation: 0.9,
  unhealthyAfterMs: 60_000,
  exitAfterMs: 180_000,
} as const;

export function watchdogExitAfterMs(env: NodeJS.ProcessEnv): number {
  const raw = env.STRAD_BUNDLE_WATCHDOG_EXIT_SECONDS;
  if (raw === undefined || raw.trim() === "") return WATCHDOG_DEFAULTS.exitAfterMs;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : WATCHDOG_DEFAULTS.exitAfterMs;
}

/** The figures that settle "how big a heap did this process actually get", logged once at boot. */
export function heapBootLine(): string {
  const heap = getHeapStatistics();
  const mb = (n: number): string => `${Math.round(n / 2 ** 20)} MB`;
  const constrained =
    typeof process.constrainedMemory === "function" ? process.constrainedMemory() : 0;
  return (
    `heap limit ${mb(heap.heap_size_limit)}; memory Node sized it from ` +
    `${constrained > 0 ? mb(constrained) : "unconstrained"}; ` +
    `NODE_OPTIONS ${process.env.NODE_OPTIONS ? `"${process.env.NODE_OPTIONS}"` : "unset"}`
  );
}
