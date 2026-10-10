/**
 * The pieces every tool file needs: the tool shape, the JSON envelope, argument
 * coercion, the paging arguments, and the one error path they all share.
 */

import { MAX_PAGES_CAP, nextCursor, type AeroClient } from "../client.js";
import { InputError, RateLimitError } from "../errors.js";
import { redact } from "../logging.js";
import { compact } from "../shape.js";

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
  annotations: Record<string, boolean>;
  handler: (args: unknown) => Promise<ToolResult>;
}

/**
 * What a tool is handed. `client()` reads the key at CALL time and throws a
 * `ConfigError` naming the variable when it is missing; `scrub()` removes the
 * literal key from any text, and is applied to every result this server
 * returns — success or failure — because a success body is upstream-authored
 * text too.
 */
export interface ToolContext {
  client: () => AeroClient;
  scrub: (text: string) => string;
}

/**
 * The longest description a client will actually show an agent. Not an MCP
 * limit — it is where Claude Code cuts one, silently. `HACKS.md` #82 in the
 * strad repo has the incident; test/mcp.test.ts asserts it over every tool.
 */
export const DESCRIPTION_BUDGET = 2048;

/** All tools here only read. AeroAPI's flight data has no write. */
export const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** The sentence every description carries, so no caller can miss the bill. */
export const BILLING_NOTE =
  "BILLED PER QUERY to the AeroAPI account: every call costs money, and on a " +
  "list each returned page is billed.";

export function ok(ctx: ToolContext, payload: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: ctx.scrub(JSON.stringify(compact(payload), null, 2)),
      },
    ],
  };
}

/**
 * The one error path every tool shares. Each class already carries a message
 * written for the caller; what the wrapper adds is the scrub (the literal key,
 * then the key SHAPE as a backstop) and, for a rate limit, the structured wait.
 */
export async function guard(
  ctx: ToolContext,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    const message = redact(
      ctx.scrub(err instanceof Error ? err.message : String(err)),
    );
    if (err instanceof RateLimitError) {
      const doc = {
        error: err.name,
        message,
        retryable: true,
        ...(err.retryAfterSeconds === undefined
          ? {}
          : { retry_after_seconds: err.retryAfterSeconds }),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(doc, null, 2) }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/** Arguments arrive as `unknown` from the SDK. */
export function args(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/**
 * Unknown keys are REFUSED, not ignored. A misspelt `destinaton` that was
 * silently dropped would turn a narrow search into a broad one — and the broad
 * one is the one that is billed.
 */
export function rejectUnknown(
  raw: Record<string, unknown>,
  properties: Record<string, unknown>,
): void {
  const unknown = Object.keys(raw).filter((k) => !(k in properties));
  if (unknown.length > 0) {
    throw new InputError(
      `Unknown argument${unknown.length === 1 ? "" : "s"}: ` +
        `${unknown.map((k) => `\`${k}\``).join(", ")}. This tool accepts: ` +
        `${Object.keys(properties).join(", ")}.`,
    );
  }
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

export function requiredString(
  raw: Record<string, unknown>,
  key: string,
): string {
  const value = optionalString(raw, key);
  if (value === undefined) {
    throw new InputError(
      `\`${key}\` is required and must be a non-empty string.`,
    );
  }
  return value;
}

export function optionalEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(raw, key);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new InputError(
      `\`${key}\`="${value}" is not one of: ${allowed.join(", ")}.`,
    );
  }
  return value as T;
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

/** A whole number in [min, max]. Refused, not clamped, when it is malformed. */
export function optionalInt(
  raw: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isInteger(parsed) ||
    parsed < min ||
    parsed > max
  ) {
    throw new InputError(
      `\`${key}\` must be a whole number between ${min} and ${max}.`,
    );
  }
  return parsed;
}

/**
 * A bounded count with a default. CLAMPED at the top rather than refused: a
 * caller asking for 50 pages wants "as many as allowed", and a failed call
 * teaches it nothing the result's `pages_billed` would not.
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

/**
 * An airport code: ICAO (`KJFK`), IATA (`JFK`) or FAA LID (`O07`). Shape-checked
 * here so a typo costs nothing; whether it exists is AeroAPI's 404 to give.
 */
export function airportCode(raw: Record<string, unknown>, key: string): string {
  const value = requiredString(raw, key).toUpperCase();
  if (!/^[A-Z0-9]{2,5}$/.test(value)) {
    throw new InputError(
      `\`${key}\`="${value}" is not an airport code. Use ICAO (preferred, e.g. ` +
        `"KJFK", "EGLL"), IATA ("JFK") or an FAA LID ("O07").`,
    );
  }
  return value;
}

