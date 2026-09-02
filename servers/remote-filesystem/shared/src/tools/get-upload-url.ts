import {
  DEFAULT_UPLOAD_URL_MINUTES,
  MAX_LINK_DAYS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_URL_MINUTES,
} from "../config.js";
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

Use this instead of upload_file whenever the payload is large enough that base64 or text would be a nontrivial number of tokens. If the file exists on disk and a shell is available, this is normally the right upload path for screenshots, recordings, PDFs, archives, logs, reports and any other artifact larger than a tiny snippet.

The returned URL is unguessable, expires quickly, accepts exactly one successful POST, and stores the posted bytes through the same artifact store as upload_file. The POST response is the same JSON shape upload_file returns: path, url, access, size_bytes, content_type, bucket and expiry fields, plus viewer_domain and sign_in_hint when the artifact is restricted.

**How to use it:**
1. Call get_upload_url with path/content_type/is_sensitive/expires_in_days.
2. Run the returned curl command, replacing /path/to/file with the artifact on disk.
3. Use the JSON response from curl as the artifact link to show a human or place in a PR description.

**Example shell flow:**
\`\`\`sh
curl -fsS -X POST -H 'Content-Type: image/png' --data-binary @/tmp/screenshot.png 'https://strad.example/mcp-upload/remote-filesystem-tmp-public/<token>'
\`\`\`

${LINK_HANDLING_DESCRIPTION}

**Use cases:**
- Upload a Playwright screenshot without base64 in the MCP call
- Upload a video recording or trace archive
- Publish a generated PDF, CSV or HTML report
- Move a large log file to a browser link
- Avoid bloating the MCP transcript with artifact bytes

**Boundaries:**
- POST only. The URL does not accept GET, PUT or PATCH.
- The upload body limit is ${MAX_UPLOAD_BYTES} bytes.
- Expiry kills the upload URL, not the stored artifact or its browser link.
- The temporary token lives in this server process. Use it promptly; a server restart
  invalidates it, and deployments that run multiple replicas need sticky routing or a
  single upload-capable replica.
- If the POST fails before storage succeeds, call it again before expiry; after one successful POST the URL cannot be reused.`;

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
        return ok(leases.create(input, store.defaultLinkDays()));
      } catch (err) {
        return fail(err);
      }
    },
  };
}
