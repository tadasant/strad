/**
 * The fakes the whole suite runs on: a Device Farm account, an HTTP surface and
 * a phone.
 *
 * NONE OF THIS IS A MOCKING LIBRARY. Every seam in this server is an injected
 * interface — `DeviceFarmApi`, `FetchLike` — so a fake is a plain object, and
 * what it fakes is the SHAPE AWS actually returns: camelCase keys, `Date`
 * objects for timestamps, `deviceMinutes` on everything that bills, and an
 * `endpoints.remoteDriverEndpoint` that only appears once a session is RUNNING.
 * A fake that returned the shape the code wanted would test nothing.
 */

import { classify, type DeviceFarmApi } from "../src/client.js";
import type { FetchInit, FetchLike, FetchResponse } from "../src/http.js";

export const PROJECT_ARN =
  "arn:aws:devicefarm:us-west-2:111122223333:project:11111111-2222-3333-4444-555555555555";
export const SESSION_ARN =
  "arn:aws:devicefarm:us-west-2:111122223333:session:11111111-2222-3333-4444-555555555555/aaaa/00000";
export const RUN_ARN =
  "arn:aws:devicefarm:us-west-2:111122223333:run:11111111-2222-3333-4444-555555555555/bbbb";
export const UPLOAD_ARN =
  "arn:aws:devicefarm:us-west-2:111122223333:upload:11111111-2222-3333-4444-555555555555/cccc";
export const DEVICE_ARN = "arn:aws:devicefarm:us-west-2::device:1A2B3C4D5E6F";
export const APPIUM_ENDPOINT =
  "https://devicefarm-interactive-global.us-west-2.api.aws/remote-endpoint/ABCD1234EFGH5678";

export const IPHONE = {
  arn: DEVICE_ARN,
  name: "Apple iPhone 15 Pro",
  model: "iPhone 15 Pro",
  os: "17.5.1",
  platform: "IOS",
  formFactor: "PHONE",
  manufacturer: "Apple",
  availability: "HIGHLY_AVAILABLE",
  remoteAccessEnabled: true,
  resolution: { width: 1179, height: 2556 },
  // Fields the gateway must NOT pass through: a real device carries these and
  // returning them is thousands of tokens a caller did not ask for.
  cpu: { architecture: "arm64", clock: 3000, frequency: "MHz" },
  heapSize: 2048,
  fleetName: "public",
};

export interface FakeCall {
  method: string;
  input: Record<string, unknown>;
}

export interface FakeDeviceFarm extends DeviceFarmApi {
  calls: FakeCall[];
  /** Mutable state the tests drive. */
  state: {
    devices: Record<string, unknown>[];
    uploadStatuses: string[];
    uploadMessage?: string;
    sessions: Record<string, unknown>[];
    run: Record<string, unknown>;
    jobs: Record<string, unknown>[];
    artifacts: Record<string, Record<string, unknown>[]>;
    failWith?: Error;
  };
}

