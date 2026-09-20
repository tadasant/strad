import { describe, expect, it } from "vitest";

import { createDriverPool } from "../src/drivers.js";
import { InputError, SessionNotReadyError } from "../src/errors.js";
import { createGateway } from "../src/gateway.js";
import {
  APPIUM_ENDPOINT,
  IPHONE,
  PROJECT_ARN,
  SESSION_ARN,
  fakeDeviceFarm,
  fakeHttp,
  runningSession,
} from "./fakes.js";

const SESSION_ID = "wd-session-1";

function poolOn(
  sessions: Record<string, unknown>[],
  routes: Parameters<typeof fakeHttp>[0] = {},
) {
  const api = fakeDeviceFarm({ sessions });
  const http = fakeHttp({
    "/session": { body: { value: { sessionId: SESSION_ID } } },
    "/source": { body: { value: "<AppiumAXDocument/>" } },
    ...routes,
  });
  const gateway = createGateway({ api, projectArn: PROJECT_ARN });
  return { api, http, pool: createDriverPool({ gateway, fetchImpl: http.fetchImpl }) };
}

describe("which session, when nobody said", () => {
  it("uses the one that is running", async () => {
    const { pool } = poolOn([runningSession()]);
    expect(await pool.resolve()).toBe(SESSION_ARN);
  });

  it("says to start one when none is", async () => {
    const { pool } = poolOn([{ arn: SESSION_ARN, status: "COMPLETED" }]);
    await expect(pool.resolve()).rejects.toThrow(InputError);
    await expect(pool.resolve()).rejects.toThrow(/start_device_session/);
    await expect(pool.resolve()).rejects.toThrow(/bills by the minute/);
  });

  it("refuses to guess between two, and lists them", async () => {
    // Driving the wrong phone is the one failure here that looks like a
    // passing test.
    const { pool } = poolOn([
      runningSession(),
      runningSession({ arn: `${SESSION_ARN}-b`, device: { ...IPHONE, name: "iPhone SE" } }),
    ]);
    await expect(pool.resolve()).rejects.toThrow(/2 device sessions are running/);
    await expect(pool.resolve()).rejects.toThrow(/iPhone SE/);
  });

  it("takes an explicit ARN without asking Device Farm anything", async () => {
    const { api, pool } = poolOn([]);
    expect(await pool.resolve(SESSION_ARN)).toBe(SESSION_ARN);
    expect(api.calls).toEqual([]);
  });
});

