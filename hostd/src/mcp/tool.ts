import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type { Grant } from "../consent/grants.js";

export interface ToolContext {
  grant: Grant;
}

/**
 * One tool of a capability. The `grant_id` parameter is NOT declared here: the
 * server adds it to every capability tool's schema and strips it before the
 * handler runs, so no tool can forget to require it.
 */
export interface CapabilityTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** A one-line, argument-aware summary for the owner's audit log. */
  summarize?: (args: z.infer<S>) => string;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<CallToolResult>;
}

/** Keeps each tool's handler typed against its own schema. */
export function defineTool<S extends z.ZodTypeAny>(
  tool: CapabilityTool<S>,
): CapabilityTool {
  return tool as unknown as CapabilityTool;
}

export function text(body: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: body }],
    ...(isError ? { isError: true } : {}),
  };
}

export function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2));
}

/** A capability: its tools, and what to tear down when the daemon stops. */
export interface Capability {
  tools: CapabilityTool[];
  close?: () => Promise<void> | void;
}
