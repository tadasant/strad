/**
 * The SDK seam: what this server asks AWS for, and what it makes of a failure.
 *
 * The `send` function is injected, so these assertions are against the REAL SDK
 * command classes — a renamed input field fails here rather than in production.
 */

import { describe, expect, it } from "vitest";

import {
  CreateRemoteAccessSessionCommand,
  GetAccountSettingsCommand,
  ListDevicesCommand,
  ScheduleRunCommand,
  StopRemoteAccessSessionCommand,
} from "@aws-sdk/client-device-farm";

import { classify, createApi, type DeviceFarmSend } from "../src/client.js";
import {
  AuthError,
  DeviceFarmApiError,
  LimitError,
  NotFoundError,
  RateLimitError,
} from "../src/errors.js";
import { DEVICE_ARN, PROJECT_ARN } from "./fakes.js";

function recorder(): { send: DeviceFarmSend; sent: unknown[] } {
  const sent: unknown[] = [];
  const send: DeviceFarmSend = async (command) => {
    sent.push(command);
    return {};
  };
  return { send, sent };
}

describe("the api builds real SDK commands", () => {
  it("sends the command class each method is named for", async () => {
    const { send, sent } = recorder();
    const api = createApi(send);

    await api.getAccountSettings();
    await api.listDevices({ arn: PROJECT_ARN, filters: [] });
    await api.createRemoteAccessSession({ projectArn: PROJECT_ARN, deviceArn: DEVICE_ARN });
    await api.stopRemoteAccessSession({ arn: "arn:aws:devicefarm:x" });
    await api.scheduleRun({ projectArn: PROJECT_ARN, test: { type: "BUILTIN_FUZZ" } });

    expect(sent[0]).toBeInstanceOf(GetAccountSettingsCommand);
    expect(sent[1]).toBeInstanceOf(ListDevicesCommand);
    expect(sent[2]).toBeInstanceOf(CreateRemoteAccessSessionCommand);
    expect(sent[3]).toBeInstanceOf(StopRemoteAccessSessionCommand);
    expect(sent[4]).toBeInstanceOf(ScheduleRunCommand);
  });

  it("passes the input through to the command unchanged", async () => {
    const { send, sent } = recorder();
    await createApi(send).listDevices({
      arn: PROJECT_ARN,
      filters: [{ attribute: "PLATFORM", operator: "EQUALS", values: ["IOS"] }],
    });
    expect((sent[0] as ListDevicesCommand).input).toEqual({
      arn: PROJECT_ARN,
      filters: [{ attribute: "PLATFORM", operator: "EQUALS", values: ["IOS"] }],
    });
  });

  it("offers no command that creates a project, deletes anything, or buys a slot", () => {
    // The length of this interface IS the least-privilege IAM policy in the
    // setup guide. A method added here without a line added there is a tool
    // that 403s on every deployment that followed the guide.
    const api = createApi(recorder().send) as unknown as Record<string, unknown>;
    const names = Object.keys(api);
    expect(names.filter((n) => /^delete/i.test(n))).toEqual([]);
    expect(names.filter((n) => /^(create|update)Project$/i.test(n))).toEqual([]);
    expect(names.filter((n) => /purchase|renew|slot/i.test(n))).toEqual([]);
    expect(names).toHaveLength(18);
  });
});

describe("a failure is classified by its recovery", () => {
  const aws = (name: string, message = "boom", status = 400): Error => {
    const err = new Error(message);
    err.name = name;
    (err as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: status };
    return err;
  };

  it("treats a rejected key and a denied action alike, and says which fix", () => {
    const denied = classify(
      aws("AccessDeniedException", "not authorized to perform: devicefarm:StopRun", 403),
    );
    expect(denied).toBeInstanceOf(AuthError);
    // The refused ACTION is the whole diagnosis for a least-privilege policy.
    expect(denied.message).toContain("devicefarm:StopRun");
    expect(denied.message).toContain("IAM policy");
    expect(classify(aws("UnrecognizedClientException"))).toBeInstanceOf(AuthError);
    expect(classify(aws("ServiceAccountException"))).toBeInstanceOf(AuthError);
  });

  it("points a limit failure at the session somebody forgot", () => {
    const limit = classify(aws("LimitExceededException"));
    expect(limit).toBeInstanceOf(LimitError);
    expect(limit.message).toContain("list_device_sessions");
  });

  it("tells a throttled caller to poll slower", () => {
    const throttled = classify(aws("TooManyRequestsException", "slow down", 429));
    expect(throttled).toBeInstanceOf(RateLimitError);
    expect(throttled.message).toMatch(/20-30 seconds/);
  });

  it("keeps AWS's own exception name on everything else", () => {
    expect(classify(aws("NotFoundException"))).toBeInstanceOf(NotFoundError);
    const other = classify(aws("ArgumentException", "bad arn"));
    expect(other).toBeInstanceOf(DeviceFarmApiError);
    expect((other as DeviceFarmApiError).awsErrorName).toBe("ArgumentException");
    expect((other as DeviceFarmApiError).status).toBe(400);
  });

  it("survives a throw that is not an Error", () => {
    expect(classify("kaboom").message).toBe("kaboom");
  });
});
