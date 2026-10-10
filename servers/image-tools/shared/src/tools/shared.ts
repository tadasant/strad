/**
 * What both tools share: the tool shape, the context they run in, and the one
 * error path.
 */
import { ZodError } from "zod";

import { ImageInputError, type FetchedImage } from "../fetch-image.js";
import { JobError, type RunJob } from "../jobs.js";
import type { Limits } from "../limits.js";

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  /** The SDK's `ServerResult` is open-ended; the index signature makes this assignable. */
  [key: string]: unknown;
  content: Content[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations?: Record<string, boolean>;
  /** `signal` is the call's cancellation; the fetch, the queue and the worker all honour it. */
  handler: (args: unknown, signal?: AbortSignal) => Promise<ToolResult>;
}

/** What a tool needs from its server, injected so tests can swap any of it. */
export interface ToolContext {
  limits: Limits;
  fetchImage: (
    url: string,
    label: string,
    signal?: AbortSignal,
  ) => Promise<FetchedImage>;
  runJob: RunJob;
}

/**
 * The longest description a client will actually show an agent. Not an MCP
 * limit: it is where Claude Code cuts one (strad's `HACKS.md` #82).
 */
export const DESCRIPTION_BUDGET = 2048;

/** Both tools read a URL and change nothing anywhere. */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const URL_GUIDANCE =
  "Must be an http(s) URL on the public internet — e.g. the signed link remote-filesystem upload_file " +
  "returns. Pass it whole: the query string is the signature. Local paths cannot be read here.";

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Arguments the npx packages took that name a FILE. An agent migrating from
 * them will send these first, and "unknown key" teaches it nothing.
 */
export function refuseLegacyPaths(
  args: unknown,
  renames: Record<string, string>,
): void {
  if (!args || typeof args !== "object") return;
  for (const [old, now] of Object.entries(renames)) {
    if (old in (args as Record<string, unknown>)) {
      throw new ImageInputError(
        `\`${old}\` is a local file path, which this server cannot read: it runs remotely. ` +
          (now
            ? `Upload the file (e.g. remote-filesystem upload_file) and pass its URL as \`${now}\`.`
            : "Nothing is written to disk here; the result comes back in the response."),
      );
    }
  }
}

/** Every failure becomes one sentence the caller can act on. */
export async function guard(
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ZodError) {
      return fail(
        "Invalid arguments: " +
          err.issues
            .map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`)
            .join("; "),
      );
    }
    if (err instanceof ImageInputError || err instanceof JobError)
      return fail(err.message);
    return fail(
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
