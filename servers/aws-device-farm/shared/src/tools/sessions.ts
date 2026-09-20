import type { DeviceFarmGateway } from "../gateway.js";
import {
  args,
  boundedInt,
  guard,
  ok,
  optionalBool,
  optionalString,
  requiredArn,
  type DepsFactory,
  type ToolDefinition,
} from "./shared.js";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/**
 * The Appium major version a session gets when the caller named none.
 *
 * Device Farm REQUIRES `appium:version` on iOS 27 and later and rejects the
 * request without it; below that it is optional and the service picks. One
 * `list_devices` call resolves the OS for the ARN. It is best-effort: a
 * lookup that fails leaves the parameter unset, which is the pre-27 answer and
 * a clear error on 27+ rather than a wrong guess.
 */
async function defaultAppiumVersion(
  gateway: DeviceFarmGateway,
  deviceArn: string,
): Promise<string | undefined> {
  try {
    const { devices } = await gateway.listDevices({
      available_only: false,
      remote_access_only: false,
      limit: 500,
    });
    const os = devices.find((d) => d.arn === deviceArn)?.os;
    const major = Number.parseInt(os ?? "", 10);
    return Number.isFinite(major) && major >= 27 ? "2" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A real phone, held for as long as somebody is using it.
 *
 * THIS IS THE INTERACTIVE MODE, and it is drivable programmatically — which is
 * the fact the whole server turns on. A remote access session is a physical
 * device in a rack with a browser view of it, and since AWS added the Appium
 * endpoint it also carries a WebDriver URL. That is what `tap_screen`,
 * `read_screen` and the rest speak to. Nothing about it needs a human at a
 * keyboard.
 *
 * IT BILLS FROM THE MOMENT THE PHONE IS ALLOCATED. 150 minutes maximum, and it
 * ends itself after five minutes with no activity — which is a safety net, not
 * a plan. `stop_device_session` is the plan.
 */
export function startDeviceSessionTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "start_device_session",
    description:
      "Take a real phone for interactive driving, install a build on it, and " +
      "wait until it can be driven. Returns a session ARN that read_screen, " +
      "tap_screen, type_text, swipe_screen, take_screenshot and " +
      "run_mobile_command all use.\n\n" +
      "⚠️ THIS SPENDS MONEY FROM THE MOMENT THE PHONE IS ALLOCATED, per " +
      "device-minute, until stop_device_session. It ends itself after 5 " +
      "minutes of no activity and at 150 minutes total — treat both as " +
      "accidents, not as the plan. get_account_status says what a minute " +
      "costs.\n\n" +
      'Example: {"arn":"arn:aws:devicefarm:us-west-2:111122223333:session:.../ef56",' +
      '"status":"RUNNING","drivable":true,"device":{"name":"Apple iPhone 15 Pro",' +
      '"os":"17.5.1"},"device_minutes":{"metered":0.5}}\n\n' +
      "`status`: PENDING / PENDING_DEVICE / PREPARING mean a phone is still " +
      "being allocated and the app installed; RUNNING with `drivable:true` is " +
      "ready. If `wait_seconds` runs out before then the session is REAL and " +
      "still starting — keep it, and poll list_device_sessions.\n\n" +
      "Device Farm re-signs the .ipa on public devices, which strips Push " +
      "Notifications, App Groups, Associated Domains and In-App Purchase " +
      "entitlements. The Appium URL is deliberately not returned: it " +
      "authorises by itself, so strad holds it and drives on your behalf.\n\n" +
      "Use cases: reproducing a bug a human saw on TestFlight; walking an app " +
      "to the screen a report describes; checking a fix on real hardware " +
      "before it ships.",
    inputSchema: {
      type: "object",
      properties: {
        device_arn: {
          type: "string",
          description:
            "The phone, from list_devices. It must have " +
            "`remote_access_enabled:true` — only a subset of the fleet can be " +
            "driven.",
        },
        app_arn: {
          type: "string",
          description:
            "A build to install when the session starts, from upload_app. " +
            "Optional — a session with no app is a bare phone — and it is the " +
            "build the Appium endpoint then launches.",
        },
        name: {
          type: "string",
          description:
            'A name for the session, shown in the console, e.g. "motet play ' +
            'button repro".',
        },
        wait_seconds: {
          type: "integer",
          description:
            "How long to wait for the phone to become drivable (0-600). " +
            "Default: 180. Zero returns as soon as the session is created.",
        },
        skip_app_resign: {
          type: "boolean",
          description:
            "Only meaningful on PRIVATE devices. Public devices are always " +
            "re-signed by Device Farm.",
        },
        appium_version: {
          type: "string",
          description:
            'The major Appium server version for the session, e.g. "2" or ' +
            '"3". REQUIRED on iOS 27 and later — Device Farm rejects the ' +
            "session without it — and optional below that, where the service " +
            "picks. Defaults to \"2\" when the device's OS is 27 or newer.",
        },
      },
      required: ["device_arn"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const { gateway } = await deps();
        const appArn = optionalString(input, "app_arn");
        const name = optionalString(input, "name");
        const skipResign = optionalBool(input, "skip_app_resign");
        const waitSeconds = boundedInt(input, "wait_seconds", 180, 600, 0);
        const deviceArn = requiredArn(input, "device_arn");
        const appiumVersion =
          optionalString(input, "appium_version") ??
          (await defaultAppiumVersion(gateway, deviceArn));

        let session = await gateway.startSession({
          device_arn: deviceArn,
          ...(appArn === undefined ? {} : { app_arn: appArn }),
          ...(name === undefined ? {} : { name }),
          ...(skipResign === undefined ? {} : { skip_app_resign: skipResign }),
          ...(appiumVersion === undefined ? {} : { appium_version: appiumVersion }),
        });

        // From here on the session is REAL and billing, so nothing below may
        // turn into a failure that loses its ARN. A poll that throws — a
        // throttle is the realistic one, at one poll every five seconds — ends
        // the wait and returns the last state read, with the ARN in it.
        let pollError: string | undefined;
        const deadline = Date.now() + waitSeconds * 1000;
        while (!session.drivable && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          try {
            session = await gateway.getSession(session.arn);
          } catch (err) {
            pollError = err instanceof Error ? err.message : String(err);
            break;
          }
          if (session.status === "COMPLETED" || session.status === "STOPPING") break;
        }

        return ok({
          ...session,
          ...(pollError === undefined ? {} : { poll_error: pollError }),
          next: session.drivable
            ? "read_screen to see what is on the phone. stop_device_session " +
              "when you are done — it bills until then."
            : "Still starting. Poll list_device_sessions; the session is real " +
              "and is already billing, so stop_device_session if you no longer " +
              "want it.",
        });
      }),
  };
}