export function fakeDeviceFarm(
  overrides: Partial<FakeDeviceFarm["state"]> = {},
): FakeDeviceFarm {
  const calls: FakeCall[] = [];
  const state: FakeDeviceFarm["state"] = {
    devices: [IPHONE],
    uploadStatuses: ["SUCCEEDED"],
    sessions: [],
    run: {
      arn: RUN_ARN,
      name: "smoke",
      type: "BUILTIN_FUZZ",
      platform: "IOS",
      status: "COMPLETED",
      result: "PASSED",
      counters: { total: 4, passed: 4, failed: 0 },
      deviceMinutes: { total: 6.5, metered: 6.5, unmetered: 0 },
      webUrl: "https://us-west-2.console.aws.amazon.com/devicefarm/home#/runs/1",
    },
    jobs: [
      {
        arn: `${RUN_ARN}/00000`,
        device: IPHONE,
        status: "COMPLETED",
        result: "PASSED",
      },
    ],
    artifacts: {
      FILE: [
        {
          arn: `${RUN_ARN}/artifact/1`,
          name: "Video",
          type: "VIDEO",
          extension: "mp4",
          url: "https://prod-us-west-2-uploads.s3.amazonaws.com/video.mp4?X-Amz-Signature=abc",
        },
      ],
      LOG: [
        {
          arn: `${RUN_ARN}/artifact/2`,
          name: "Device Log",
          type: "DEVICE_LOG",
          extension: "syslog",
          url: "https://prod-us-west-2-uploads.s3.amazonaws.com/syslog?X-Amz-Signature=def",
        },
      ],
      SCREENSHOT: [],
    },
    ...overrides,
  };

  let uploadPoll = 0;

  const record = (method: string, input: Record<string, unknown>): void => {
    calls.push({ method, input });
    // Through `classify`, because that is what the real adapter does: a raw
    // SDK exception never reaches a tool, and a fake that threw one would let
    // the error classification go untested from here.
    if (state.failWith) throw classify(state.failWith);
  };

  return {
    calls,
    state,

    async getAccountSettings() {
      record("getAccountSettings", {});
      return {
        accountSettings: {
          awsAccountNumber: "111122223333",
          trialMinutes: { total: 1000, remaining: 827.5 },
          unmeteredDevices: { IOS: 0 },
          unmeteredRemoteAccessDevices: { IOS: 0 },
          maxSlots: { IOS: 0 },
          defaultJobTimeoutMinutes: 150,
          skipAppResign: false,
        },
      };
    },

    async listDevices(input) {
      record("listDevices", input);
      return { devices: state.devices };
    },

    async listDevicePools(input) {
      record("listDevicePools", input);
      return {
        devicePools: [
          {
            arn: "arn:aws:devicefarm:us-west-2::devicepool:top",
            name: "Top Devices",
            type: "CURATED",
            maxDevices: 5,
          },
        ],
      };
    },

    async listUploads(input) {
      record("listUploads", input);
      return {
        uploads: [
          {
            arn: UPLOAD_ARN,
            name: "Motet-staging.ipa",
            type: "IOS_APP",
            status: "SUCCEEDED",
            created: new Date("2026-09-20T07:41:02Z"),
          },
        ],
      };
    },

    async createUpload(input) {
      record("createUpload", input);
      return {
        upload: {
          arn: UPLOAD_ARN,
          name: input.name,
          type: input.type,
          status: "INITIALIZED",
          created: new Date("2026-09-20T07:41:02Z"),
          url: "https://prod-us-west-2-uploads.s3.amazonaws.com/put?X-Amz-Signature=ghi",
        },
      };
    },

    async getUpload(input) {
      record("getUpload", input);
      const status =
        state.uploadStatuses[Math.min(uploadPoll, state.uploadStatuses.length - 1)]!;
      uploadPoll += 1;
      return {
        upload: {
          arn: UPLOAD_ARN,
          name: "Motet-staging.ipa",
          type: "IOS_APP",
          status,
          ...(state.uploadMessage ? { message: state.uploadMessage } : {}),
        },
      };
    },

    async scheduleRun(input) {
      record("scheduleRun", input);
      return { run: { ...state.run, status: "SCHEDULING", result: "PENDING" } };
    },

    async getRun(input) {
      record("getRun", input);
      return { run: state.run };
    },

    async stopRun(input) {
      record("stopRun", input);
      return { run: { ...state.run, status: "STOPPING", result: "STOPPED" } };
    },

    async listJobs(input) {
      record("listJobs", input);
      return { jobs: state.jobs };
    },

    async listSuites(input) {
      record("listSuites", input);
      return { suites: [] };
    },

    async listTests(input) {
      record("listTests", input);
      return { tests: [] };
    },

    async listArtifacts(input) {
      record("listArtifacts", input);
      return { artifacts: state.artifacts[String(input.type)] ?? [] };
    },

    async createRemoteAccessSession(input) {
      record("createRemoteAccessSession", input);
      const session = {
        arn: SESSION_ARN,
        name: input.name ?? "session",
        status: "PENDING",
        device: IPHONE,
        appUpload: input.appArn,
        created: new Date("2026-09-20T08:00:00Z"),
        deviceMinutes: { total: 0, metered: 0, unmetered: 0 },
      };
      state.sessions = [session, ...state.sessions];
      return { remoteAccessSession: session };
    },

    async getRemoteAccessSession(input) {
      record("getRemoteAccessSession", input);
      const found = state.sessions.find((s) => s.arn === input.arn);
      return { remoteAccessSession: found ?? { arn: input.arn, status: "COMPLETED" } };
    },

    async listRemoteAccessSessions(input) {
      record("listRemoteAccessSessions", input);
      return { remoteAccessSessions: state.sessions };
    },

    async stopRemoteAccessSession(input) {
      record("stopRemoteAccessSession", input);
      const found = state.sessions.find((s) => s.arn === input.arn);
      if (found) found.status = "STOPPING";
      return {
        remoteAccessSession: found ?? { arn: input.arn, status: "STOPPING" },
      };
    },

    async installToRemoteAccessSession(input) {
      record("installToRemoteAccessSession", input);
      return {};
    },
  };
}

