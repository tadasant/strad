/**
 * The pieces every tool file needs: the tool shape, the JSON envelope, argument
 * coercion, and the one error path they all share.
 */

import {
  AuthError,
  DriverError,
  InputError,
  LimitError,
  RateLimitError,
  SessionNotReadyError,
  SourceFetchError,
  UploadFailedError,
} from "../errors.js";
import type { DeviceFarmGateway } from "../gateway.js";
import type { DriverPool } from "../drivers.js";
import type { FetchLike } from "../http.js";
import { redact } from "../logging.js";

export interface ToolResult {
  /** The SDK's `ServerResult` is open-ended; the index signature is what makes
   * this assignable to it without a cast at the registration site. */
  [key: string]: unknown;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: Record<string, boolean>;
  handler: (args: unknown) => Promise<ToolResult>;
}

/** Everything a tool needs, built on the first call rather than at boot. */
export interface Deps {
  gateway: DeviceFarmGateway;
  pool: DriverPool;
  maxUploadBytes: number;
  /** Used to download a build and to PUT it; injected so the suite needs no network. */
  fetchImpl: FetchLike;
}

/**
 * Built on the first tool call, not at import time.
 *
 * This server shares a process with twenty-two others. Reading a credential at
 * import time would make one missing variable a boot failure for all of them.
 */
export type DepsFactory = () => Promise<Deps>;

/**
 * The longest description a client will actually show an agent.
 *
 * NOT AN MCP LIMIT — the protocol puts no ceiling on `description` at all. It is
 * where Claude Code cuts one, and it reports the cut in its own connection log
 * rather than to the server, so the tail of a longer description is text no
 * agent on that client ever reads. `HACKS.md` #82 has the incident;
 * `test/tools.test.ts` asserts this over every tool here.
 */
export const DESCRIPTION_BUDGET = 2048;

/** The `session_arn` parameter copy. Every driving tool takes one. */
export const SESSION_ARN_DESCRIPTION =
  "Which device session to drive, from start_device_session or " +
  "list_device_sessions. Optional: when exactly one session is RUNNING it is " +
  "used automatically, and when two are, this is required rather than guessed.";

/** The coordinate warning. Repeated wherever a tool takes an x/y. */
export const COORDINATE_NOTE =
  "Coordinates are the POINTS read_screen reports, not screenshot pixels — a " +
  "screenshot of the same phone is 2-3x larger in each direction, so a " +
  "coordinate taken off the image lands near the top-left of what you aimed at.";

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function fail(err: unknown): ToolResult {
  // REDACTED, because some of what reaches here was written by AWS or by the
  // device rather than by this server, and an error that echoed the Appium
  // endpoint back at a caller would hand over control of the phone.
  const message = redact(err instanceof Error ? err.message : String(err));
  return { content: [{ type: "text", text: message }], isError: true };
}

function failWithDetail(err: Error, detail: Record<string, unknown>): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: redact(
          JSON.stringify({ error: err.name, message: err.message, ...detail }, null, 2),
        ),
      },
    ],
    isError: true,
  };
}

/**
 * The one error path every tool shares, and the reason it is not a bare
 * `catch`: the interesting failures here are classified, and each has a
 * different next move.
 *
 *   - config          nobody can fix this from the agent side; name the variable.
 *   - input           the caller passed something wrong; the message says what.
 *   - not ready       a phone is still being allocated. WAIT, then call again.
 *   - driver          the app, the screen or the locator. `code` says which.
 *   - upload failed   Device Farm rejected the build. Usually a simulator .ipa.
 *   - limit           something is already running and billing. Stop it.
 *   - rate limit      ten burst, one a second. Poll slower.
 *   - auth            a key or an IAM policy. A human, not a retry.
 */
export async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SessionNotReadyError) {
      return failWithDetail(err, {
        session_arn: err.sessionArn,
        session_status: err.status,
        retryable: !["COMPLETED", "STOPPING"].includes(err.status),
      });
    }
    if (err instanceof DriverError) {
      return failWithDetail(err, {
        webdriver_error: err.code,
        ...(err.sessionArn ? { session_arn: err.sessionArn } : {}),
        // `no such element` is the ordinary case and it is not a failure of the
        // session: the screen has not rendered yet, or the locator is wrong.
        // Saying so is what stops an agent from tearing down a phone it is
        // paying for and starting another one.
        retryable: err.code === "no such element" || err.code === "stale element reference",
      });
    }
    if (err instanceof UploadFailedError) {
      return failWithDetail(err, {
        upload_arn: err.uploadArn,
        upload_status: err.status,
        ...(err.detail ? { device_farm_message: err.detail } : {}),
        retryable: false,
      });
    }
    if (err instanceof LimitError) {
      return failWithDetail(err, { retryable: false, next: "list_device_sessions" });
    }
    if (err instanceof RateLimitError) {
      return failWithDetail(err, { retryable: true });
    }
    if (err instanceof AuthError) {
      return failWithDetail(err, { retryable: false, needs_human: true });
    }
    if (err instanceof SourceFetchError) {
      return failWithDetail(err, {
        ...(err.status === undefined ? {} : { source_status: err.status }),
        retryable: false,
      });
    }
    // Everything else — ConfigError, InputError, DeviceFarmApiError and
    // anything unforeseen — is one redacted sentence. Each already carries a
    // message written for the caller; what separates the classes above is that
    // their recovery needs STRUCTURE rather than prose.
    return fail(err);
  }
}

/** Arguments arrive as `unknown` from the SDK. */
export function args(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export function requiredString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(`\`${key}\` is required and must be a non-empty string.`);
  }
  return value.trim();
}

export function optionalString(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new InputError(`\`${key}\` must be a string.`);
  return value.trim() === "" ? undefined : value.trim();
}

export function enumString<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(raw, key);
  if (value === undefined) return undefined;
  const upper = value.toUpperCase() as T;
  if (!allowed.includes(upper)) {
    throw new InputError(
      `\`${key}\`="${value}" is not one of: ${allowed.join(", ")}.`,
    );
  }
  return upper;
}

export function optionalBool(
  raw: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new InputError(`\`${key}\` must be true or false.`);
  return value;
}

export function boundedInt(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
  min = 1,
): number {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < min) {
    throw new InputError(
      `\`${key}\` must be a whole number between ${min} and ${max}.`,
    );
  }
  // Clamped rather than refused: an agent that asks for 500 wants "as many as
  // you can", and failing the call teaches it nothing the result would not.
  return Math.min(parsed, max);
}

export function requiredNumber(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new InputError(`\`${key}\` is required and must be a number.`);
  }
  return parsed;
}

export function requiredArn(raw: Record<string, unknown>, key: string): string {
  const value = requiredString(raw, key);
  if (!value.startsWith("arn:aws:devicefarm:")) {
    throw new InputError(
      `\`${key}\`="${value}" is not a Device Farm ARN. Every ARN this server ` +
        `takes starts with "arn:aws:devicefarm:" and comes from another tool's ` +
        `result — a name or a console URL is not one.`,
    );
  }
  return value;
}
