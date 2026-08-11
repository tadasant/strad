import { readFileSync } from "node:fs";
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} from "node:perf_hooks";
import { metrics, type Meter, type ObservableResult } from "@opentelemetry/api";

/**
 * Process, runtime and CONTAINER resource metrics.
 *
 * This module is the answer to the question the collapse is about to pose:
 * *when 17 MCP servers, the `op` CLI and Chromium all share one 1-vCPU box, is
 * it dying of memory or of CPU?* Those have completely different fixes, and
 * from the outside they look identical (App Platform restarts the component and
 * says nothing useful).
 *
 * Three signals separate them, and all three are here:
 *
 *   MEMORY  `strad.container.memory.utilization` — usage / limit, read from the
 *           CGROUP, not from `os.totalmem()`. This matters more than it sounds:
 *           inside a 1GB App Platform container, `os.totalmem()` reports the
 *           HOST's memory (tens of GB), so any "% of memory used" computed the
 *           obvious way is off by an order of magnitude and will cheerfully read
 *           4% while the kernel is about to OOM-kill you. The cgroup limit is
 *           the only number the OOM killer actually consults.
 *
 *   CPU     `strad.eventloop.delay.p99` — the single best saturation signal for
 *           Node. A saturated 1-vCPU box does not report "CPU: 100%" in any way
 *           you will notice; it reports as an event loop that is 800ms behind,
 *           which is why every request suddenly takes a second. Chromium is the
 *           expected culprit (the known baseline says CPU, not RAM, is what
 *           binds for the browser servers) and it will show up HERE, as lag in
 *           the Node process that is waiting on it.
 *
 *   RESTART `service.instance.id` (a fresh UUID per process; see resource.ts)
 *           plus `strad.process.uptime`, a sawtooth that resets to zero. A
 *           restart is invisible in an averaged CPU graph and glaring in these.
 *
 * Everything is an OBSERVABLE (pull-based) instrument: the callbacks run once
 * per export interval, so the cost is a handful of syscalls per minute and there
 * is no background timer of our own to leak.
 */

/** Byte counts and durations are read fresh on each observation. */
export interface RuntimeMetricsHandle {
  /** Current container memory utilisation (0..1), or null if no cgroup limit. */
  memoryUtilization(): number | null;
  stop(): void;
}

const PROCESS_START_MS = Date.now();

