import type { CapabilityId } from "../capabilities.js";
import type { HelperClient, HelperHello } from "../native/client.js";

/**
 * Whether a computer-use server can work right now, asked before the consent
 * dialog goes up. The answers are the three things a person can fix on the
 * machine, each named with where to fix it.
 */
export async function helperPreflight(
  helper: HelperClient,
  id: CapabilityId,
): Promise<string | undefined> {
  let hello: HelperHello;
  try {
    hello = await helper.hello();
  } catch (err) {
    return `the native helper (strad-hostd-ax) is not running: ${(err as Error).message}`;
  }
  if (!hello.trusted.accessibility) {
    return "strad-hostd-ax is not trusted for Accessibility on this machine; its owner has to add it under System Settings › Privacy & Security › Accessibility";
  }
  if (id === "computer" && !hello.trusted.screen_recording) {
    return "strad-hostd-ax is not allowed to record the screen on this machine; its owner has to add it under System Settings › Privacy & Security › Screen & System Audio Recording";
  }
  return undefined;
}

export async function helperStatus(
  helper: HelperClient,
): Promise<Record<string, unknown>> {
  try {
    const hello = await helper.hello();
    return {
      helper: {
        running: true,
        version: hello.version,
        accessibility: hello.trusted.accessibility,
        screen_recording: hello.trusted.screen_recording,
      },
    };
  } catch (err) {
    return { helper: { running: false, error: (err as Error).message } };
  }
}
