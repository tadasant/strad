import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A Chrome or Chromium to test against: $HOSTD_TEST_CHROME, Playwright's cache, then the system's. */
export function findChrome(): string | undefined {
  const candidates: string[] = [];
  if (process.env.HOSTD_TEST_CHROME)
    candidates.push(process.env.HOSTD_TEST_CHROME);
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse()) {
      for (const sub of ["chrome-linux64", "chrome-linux"])
        candidates.push(join(cache, dir, sub, "chrome"));
    }
  }
  candidates.push(
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  );
  candidates.push(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  return candidates.find((c) => existsSync(c));
}