/**
 * The tool that stops the meter.
 *
 * IN EVERY TOOL GROUP, including the read-only one. Stopping a session can only
 * ever reduce what somebody is charged, and an agent that can SEE a runaway
 * session and cannot end it is the worst arrangement available here.
 */
export function stopDeviceSessionTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "stop_device_session",
    description:
      "End a device session and stop its billing. Call it as soon as the " +
      "phone is no longer needed — a session left running bills by the minute " +
      "for up to 150 of them, and it is the most expensive mistake available " +
      "with these tools.\n\n" +
      'Example: {"arn":"arn:aws:devicefarm:us-west-2:111122223333:session:.../ef56",' +
      '"status":"STOPPING","device_minutes":{"total":11.0,"metered":11.0},' +
      '"estimated_metered_cost_usd":1.87}\n\n' +
      "Safe to call on a session that has already ended. The video Device " +
      "Farm recorded of the session survives it and is in the console.\n\n" +
      "Use cases: finishing a verification; cleaning up a session an earlier " +
      "task abandoned; freeing remote-access concurrency, which defaults to " +
      "two devices.",
    inputSchema: {
      type: "object",
      properties: {
        session_arn: {
          type: "string",
          description: "The session to stop, from list_device_sessions.",
        },
      },
      required: ["session_arn"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const { gateway, pool } = await deps();
        const arn = requiredArn(input, "session_arn");
        // The WebDriver handle goes first. Stopping the session kills the
        // endpoint, and a pooled handle for a dead session would be tried once
        // more on the next call before it was noticed.
        await pool.release(arn);
        return ok(await gateway.stopSession(arn));
      }),
  };
}