/** An operator code: ICAO (`UAL`, preferred) or IATA (`UA`). */
export function operatorCode(
  raw: Record<string, unknown>,
  key: string,
): string {
  const value = requiredString(raw, key).toUpperCase();
  if (!/^[A-Z0-9]{2,3}$/.test(value)) {
    throw new InputError(
      `\`${key}\`="${value}" is not an operator code. Use the ICAO code ` +
        `(preferred, e.g. "UAL", "BAW") or the IATA code ("UA", "BA").`,
    );
  }
  return value;
}

/**
 * A flight ident, registration, or fa_flight_id. Restricted to the characters
 * those actually use, so nothing a caller passes can reshape the path.
 */
export function flightIdent(raw: Record<string, unknown>, key: string): string {
  const value = requiredString(raw, key);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
    throw new InputError(
      `\`${key}\`="${value}" is not a flight identifier. Use an ICAO flight ` +
        `ident ("UAL4"), a registration ("N123HQ"), or an fa_flight_id ` +
        `("UAL4-1700000000-airline-0123").`,
    );
  }
  return value;
}

/**
 * A date or a zoned RFC 3339 instant, passed to AeroAPI as given.
 *
 * A time of day MUST carry a zone: AeroAPI would read a bare one as UTC, and a
 * caller who meant local time would get a window hours off with no error. The
 * zone is `Z` or `±HH:MM` — RFC 3339's form, not ISO-8601's colonless `-0800`,
 * which is not this server's to guess at.
 *
 * The calendar date is ROUND-TRIPPED, because `Date.parse` rolls an impossible
 * one over rather than refusing it: `2026-02-30` would be read as 2 March, and
 * the caller would be billed for a window it never named.
 */
export function isoBound(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = optionalString(raw, key);
  if (value === undefined) return undefined;
  const shape =
    /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
  const match = shape.exec(value);
  const datePart = value.slice(0, 10);
  const realDate =
    match !== null &&
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
      .toISOString()
      .slice(0, 10) === datePart;
  if (!realDate || Number.isNaN(Date.parse(value))) {
    throw new InputError(
      `\`${key}\`="${value}" is not a date or a zoned date-time. Use a real ` +
        `calendar date ("2026-10-09", read as 00:00Z) or RFC 3339 WITH a zone, ` +
        `\`Z\` or \`±HH:MM\` ("2026-10-09T14:00:00Z", "2026-10-09T09:30:00+05:30").`,
    );
  }
  return value;
}

export function assertOrdered(start?: string, end?: string): void {
  if (start === undefined || end === undefined) return;
  if (Date.parse(start) < Date.parse(end)) return;
  throw new InputError(
    `\`start\`="${start}" is not before \`end\`="${end}" (end is exclusive), ` +
      `so the window is empty. Swap them, or drop one.`,
  );
}

/** The two paging arguments every list tool shares, in schema form. */
export const PAGING_PROPERTIES = {
  max_pages: {
    type: "integer",
    minimum: 1,
    maximum: MAX_PAGES_CAP,
    description:
      `How many result pages AeroAPI may return in this one call (1-` +
      `${MAX_PAGES_CAP}, default 1). EACH PAGE IS BILLED. Raise it only when ` +
      `you know you need the extra rows.`,
  },
  cursor: {
    type: "string",
    description:
      "The `next_cursor` from a previous result, to fetch the next page. Pass " +
      "the SAME other arguments with it. Omit for the first page; a result " +
      "with no `next_cursor` is the last.",
  },
} as const;

export function pagingArgs(raw: Record<string, unknown>): {
  max_pages: number;
  cursor?: string;
} {
  const cursor = optionalString(raw, "cursor");
  return {
    max_pages: boundedInt(raw, "max_pages", 1, MAX_PAGES_CAP),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/**
 * The paging half of every list result: how many pages were BILLED, and the
 * cursor to continue with. `num_pages` is AeroAPI's own count of pages in the
 * reply, which is what the account is charged for.
 */
export function pagingResult(body: Record<string, unknown>): {
  pages_billed: number;
  next_cursor?: string;
} {
  const cursor = nextCursor(body.links);
  const pages = typeof body.num_pages === "number" ? body.num_pages : 1;
  return {
    pages_billed: pages,
    ...(cursor === undefined ? {} : { next_cursor: cursor }),
  };
}
