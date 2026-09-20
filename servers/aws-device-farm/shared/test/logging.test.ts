import { describe, expect, it } from "vitest";

import { redact } from "../src/logging.js";
import { APPIUM_ENDPOINT, DEVICE_ARN, PROJECT_ARN, RUN_ARN } from "./fakes.js";

describe("two secrets, and the second one does not look like one", () => {
  it("scrubs the Appium endpoint whole, host and all", () => {
    // The URL IS the credential: it authorises by the opaque segment in its
    // path, with no signature and no header. Leaving the hostname behind would
    // say which service was in play and not what was scrubbed.
    const scrubbed = redact(`could not reach ${APPIUM_ENDPOINT}/status`);
    expect(scrubbed).not.toContain("remote-endpoint");
    expect(scrubbed).not.toContain("ABCD1234EFGH5678");
    expect(scrubbed).not.toContain("devicefarm-interactive-global");
    expect(scrubbed).toContain("[redacted]");
  });

  it("scrubs an AWS secret access key, which is exactly 40 characters", () => {
    const key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(key).toHaveLength(40);
    expect(redact(`signature failed for ${key}`)).not.toContain(key);
  });

  it("leaves every identifier a result depends on readable", () => {
    // An ARN is long, and redacting one makes every error this server returns
    // useless: the ARN is what a caller passes to the next tool.
    for (const arn of [PROJECT_ARN, RUN_ARN, DEVICE_ARN]) {
      expect(redact(`no such thing: ${arn}`)).toContain(arn);
    }
    expect(redact("upload IOS_APP_WRONG_PLATFORM_DEVICE_VALUE failed")).toContain(
      "IOS_APP_WRONG_PLATFORM_DEVICE_VALUE",
    );
    expect(redact("the device is HIGHLY_AVAILABLE")).toContain("HIGHLY_AVAILABLE");
  });

  it("is safe to run over text it has already scrubbed", () => {
    const once = redact(APPIUM_ENDPOINT);
    expect(redact(once)).toBe(once);
  });
});