/**
 * What is running, and what it has cost so far.
 *
 * The first thing to call when a `LimitExceededException` says the account is
 * out of remote-access concurrency: the cause is almost always a session
 * somebody forgot, still billing.
 */
export function listDeviceSessionsTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "list_device_sessions",
    description:
      "Device sessions in this project, newest first, with what each has " +
      "billed. Call it when a session ARN has been lost, when concurrency is " +
      "exhausted, or before starting a session — a forgotten one is still " +
      "charging.\n\n" +
      'Example: {"sessions":[{"arn":"arn:aws:devicefarm:us-west-2:111122223333:session:.../ef56",' +
      '"name":"motet play button repro","status":"RUNNING","drivable":true,' +
      '"device":{"name":"Apple iPhone 15 Pro","os":"17.5.1"},' +
      '"device_minutes":{"metered":24.0},"estimated_metered_cost_usd":4.08}],' +
      '"running":1,"returned":1}\n\n' +
      "`status` RUNNING is the only one that is billing and the only one that " +
      "can be driven. `drivable:true` means the Appium endpoint is up.\n\n" +
      "Use cases: finding the session to drive when only one is running; " +
      "stopping what an interrupted task left behind; reporting the cost of a " +
      "verification.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: `How many to return (1-${MAX_LIMIT}). Default: ${DEFAULT_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const sessions = await (
          await deps()
        ).gateway.listSessions(boundedInt(input, "limit", DEFAULT_LIMIT, MAX_LIMIT));
        const running = sessions.filter((s) => s.status === "RUNNING");
        return ok({
          sessions,
          running: running.length,
          returned: sessions.length,
          ...(running.length > 0
            ? {
                note:
                  `${running.length} session(s) are RUNNING and billing by the ` +
                  `minute. stop_device_session ends one.`,
              }
            : {}),
        });
      }),
  };
}

/**
 * A different build on the same phone.
 *
 * Worth its own tool because the alternative is a new session: allocation,
 * install and the minutes both cost. Swapping the build in place keeps the
 * phone and the session.
 */
export function installAppTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "install_app",
    description:
      "Install a build onto a phone that already has a session, without " +
      "starting a new one. Cheaper than a second session: the allocation and " +
      "the minutes spent getting there are not paid twice.\n\n" +
      "The newly installed build becomes what the Appium endpoint launches for " +
      "the NEXT driving command, so call read_screen afterwards rather than " +
      "assuming the old screen is still there.\n\n" +
      'Example: {"installed":true,"session_arn":"arn:aws:devicefarm:...:session:.../ef56",' +
      '"app_arn":"arn:aws:devicefarm:...:upload:.../ab12"}\n\n' +
      "Use cases: comparing two builds on one phone; installing a fix without " +
      "losing the device; adding a second app a test needs.",
    inputSchema: {
      type: "object",
      properties: {
        session_arn: {
          type: "string",
          description: "The running session, from list_device_sessions.",
        },
        app_arn: {
          type: "string",
          description: "The build to install, from upload_app or list_uploads.",
        },
      },
      required: ["session_arn", "app_arn"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const { gateway, pool } = await deps();
        const sessionArn = requiredArn(input, "session_arn");
        const appArn = requiredArn(input, "app_arn");
        await gateway.installToSession(sessionArn, appArn);
        // The pooled WebDriver session launched the PREVIOUS build. Dropping it
        // makes the next driving call establish a fresh one, which is what
        // launches what was just installed.
        await pool.release(sessionArn);
        return ok({
          installed: true,
          session_arn: sessionArn,
          app_arn: appArn,
          next: "read_screen — the next command relaunches the app, so the " +
            "screen will be the new build's first one.",
        });
      }),
  };
}
