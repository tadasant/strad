import { describe, expect, it } from "vitest";

import {
  ConfigError,
  ENV,
  loadConfig,
  missingCredentials,
} from "../src/config.js";
import { parseToolGroups } from "../src/tools.js";

describe("config", () => {
  it("names the missing key", () => {
    expect(missingCredentials({})).toEqual([ENV.apiKey]);
    expect(missingCredentials({ [ENV.apiKey]: "  " })).toEqual([ENV.apiKey]);
    expect(missingCredentials({ [ENV.apiKey]: "k".repeat(32) })).toEqual([]);
  });

  it("refuses to load without a key, and says how to get one", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/aeroapi\/portal/);
  });

  it("trims the key and the base URL", () => {
    const config = loadConfig(
      { [ENV.apiKey]: " abc12345 " },
      "https://x/aeroapi/",
    );
    expect(config).toEqual({
      apiKey: "abc12345",
      baseUrl: "https://x/aeroapi",
    });
  });
});

describe("parseToolGroups", () => {
  it("serves everything when unset", () => {
    expect(parseToolGroups(undefined)).toEqual(["readonly", "readwrite"]);
  });
  it("fails closed to readonly on an unrecognised value", () => {
    expect(parseToolGroups("read-only")).toEqual(["readonly"]);
  });
  it("accepts a known value", () => {
    expect(parseToolGroups(" READONLY ")).toEqual(["readonly"]);
  });
});
