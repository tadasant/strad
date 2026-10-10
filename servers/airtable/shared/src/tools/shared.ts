/**
 * The pieces every tool file needs: the tool shape, the JSON envelope, argument
 * coercion, the shared parameter copy, and the one error path they all share.
 */

import type { AirtableClient } from "../client.js";
import { ConfigError } from "../config.js";
import { AirtableApiError, InputError, RateLimitError } from "../errors.js";
import { redact } from "../logging.js";

export interface ToolResult {
  /** The SDK's `ServerResult` is open-ended; the index signature is what makes
   * this assignable to it without a cast at the registration site. */
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
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
  annotations: ToolAnnotations;
  handler: (args: unknown) => Promise<ToolResult>;
}

/**
 * Built on each tool call, not at boot — so a missing token is one failed call
 * rather than a crashed host. The token is read from the env this server was
 * given; in the strad bundle that is a snapshot taken at boot, so a rotated
 * token takes a redeploy.
 */
export type ClientFactory = () => Promise<AirtableClient>;

/**
 * The longest description a client will actually show an agent. Not an MCP
 * limit: it is where Claude Code cuts one, silently (`HACKS.md` #82 in strad).
 * Asserted over every tool by the test suite.
 */
export const DESCRIPTION_BUDGET = 2048;

export const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// The parameter copy, shared so every tool describes an ID the same way.
export const BASE_ID = {
  type: "string",
  description:
    'The ID of the base, e.g. "appXXXXXXXXXXXXXX" (from list_bases).',
};
export const TABLE_ID = {
  type: "string",
  description:
    'The ID or name of the table, e.g. "tblXXXXXXXXXXXXXX" or "Projects" (from list_tables). Prefer the ID: a name breaks when the table is renamed.',
};
export const RECORD_ID = {
  type: "string",
  description: 'The ID of the record, e.g. "recXXXXXXXXXXXXXX".',
};
export const VIEW = {
  type: "string",
  description:
    "The name or ID of a view. Only records visible in it are returned, in its order unless `sort` is given.",
};
export const OFFSET = {
  type: "string",
  description:
    "The `offset` a previous call returned, to continue where it stopped. Repeat the other arguments unchanged.",
};

export const DETAIL_LEVEL = {
  type: "string",
  enum: ["tableIdentifiersOnly", "identifiersOnly", "full"],
  description:
    "How much schema to return. tableIdentifiersOnly: table IDs and names. " +
    "identifiersOnly: plus field and view IDs and names. full (default): plus " +
    "field types, options and descriptions. Ask for the least you need — a " +
    "base with many tables at `full` is large.",
};

export function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(text: string): ToolResult {
  // Shape-redacted: most of what reaches here was written by Airtable, not by
  // this server. The literal token is scrubbed again at the registration site.
  return { content: [{ type: "text", text: redact(text) }], isError: true };
}

/**
 * The one error path. Config and input errors are a sentence — their recovery
 * is in the words. An Airtable error is a small document, because `retryable`
 * is what a caller decides on, and `type` is what Airtable's docs are indexed by.
 */
export async function guard(
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof RateLimitError) {
      return fail(
        JSON.stringify(
          {
            error: err.name,
            message: err.message,
            status: 429,
            retryable: true,
            retry_after_seconds: err.retryAfterSeconds,
          },
          null,
          2,
        ),
      );
    }
    if (err instanceof AirtableApiError) {
      return fail(
        JSON.stringify(
          {
            error: err.name,
            message: err.message,
            ...(err.status ? { status: err.status } : {}),
            ...(err.type ? { type: err.type } : {}),
            retryable: err.retryable,
          },
          null,
          2,
        ),
      );
    }
    if (err instanceof ConfigError || err instanceof InputError) {
      return fail(err.message);
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Arguments arrive as `unknown` from the SDK. */
export function args(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function requiredString(
  raw: Record<string, unknown>,
  key: string,
): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(
      `\`${key}\` is required and must be a non-empty string.`,
    );
  }
  return value.trim();
}

/**
 * Free text the caller means exactly — a search term, a comment. Refused only
 * when empty or whitespace-only; otherwise passed through UNTRIMMED, because
 * the spaces are part of what was asked for.
 */
export function requiredText(
  raw: Record<string, unknown>,
  key: string,
): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(
      `\`${key}\` is required and must be a non-empty string.`,
    );
  }
  return value;
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

/**
 * A positive whole number, CLAMPED to `max` rather than refused: an agent that
 * asks for 5000 wants "as many as you can", and failing the call teaches it
 * nothing the result's `offset` would not.
 */
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
  return Math.min(parsed, max);
}

export function stringArray(
  raw: Record<string, unknown>,
  key: string,
  { required = false, max }: { required?: boolean; max?: number } = {},
): string[] | undefined {
  const value = raw[key];
  if (value === undefined || value === null) {
    if (required)
      throw new InputError(
        `\`${key}\` is required and must be an array of strings.`,
      );
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || v.trim() === "")
  ) {
    throw new InputError(`\`${key}\` must be an array of non-empty strings.`);
  }
  if (required && value.length === 0) {
    throw new InputError(`\`${key}\` must name at least one item.`);
  }
  // Refused, not clamped: silently writing or deleting the first ten of
  // twelve records is a partial write the caller did not ask for.
  if (max !== undefined && value.length > max) {
    throw new InputError(
      `\`${key}\` has ${value.length} items; Airtable takes at most ${max} per request. Split the call.`,
    );
  }
  return (value as string[]).map((v) => v.trim());
}

export function plainObject(
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = raw[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError(
      `\`${key}\` is required and must be an object, e.g. {"Name": "Ada", "Status": "Done"}.`,
    );
  }
  return value as Record<string, unknown>;
}

export function oneOf<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new InputError(`\`${key}\` must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}
