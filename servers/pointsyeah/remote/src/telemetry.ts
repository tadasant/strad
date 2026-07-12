/**
 * Browser telemetry shim.
 *
 * Chromium is the memory hog strad is about to co-locate with ~26 other MCP
 * servers on one 1-vCPU box, so its launches, its live count and — above all —
 * its CRASHES need to be visible. This file is how that happens without adding a
 * single dependency to this package.
 *
 * The telemetry bootstrap (`otel/instrument.mjs`, loaded via `node --import`)
 * publishes its hooks on `globalThis`. We look for them and call them if they
 * are there. If they are NOT there — no bootstrap loaded, no OTLP endpoint
 * configured, a plain `npm start`, a unit test — `withBrowserTelemetry` just
 * calls the launch function and returns, and this package behaves exactly as it
 * did before.
 *
 * That is the whole design: `shared/` is vendored from upstream (HACKS #10), so
 * it must not grow a hard dependency on strad's telemetry. A duck-typed global
 * and an optional call keep the coupling at zero.
 */

interface BrowserTelemetryHooks {
  version: number;
  instrumentLaunch<T>(
    launch: () => Promise<T>,
    attrs?: { browser?: string; server?: string },
  ): Promise<T>;
  contextOpened(attrs?: { browser?: string; server?: string }): () => void;
}

function hooks(): BrowserTelemetryHooks | undefined {
  return (globalThis as Record<string, unknown>).__stradBrowserTelemetry as
    | BrowserTelemetryHooks
    | undefined;
}

/**
 * Wrap a browser launch so it is timed, counted, and watched for a crash.
 *
 * A no-op passthrough when no bootstrap is loaded.
 */
export async function withBrowserTelemetry<T>(
  server: string,
  launch: () => Promise<T>,
): Promise<T> {
  const h = hooks();
  if (!h) return launch();
  return h.instrumentLaunch(launch, { browser: "chromium", server });
}

/** Track a browser context's lifetime. Returns the "closed" callback. */
export function trackBrowserContext(server: string): () => void {
  const h = hooks();
  if (!h) return () => {};
  return h.contextOpened({ browser: "chromium", server });
}
