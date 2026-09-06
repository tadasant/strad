import { log, logWarn } from "./log.js";

/**
 * ONE Chromium, for every browser server in this container.
 *
 * good-eggs, fetchpet and pointsyeah each used to own a browser, because each
 * used to own a component. Collapsed into one 1-vCPU box, three browsers is
 * three ~545MB peaks and three renderers fighting over one core — and CPU, not
 * RAM, is what actually binds a Chromium on App Platform's gVisor sandbox.
 *
 * So the host launches one browser, applies the SAME playwright-extra stealth
 * plugin the servers used to apply themselves (stealth patches the Browser
 * object, so contexts opened on it by any of the three are evasion-equipped),
 * and hands it to each server through its `setSharedBrowserProvider` seam. Each
 * server still opens its OWN context: good-eggs' logged-in session cannot see
 * fetchpet's cookies.
 *
 * Self-healing: if the browser process dies (OOM, crash), the next caller gets a
 * fresh one rather than a dead handle. A crash is therefore a degraded call, not
 * a dead container — which matters a great deal more now that the container also
 * holds the other 19 servers (22 mounts in all, of which 3 drive a browser).
 *
 * TELEMETRY. The launch is wrapped in the bootstrap's `instrumentLaunch` hook, so
 * it is timed, counted, and its `disconnected` event reports a Chromium crash
 * alongside the container's memory pressure at that instant — the only way to
 * tell an OOM-killed browser from one that died on a bad page. That distinction
 * is the entire question this collapse raises, so the ONE browser is exactly the
 * thing that must be measured. good-eggs and fetchpet no longer instrument their
 * own launches here (they no longer launch); they instrument the launch they do
 * make when they run standalone.
 */

export interface SharedBrowser {
  isConnected(): boolean;
  newContext(options?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * The hooks `otel/instrument.mjs` publishes on `globalThis` (see
 * telemetry/bundle/instrument.mjs). Duck-typed and optional on purpose: with no
 * bootstrap loaded — a unit test, a plain `npm start`, no OTLP endpoint — the
 * wrapper is a passthrough and this file behaves exactly as it would without it.
 */
interface BrowserTelemetryHooks {
  instrumentLaunch<T>(
    launch: () => Promise<T>,
    attrs?: { browser?: string; server?: string },
  ): Promise<T>;
  contextOpened(attrs?: { browser?: string; server?: string }): () => void;
}

function telemetry(): BrowserTelemetryHooks | undefined {
  return (globalThis as Record<string, unknown>).__stradBrowserTelemetry as
    | BrowserTelemetryHooks
    | undefined;
}

async function instrumented<T>(launch: () => Promise<T>): Promise<T> {
  const hooks = telemetry();
  if (!hooks) return launch();
  // `server: "bundle"` — the browser belongs to the container, not to any one of
  // the three servers borrowing it. Attributing it to good-eggs would make the
  // dashboard claim good-eggs launched a browser for a fetchpet call.
  return hooks.instrumentLaunch(launch, {
    browser: "chromium",
    server: "bundle",
  });
}

let browser: SharedBrowser | null = null;
let launching: Promise<SharedBrowser> | null = null;
let launches = 0;

export function browserLaunchCount(): number {
  return launches;
}

export function browserIsUp(): boolean {
  return browser?.isConnected() === true;
}

/** Launch (or relaunch) the one browser. Concurrent callers share one launch. */
export async function getSharedBrowser(): Promise<SharedBrowser> {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;

  launching = (async () => {
    const started = Date.now();
    // playwright-extra wraps playwright-core's chromium; the stealth plugin's
    // evasions are installed onto the Browser it returns, which is precisely why
    // handing THAT object to good-eggs/fetchpet preserves their bot-evasion
    // posture without each of them launching one.
    const { chromium } = await import("playwright-extra");
    const StealthPlugin = (await import("puppeteer-extra-plugin-stealth"))
      .default;
    chromium.use(StealthPlugin());

    const launched = (await instrumented(() =>
      chromium.launch({
        headless: true,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
          "--no-sandbox",
        ],
      }),
    )) as unknown as SharedBrowser;

    launches += 1;
    log(
      `chromium: launched (#${launches}) in ${Date.now() - started}ms — shared by good-eggs, fetchpet, pointsyeah`,
    );
    browser = launched;
    launching = null;
    return launched;
  })().catch((err: unknown) => {
    launching = null;
    logWarn(
      `chromium: launch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  });

  return launching;
}

export async function closeSharedBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  if (b?.isConnected()) await b.close().catch(() => {});
}
