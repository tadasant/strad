import { describe, expect, it } from "vitest";

import { createGateway, METERED_USD_PER_MINUTE } from "../src/gateway.js";
import { InputError } from "../src/errors.js";
import {
  DEVICE_ARN,
  IPHONE,
  PROJECT_ARN,
  RUN_ARN,
  SESSION_ARN,
  fakeDeviceFarm,
  runningSession,
} from "./fakes.js";

const gatewayOn = (api: ReturnType<typeof fakeDeviceFarm>) =>
  createGateway({ api, projectArn: PROJECT_ARN });

describe("listing devices", () => {
  it("scopes the list to the project the credential is for", async () => {
    const api = fakeDeviceFarm();
    await gatewayOn(api).listDevices({ platform: "IOS", limit: 10 });
    expect(api.calls[0]!.input.arn).toBe(PROJECT_ARN);
  });

  it("sends only filters Device Farm's grammar accepts", async () => {
    // `IN` is allowed on ARN, OS_VERSION, MODEL, MANUFACTURER and INSTANCE_ARN
    // and nothing else, and a boolean attribute is the literal TRUE / FALSE.
    // AVAILABILITY therefore never goes on the wire: it is filtered after the
    // walk. An `IN` on it is an ArgumentException on the DEFAULT call.
    const api = fakeDeviceFarm();
    await gatewayOn(api).listDevices({
      platform: "IOS",
      min_os_version: "17.0",
      model_contains: "iPhone 15",
      available_only: true,
      remote_access_only: true,
      limit: 10,
    });
    expect(api.calls[0]!.input.filters).toEqual([
      { attribute: "PLATFORM", operator: "EQUALS", values: ["IOS"] },
      { attribute: "OS_VERSION", operator: "GREATER_THAN_OR_EQUALS", values: ["17.0"] },
      { attribute: "MODEL", operator: "CONTAINS", values: ["iPhone 15"] },
      { attribute: "REMOTE_ACCESS_ENABLED", operator: "EQUALS", values: ["TRUE"] },
    ]);
    for (const f of api.calls[0]!.input.filters as { attribute: string }[]) {
      expect(f.attribute).not.toBe("AVAILABILITY");
    }
  });

  it("drops a busy device client-side when only available ones were asked for", async () => {
    const api = fakeDeviceFarm({
      devices: [
        { ...IPHONE, arn: `${DEVICE_ARN}1`, availability: "BUSY" },
        { ...IPHONE, arn: `${DEVICE_ARN}2`, availability: "AVAILABLE" },
        { ...IPHONE, arn: `${DEVICE_ARN}3`, availability: "TEMPORARY_NOT_AVAILABLE" },
      ],
    });
    const { devices } = await gatewayOn(api).listDevices({ available_only: true, limit: 10 });
    expect(devices.map((d) => d.arn)).toEqual([`${DEVICE_ARN}2`]);
    const all = await gatewayOn(api).listDevices({ available_only: false, limit: 10 });
    expect(all.devices).toHaveLength(3);
  });

  it("ranks the whole fleet before cutting to the limit", async () => {
    // The best phone is on page two. A walk that stopped at `limit` and then
    // sorted would never see it, and the description promises it is first.
    const api = fakeDeviceFarm({
      devices: [
        { ...IPHONE, arn: `${DEVICE_ARN}old`, os: "16.0", availability: "AVAILABLE" },
        { ...IPHONE, arn: `${DEVICE_ARN}new`, os: "18.0", availability: "HIGHLY_AVAILABLE" },
      ],
    });
    // Page it: the fake hands the list back one device per call.
    let page = 0;
    api.listDevices = async (input) => {
      api.calls.push({ method: "listDevices", input });
      const device = api.state.devices[page]!;
      page += 1;
      return {
        devices: [device],
        ...(page < api.state.devices.length ? { nextToken: `t${page}` } : {}),
      };
    };
    const { devices, truncated } = await gatewayOn(api).listDevices({ limit: 1 });
    expect(devices.map((d) => d.arn)).toEqual([`${DEVICE_ARN}new`]);
    expect(truncated).toBe(true);
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]!.input.nextToken).toBe("t1");
  });

  it("returns what an agent needs and drops what it does not", async () => {
    const { devices } = await gatewayOn(fakeDeviceFarm()).listDevices({ limit: 10 });
    expect(devices[0]).toEqual({
      arn: DEVICE_ARN,
      name: "Apple iPhone 15 Pro",
      model: "iPhone 15 Pro",
      os: "17.5.1",
      platform: "IOS",
      form_factor: "PHONE",
      manufacturer: "Apple",
      availability: "HIGHLY_AVAILABLE",
      remote_access_enabled: true,
      resolution: "1179x2556",
    });
    // The CPU record, the heap size and the fleet name are thousands of tokens
    // across a full list, and no caller here branches on them.
    expect(JSON.stringify(devices)).not.toContain("heapSize");
    expect(JSON.stringify(devices)).not.toContain("fleetName");
  });

  it("puts the phone you can have now, on the newest OS, first", async () => {
    const api = fakeDeviceFarm({
      devices: [
        { ...IPHONE, arn: `${DEVICE_ARN}1`, os: "16.7", availability: "AVAILABLE" },
        { ...IPHONE, arn: `${DEVICE_ARN}2`, os: "18.0", availability: "BUSY" },
        { ...IPHONE, arn: `${DEVICE_ARN}3`, os: "17.5.1", availability: "AVAILABLE" },
        { ...IPHONE, arn: `${DEVICE_ARN}4`, os: "17.0", availability: "HIGHLY_AVAILABLE" },
      ],
    });
    const { devices } = await gatewayOn(api).listDevices({ limit: 10 });
    expect(devices.map((d) => d.arn)).toEqual([
      `${DEVICE_ARN}4`, // free right now
      `${DEVICE_ARN}3`, // available, newer than 16.7
      `${DEVICE_ARN}1`,
      `${DEVICE_ARN}2`, // busy, however new
    ]);
  });

  it("compares OS versions numerically, not lexically", async () => {
    // "9.0" sorts above "10.0" as a string, and an agent taking the first row
    // would get a device five major versions behind.
    const api = fakeDeviceFarm({
      devices: [
        { ...IPHONE, arn: `${DEVICE_ARN}a`, os: "9.0" },
        { ...IPHONE, arn: `${DEVICE_ARN}b`, os: "10.0" },
      ],
    });
    const { devices } = await gatewayOn(api).listDevices({ limit: 10 });
    expect(devices[0]!.os).toBe("10.0");
  });
});

