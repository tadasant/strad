/**
 * The pieces every tool file needs: the tool shape, the JSON envelope, argument
 * coercion, and the one error path they all share.
 */

import {
  InputError,
  LockedTransactionError,
  RateLimitError,
  WriteNotPersistedError,
} from "../errors.js";
import type { BillGateway } from "../gateway.js";
import { redact } from "../logging.js";

export interface ToolResult {
  /** The SDK's `ServerResult` is open-ended; the index signature is what makes
   * this assignable to it without a cast at the registration site. */
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
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

/**
 * Built on the first tool call, not at boot.
 *
 * This server shares a process with twenty-one others. Reading a credential at
 * import time would make one missing variable a boot failure for all of them.
 */
export type GatewayFactory = () => Promise<BillGateway>;

/** The `field` parameter copy. Every tool that takes one uses this text. */
export const FIELD_DESCRIPTION =
  "Which custom field, as the `id` or `uuid` from list_coding_fields (or from " +
  "get_transaction_coding, which returns both forms). BILL has no native " +
  "chart-of-accounts field: GL coding is carried on a CUSTOM FIELD whose values " +
  "are the accounts, so this is the field whose values look like " +
  '"Internet/Phone".';

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function fail(err: unknown): ToolResult {
  // REDACTED, because most of what reaches here was written by BILL rather than
  // by this server, and an error that echoed the apiToken back at a caller would
  // hand over the ability to issue a virtual card.
  const message = redact(err instanceof Error ? err.message : String(err));
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * A failure with its structure intact, for the two errors whose DETAIL is the
 * whole point.
 *
 * A `WriteNotPersistedError` is a table — one row per body shape tried, with
 * what BILL answered and what the transaction looked like afterwards — and
 * flattening it into a sentence would throw away the only evidence anyone has
 * about which shape BILL actually honours.
 */
function failWithDetail(err: Error, detail: Record<string, unknown>): ToolResult {
  // The WHOLE document goes through `redact`, not just the message. `detail`
  // carries the attempt table, and an attempt's `observedAfter` / `observedNote`
  // are strings BILL authored — the same provenance the message has, and the
  // same reason to scrub them.
  return {
    content: [
      {
        type: "text",
        text: redact(
          JSON.stringify(
            { error: err.name, message: err.message, ...detail },
            null,
            2,
          ),
        ),
      },
    ],
    isError: true,
  };
}

/**
 * The one error path every tool shares, and the reason it is not a bare `catch`:
 * the interesting failures here are classified, and each has a different next
 * move.
 *
 *   - config          nobody can fix this from the agent side; name the variable.
 *   - input           the caller passed something wrong; the message says what.
 *   - locked          a human unlocks it in the web app. No retry helps.
 *   - not persisted   BILL said SUCCESS and nothing changed. Treat as UNWRITTEN.
 *   - rate limit      60/minute, spent. Wait, then slow down.
 *   - anything else   BILL's own code and message, which its docs are indexed by.
 */
export async function guard(
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof WriteNotPersistedError) {
      return failWithDetail(err, {
        transaction_id: err.transactionId,
        persisted: false,
        // STRUCTURE, not just the sentence. `changed: true` on a FAILURE reads
        // like a contradiction and is the most important thing in the result:
        // this write applied none of what it sent, and the transaction moved
        // anyway — so somebody else is editing it.
        ...(err.drift === undefined
          ? { changed: false }
          : { changed: true, before: err.drift.before, after: err.drift.after }),
        attempts: err.attempts,
      });
    }
    if (err instanceof LockedTransactionError) {
      return failWithDetail(err, {
        transaction_id: err.transactionId,
        is_locked: true,
        persisted: false,
        retryable: false,
      });
    }
    if (err instanceof RateLimitError) {
      return failWithDetail(err, {
        retryable: true,
        ...(err.retryAfterSeconds === undefined
          ? {}
          : { retry_after_seconds: err.retryAfterSeconds }),
      });
    }
    // Everything else — ConfigError, InputError, BillApiError and anything
    // unforeseen — is one redacted sentence. Each already carries a message
    // written for the caller; what separates them is the recovery, and the
    // classes above are the ones whose recovery needs STRUCTURE rather than
    // prose.
    return fail(err);
  }
}

/** Arguments arrive as `unknown` from the SDK. */
export function args(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export function requiredString(
  raw: Record<string, unknown>,
  key: string,
): string {
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
  if (typeof value !== "string") {
    throw new InputError(`\`${key}\` must be a string.`);
  }
  return value.trim() === "" ? undefined : value.trim();
}

export function boundedInt(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    throw new InputError(
      `\`${key}\` must be a whole number between 1 and ${max}.`,
    );
  }
  // Clamped rather than refused: an agent that asks for 500 wants "as many as
  // you can", and failing the call teaches it nothing the result would not.
  return Math.min(parsed, max);
}

export function optionalBool(
  raw: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new InputError(`\`${key}\` must be true or false.`);
  }
  return value;
}

/**
 * An ISO-8601 instant, refused here rather than at BILL.
 *
 * BILL answers a malformed datetime filter with a generic 400 that does not name
 * the parameter, and the failure a caller most wants caught is the one that does
 * NOT error: a filter BILL cannot parse and silently ignores turns "everything
 * updated since yesterday" into "everything", which is a sweep over the whole
 * ledger reported as an incremental one.
 */
export function isoInstant(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = optionalString(raw, key);
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new InputError(
      `\`${key}\`="${value}" is not a date-time. Use ISO-8601 with a zone, ` +
        `e.g. "2026-09-01T00:00:00Z".`,
    );
  }
  return new Date(parsed).toISOString();
}
