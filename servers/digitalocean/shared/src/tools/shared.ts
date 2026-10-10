/**
 * The pieces every tool file needs: the tool shape, the one result path, the
 * one error path, argument coercion and pagination.
 */

import { scrubber, type DigitalOceanClient } from "../client.js";
import { InputError } from "../errors.js";
import { redact } from "../logging.js";
import { redactSecrets } from "../secrets.js";

export interface ToolResult {
  /** The SDK's `ServerResult` is open-ended; the index signature is what makes
   * this assignable to it without a cast at the registration site. */
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolAnnotations {
  [key: string]: boolean;
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
 * Built on the call, not at boot, and not cached: the token is read each time
 * from the environment the server was given, and building a client is one
 * object allocation. In the strad bundle that environment is a snapshot taken
 * at boot, so a rotated token takes a redeploy to arrive.
 */
export type ClientFactory = () => {
  client: DigitalOceanClient;
  /** The literal credential, so the result path can scrub it. */
  token: string;
};

/**
 * The longest description a client will actually show an agent. Not an MCP
 * limit — where Claude Code cuts one (`HACKS.md` #82 in the strad repo).
 * `test/server.test.ts` asserts it over every tool here.
 */
export const DESCRIPTION_BUDGET = 2048;

export const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Creates something new; repeating it creates another. */
export const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Can take something down or lose data. */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Destructive, and repeating it changes nothing further (a delete, a full replace). */
export const DESTRUCTIVE_IDEMPOTENT: ToolAnnotations = {
  ...DESTRUCTIVE,
  idempotentHint: true,
};

/**
 * The one path every tool runs through.
 *
 * SUCCESS: the payload is walked by `redactSecrets` (database passwords, URIs
 * with a password in them — see secrets.ts) and the literal token is scrubbed
 * from the serialised text. The length-based shape rule is NOT applied to
 * success: it would eat SSH public keys and other long public values a result
 * legitimately carries.
 *
 * FAILURE: the message is scrubbed of the literal token AND of anything
 * token-shaped, because most of it was written by DigitalOcean.
 *
 * The client is obtained through `api()` rather than up front so a tool
 * validates its arguments before it asks for a credential — a bad argument is
 * reported as one even on a deployment with no token.
 */
export async function guard(
  factory: ClientFactory,
  run: (api: () => DigitalOceanClient) => Promise<unknown>,
): Promise<ToolResult> {
  let scrub: (text: string) => string = (text) => text;
  try {
    const payload = await run(() => {
      const built = factory();
      scrub = scrubber(built.token);
      return built.client;
    });
    const text = scrub(JSON.stringify(redactSecrets(payload), null, 2));
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: redact(scrub(message)) }],
      isError: true,
    };
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

export function optionalInt(
  raw: Record<string, unknown>,
  key: string,
  min: number,
): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < min) {
    throw new InputError(
      `\`${key}\` must be a whole number of at least ${min}.`,
    );
  }
  return parsed;
}

/** A whole number between 1 and `max`, clamped rather than refused above it. */
export function boundedInt(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const value = optionalInt(raw, key, 1);
  return value === undefined ? fallback : Math.min(value, max);
}

export function enumValue<T extends string>(
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

export function optionalStringArray(
  raw: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || v.trim() === "")
  ) {
    throw new InputError(`\`${key}\` must be an array of non-empty strings.`);
  }
  return value.map((v: string) => v.trim());
}

export function requiredObject(
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = raw[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError(`\`${key}\` is required and must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * A droplet (or action) id: DigitalOcean's are positive integers. Refused here
 * because the id is spliced into a URL path, and a string like `1/actions`
 * would address a different endpoint than the tool claims to. `what` names the
 * kind of id in the refusal.
 */
export function dropletId(
  raw: Record<string, unknown>,
  key = "droplet_id",
  what = "a droplet's numeric id (from droplet-list)",
): number {
  const value = raw[key];
  const parsed =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1
  ) {
    throw new InputError(`\`${key}\` is required and must be ${what}.`);
  }
  return parsed;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An app, deployment or database id: a UUID, checked for the same path-splicing reason. */
export function uuid(
  raw: Record<string, unknown>,
  key: string,
  from: string,
): string {
  const value = requiredString(raw, key);
  if (!UUID.test(value)) {
    throw new InputError(
      `\`${key}\`="${value}" is not a UUID. Take it from ${from}.`,
    );
  }
  return value.toLowerCase();
}

export function optionalUuid(
  raw: Record<string, unknown>,
  key: string,
  from: string,
): string | undefined {
  return raw[key] === undefined || raw[key] === null || raw[key] === ""
    ? undefined
    : uuid(raw, key, from);
}

export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 200;

/** The pagination properties every list tool takes, in one place. */
export const PAGE_PROPERTIES = {
  page: {
    type: "integer",
    minimum: 1,
    description:
      "Which page, from 1. Pass the previous result's `next_page` to continue; " +
      "a result with `has_next_page: false` is the last.",
  },
  per_page: {
    type: "integer",
    minimum: 1,
    maximum: MAX_PER_PAGE,
    description: `Rows per page (1-${MAX_PER_PAGE}; larger is clamped). Default ${DEFAULT_PER_PAGE}.`,
  },
} as const;

export function pageArgs(raw: Record<string, unknown>): {
  page: number;
  perPage: number;
} {
  return {
    page: optionalInt(raw, "page", 1) ?? 1,
    perPage: boundedInt(raw, "per_page", DEFAULT_PER_PAGE, MAX_PER_PAGE),
  };
}
