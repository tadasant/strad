/**
 * One WebDriver session per live phone, held for as long as the phone is.
 *
 * WHY A POOL AT ALL. strad builds a fresh MCP `Server` per request, so nothing
 * in a tool call survives it — but a WebDriver session takes seconds to
 * establish and RELAUNCHES THE APP when it does, because the Appium endpoint
 * injects the installed build as `appium:app`. A pool keyed on the Device Farm
 * session ARN is what makes `tap_screen` then `read_screen` two taps on one
 * running app instead of two cold starts of it. The pool lives at module scope
 * in the mount, which is the same process for the life of the container.
 *
 * WHICH SESSION, WHEN NOBODY SAID. Every driving tool takes an optional
 * `session_arn` and resolves it the obvious way when it is absent: if exactly
 * one session is running, that is the one. Two running sessions is an error
 * that lists them rather than a coin toss — the wrong phone is the one failure
 * here that looks like a passing test.
 *
 * A DEAD SESSION IS RETRIED ONCE. A phone can drop a WebDriver session while
 * the Device Farm session stays up (`invalid session id`), and the cached
 * handle then fails every call. That is recoverable without a human: drop it,
 * establish a new one, run the command again — once, so a genuinely broken
 * endpoint fails rather than loops.
 */

import type { DeviceFarmGateway } from "./gateway.js";
import { InputError, SessionNotReadyError } from "./errors.js";
import type { FetchLike } from "./http.js";
import {
  createWebDriverSession,
  type WebDriverSession,
} from "./webdriver.js";

/** Statuses from which a session will never become drivable. */
const TERMINAL = new Set(["COMPLETED", "STOPPING"]);

/** WebDriver error codes that mean "the handle is stale, not the request wrong". */
const STALE = new Set(["invalid session id", "no such session", "transport error"]);

export interface DriverPool {
  /** The session to drive, given what the caller did or did not say. */
  resolve(sessionArn?: string): Promise<string>;
  /** Run one command against a session, re-establishing a stale handle once. */
  with<T>(
    sessionArn: string,
    run: (driver: WebDriverSession) => Promise<T>,
  ): Promise<T>;
  /** Forget a session, ending its WebDriver handle if there is one. */
  release(sessionArn: string): Promise<void>;
}

export interface CreateDriverPoolOptions {
  gateway: DeviceFarmGateway;
  fetchImpl: FetchLike;
}

export function createDriverPool(options: CreateDriverPoolOptions): DriverPool {
  const { gateway, fetchImpl } = options;
  /**
   * Keyed on the Device Farm session ARN, and holding the PROMISE rather than
   * the session. strad builds a `Server` per request and nothing serialises
   * them, so two commands can arrive for a phone with no handle yet; a map of
   * settled sessions would let both connect, relaunch the app twice, and leak
   * the handle the second `set` overwrote. A shared in-flight promise means the
   * second caller waits on the first connect instead of starting its own.
   */
  const open = new Map<string, Promise<WebDriverSession>>();

  const acquire = (sessionArn: string): Promise<WebDriverSession> => {
    let pending = open.get(sessionArn);
    if (!pending) {
      pending = connect(sessionArn);
      open.set(sessionArn, pending);
      // A connect that fails must not be cached as a permanently broken
      // handle: the next call gets a fresh attempt.
      pending.catch(() => {
        if (open.get(sessionArn) === pending) open.delete(sessionArn);
      });
    }
    return pending;
  };

  /** Forget a handle, ending it politely if it ever came up. Never throws. */
  const discard = async (sessionArn: string, handle?: Promise<WebDriverSession>): Promise<void> => {
    const current = open.get(sessionArn);
    // Only the handle the caller found stale is dropped. A sibling that has
    // already re-established a fresh one must not lose it to this retry.
    if (handle !== undefined && current !== handle) return;
    open.delete(sessionArn);
    const driver = await (handle ?? current)?.catch(() => undefined);
    await driver?.quit().catch(() => undefined);
  };

  async function connect(sessionArn: string): Promise<WebDriverSession> {
    const raw = await gateway.rawSession(sessionArn);
    const status = String(raw.status ?? "UNKNOWN");
    const endpoint = (raw.endpoints as { remoteDriverEndpoint?: string } | undefined)
      ?.remoteDriverEndpoint;

    if (!endpoint) {
      throw new SessionNotReadyError(
        sessionArn,
        status,
        TERMINAL.has(status)
          ? "the session has ended"
          : "Device Farm has not published an Appium endpoint for it yet",
      );
    }

    const platform = String(
      (raw.device as { platform?: string } | undefined)?.platform ?? "IOS",
    );
    const capabilities: Record<string, unknown> =
      platform === "ANDROID"
        ? { platformName: "Android", "appium:automationName": "UiAutomator2" }
        : { platformName: "iOS", "appium:automationName": "XCUITest" };

    // No `appium:app` and no `appium:bundleId`: Device Farm injects the build
    // that was installed into the session, and naming one here would override
    // that with something this server would have to be told.
    return createWebDriverSession({
      endpoint,
      fetchImpl,
      capabilities,
      sessionArn,
    });
  }

  return {
    async resolve(sessionArn) {
      if (sessionArn) return sessionArn;
      const sessions = await gateway.listSessions(50);
      const live = sessions.filter((s) => s.status === "RUNNING");
      if (live.length === 1) return live[0]!.arn;
      if (live.length === 0) {
        throw new InputError(
          "No device session is running, so there is nothing to drive. Start " +
            "one with start_device_session — and remember it bills by the " +
            "minute until stop_device_session ends it.",
        );
      }
      throw new InputError(
        `${live.length} device sessions are running, so \`session_arn\` is ` +
          `required. They are: ${live
            .map((s) => `${s.arn} (${s.device?.name ?? "unknown device"})`)
            .join("; ")}.`,
      );
    },

    async with(sessionArn, run) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const handle = acquire(sessionArn);
        const driver = await handle;
        try {
          return await run(driver);
        } catch (err) {
          const code = (err as { code?: string }).code;
          const stale = typeof code === "string" && STALE.has(code);
          if (!stale || attempt === 1) throw err;
          await discard(sessionArn, handle);
        }
      }
      // Unreachable: the loop either returns or throws on its second pass.
      throw new Error("driver pool exhausted its retry");
    },

    async release(sessionArn) {
      // Best effort. The Device Farm session is about to be stopped, which ends
      // the endpoint anyway, and a failure to say goodbye politely must not
      // stop the call that stops the billing.
      await discard(sessionArn);
    },
  };
}
