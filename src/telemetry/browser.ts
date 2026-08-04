import { metrics, type Meter } from "@opentelemetry/api";

/**
 * Chromium instrumentation — the memory hog we are about to co-locate.
 *
 * Three of the servers (fetchpet, pointsyeah, good-eggs) drive a real headless
 * Chromium. The known baseline: ~1.06s per launch, ~545MB peak RSS, a 1GB
 * budget, and CPU — not RAM — is what binds, because 1 vCPU serialises page
 * rendering. After the collapse, all three of those browsers are ONE browser,
 * and it shares a 1-vCPU container with the bundle's other 13 MCP servers (16
 * mounts in all) and the `op` CLI. If that was a mistake, this file is where it
 * shows up.
 *
 * ── The globalThis contract ──────────────────────────────────────────────────
 *
 * The browser servers are SEPARATE npm projects with their own lockfiles, and
 * their `shared/` trees are vendored from upstream repos (HACKS #10, #15). Making
 * them `import` strad's telemetry would mean adding a dependency, a build step
 * and a tsconfig path to five packages, and would put a hard coupling into code
 * we deliberately keep close to its upstream.
 *
 * So instead the bootstrap publishes its hooks on `globalThis`, and the browser
 * servers call them through a ~15-line local shim that no-ops when the hooks are
 * absent. That means:
 *
 *   - a browser server with no telemetry bootstrap loaded runs EXACTLY as before
 *     (the shim's `?.` short-circuits and it just calls the launch function),
 *   - the vendored `shared/` trees gain three call sites and zero dependencies,
 *   - and the collapse-into-one-bundle inherits all of it for free, because the
 *     hooks are per-process, not per-package.
 *
 * The contract is `BrowserTelemetryHooks` below. It is the only thing the browser
 * servers may rely on, and it is versioned by `STRAD_BROWSER_TELEMETRY_VERSION`.
 */

export const STRAD_BROWSER_TELEMETRY_VERSION = 1;
export const BROWSER_TELEMETRY_KEY = "__stradBrowserTelemetry";

/** The shape a browser server's shim looks for on `globalThis`. */
export interface BrowserTelemetryHooks {
  readonly version: number;
  /**
   * Wrap a browser launch: time it, count it, track the live browser, and attach
   * a `disconnected` listener that reports a crash WITH the container's memory
   * pressure at that moment (see `instrumentLaunch`).
   */
  instrumentLaunch<T>(
    launch: () => Promise<T>,
    attrs?: BrowserAttrs,
  ): Promise<T>;
  /** Track a browser context's lifetime. Returns a function to call on close. */
  contextOpened(attrs?: BrowserAttrs): () => void;
}

export interface BrowserAttrs {
  /** "chromium" — kept as an attribute so a future firefox/webkit is separable. */
  browser?: string;
  /** The server slug driving this browser ("fetchpet"). */
  server?: string;
}

/** A duck-typed Playwright Browser. We refuse to depend on playwright here. */
interface DisconnectableBrowser {
  on?(event: "disconnected", handler: () => void): unknown;
  isConnected?(): boolean;
}

export interface BrowserTelemetryOptions {
  /**
   * Container memory utilisation (0..1) at the moment it is asked, or null.
   * Supplied by the runtime metrics handle — see runtime.ts.
   *
   * This is what turns "the browser died" into "the browser died BECAUSE we were
   * out of memory". Chromium being OOM-killed by the kernel and Chromium
   * crashing on a bad page look identical from Playwright's side: both surface
   * as a `disconnected` event with no exit reason. The container's memory
   * pressure in that instant is the only thing that tells them apart, and it is
   * gone a second later.
   */
  memoryUtilization?: () => number | null;
  meter?: Meter;
}

/**
 * Install the hooks on `globalThis`. Idempotent.
 *
 * Called by the telemetry bootstrap AFTER the SDK is started, so the instruments
 * below bind to the real meter provider rather than the no-op one.
 */
export function installBrowserTelemetry(
  opts: BrowserTelemetryOptions = {},
): BrowserTelemetryHooks {
  const meter = opts.meter ?? metrics.getMeter("strad.browser");
  const memoryUtilization = opts.memoryUtilization ?? (() => null);

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

  const hooks: BrowserTelemetryHooks = {
    version: STRAD_BROWSER_TELEMETRY_VERSION,

    async instrumentLaunch<T>(
      launch: () => Promise<T>,
      attrs: BrowserAttrs = {},
    ): Promise<T> {
      const base = {
        "browser.name": attrs.browser ?? "chromium",
        ...(attrs.server ? { "mcp.server": attrs.server } : {}),
      };
      const startedAt = process.hrtime.bigint();

      let browser: T;
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

      // A launched browser that later dies is the OOM story. Playwright gives us
      // `disconnected` and nothing else — no exit code, no reason — so we sample
      // the container's memory pressure right now, while it is still true.
      const disconnectable = browser as DisconnectableBrowser;
      if (typeof disconnectable.on === "function") {
        let counted = false;
        disconnectable.on("disconnected", () => {
          if (counted) return; // a close() during shutdown fires this too
          counted = true;
          active.add(-1, base);
          const util = memoryUtilization();
          crashes.add(1, {
            ...base,
            // Bucketed, not raw: a metric attribute must stay low-cardinality.
            // "high" is the OOM fingerprint.
            "memory.pressure":
              util === null ? "unknown" : util >= 0.85 ? "high" : "normal",
          });
        });
      }

      return browser;
    },

    contextOpened(attrs: BrowserAttrs = {}) {
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

  (globalThis as Record<string, unknown>)[BROWSER_TELEMETRY_KEY] = hooks;
  return hooks;
}

/** Remove the hooks. Test seam. */
export function uninstallBrowserTelemetry(): void {
  delete (globalThis as Record<string, unknown>)[BROWSER_TELEMETRY_KEY];
}

function seconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}
