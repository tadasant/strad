import {
  DEFAULT_UPLOAD_URL_MINUTES,
  MAX_LINK_DAYS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_URL_MINUTES,
} from "../config.js";
import { StoreError, UNIFORM_ACCESS_SENSITIVE_REFUSAL } from "../store.js";
import {
  UploadLeaseSchema,
  type UploadLeaseStore,
} from "../upload-targets.js";
import {
  EXPIRES_DESCRIPTION,
  LINK_HANDLING_DESCRIPTION,
  SENSITIVE_DESCRIPTION,
  fail,
  ok,
  type StoreFactory,
  type ToolDefinition,
} from "./shared.js";

const PARAMS = {
  path:
    "Where the eventual POST body will be stored, e.g. \"screenshots/pr-123/before.png\". " +
    "Omit it and a date-partitioned path is generated after upload. An explicit path overwrites.",
  content_type:
    'MIME type of the artifact, e.g. "image/png", "video/webm", "application/pdf". ' +
    "Pass the same value in the curl Content-Type header shown in this tool's response.",
  is_sensitive: SENSITIVE_DESCRIPTION,
  expires_in_days: EXPIRES_DESCRIPTION,
  upload_url_expires_in_minutes:
    `How long the temporary POST URL may be used (${MAX_UPLOAD_URL_MINUTES} minutes max). ` +
    `Default: ${DEFAULT_UPLOAD_URL_MINUTES}. This expiry controls only the upload window; ` +
    "`expires_in_days` controls the browser link returned after the upload succeeds.",
} as const;

const DESCRIPTION = `Create a temporary URL for uploading an artifact with curl, then get back the usual browser link.

Use this rather than upload_file for anything but a tiny snippet: bytes travel from a
shell instead of base64 through an MCP call. The response carries a ready-made \`curl\`
command — run it with \`/path/to/file\` replaced by your file. That POST answers with the
same JSON upload_file returns; hand its \`url\` to a human or put it in a PR.

The guidance below is about that browser link, **not** the upload target, which is a
strad route carrying no signature.

${LINK_HANDLING_DESCRIPTION}

**Use cases:**
- Upload a screenshot or recording without base64 in the MCP call
- Publish a generated PDF, CSV or HTML report
- Move a large log or trace archive to a browser link

**Boundaries:** POST only, one successful upload, ${MAX_UPLOAD_BYTES} bytes max. The
token lives in this process — use it promptly, a restart invalidates it. Expiry kills
the upload URL, not the artifact.`;

export function getUploadUrlTool(
  storeFactory: StoreFactory,
  leases: UploadLeaseStore,
): ToolDefinition {
  return {
    name: "get_upload_url",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
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
          description: PARAMS.expires_in_days,
        },
        upload_url_expires_in_minutes: {
          type: "number",
          minimum: 1,
          maximum: MAX_UPLOAD_URL_MINUTES,
          default: DEFAULT_UPLOAD_URL_MINUTES,
          description: PARAMS.upload_url_expires_in_minutes,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: async (args: unknown) => {
      try {
        const input = UploadLeaseSchema.parse(args);
        const store = storeFactory();
        // Refused HERE, not when the POST arrives: the put would refuse it too,
        // but only after the caller had already shipped the bytes with curl.
        if (input.is_sensitive && store.uniformAccess?.()) {
          throw new StoreError(UNIFORM_ACCESS_SENSITIVE_REFUSAL);
        }
        return ok(leases.create(input, store.defaultLinkDays()));
      } catch (err) {
        return fail(err);
      }
    },
  };
}
