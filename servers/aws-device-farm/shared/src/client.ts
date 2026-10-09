/**
 * The one place the AWS SDK is touched, and the one place its failures are
 * classified.
 *
 * THE SEAM IS `send`. Everything above this module talks to a `DeviceFarmApi`
 * of plain async methods; this module is what turns those into SDK command
 * objects and hands them to a `send` function. Production builds that function
 * from a `DeviceFarmClient`; a test passes its own and gets the command objects
 * the real SDK constructed — so the suite checks the INPUTS this server builds,
 * against the real command classes, without a network or an AWS account. A
 * hand-rolled fake of the whole SDK would check neither.
 *
 * CREDENTIALS ARE PASSED, NEVER DISCOVERED. `new DeviceFarmClient` is given an
 * explicit `credentials` object, which takes the default provider chain out of
 * the picture entirely: this process holds twenty-four other servers' variables
 * and a Google service-account key, and an `AWS_ACCESS_KEY_ID` that arrived for
 * some other reason must not become the identity that spends device minutes.
 */

import {
  CreateRemoteAccessSessionCommand,
  CreateUploadCommand,
  DeviceFarmClient,
  GetAccountSettingsCommand,
  GetRemoteAccessSessionCommand,
  GetRunCommand,
  GetUploadCommand,
  InstallToRemoteAccessSessionCommand,
  ListArtifactsCommand,
  ListDevicePoolsCommand,
  ListDevicesCommand,
  ListJobsCommand,
  ListRemoteAccessSessionsCommand,
  ListUploadsCommand,
  ScheduleRunCommand,
  StopRemoteAccessSessionCommand,
  StopRunCommand,
} from "@aws-sdk/client-device-farm";

import type { DeviceFarmConfig } from "./config.js";
import {
  AuthError,
  DeviceFarmApiError,
  LimitError,
  NotFoundError,
  RateLimitError,
} from "./errors.js";

/**
 * What a command sender looks like. Deliberately `unknown` in and `any` out:
 * the SDK's own `send` is overloaded per command and reproducing that typing
 * here would buy nothing — the methods below are where the types are.
 */
export type DeviceFarmSend = (command: unknown) => Promise<any>;

export interface CreateSendOptions {
  config: DeviceFarmConfig;
  /**
   * Retries the SDK makes before this module sees a failure. The default is the
   * SDK's own standard mode; Device Farm's List/Get bucket refills at ten a
   * second and everything else at one, so a burst is normal and worth riding
   * out inside the call rather than bouncing off it.
   */
  maxAttempts?: number;
}

export function createSend(options: CreateSendOptions): DeviceFarmSend {
  const client = new DeviceFarmClient({
    region: options.config.region,
    maxAttempts: options.maxAttempts ?? 4,
    credentials: {
      accessKeyId: options.config.accessKeyId,
      secretAccessKey: options.config.secretAccessKey,
    },
  });
  return (command) => client.send(command as never);
}

/** AWS exception names whose recovery is a human editing IAM or minting a key. */
const AUTH_NAMES = new Set([
  "AccessDeniedException",
  "UnrecognizedClientException",
  "InvalidClientTokenId",
  "InvalidSignatureException",
  "SignatureDoesNotMatch",
  "ExpiredTokenException",
  "ServiceAccountException",
]);

const RATE_NAMES = new Set([
  "TooManyRequestsException",
  "ThrottlingException",
  "RequestThrottledException",
]);

/**
 * One SDK failure, classified.
 *
 * `ServiceAccountException` is grouped with the auth failures on purpose: Device
 * Farm raises it for an account that cannot run the request at all — a suspended
 * account, or one whose free trial is spent with no payment method — and no
 * retry and no different argument fixes either.
 */
