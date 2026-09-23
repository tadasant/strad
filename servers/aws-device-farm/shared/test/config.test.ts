import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DEFAULT_MAX_UPLOAD_MB,
  ENV,
  loadConfig,
  MAX_UPLOAD_MB_CEILING,
  missingCredentials,
  readMaxUploadBytes,
  readRegion,
  REGIONS,
} from "../src/config.js";
import { PROJECT_ARN } from "./fakes.js";

const full = {
  [ENV.accessKeyId]: "AKIAIOSFODNN7EXAMPLE",
  [ENV.secretAccessKey]: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  [ENV.projectArn]: PROJECT_ARN,
};

describe("the credential is read under names of its own", () => {
  it("names every missing variable, in declaration order", () => {
    expect(missingCredentials({})).toEqual([
      ENV.accessKeyId,
      ENV.secretAccessKey,
      ENV.projectArn,
    ]);
    expect(missingCredentials({ ...full })).toEqual([]);
  });

  it("counts a whitespace-only value as missing", () => {
    // App Platform and a pasted console value both produce this, and a config
    // that treated "  " as set would sign requests with an empty key and
    // report the failure as an auth error nobody can explain.
    expect(missingCredentials({ ...full, [ENV.accessKeyId]: "   " })).toEqual([
      ENV.accessKeyId,
    ]);
  });

  it("never falls back to the AWS default credential chain", () => {
    // The bundle is one process for twenty-four servers. An AWS variable that
    // arrived for some other reason must not become the identity that spends
    // device minutes, so the generic names are simply not read.
    expect(() =>
      loadConfig({
        AWS_ACCESS_KEY_ID: "AKIAsomebodyelse",
        AWS_SECRET_ACCESS_KEY: "somebodyelse",
        [ENV.projectArn]: PROJECT_ARN,
      }),
    ).toThrow(ConfigError);
  });

  it("tells a caller how to get the credential", () => {
    expect(() => loadConfig({})).toThrow(/ui\/secrets/);
    expect(() => loadConfig({})).toThrow(/an agent never holds the value/);
  });

  it("refuses a project ARN that is not one", () => {
    expect(() => loadConfig({ ...full, [ENV.projectArn]: "motet-testing" })).toThrow(
      /not a Device Farm ARN/,
    );
    expect(() =>
      loadConfig({
        ...full,
        [ENV.projectArn]:
          "https://us-west-2.console.aws.amazon.com/devicefarm/home#/projects/abc",
      }),
    ).toThrow(/not the console URL/);
  });

  it("trims what it loads", () => {
    const config = loadConfig({
      [ENV.accessKeyId]: " AKIAIOSFODNN7EXAMPLE ",
      [ENV.secretAccessKey]: " secret ",
      [ENV.projectArn]: ` ${PROJECT_ARN} `,
    });
    expect(config.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(config.projectArn).toBe(PROJECT_ARN);
  });
});

describe("the region is a closed set of one", () => {
  it("defaults to us-west-2", () => {
    expect(readRegion({})).toBe("us-west-2");
    expect(readRegion({ [ENV.region]: "" })).toBe("us-west-2");
    expect(REGIONS).toEqual(["us-west-2"]);
  });

  it("refuses a region Device Farm is not served from, and says why", () => {
    // us-east-1 is the reflex, and it is a hostname that does not answer.
    expect(() => readRegion({ [ENV.region]: "us-east-1" })).toThrow(
      /device cloud lives in us-west-2 only/,
    );
    // Quoted back, because a trailing space is otherwise undiagnosable.
    expect(() => readRegion({ [ENV.region]: "us-west-2 " })).not.toThrow();
    expect(() => readRegion({ [ENV.region]: "US-WEST-2" })).toThrow(/"US-WEST-2"/);
  });

  it("reports a bad region before a missing credential", () => {
    // The one a human can fix without minting anything comes first.
    expect(() => loadConfig({ [ENV.region]: "eu-west-1" })).toThrow(/not a region/);
  });
});

describe("the upload ceiling is a memory bound", () => {
  it("defaults to the documented number of megabytes", () => {
    expect(readMaxUploadBytes({})).toBe(DEFAULT_MAX_UPLOAD_MB * 1024 * 1024);
  });

  it("takes a whole number of megabytes up to the ceiling", () => {
    expect(readMaxUploadBytes({ [ENV.maxUploadMb]: "512" })).toBe(512 * 1024 * 1024);
    expect(() => readMaxUploadBytes({ [ENV.maxUploadMb]: "0" })).toThrow(ConfigError);
    expect(() => readMaxUploadBytes({ [ENV.maxUploadMb]: "1.5" })).toThrow(ConfigError);
    expect(() =>
      readMaxUploadBytes({ [ENV.maxUploadMb]: String(MAX_UPLOAD_MB_CEILING + 1) }),
    ).toThrow(ConfigError);
  });
});
