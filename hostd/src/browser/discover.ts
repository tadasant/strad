import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Config } from "../config.js";

/** Where stock Chrome keeps the profile a person actually uses. */
export function defaultUserDataDir(
  platform = process.platform,
): string | undefined {
  if (platform === "darwin")
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
  if (platform === "linux") return join(homedir(), ".config", "google-chrome");
  return undefined;
}

/**
 * `DevToolsActivePort`: two lines Chrome writes into its user-data directory
 * while it is accepting DevTools connections — the port, then the browser
 * target's WebSocket path. It is the only discovery that works for a Chrome
 * whose debugging was switched on from `chrome://inspect/#remote-debugging`
 * rather than from the command line, because that Chrome serves no
 * `/json/version` to ask.
 */
export function parseActivePort(contents: string): string | undefined {
  const [port, path] = contents.split("\n").map((l) => l.trim());
  if (!port || !/^\d+$/.test(port) || !path?.startsWith("/")) return undefined;
  return `ws://127.0.0.1:${port}${path}`;
}

export const NOT_DEBUGGABLE =
  "The owner's Chrome is not accepting DevTools connections. On that machine: open Chrome, go to " +
  'chrome://inspect/#remote-debugging, and turn on "Allow remote debugging for this browser instance" ' +
  "(Chrome 144 or newer). Chrome must be running. Launching Chrome with --remote-debugging-port does NOT work " +
  "for the default profile — Chrome has ignored that flag there since version 136.";

/** The browser-level DevTools WebSocket URL, or a reason a human can act on. */
export async function discoverBrowserWsUrl(config: Config): Promise<string> {
  const { cdpUrl, userDataDir } = config.browser;
  if (cdpUrl) {
    const res = await fetch(new URL("/json/version", cdpUrl), {
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
    const body = (
      res?.ok ? await res.json().catch(() => undefined) : undefined
    ) as { webSocketDebuggerUrl?: string } | undefined;
    if (!body?.webSocketDebuggerUrl)
      throw new Error(
        `No DevTools endpoint answered at ${cdpUrl}. ${NOT_DEBUGGABLE}`,
      );
    return body.webSocketDebuggerUrl;
  }
  const dir = userDataDir ?? defaultUserDataDir();
  if (!dir)
    throw new Error(
      "No Chrome user-data directory is known for this platform; set browser.userDataDir.",
    );
  let contents: string;
  try {
    contents = readFileSync(join(dir, "DevToolsActivePort"), "utf8");
  } catch {
    throw new Error(NOT_DEBUGGABLE);
  }
  const url = parseActivePort(contents);
  if (!url)
    throw new Error(
      `${join(dir, "DevToolsActivePort")} is malformed. ${NOT_DEBUGGABLE}`,
    );
  return url;
}