export function classify(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const awsName = err.name || "UnknownError";
  const status: number | undefined = (err as { $metadata?: { httpStatusCode?: number } })
    .$metadata?.httpStatusCode;
  const message = err.message || awsName;

  if (AUTH_NAMES.has(awsName)) {
    return new AuthError(
      `${message} (${awsName}). Either the access key is wrong or its IAM ` +
        `policy is short the action this call needs — an ` +
        `AccessDeniedException names the action it refused, and that name is ` +
        `the whole fix. Nobody can resolve this from the agent side.`,
      awsName,
      status,
    );
  }
  if (RATE_NAMES.has(awsName)) {
    return new RateLimitError(
      `${message} (${awsName}). Device Farm throttles at ten burst / one per ` +
        `second for everything that is not a List or a Get. Wait a few seconds ` +
        `and try again, and poll a run every 20-30 seconds rather than tightly.`,
      awsName,
      status,
    );
  }
  if (awsName === "NotFoundException") {
    return new NotFoundError(
      `${message} (NotFoundException). The ARN does not exist in this project, ` +
        `in this region, or for this account.`,
      awsName,
      status,
    );
  }
  if (awsName === "LimitExceededException") {
    return new LimitError(
      `${message} (LimitExceededException). The usual cause is a device ` +
        `session nobody stopped — remote-access concurrency defaults to two ` +
        `metered devices, and an abandoned session keeps billing. Call ` +
        `list_device_sessions and stop what is running.`,
      awsName,
      status,
    );
  }
  return new DeviceFarmApiError(message, awsName, status);
}

async function call<T>(send: DeviceFarmSend, command: unknown): Promise<T> {
  try {
    return (await send(command)) as T;
  } catch (err) {
    throw classify(err);
  }
}

/**
 * Every Device Farm action this server can take — and nothing else.
 *
 * THE LENGTH OF THIS INTERFACE IS THE IAM POLICY. The setup guide's
 * least-privilege policy is derived from exactly these commands, so an action
 * added here without a line added there is a tool that 403s on a deployment
 * that followed the guide. Nothing that creates a project, deletes anything, or
 * buys an unmetered slot appears here: a `$250/month` offer is one API call
 * away and no agent is going to make it.
 */
export interface DeviceFarmApi {
  getAccountSettings(): Promise<any>;
  listDevices(input: Record<string, unknown>): Promise<any>;
  listDevicePools(input: Record<string, unknown>): Promise<any>;
  listUploads(input: Record<string, unknown>): Promise<any>;
  createUpload(input: Record<string, unknown>): Promise<any>;
  getUpload(input: Record<string, unknown>): Promise<any>;
  scheduleRun(input: Record<string, unknown>): Promise<any>;
  getRun(input: Record<string, unknown>): Promise<any>;
  stopRun(input: Record<string, unknown>): Promise<any>;
  listJobs(input: Record<string, unknown>): Promise<any>;
  listArtifacts(input: Record<string, unknown>): Promise<any>;
  createRemoteAccessSession(input: Record<string, unknown>): Promise<any>;
  getRemoteAccessSession(input: Record<string, unknown>): Promise<any>;
  listRemoteAccessSessions(input: Record<string, unknown>): Promise<any>;
  stopRemoteAccessSession(input: Record<string, unknown>): Promise<any>;
  installToRemoteAccessSession(input: Record<string, unknown>): Promise<any>;
}

export function createApi(send: DeviceFarmSend): DeviceFarmApi {
  return {
    getAccountSettings: () => call(send, new GetAccountSettingsCommand({})),
    listDevices: (i) => call(send, new ListDevicesCommand(i as never)),
    listDevicePools: (i) => call(send, new ListDevicePoolsCommand(i as never)),
    listUploads: (i) => call(send, new ListUploadsCommand(i as never)),
    createUpload: (i) => call(send, new CreateUploadCommand(i as never)),
    getUpload: (i) => call(send, new GetUploadCommand(i as never)),
    scheduleRun: (i) => call(send, new ScheduleRunCommand(i as never)),
    getRun: (i) => call(send, new GetRunCommand(i as never)),
    stopRun: (i) => call(send, new StopRunCommand(i as never)),
    listJobs: (i) => call(send, new ListJobsCommand(i as never)),
    listArtifacts: (i) => call(send, new ListArtifactsCommand(i as never)),
    createRemoteAccessSession: (i) =>
      call(send, new CreateRemoteAccessSessionCommand(i as never)),
    getRemoteAccessSession: (i) =>
      call(send, new GetRemoteAccessSessionCommand(i as never)),
    listRemoteAccessSessions: (i) =>
      call(send, new ListRemoteAccessSessionsCommand(i as never)),
    stopRemoteAccessSession: (i) =>
      call(send, new StopRemoteAccessSessionCommand(i as never)),
    installToRemoteAccessSession: (i) =>
      call(send, new InstallToRemoteAccessSessionCommand(i as never)),
  };
}