describe("cost is a first-class result", () => {
  it("prices metered minutes at the documented rate, and labels the basis", async () => {
    const run = await gatewayOn(fakeDeviceFarm()).getRun(RUN_ARN);
    expect(run.device_minutes).toEqual({ total: 6.5, metered: 6.5, unmetered: 0 });
    expect(run.estimated_metered_cost_usd).toBe(
      Math.round(6.5 * METERED_USD_PER_MINUTE * 100) / 100,
    );
    expect(run.cost_basis).toContain("free trial");
  });

  it("quotes no price when Device Farm reported no minutes", async () => {
    const api = fakeDeviceFarm();
    delete (api.state.run as Record<string, unknown>).deviceMinutes;
    const run = await gatewayOn(api).getRun(RUN_ARN);
    expect(run.estimated_metered_cost_usd).toBeUndefined();
    expect(run.cost_basis).toBeUndefined();
  });

  it("reports the free-trial balance, which is the only thing that says minutes are free", async () => {
    const status = await gatewayOn(fakeDeviceFarm()).accountStatus();
    expect(status.free_trial_minutes_remaining).toBe(827.5);
    expect(status.unmetered_remote_access_slots).toEqual({ IOS: 0 });
    expect(status.metered_rate_usd_per_minute).toBe(METERED_USD_PER_MINUTE);
  });
});

