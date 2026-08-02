import { z } from "zod";
import {
  PATH_DESCRIPTION,
  fail,
  ok,
  type StoreFactory,
  type ToolDefinition,
} from "./shared.js";

/** Text over this many bytes is truncated; the whole artifact is still in the bucket. */
const MAX_TEXT_BYTES = 200_000;

const PARAMS = {
  path: PATH_DESCRIPTION,
  as_base64:
    "Return the bytes base64-encoded instead of as text. Default: false. " +
    "Set true for images, video, PDFs and anything else binary — decoding a PNG as " +
    "UTF-8 produces garbage. For a human who just needs to LOOK at an image, do not " +
    "use this tool at all: hand them the URL from refresh_link.",
} as const;

export const DownloadSchema = z.object({
  path: z.string().min(1).describe(PARAMS.path),
  as_base64: z.boolean().optional().default(false).describe(PARAMS.as_base64),
});

const DESCRIPTION = `Read a stored artifact's contents back into the conversation.

For when YOU need the bytes — re-reading a log you uploaded, diffing two stored
reports, checking what a file actually contains. If a HUMAN needs to see it, use
refresh_link instead and give them the URL; that costs no tokens and renders properly
in a browser.

**Example response:**
\`\`\`json
{
  "path": "reports/2026-08/summary.txt",
  "content": "Total: 412 rows processed\\n",
  "encoding": "utf-8",
  "size_bytes": 26,
  "content_type": "text/plain",
  "truncated": false
}
\`\`\`

**Encoding:**
- \`utf-8\` — the default. Text, decoded as a string.
- \`base64\` — returned when \`as_base64\` is true. Use for any binary artifact.

Text responses are truncated at ${MAX_TEXT_BYTES.toLocaleString("en-US")} bytes and the response says so; the stored
artifact is never modified.

**Use cases:**
- Re-read a log or report you stored earlier in the session
- Inspect a stored JSON or CSV artifact before acting on it
- Verify an upload landed with the bytes you expected
- Pull a stored image back as base64 to pass to another tool`;

export function downloadFileTool(storeFactory: StoreFactory): ToolDefinition {
  return {
    name: "download_file",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: PARAMS.path },
        as_base64: {
          type: "boolean",
          default: false,
          description: PARAMS.as_base64,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args: unknown) => {
      try {
        const input = DownloadSchema.parse(args);
        const store = storeFactory();
        const { buffer, artifact } = await store.read(input.path);
        const truncated = !input.as_base64 && buffer.length > MAX_TEXT_BYTES;
        const content = input.as_base64
          ? buffer.toString("base64")
          : buffer.subarray(0, MAX_TEXT_BYTES).toString("utf-8");
        return ok({
          path: artifact.path,
          content,
          encoding: input.as_base64 ? "base64" : "utf-8",
          size_bytes: artifact.size_bytes,
          content_type: artifact.content_type,
          truncated,
        });
      } catch (err) {
        return fail(err);
      }
    },
  };
}
