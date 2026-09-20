import { describe, expect, it } from "vitest";

import { InputError, SourceFetchError, UploadFailedError } from "../src/errors.js";
import { createGateway } from "../src/gateway.js";
import { expectedExtension, uploadApp } from "../src/uploads.js";
import { PROJECT_ARN, UPLOAD_ARN, fakeDeviceFarm, fakeHttp } from "./fakes.js";

const BUILD = new Uint8Array(1024).fill(7);
const noSleep = async (): Promise<void> => undefined;

function harness(routes: Parameters<typeof fakeHttp>[0], state = {}) {
  const api = fakeDeviceFarm(state);
  const http = fakeHttp(routes);
  return {
    api,
    http,
    run: (overrides: Record<string, unknown> = {}) =>
      uploadApp({
        gateway: createGateway({ api, projectArn: PROJECT_ARN }),
        fetchImpl: http.fetchImpl,
        sourceUrl: "https://builds.example.com/Motet-staging.ipa",
        name: "Motet-staging.ipa",
        type: "IOS_APP",
        maxBytes: 10 * 1024,
        timeoutMs: 60_000,
        sleep: noSleep,
        pollMs: 0,
        ...overrides,
      }),
  };
}

const okRoutes = {
  "builds.example.com": { bytes: BUILD, headers: { "content-length": "1024" } },
  "s3.amazonaws.com/put": { status: 200 },
};

describe("a build reaches Device Farm", () => {
  it("downloads, creates the upload, PUTs the bytes and waits for SUCCEEDED", async () => {
    const h = harness(okRoutes, { uploadStatuses: ["INITIALIZED", "PROCESSING", "SUCCEEDED"] });
    const result = await h.run();

    expect(result).toMatchObject({
      arn: UPLOAD_ARN,
      status: "SUCCEEDED",
      bytes: 1024,
      ready: true,
    });
    // The bytes are fetched BEFORE the upload is created, so a bad source URL
    // leaves no dead INITIALIZED entry in the project's upload list.
    expect(h.http.calls[0]!.url).toContain("builds.example.com");
    expect(h.api.calls[0]!.method).toBe("createUpload");
    const put = h.http.calls[1]!;
    expect(put.init?.method).toBe("PUT");
    expect(put.init?.body).toStrictEqual(BUILD);
    // The content type has to match what CreateUpload was told, because that is
    // what S3 signed the URL with.
    expect(put.init?.headers?.["content-type"]).toBe("application/octet-stream");
    expect(h.api.calls[0]!.input.contentType).toBe("application/octet-stream");
  });

  it("reports Device Farm's own message when the build is rejected", async () => {
    // The simulator .ipa: CreateUpload succeeded, the PUT succeeded, and the
    // build fails a check minutes later.
    const h = harness(okRoutes, {
      uploadStatuses: ["PROCESSING", "FAILED"],
      uploadMessage: "IOS_APP_WRONG_PLATFORM_DEVICE_VALUE",
    });
    await expect(h.run()).rejects.toThrow(UploadFailedError);
    await expect(h.run()).rejects.toThrow(/IOS_APP_WRONG_PLATFORM_DEVICE_VALUE/);
    await expect(h.run()).rejects.toThrow(/SIMULATOR build/);
  });

  it("returns the ARN rather than failing when the wait runs out", async () => {
    // The upload is real and still processing. Failing here would lose an ARN
    // whose bytes are already uploaded.
    const h = harness(okRoutes, { uploadStatuses: ["PROCESSING"] });
    const result = await h.run({ timeoutMs: -1 });
    expect(result.ready).toBe(false);
    expect(result.arn).toBe(UPLOAD_ARN);
  });
});

describe("what is refused before anything is spent", () => {
  it("refuses a plain-HTTP source rather than downgrading to it", async () => {
    const h = harness(okRoutes);
    await expect(h.run({ sourceUrl: "http://builds.example.com/x.ipa" })).rejects.toThrow(
      InputError,
    );
    expect(h.http.calls).toHaveLength(0);
  });

  it("enforces the extension Device Farm demands, per type", () => {
    expect(expectedExtension("IOS_APP")).toBe(".ipa");
    expect(expectedExtension("ANDROID_APP")).toBe(".apk");
    expect(expectedExtension("APPIUM_NODE_TEST_PACKAGE")).toBe(".zip");
  });

  it("refuses a name whose extension is wrong for its type", async () => {
    const h = harness(okRoutes);
    await expect(h.run({ name: "Motet-staging.zip" })).rejects.toThrow(/\*\.ipa/);
    await expect(
      h.run({ name: "tests.ipa", type: "APPIUM_NODE_TEST_PACKAGE" }),
    ).rejects.toThrow(/\*\.zip/);
  });

  it("refuses a name with a path in it", async () => {
    await expect(harness(okRoutes).run({ name: "builds/Motet.ipa" })).rejects.toThrow(
      /forward slash/,
    );
  });

  it("refuses an oversized build on its declared length, before downloading it", async () => {
    const h = harness({
      ...okRoutes,
      "builds.example.com": {
        bytes: BUILD,
        headers: { "content-length": String(50 * 1024) },
      },
    });
    await expect(h.run()).rejects.toThrow(/over this server's 0 MB ceiling|ceiling/);
    // One call: the download was refused on its headers, and nothing was created.
    expect(h.api.calls).toHaveLength(0);
  });

  it("abandons an oversized stream that declared no length", async () => {
    // The case the ceiling exists for: a source that does not say how big it
    // is, on a 2 GB box shared with a Chromium.
    const big = new Uint8Array(40 * 1024).fill(1);
    const h = harness({
      ...okRoutes,
      "builds.example.com": { bytes: big, stream: true },
    });
    await expect(h.run()).rejects.toThrow(/abandoned/);
    expect(h.api.calls).toHaveLength(0);
  });

  it("accepts a stream inside the ceiling, in however many chunks", async () => {
    const h = harness({
      ...okRoutes,
      "builds.example.com": { bytes: BUILD, stream: true },
    });
    const result = await h.run();
    expect(result.bytes).toBe(1024);
  });

  it("says what a 403 on a pre-signed source link means", async () => {
    const h = harness({ ...okRoutes, "builds.example.com": { status: 403 } });
    await expect(h.run()).rejects.toThrow(SourceFetchError);
    await expect(h.run()).rejects.toThrow(/expired/);
  });

  it("reports a rejected PUT as a failure rather than a finished upload", async () => {
    const h = harness({ ...okRoutes, "s3.amazonaws.com/put": { status: 403 } });
    await expect(h.run()).rejects.toThrow(/rejected the build with HTTP 403/);
  });
});