describe("runs", () => {
  it("refuses a run that names no devices, rather than letting AWS say so", async () => {
    await expect(
      gatewayOn(fakeDeviceFarm()).scheduleRun({ test_type: "BUILTIN_FUZZ" }),
    ).rejects.toThrow(InputError);
  });

  it("refuses a run that names both a pool and a list", async () => {
    // Two answers to "which devices" is two different bills.
    await expect(
      gatewayOn(fakeDeviceFarm()).scheduleRun({
        test_type: "BUILTIN_FUZZ",
        device_pool_arn: "arn:aws:devicefarm:us-west-2::devicepool:top",
        device_arns: [DEVICE_ARN],
      }),
    ).rejects.toThrow(/not both/);
  });

  it("turns a device list into a selection configuration", async () => {
    const api = fakeDeviceFarm();
    await gatewayOn(api).scheduleRun({
      test_type: "BUILTIN_FUZZ",
      app_arn: "arn:aws:devicefarm:us-west-2:111122223333:upload:x/y",
      device_arns: [DEVICE_ARN],
    });
    const input = api.calls[0]!.input as Record<string, unknown>;
    expect(input.deviceSelectionConfiguration).toEqual({
      filters: [{ attribute: "ARN", operator: "IN", values: [DEVICE_ARN] }],
      maxDevices: 1,
    });
    expect(input.devicePoolArn).toBeUndefined();
  });

  it("asks for video even though Device Farm already defaults to it", async () => {
    // The video is the evidence, and the default is AWS's to change.
    const api = fakeDeviceFarm();
    await gatewayOn(api).scheduleRun({
      test_type: "BUILTIN_FUZZ",
      device_pool_arn: "arn:aws:devicefarm:us-west-2::devicepool:top",
    });
    const config = (api.calls[0]!.input as { executionConfiguration: { videoCapture: boolean } })
      .executionConfiguration;
    expect(config.videoCapture).toBe(true);
  });

  it("reports each device's outcome beside the run's", async () => {
    const run = await gatewayOn(fakeDeviceFarm()).getRun(RUN_ARN);
    expect(run.jobs).toEqual([
      {
        arn: `${RUN_ARN}/00000`,
        device: "Apple iPhone 15 Pro",
        os: "17.5.1",
        status: "COMPLETED",
        result: "PASSED",
      },
    ]);
  });

  it("still reports the run when the jobs call fails", async () => {
    // `status` is the field a caller is polling for. Losing it because a
    // secondary call failed would turn a finished run into an error.
    const api = fakeDeviceFarm();
    const listJobs = api.listJobs;
    api.listJobs = async () => {
      throw new Error("throttled");
    };
    const run = await gatewayOn(api).getRun(RUN_ARN);
    expect(run.status).toBe("COMPLETED");
    expect(run.jobs).toBeUndefined();
    api.listJobs = listJobs;
  });

  it("groups artifacts by the kind that was asked for", async () => {
    const api = fakeDeviceFarm();
    const grouped = await gatewayOn(api).listRunArtifacts(RUN_ARN, ["FILE", "LOG"]);
    expect(Object.keys(grouped)).toEqual(["file", "log"]);
    expect(grouped.file![0]!.type).toBe("VIDEO");
    expect(grouped.log![0]!.type).toBe("DEVICE_LOG");
    expect(api.calls.map((c) => c.input.type)).toEqual(["FILE", "LOG"]);
  });
});

describe("sessions", () => {
  it("reports drivability without ever returning the endpoint", async () => {
    // The Appium URL authorises by itself. Anyone holding the string can drive
    // the phone, so it is a credential and it does not leave this server.
    const api = fakeDeviceFarm({ sessions: [runningSession()] });
    const session = await gatewayOn(api).getSession(SESSION_ARN);
    expect(session.drivable).toBe(true);
    expect(JSON.stringify(session)).not.toContain("remote-endpoint");
    expect(JSON.stringify(session)).not.toContain("remoteDriverEndpoint");
  });

  it("is not drivable while the phone is still being allocated", async () => {
    const api = fakeDeviceFarm({
      sessions: [{ arn: SESSION_ARN, status: "PREPARING", device: IPHONE }],
    });
    const session = await gatewayOn(api).getSession(SESSION_ARN);
    expect(session.status).toBe("PREPARING");
    expect(session.drivable).toBe(false);
  });

  it("passes an Appium version through as the session parameter AWS names", async () => {
    // Required on iOS 27 and later; the request is rejected without it.
    const api = fakeDeviceFarm();
    await gatewayOn(api).startSession({ device_arn: DEVICE_ARN, appium_version: "2" });
    expect(api.calls[0]!.input.configuration).toEqual({
      parameters: { "appium:version": "2" },
    });
    const bare = fakeDeviceFarm();
    await gatewayOn(bare).startSession({ device_arn: DEVICE_ARN });
    expect(bare.calls[0]!.input.configuration).toBeUndefined();
  });

  it("stops a session by ARN", async () => {
    const api = fakeDeviceFarm({ sessions: [runningSession()] });
    const stopped = await gatewayOn(api).stopSession(SESSION_ARN);
    expect(stopped.status).toBe("STOPPING");
    expect(api.calls.at(-1)).toEqual({
      method: "stopRemoteAccessSession",
      input: { arn: SESSION_ARN },
    });
  });
});
