/**
 * The pieces every tool file needs: the tool shape, the JSON envelope, and the
 * one error path.
 */

import { z } from "zod";

import type { Lookups } from "../lookup.js";

export interface ToolResult {
  /** The SDK's `ServerResult` is open-ended; the index signature makes this
   * assignable to it without a cast at the registration site. */
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

export interface ToolContext {
  lookups: Lookups;
}

/**
 * The longest description a client will actually show an agent. Not an MCP
 * limit — it is where Claude Code cuts one, silently (strad's HACKS.md #82).
 * test/mcp.test.ts asserts it over every tool.
 */
export const DESCRIPTION_BUDGET = 2048;

/**
 * Every tool only reads. `openWorldHint` because FatSecret and USDA Branded
 * are live services whose answers change.
 */
export const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Validation errors in one sentence each, naming the argument. */
function describeZod(err: z.ZodError): string {
  return err.issues
    .map((i) => `\`${i.path.join(".") || "arguments"}\`: ${i.message}`)
    .join("; ");
}

export async function guard(
  schema: z.ZodTypeAny,
  raw: unknown,
  run: (input: never) => Promise<ToolResult>,
): Promise<ToolResult> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) return fail(`Invalid arguments: ${describeZod(parsed.error)}.`);
  try {
    return await run(parsed.data as never);
  } catch (err) {
    return fail(
      `nutrition-facts failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export const SOURCE_NAMES = ["usda", "menustat", "fatsecret"] as const;

export const KINDS = ["auto", "ingredient", "dish", "branded"] as const;

export const KIND_DESCRIPTION =
  'Steers which USDA dataset wins a near-tie. "ingredient" (a single food: ' +
  '"chicken breast", "olive oil") favours USDA Foundation and SR Legacy; ' +
  '"dish" (a mixed dish: "pad thai", "beef stew") favours USDA FNDDS; ' +
  '"branded" also searches USDA Branded and FatSecret brand foods. Default ' +
  '"auto". Setting `brand` implies "branded".';