/** A session that is RUNNING and has published its Appium endpoint. */
export function runningSession(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    arn: SESSION_ARN,
    name: "motet play button repro",
    status: "RUNNING",
    device: IPHONE,
    created: new Date("2026-09-20T08:00:00Z"),
    started: new Date("2026-09-20T08:01:00Z"),
    deviceMinutes: { total: 4, metered: 4, unmetered: 0 },
    endpoints: { remoteDriverEndpoint: APPIUM_ENDPOINT, interactiveEndpoint: "https://x" },
    ...overrides,
  };
}

export interface FakeHttpCall {
  url: string;
  init?: FetchInit;
}

export interface FakeHttp {
  fetchImpl: FetchLike;
  calls: FakeHttpCall[];
}

export interface FakeRoute {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw bytes for a download; `body` is ignored when this is set. */
  bytes?: Uint8Array;
  /** Serve the bytes as a stream, the way a real `fetch` does. */
  stream?: boolean;
  throws?: Error;
}

/**
 * An HTTP surface driven by a route table.
 *
 * A route key matches the END of the URL first and any part of it second, which
 * is what lets `/session` and `/source` both be routes: every WebDriver command
 * URL contains `/session`, so a plain substring match would answer every one of
 * them with the session-creation response. A URL nothing matches is a 404 — a
 * silent default would let a typo in a test read as a passing request.
 */
export function fakeHttp(routes: Record<string, FakeRoute | (() => FakeRoute)>): FakeHttp {
  const calls: FakeHttpCall[] = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const key = keys.find((k) => url.endsWith(k)) ?? keys.find((k) => url.includes(k));
    const route: FakeRoute = key
      ? typeof routes[key] === "function"
        ? (routes[key] as () => FakeRoute)()
        : (routes[key] as FakeRoute)
      : { status: 404, body: { value: { error: "unknown command", message: url } } };

    if (route.throws) throw route.throws;

    const status = route.status ?? 200;
    const bytes = route.bytes;
    const text = bytes ? "" : JSON.stringify(route.body ?? {});
    const headers = new Map(
      Object.entries(route.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );

    const response: FetchResponse = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      text: async () => text,
      arrayBuffer: async () =>
        (bytes ?? new TextEncoder().encode(text)).slice().buffer as ArrayBuffer,
    };

    if (bytes && route.stream) {
      response.body = new ReadableStream<Uint8Array>({
        start(controller) {
          // Two chunks, so a cap that only checks the first one fails here.
          const half = Math.ceil(bytes.byteLength / 2);
          controller.enqueue(bytes.slice(0, half));
          controller.enqueue(bytes.slice(half));
          controller.close();
        },
      });
    }

    return response;
  };

  return { fetchImpl, calls };
}

/** A believable XCUITest page source: a Play button, a timer, and scaffolding. */
export const SCREEN_XML = (timer: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAXDocument>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Motet" label="Motet" enabled="true" visible="true" x="0" y="0" width="393" height="852">
    <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" x="0" y="0" width="393" height="852">
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="episode-title" label="Tuesday&apos;s briefing" enabled="true" visible="true" x="24" y="120" width="345" height="34"/>
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="play-button" label="Play" enabled="true" visible="true" x="167" y="612" width="60" height="60"/>
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="elapsed" label="${timer}" value="${timer}" enabled="true" visible="true" x="24" y="540" width="60" height="20"/>
      <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="false" x="0" y="900" width="393" height="200">
        <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Offscreen sheet" enabled="true" visible="false" x="24" y="920" width="345" height="20"/>
      </XCUIElementTypeOther>
    </XCUIElementTypeOther>
  </XCUIElementTypeApplication>
</AppiumAXDocument>`;