export function startRuntimeMetrics(
  meter: Meter = metrics.getMeter("strad.runtime"),
): RuntimeMetricsHandle {
  // --- event loop lag ------------------------------------------------------
  // resolution:10 means the histogram samples every 10ms; anything finer is
  // noise on a 1-vCPU box.
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();

  let lastElu = performance.eventLoopUtilization();
  let lastCpu = process.cpuUsage();
  let lastCpuAt = process.hrtime.bigint();

  // --- GC ------------------------------------------------------------------
  // A histogram recorded per GC event, rather than an observable: we want the
  // DISTRIBUTION of pauses (a p99 of 400ms is a different problem from a mean of
  // 4ms), and that is only visible if every pause is recorded.
  const gcDuration = meter.createHistogram("strad.gc.duration", {
    description: "Garbage-collection pause duration",
    unit: "s",
  });
  const gcCount = meter.createCounter("strad.gc.collections", {
    description: "Garbage collections, by kind",
  });

  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      // `kind` is a v8 constant; map it to a stable, low-cardinality label.
      const kind = gcKind(
        (entry as unknown as { detail?: { kind?: number } }).detail?.kind,
      );
      gcDuration.record(entry.duration / 1000, { "gc.kind": kind });
      gcCount.add(1, { "gc.kind": kind });
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });

  // --- the cgroup limit ----------------------------------------------------
  // Read ONCE: the limit does not change under a running container, and re-reading
  // it every 60s for the life of the process is pointless syscall noise.
  const memoryLimit = readCgroupMemoryLimit();

  // --- observables ---------------------------------------------------------
  const rss = meter.createObservableGauge("strad.process.memory.rss", {
    description: "Resident set size of the Node process",
    unit: "By",
  });
  const heapUsed = meter.createObservableGauge(
    "strad.process.memory.heap.used",
    {
      description: "V8 heap in use",
      unit: "By",
    },
  );
  const heapTotal = meter.createObservableGauge(
    "strad.process.memory.heap.total",
    {
      description: "V8 heap allocated",
      unit: "By",
    },
  );
  const external = meter.createObservableGauge(
    "strad.process.memory.external",
    {
      description:
        "Memory used by C++ objects bound to JS (Buffers, and Chromium's IPC surface)",
      unit: "By",
    },
  );

  const containerLimit = meter.createObservableGauge(
    "strad.container.memory.limit",
    {
      description:
        "The cgroup memory limit — what the OOM killer actually enforces",
      unit: "By",
    },
  );
  const containerUsage = meter.createObservableGauge(
    "strad.container.memory.usage",
    {
      description:
        "Current cgroup memory usage, INCLUDING child processes (i.e. Chromium)",
      unit: "By",
    },
  );
  const containerUtil = meter.createObservableGauge(
    "strad.container.memory.utilization",
    {
      description:
        "cgroup usage / cgroup limit, 0..1. The OOM predictor: watch this against a restart.",
      unit: "1",
    },
  );

  const eventLoopP99 = meter.createObservableGauge(
    "strad.eventloop.delay.p99",
    {
      description:
        "Event loop lag, p99 over the export interval — the saturation signal",
      unit: "s",
    },
  );
  const eventLoopMean = meter.createObservableGauge(
    "strad.eventloop.delay.mean",
    {
      description: "Event loop lag, mean over the export interval",
      unit: "s",
    },
  );
  const eventLoopMax = meter.createObservableGauge(
    "strad.eventloop.delay.max",
    {
      description: "Event loop lag, max over the export interval",
      unit: "s",
    },
  );
  const eventLoopUtil = meter.createObservableGauge(
    "strad.eventloop.utilization",
    {
      description: "Fraction of the interval the event loop was busy, 0..1",
      unit: "1",
    },
  );

  const cpuUtil = meter.createObservableGauge("strad.process.cpu.utilization", {
    description:
      "CPU seconds burned per wall second. >1 means more than one core's worth.",
    unit: "1",
  });
  const cpuTime = meter.createObservableCounter("strad.process.cpu.time", {
    description: "Cumulative CPU time, by mode",
    unit: "s",
  });

  const uptime = meter.createObservableGauge("strad.process.uptime", {
    description:
      "Seconds since this process started. A reset to ~0 IS a restart.",
    unit: "s",
  });

  // A single batch callback: every observation in one pass, so the numbers are
  // mutually consistent (a utilisation of 0.97 always pairs with the usage and
  // limit that produced it) and the event-loop histogram is reset exactly once.
  const observables = [
    rss,
    heapUsed,
    heapTotal,
    external,
    containerLimit,
    containerUsage,
    containerUtil,
    eventLoopP99,
    eventLoopMean,
    eventLoopMax,
    eventLoopUtil,
    cpuUtil,
    cpuTime,
    uptime,
  ];

  let lastUtilization: number | null = null;

  const batch = (observer: ObservableResult | BatchObserver): void => {
    const o = observer as BatchObserver;

    const mem = process.memoryUsage();
    o.observe(rss, mem.rss);
    o.observe(heapUsed, mem.heapUsed);
    o.observe(heapTotal, mem.heapTotal);
    o.observe(external, mem.external);

    const usage = readCgroupMemoryUsage();
    if (memoryLimit !== null) o.observe(containerLimit, memoryLimit);
    if (usage !== null) o.observe(containerUsage, usage);
    if (memoryLimit !== null && usage !== null && memoryLimit > 0) {
      lastUtilization = usage / memoryLimit;
      o.observe(containerUtil, lastUtilization);
    }

    // ns -> s. Read, then reset, so each export describes ITS interval rather
    // than the whole life of the process (a process-lifetime p99 stops moving
    // after the first bad minute and hides everything after it).
    o.observe(eventLoopP99, lag.percentile(99) / 1e9);
    o.observe(eventLoopMean, lag.mean / 1e9);
    o.observe(eventLoopMax, lag.max / 1e9);
    lag.reset();

    const elu = performance.eventLoopUtilization(lastElu);
    lastElu = performance.eventLoopUtilization();
    o.observe(eventLoopUtil, elu.utilization);

    const cpu = process.cpuUsage();
    const now = process.hrtime.bigint();
    const wallSeconds = Number(now - lastCpuAt) / 1e9;
    const userSeconds = (cpu.user - lastCpu.user) / 1e6;
    const systemSeconds = (cpu.system - lastCpu.system) / 1e6;
    lastCpu = cpu;
    lastCpuAt = now;
    if (wallSeconds > 0) {
      o.observe(cpuUtil, (userSeconds + systemSeconds) / wallSeconds);
    }
    o.observe(cpuTime, cpu.user / 1e6, { "cpu.mode": "user" });
    o.observe(cpuTime, cpu.system / 1e6, { "cpu.mode": "system" });

    o.observe(uptime, (Date.now() - PROCESS_START_MS) / 1000);
  };

  meter.addBatchObservableCallback(batch, observables);

  return {
    memoryUtilization: () => lastUtilization,
    stop() {
      meter.removeBatchObservableCallback(batch, observables);
      gcObserver.disconnect();
      lag.disable();
    },
  };
}

