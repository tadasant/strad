import { z } from "zod";
import { DEFAULT_LINK_DAYS, MAX_LINK_DAYS } from "../config.js";
import {
  EXPIRES_DESCRIPTION,
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

const DESCRIPTION = `Upload a file and get back a link a human can open in a browser.

This is how an agent hands a person a screenshot, a recording, a report or any other
artifact it produced. The artifact is stored in a Google Cloud Storage bucket and the
tool returns a URL — put that URL in your reply, or embed it in a PR description with
markdown image syntax.

For nontrivial payloads, prefer get_upload_url: it returns a temporary POST target
and a curl command, so the bytes travel from the shell to the server instead of being
base64/text-encoded into the MCP tool call. Use this direct upload_file tool for tiny
in-memory payloads or files already visible to this server through file://.

**Two kinds of link, chosen by \`is_sensitive\`:**
- \`false\` (default) — a signed URL. Unguessable, opens instantly for anyone holding
  it with no sign-in, and expires after \`expires_in_days\` (default ${DEFAULT_LINK_DAYS}). This is
  the right choice for essentially every screenshot.
- \`true\` — a link that requires signing in to a Google account on the viewer domain.
  It never expires. Use it only for genuinely sensitive material; see the
  \`is_sensitive\` parameter description for the line.

**Example response:**
\`\`\`json
{
  "path": "uploads/2026/08/02/081500-a1b2c3.png",
  "url": "https://storage.googleapis.com/artifacts/uploads/2026/08/02/081500-a1b2c3.png?GoogleAccessId=...&Expires=1786869329&Signature=...",
  "access": "link",
  "requires_sign_in": false,
  "expires_at": "2026-08-16T08:15:00.000Z",
  "signing_version": "v2",
  "size_bytes": 50450,
  "content_type": "image/png",
  "bucket": "artifacts"
}
\`\`\`

**\`access\` values:**
- \`link\` — private object, reachable only through the signed URL above
- \`restricted\` — private object, reachable only by a signed-in member of the viewer
  domain (\`viewer_domain\` is included in the response)
- \`public\` — world-readable forever. This tool never creates one; you will only see
  it from set_sensitivity or refresh_link on an object made public long ago.

**Use cases:**
- Share a Playwright screenshot as PR evidence
- Hand a human a recording of a bug reproducing
- Publish a generated chart or report and link to it in a message
- Store a large output that would be unreadable pasted inline
- Attach a design mock to a review comment

**The link outlives nothing.** Expiry kills the URL, never the artifact. If a link has
gone stale, call refresh_link with the \`path\` from this response and you get a fresh
one. Keep the \`path\` — it is the durable handle; the URL is not.`;

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
