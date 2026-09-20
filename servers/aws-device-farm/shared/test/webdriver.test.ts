import { describe, expect, it } from "vitest";

import { DriverError } from "../src/errors.js";
import { ELEMENT_KEY, createWebDriverSession } from "../src/webdriver.js";
import { APPIUM_ENDPOINT, SESSION_ARN, fakeHttp } from "./fakes.js";

const SESSION_ID = "abcdef123456-1234-5678-abcd-abcdef123456";

const baseRoutes = {
  "/session": { body: { value: { sessionId: SESSION_ID, capabilities: {} } } },
};

async function driverOn(routes: Parameters<typeof fakeHttp>[0]) {
  const http = fakeHttp({ ...baseRoutes, ...routes });
  const driver = await createWebDriverSession({
    endpoint: APPIUM_ENDPOINT,
    fetchImpl: http.fetchImpl,
    capabilities: { platformName: "iOS", "appium:automationName": "XCUITest" },
    sessionArn: SESSION_ARN,
  });
  return { driver, http };
}

const body = (raw: unknown): Record<string, unknown> =>
  JSON.parse(String(raw)) as Record<string, unknown>;

describe("establishing a session", () => {
  it("sends W3C capabilities and keeps the session id", async () => {
    const { driver, http } = await driverOn({});
    expect(driver.sessionId).toBe(SESSION_ID);
    const created = body(http.calls[0]!.init?.body);
    expect(created).toEqual({
      capabilities: {
        alwaysMatch: { platformName: "iOS", "appium:automationName": "XCUITest" },
        firstMatch: [{}],
      },
    });
  });

  it("puts a deadline on every request, past Device Farm's own four-minute cap", async () => {
    const { http } = await driverOn({});
    expect(http.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("names no app: the endpoint injects the build the session installed", async () => {
    const { http } = await driverOn({});
    expect(String(http.calls[0]!.init?.body)).not.toContain("appium:app");
    expect(String(http.calls[0]!.init?.body)).not.toContain("bundleId");
  });

  it("fails loudly when the endpoint accepts the request and returns no session", async () => {
    const http = fakeHttp({ "/session": { body: { value: {} } } });
    await expect(
      createWebDriverSession({
        endpoint: APPIUM_ENDPOINT,
        fetchImpl: http.fetchImpl,
        capabilities: {},
      }),
    ).rejects.toThrow(/no sessionId/);
  });
});

describe("the commands a phone is driven with", () => {
  it("taps with a pointer sequence the app can track", async () => {
    const { driver, http } = await driverOn({ "/actions": { body: { value: null } } });
    await driver.tap({ x: 197, y: 642 });
    const actions = body(http.calls[1]!.init?.body).actions as {
      type: string;
      parameters: { pointerType: string };
      actions: { type: string; x?: number; y?: number }[];
    }[];
    expect(actions[0]!.parameters.pointerType).toBe("touch");
    expect(actions[0]!.actions.map((a) => a.type)).toEqual([
      "pointerMove",
      "pointerDown",
      "pause",
      "pointerUp",
    ]);
    expect(actions[0]!.actions[0]).toMatchObject({ x: 197, y: 642 });
  });

  it("pauses before dragging, or iOS reads the gesture as a flick", async () => {
    const { driver, http } = await driverOn({ "/actions": { body: { value: null } } });
    await driver.swipe({ x: 196, y: 1400 }, { x: 196, y: 600 }, 400);
    const sequence = (
      body(http.calls[1]!.init?.body).actions as {
        actions: { type: string; duration?: number }[];
      }[]
    )[0]!.actions;
    expect(sequence.map((a) => a.type)).toEqual([
      "pointerMove",
      "pointerDown",
      "pause",
      "pointerMove",
      "pointerUp",
    ]);
    expect(sequence[3]!.duration).toBe(400);
  });

  it("sends both `text` and the legacy `value` when typing", async () => {
    // An element that received neither reports success and types nothing,
    // which is the quietest possible failure in a login flow.
    const { driver, http } = await driverOn({ "/value": { body: { value: null } } });
    await driver.sendKeys("elem-1", "hi");
    expect(body(http.calls[1]!.init?.body)).toEqual({ text: "hi", value: ["h", "i"] });
  });

  it("reads elements out of the W3C element-key envelope", async () => {
    const { driver } = await driverOn({
      "/elements": {
        body: { value: [{ [ELEMENT_KEY]: "elem-1" }, { [ELEMENT_KEY]: "elem-2" }] },
      },
    });
    expect(await driver.findElements("-ios predicate string", 'label == "Play"')).toEqual([
      "elem-1",
      "elem-2",
    ]);
  });

  it("returns an empty list rather than inventing an element", async () => {
    const { driver } = await driverOn({ "/elements": { body: { value: [] } } });
    expect(await driver.findElements("-ios predicate string", "x")).toEqual([]);
  });

  it("clears through the W3C endpoint rather than a `mobile:` verb", async () => {
    const { driver, http } = await driverOn({ "/clear": { body: { value: null } } });
    await driver.clear("elem-1");
    expect(http.calls[1]!.url).toContain(`/session/${SESSION_ID}/element/elem-1/clear`);
  });

  it("ends a session with DELETE, so the phone is not left holding one", async () => {
    const { driver, http } = await driverOn({});
    await driver.quit();
    expect(http.calls[1]!.init?.method).toBe("DELETE");
    expect(http.calls[1]!.url).toBe(`${APPIUM_ENDPOINT}/session/${SESSION_ID}`);
  });
});

describe("a failure keeps the code a caller branches on", () => {
  it("carries the W3C error code, not just the status", async () => {
    const { driver } = await driverOn({
      "/elements": {
        status: 404,
        body: {
          value: {
            error: "no such element",
            message: "unable to find an element matching the predicate",
          },
        },
      },
    });
    await expect(driver.findElements("-ios predicate string", "x")).rejects.toMatchObject({
      name: "DriverError",
      code: "no such element",
      sessionArn: SESSION_ARN,
    });
  });

  it("reads an error body that came back with a 200", async () => {
    // Appium does this, and a status-only check would report success.
    const { driver } = await driverOn({
      "/source": { status: 200, body: { value: { error: "invalid session id" } } },
    });
    await expect(driver.source()).rejects.toMatchObject({ code: "invalid session id" });
  });

  it("calls a dead endpoint a transport error and says why it died", async () => {
    const { driver } = await driverOn({
      "/source": { throws: new Error("ECONNREFUSED") },
    });
    const err = await driver.source().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe("transport error");
    expect((err as DriverError).message).toMatch(/five minutes of no activity/);
  });

  it("does not choke on a body that is not JSON", async () => {
    const http = fakeHttp({
      "/session": { status: 502, body: {} },
    });
    // `body: {}` serialises to "{}", so force the non-JSON case directly.
    const notJson: typeof http.fetchImpl = async () => ({
      ok: false,
      status: 502,
      headers: { get: () => null },
      text: async () => "<html>bad gateway</html>",
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      createWebDriverSession({
        endpoint: APPIUM_ENDPOINT,
        fetchImpl: notJson,
        capabilities: {},
      }),
    ).rejects.toThrow(/not JSON/);
  });
});