/**
 * The batch-observable callback's argument. The OTel API types this as
 * `BatchObservableResult`, which is not exported from the version we pin; the
 * structural type is all we need and it cannot drift silently (a change would
 * fail the build).
 */
interface BatchObserver {
  observe(
    metric: unknown,
    value: number,
    attributes?: Record<string, string | number | boolean>,
  ): void;
}

/**
 * The cgroup memory limit, in bytes, or null when there isn't one.
 *
 * cgroup v2 first (`memory.max`, which is what a modern container runtime and
 * App Platform's gVisor sandbox present), then v1. "max" means unlimited — a
 * bare `docker run` with no `-m`, or a dev laptop — and yields null rather than
 * a fake number, so a missing limit reads as "unknown" in the ingestor instead
 * of silently making utilisation look wonderful.
 *
 * A v1 limit is also reported as a preposterous number (~9.2e18) when unset;
 * anything at or above that sentinel is treated as no limit.
 */
export function readCgroupMemoryLimit(
  readFile = defaultReadFile,
): number | null {
  const v2 = readFile("/sys/fs/cgroup/memory.max");
  if (v2 !== null) {
    const trimmed = v2.trim();
    if (trimmed === "max") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  const v1 = readFile("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  if (v1 !== null) {
    const n = Number(v1.trim());
    // v1's "no limit" is PAGE_COUNTER_MAX, a number near 2^63.
    if (Number.isFinite(n) && n > 0 && n < 9e18) return n;
  }
  return null;
}

/** Current cgroup memory usage in bytes, or null when unreadable. */
export function readCgroupMemoryUsage(
  readFile = defaultReadFile,
): number | null {
  const v2 = readFile("/sys/fs/cgroup/memory.current");
  if (v2 !== null) {
    const n = Number(v2.trim());
    if (Number.isFinite(n)) return n;
  }
  const v1 = readFile("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  if (v1 !== null) {
    const n = Number(v1.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Read a cgroup pseudo-file, or null.
 *
 * Sync IO on purpose: these are kernel pseudo-files (no disk, sub-millisecond),
 * they are read once per export interval, and doing it synchronously means a
 * failure cannot become an unhandled rejection inside a metrics callback.
 */
function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** v8's GC kind constants -> a stable label. */
function gcKind(kind: number | undefined): string {
  switch (kind) {
    case 1:
      return "minor";
    case 2:
      return "major";
    case 4:
      return "incremental";
    case 8:
      return "weakcb";
    default:
      return "unknown";
  }
}
