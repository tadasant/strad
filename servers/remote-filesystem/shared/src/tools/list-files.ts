import { z } from "zod";
import { fail, ok, type StoreFactory, type ToolDefinition } from "./shared.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const PARAMS = {
  prefix:
    'Directory to list, e.g. "screenshots/8379" or "uploads/2026/08". ' +
    "Omit it to list the top level. Listing is one level deep: sub-directories come " +
    "back in `directories`, and you pass one of those to descend.",
  limit: `Maximum number of files to return (1-${MAX_LIMIT}). Default: ${DEFAULT_LIMIT}. Raise it when you are searching a large directory for one artifact.`,
} as const;

export const ListFilesSchema = z.object({
  prefix: z.string().optional().describe(PARAMS.prefix),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .optional()
    .default(DEFAULT_LIMIT)
    .describe(PARAMS.limit),
});

const DESCRIPTION = `Browse stored artifacts, one directory level at a time.

Use this to find the \`path\` of an artifact when you do not already have it — which is
the usual situation when a human asks you to dig up something from a previous session.
Pass the path you find to refresh_link to get a working URL for it.

**Example response:**
\`\`\`json
{
  "prefix": "screenshots/8379",
  "files": [
    {
      "path": "screenshots/8379/v1-kpi-dashboard.png",
      "size_bytes": 6988,
      "content_type": "image/png",
      "updated_at": "2026-06-17T03:57:04.504Z"
    }
  ],
  "directories": ["screenshots/8379/archive"],
  "count": 1
}
\`\`\`

**No link, and no access level, in this response — on purpose.** Both cost a round trip
to Google per object, so a fifty-file listing would be fifty extra calls for data you
usually do not want. Call refresh_link on the one artifact you actually care about.

**Use cases:**
- Find an artifact a human is describing from memory ("that dashboard from June")
- Check what you already uploaded for a given PR or issue before uploading again
- Confirm an upload landed where you meant it to
- Walk a date-partitioned tree ("uploads/2026" then "uploads/2026/08")`;

export function listFilesTool(storeFactory: StoreFactory): ToolDefinition {
  return {
    name: "list_files",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: PARAMS.prefix },
        limit: {
          type: "number",
          minimum: 1,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT,
          description: PARAMS.limit,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args: unknown) => {
      try {
        const input = ListFilesSchema.parse(args ?? {});
        const store = storeFactory();
        const page = await store.list({
          prefix: input.prefix,
          limit: input.limit,
        });
        return ok({
          prefix: input.prefix ?? "",
          files: page.files.map((f) => ({
            path: f.path,
            size_bytes: f.size_bytes,
            content_type: f.content_type,
            updated_at: f.updated_at,
          })),
          directories: page.directories,
          count: page.files.length,
        });
      } catch (err) {
        return fail(err);
      }
    },
  };
}
