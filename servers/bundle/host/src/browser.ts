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
 * holds the other 22 servers.
 */

export interface SharedBrowser {
  isConnected(): boolean;
  newContext(options?: unknown): Promise<unknown>;
  close(): Promise<void>;
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

    const launched = (await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox",
      ],
    })) as unknown as SharedBrowser;

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