describe("connecting to the phone", () => {
  it("drives through the session's own Appium endpoint", async () => {
    const { pool, http } = poolOn([runningSession()]);
    await pool.with(SESSION_ARN, (driver) => driver.source());
    expect(http.calls[0]!.url).toBe(`${APPIUM_ENDPOINT}/session`);
    expect(http.calls[1]!.url).toBe(`${APPIUM_ENDPOINT}/session/${SESSION_ID}/source`);
  });

  it("asks for XCUITest on an iPhone and UiAutomator2 on an Android", async () => {
    const ios = poolOn([runningSession()]);
    await ios.pool.with(SESSION_ARN, (d) => d.source());
    expect(String(ios.http.calls[0]!.init?.body)).toContain("XCUITest");

    const android = poolOn([
      runningSession({ device: { ...IPHONE, platform: "ANDROID" } }),
    ]);
    await android.pool.with(SESSION_ARN, (d) => d.source());
    expect(String(android.http.calls[0]!.init?.body)).toContain("UiAutomator2");
  });

  it("refuses a session that has no endpoint yet, and says to wait", async () => {
    const { pool } = poolOn([{ arn: SESSION_ARN, status: "PREPARING", device: IPHONE }]);
    const err = await pool.with(SESSION_ARN, async () => "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionNotReadyError);
    expect((err as SessionNotReadyError).status).toBe("PREPARING");
    expect((err as Error).message).toMatch(/wait a few seconds/);
  });

  it("says a finished session is over rather than telling a caller to wait for it", async () => {
    const { pool } = poolOn([{ arn: SESSION_ARN, status: "COMPLETED", device: IPHONE }]);
    await expect(pool.with(SESSION_ARN, async () => "x")).rejects.toThrow(
      /the session has ended/,
    );
  });

  it("establishes the session once and reuses it", async () => {
    // Establishing one RELAUNCHES the app, so a pool rebuilt per call would
    // turn a sequence of taps into a sequence of cold starts.
    const { pool, http } = poolOn([runningSession()]);
    await pool.with(SESSION_ARN, (d) => d.source());
    await pool.with(SESSION_ARN, (d) => d.source());
    expect(http.calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(1);
  });
});

describe("a stale handle recovers once", () => {
  it("re-establishes the session and runs the command again", async () => {
    let sourceCalls = 0;
    const { pool, http } = poolOn([runningSession()], {
      "/source": () => {
        sourceCalls += 1;
        return sourceCalls === 1
          ? { status: 404, body: { value: { error: "invalid session id" } } }
          : { body: { value: "<AppiumAXDocument/>" } };
      },
    });
    expect(await pool.with(SESSION_ARN, (d) => d.source())).toBe("<AppiumAXDocument/>");
    expect(http.calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(2);
  });

  it("gives up after one retry rather than looping on a broken endpoint", async () => {
    const { pool, http } = poolOn([runningSession()], {
      "/source": { status: 404, body: { value: { error: "invalid session id" } } },
    });
    await expect(pool.with(SESSION_ARN, (d) => d.source())).rejects.toThrow(
      /invalid session id/,
    );
    expect(http.calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(2);
  });

  it("does not retry a failure that is about the request", async () => {
    // `no such element` means the screen or the locator, and re-establishing
    // the session would relaunch the app and lose the screen being examined.
    const { pool, http } = poolOn([runningSession()], {
      "/elements": { status: 404, body: { value: { error: "no such element" } } },
    });
    await expect(
      pool.with(SESSION_ARN, (d) => d.findElements("-ios predicate string", "x")),
    ).rejects.toThrow(/no such element/);
    expect(http.calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(1);
  });
});

describe("two commands racing for a phone with no handle yet", () => {
  it("establishes one session and shares it", async () => {
    // Each connect RELAUNCHES the app. Two interleaved reads must not cold-start
    // it twice and leak the handle the second `set` would overwrite.
    const { pool, http } = poolOn([runningSession()]);
    await Promise.all([
      pool.with(SESSION_ARN, (d) => d.source()),
      pool.with(SESSION_ARN, (d) => d.source()),
    ]);
    expect(http.calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(1);
  });

  it("does not cache a connect that failed", async () => {
    const { pool, http } = poolOn([runningSession()], {
      "/session": () =>
        http.calls.filter((c) => c.url.endsWith("/session")).length === 1
          ? { status: 500, body: { value: { error: "session not created", message: "no" } } }
          : { body: { value: { sessionId: SESSION_ID } } },
    });
    await expect(pool.with(SESSION_ARN, (d) => d.source())).rejects.toMatchObject({
      code: "session not created",
    });
    expect(await pool.with(SESSION_ARN, (d) => d.source())).toBe("<AppiumAXDocument/>");
  });

  it("quits a stale handle rather than leaking it on the phone", async () => {
    const { pool, http } = poolOn([runningSession()], {
      "/source": { status: 404, body: { value: { error: "invalid session id" } } },
    });
    await pool.with(SESSION_ARN, (d) => d.source()).catch(() => undefined);
    expect(http.calls.filter((c) => c.init?.method === "DELETE")).toHaveLength(1);
  });
});

describe("releasing", () => {
  it("ends the WebDriver session and forgets it", async () => {
    const { pool, http } = poolOn([runningSession()]);
    await pool.with(SESSION_ARN, (d) => d.source());
    await pool.release(SESSION_ARN);
    expect(http.calls.at(-1)!.init?.method).toBe("DELETE");
    await pool.with(SESSION_ARN, (d) => d.source());
    expect(http.calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(2);
  });

  it("is quiet about a session it never held", async () => {
    const { pool, http } = poolOn([runningSession()]);
    await pool.release(SESSION_ARN);
    expect(http.calls).toEqual([]);
  });

  it("does not let a failed goodbye stop the call that stops the billing", async () => {
    const { pool } = poolOn([runningSession()], {
      "/session/wd-session-1": { throws: new Error("ECONNRESET") },
    });
    await pool.with(SESSION_ARN, (d) => d.source());
    await expect(pool.release(SESSION_ARN)).resolves.toBeUndefined();
  });
});
