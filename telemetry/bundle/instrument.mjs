/**
 * strad bundle telemetry — the canonical source.
 *
 * ⚠️  DO NOT EDIT THE COPIES. This file is vendored, byte-identical, into every
 *     supplementary image's `otel/` directory by `npm run telemetry:sync`, and
 *     `test/telemetry.sync.test.ts` fails CI if a copy drifts. Edit THIS file,
 *     run the sync, commit the result.
 *
 * ── Why a vendored copy instead of an import ─────────────────────────────────
 *
 * The supplementary images (fetchpet, pointsyeah, good-eggs, bundle-api,
 * onepassword, bundle-google) are SEPARATE npm projects with their own
 * lockfiles, and each Docker build context is its own directory — so a build
 * cannot `COPY ../../telemetry`, and an `import` would need a published package.
 * Vendoring is the pattern this repo already uses for exactly this reason
 * (HACKS #10, #15). The sync script plus the drift test is what keeps vendoring
 * honest.
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 *
 * Loaded with `node --import ./otel/instrument.mjs <entrypoint>`, so it runs to
 * completion BEFORE the server's own code, and emits:
 *
 *   - process + CONTAINER resource metrics (RSS, heap, cgroup limit/usage/
 *     utilisation, event-loop lag, CPU, GC, uptime) — the OOM and saturation
 *     story, identical to the core gateway's (src/telemetry/runtime.ts).
 *   - the Chromium hooks, on `globalThis`, for the three browser servers to call
 *     (see `installBrowserHooks` below and src/telemetry/browser.ts).
 *
 * With no OTEL_EXPORTER_OTLP_ENDPOINT it starts nothing, logs one line, and the
 * server runs exactly as it did before. That has to stay true: these images are
 * live, and telemetry must never be able to take one down.
 *
 * SECRETS: this file records only sizes, counts and identifiers. It never reads
 * a tool argument, a result or a header. See src/telemetry/redact.ts.
 */
import { readFileSync } from "node:fs";
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  metrics,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

const PROCESS_START_MS = Date.now();

const env = process.env;
const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

if (!endpoint) {
  // Not an error. Telemetry is opt-in; an image with no ingestor is ordinary.
  console.log(
    JSON.stringify({
      evt: "telemetry.disabled",
      reason: "OTEL_EXPORTER_OTLP_ENDPOINT is not set",
    }),
  );
} else {
  try {
    start();
  } catch (err) {
    // Telemetry must NEVER be why a container fails to boot.
    console.log(
      JSON.stringify({
        evt: "telemetry.start_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function start() {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  // `STRAD_COMPONENT` is injected per-component by the app spec (appspec.ts). It
  // is the only thing that lets a supplementary image say WHICH of the ~13
  // processes it is — it has no STRAD_BUNDLE and cannot infer it.
  const component = env.STRAD_COMPONENT ?? "bundle";
  const serviceName = env.OTEL_SERVICE_NAME?.trim() || `strad-${component}`;

  const sdk = new NodeSDK({
    resource: defaultResource().merge(
      resourceFromAttributes({
        "service.name": serviceName,
        "service.version": env.STRAD_VERSION ?? "0.0.0",
        "service.namespace": "strad",
        // Fresh per process start: count(distinct service.instance.id) over a
        // window IS the restart count, and App Platform restarts on OOM.
        "service.instance.id": randomUUID(),
        "deployment.environment": env.STRAD_ENV ?? "dev",
        "deployment.environment.name": env.STRAD_ENV ?? "dev",
        "strad.mode": "bundle",
        "strad.component": component,
      }),
    ),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        // 15s, not the 60s default: a 60s window can miss the entire memory ramp
        // that precedes an OOM kill, which is the one thing we came for.
        exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 15_000),
      }),
    ],
  });

  sdk.start();

  // AFTER start(): a meter resolved before the provider is registered is
  // permanently the no-op meter, and the metrics would silently never appear.
  const runtime = startRuntimeMetrics();
  installBrowserHooks(runtime.memoryUtilization);

  console.log(
    JSON.stringify({
      evt: "telemetry.started",
      service: serviceName,
      component,
      environment: env.STRAD_ENV ?? "dev",
    }),
  );

  // Flush on the way out. When the container is being killed for OOM, the last
  // few seconds of memory metrics ARE the diagnosis.
  const flush = () => {
    void sdk.shutdown().catch(() => {});
  };
  process.on("SIGTERM", flush);
  process.on("SIGINT", flush);
}

// ---------------------------------------------------------------------------
// Process + container resource metrics
// ---------------------------------------------------------------------------

