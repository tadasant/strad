import { z } from "zod";
import { DEFAULT_LINK_DAYS, MAX_LINK_DAYS } from "../config.js";
import {
  EXPIRES_DESCRIPTION,
  LINK_HANDLING_DESCRIPTION,
  SENSITIVE_DESCRIPTION,
  artifactPayload,
  fail,
  ok,
  readSource,
  type StoreFactory,
  type ToolDefinition,
} from "./shared.js";

const PARAMS = {
  source:
    "The bytes to upload, in either of two forms: " +
    '(1) a file:// URI to a file this server can read, e.g. "file:///tmp/shot.png", or ' +
    "(2) a base64-encoded string of the file contents. " +
    "Use base64 when the artifact was produced in memory.",
  path:
    "Where to store it in the bucket, e.g. \"screenshots/pr-123/before.png\". " +
    "Omit it and a date-partitioned path is generated for you " +
    '("uploads/2026/08/02/081500-a1b2c3.png"), which is what you want unless the ' +
    "artifact belongs to a set a human will browse later.",
  content_type:
    'MIME type of the artifact, e.g. "image/png", "video/webm", "application/pdf". ' +
    "Omit it and the type is inferred from the path extension. Get this right for " +
    "images: a browser will download rather than display an artifact typed " +
    "application/octet-stream.",
  is_sensitive: SENSITIVE_DESCRIPTION,
  expires_in_days: EXPIRES_DESCRIPTION,
} as const;

export const UploadSchema = z.object({
  source: z.string().min(1).describe(PARAMS.source),
  path: z.string().optional().describe(PARAMS.path),
  content_type: z.string().optional().describe(PARAMS.content_type),
  is_sensitive: z.boolean().optional().default(false).describe(PARAMS.is_sensitive),
  expires_in_days: z
    .number()
    .positive()
    .max(MAX_LINK_DAYS)
    .optional()
    .describe(PARAMS.expires_in_days),
});

const DESCRIPTION = `Upload a file and get back a link a human can open in a browser. Put the returned
\`url\` in your reply, or embed it with markdown image syntax.

**Prefer get_upload_url for anything but a tiny payload** — it returns a POST target
and a curl command, so bytes travel from a shell instead of base64-encoded into this
call. Use this one for small in-memory payloads and \`file://\` paths it can read.

\`is_sensitive\` picks the KIND of link — see its parameter description; the default is
right for essentially every screenshot. A \`restricted\` response also carries
\`sign_in_hint\`, the answer for a human whose link 403s.

${LINK_HANDLING_DESCRIPTION}

**Use cases:**
- Share a Playwright screenshot as PR evidence
- Hand a human a recording of a bug reproducing
- Publish a generated chart or report and link to it
- Store an output too large to paste inline

**Keep the \`path\`, not the URL.** Expiry kills the link, never the artifact:
refresh_link mints a fresh one.`;

export function uploadFileTool(storeFactory: StoreFactory): ToolDefinition {
  return {
    name: "upload_file",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: PARAMS.source },
        path: { type: "string", description: PARAMS.path },
        content_type: { type: "string", description: PARAMS.content_type },
        is_sensitive: {
          type: "boolean",
          default: false,
          description: PARAMS.is_sensitive,
        },
        expires_in_days: {
          type: "number",
          minimum: 1,
          maximum: MAX_LINK_DAYS,
          default: DEFAULT_LINK_DAYS,
          description: PARAMS.expires_in_days,
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async (args: unknown) => {
      try {
        const input = UploadSchema.parse(args);
        const store = storeFactory();
        const data = await readSource(input.source);
        const { artifact, link } = await store.put(data, {
          path: input.path,
          content_type: input.content_type,
          sensitive: input.is_sensitive,
          expires_in_days: input.expires_in_days ?? store.defaultLinkDays(),
        });
        return ok(artifactPayload(store, artifact, link));
      } catch (err) {
        return fail(err);
      }
    },
  };
}