function startRuntimeMetrics() {
  const meter = metrics.getMeter("strad.runtime");

  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();

  let lastElu = performance.eventLoopUtilization();
  let lastCpu = process.cpuUsage();
  let lastCpuAt = process.hrtime.bigint();

  const gcDuration = meter.createHistogram("strad.gc.duration", {
    description: "Garbage-collection pause duration",
    unit: "s",
  });
  const gcCount = meter.createCounter("strad.gc.collections", {
    description: "Garbage collections, by kind",
  });
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const kind = gcKind(entry.detail?.kind);
      gcDuration.record(entry.duration / 1000, { "gc.kind": kind });
      gcCount.add(1, { "gc.kind": kind });
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });

  // Read ONCE: a container's limit does not change while it runs.
  const memoryLimit = readCgroupMemoryLimit();

  const rss = meter.createObservableGauge("strad.process.memory.rss", {
    description: "Resident set size of the Node process",
    unit: "By",
  });
  const heapUsed = meter.createObservableGauge(
    "strad.process.memory.heap.used",
    { description: "V8 heap in use", unit: "By" },
  );
  const heapTotal = meter.createObservableGauge(
    "strad.process.memory.heap.total",
    { description: "V8 heap allocated", unit: "By" },
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
    { description: "Event loop lag, mean over the export interval", unit: "s" },
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

  let lastUtilization = null;

  const batch = (o) => {
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

    // Read, then reset, so each export describes ITS interval. A
    // process-lifetime p99 stops moving after the first bad minute and hides
    // everything that comes after it.
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

  return { memoryUtilization: () => lastUtilization };
}

/**
 * The cgroup memory limit in bytes, or null when there is none.
 *
 * This must come from the cgroup, never from os.totalmem(): inside a 1GB
 * container os.totalmem() reports the HOST's memory, so "percent used" computed
 * the obvious way reads ~4% while the kernel is about to OOM-kill you. The
 * cgroup limit is the only number the OOM killer consults.
 */
function readCgroupMemoryLimit() {
  const v2 = readFileOrNull("/sys/fs/cgroup/memory.max");
  if (v2 !== null) {
    const trimmed = v2.trim();
    if (trimmed === "max") return null; // unlimited
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const v1 = readFileOrNull("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  if (v1 !== null) {
    const n = Number(v1.trim());
    // v1 reports "no limit" as PAGE_COUNTER_MAX, a number near 2^63.
    if (Number.isFinite(n) && n > 0 && n < 9e18) return n;
  }
  return null;
}

function readCgroupMemoryUsage() {
  const v2 = readFileOrNull("/sys/fs/cgroup/memory.current");
  if (v2 !== null) {
    const n = Number(v2.trim());
    if (Number.isFinite(n)) return n;
  }
  const v1 = readFileOrNull("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  if (v1 !== null) {
    const n = Number(v1.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readFileOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function gcKind(kind) {
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

// ---------------------------------------------------------------------------
// Chromium hooks
// ---------------------------------------------------------------------------

/**
 * Publish the browser hooks on `globalThis`.
 *
 * The three browser servers call these through a tiny local shim that no-ops
 * when the hooks are absent, so their vendored `shared/` trees gain a couple of
 * call sites and ZERO dependencies. Contract mirrors src/telemetry/browser.ts.
 */
function installBrowserHooks(memoryUtilization) {
  const meter = metrics.getMeter("strad.browser");

  const launches = meter.createCounter("strad.browser.launches", {
    description: "Browser launches, by outcome",
  });
  const launchDuration = meter.createHistogram(
    "strad.browser.launch.duration",
    {
      description:
        "Time to launch a browser. Baseline ~1.06s; watch this climb as the box saturates.",
      unit: "s",
    },
  );
  const active = meter.createUpDownCounter("strad.browser.active", {
    description:
      "Live browser processes. On a collapsed bundle this should be 3, not 30.",
  });
  const contexts = meter.createUpDownCounter("strad.browser.contexts.active", {
    description: "Live browser contexts",
  });
  const crashes = meter.createCounter("strad.browser.crashes", {
    description:
      "Browsers that disconnected unexpectedly, tagged with the container's memory pressure at that instant",
  });

  globalThis.__stradBrowserTelemetry = {
    version: 1,

    async instrumentLaunch(launch, attrs = {}) {
      const base = {
        "browser.name": attrs.browser ?? "chromium",
        ...(attrs.server ? { "mcp.server": attrs.server } : {}),
      };
      const startedAt = process.hrtime.bigint();

      let browser;
      try {
        browser = await launch();
      } catch (err) {
        launches.add(1, { ...base, outcome: "error" });
        launchDuration.record(seconds(startedAt), {
          ...base,
          outcome: "error",
        });
        throw err;
      }

      launches.add(1, { ...base, outcome: "ok" });
      launchDuration.record(seconds(startedAt), { ...base, outcome: "ok" });
      active.add(1, base);

      // Playwright reports a dead browser as `disconnected` and nothing else —
      // no exit code, no reason. An OOM-killed Chromium and a Chromium that
      // crashed on a bad page look identical. The container's memory pressure at
      // THIS instant is the only thing that separates them, and it is gone a
      // second later.
      if (browser && typeof browser.on === "function") {
        let counted = false;
        browser.on("disconnected", () => {
          if (counted) return; // a deliberate close() fires this too
          counted = true;
          active.add(-1, base);
          const util = memoryUtilization();
          crashes.add(1, {
            ...base,
            // Bucketed: a metric attribute must stay low-cardinality.
            // "high" is the OOM fingerprint.
            "memory.pressure":
              util === null ? "unknown" : util >= 0.85 ? "high" : "normal",
          });
        });
      }

      return browser;
    },

    contextOpened(attrs = {}) {
      const base = {
        "browser.name": attrs.browser ?? "chromium",
        ...(attrs.server ? { "mcp.server": attrs.server } : {}),
      };
      contexts.add(1, base);
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        contexts.add(-1, base);
      };
    },
  };
}

function seconds(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}
