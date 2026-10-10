import { InputError } from "../errors.js";
import {
  args,
  BASE_ID,
  guard,
  ok,
  RECORD_ID,
  requiredString,
  type ClientFactory,
  type ToolDefinition,
} from "./shared.js";

/** Airtable's ceiling for the direct upload endpoint. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * The base64 payload, checked HERE rather than at Airtable. A data-URL prefix
 * is stripped rather than refused — it is the most common way a caller hands
 * over a file, and its meaning is unambiguous. So is base64url: `-` and `_`
 * become `+` and `/`, and missing padding is restored, so Airtable is always
 * sent the standard alphabet. The size is checked on the
 * DECODED bytes, because that is what Airtable measures, so a file just under
 * 5 MB is not refused for its ~6.7 MB of base64.
 */
export function normaliseBase64(raw: string): string {
  const stripped = raw
    .replace(/^data:[^,]*;base64,/, "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (
    stripped === "" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(stripped) ||
    stripped.length % 4 === 1
  ) {
    throw new InputError("`file` must be base64-encoded file content.");
  }
  const padded = stripped.padEnd(Math.ceil(stripped.length / 4) * 4, "=");
  const bytes = Buffer.from(padded, "base64").length;
  if (bytes > MAX_UPLOAD_BYTES) {
    throw new InputError(
      `\`file\` is ${bytes} bytes; Airtable's upload endpoint takes at most ` +
        `${MAX_UPLOAD_BYTES} (5 MB). Put a larger file at a public URL and set ` +
        `it with update_records, e.g. {"Files":[{"url":"https://…"}]}.`,
    );
  }
  return padded;
}

export function uploadAttachmentTool(client: ClientFactory): ToolDefinition {
  return {
    name: "upload_attachment",
    description:
      "Upload a file (base64, up to 5 MB) into an attachment field of an " +
      "EXISTING record. The file is APPENDED to the field's current " +
      "attachments. For a larger file, or one already online, set the field " +
      'with update_records instead: {"Files":[{"url":"https://…"}]}.\n\n' +
      'Example call: {"baseId":"app…","recordId":"recA1b2C3d4E5f6G7",' +
      '"attachmentFieldIdOrName":"Files","file":"iVBORw0KGgo…","filename":' +
      '"chart.png","contentType":"image/png"}\n' +
      'Returns: {"id":"recA1b2C3d4E5f6G7","fields":{"fldXXXXXXXXXXXXXX":' +
      '[{"id":"att…","url":"https://…","filename":"chart.png","size":1234,' +
      '"type":"image/png"}]}}\n\n' +
      "The result's `fields` is keyed by field ID, not name. No tableId is " +
      "needed — a record ID is unique within its base.",
    inputSchema: {
      type: "object",
      properties: {
        baseId: BASE_ID,
        recordId: RECORD_ID,
        attachmentFieldIdOrName: {
          type: "string",
          description:
            'The attachment field\'s ID or name, e.g. "fldXXXXXXXXXXXXXX" or "Images".',
        },
        file: {
          type: "string",
          description:
            "The file content, base64-encoded (base64url is accepted). A data: URL prefix is accepted and stripped.",
        },
        filename: { type: "string", description: 'e.g. "image.jpg".' },
        contentType: {
          type: "string",
          description: 'MIME type, e.g. "image/jpeg", "application/pdf".',
        },
      },
      required: [
        "baseId",
        "recordId",
        "attachmentFieldIdOrName",
        "file",
        "filename",
        "contentType",
      ],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const baseId = requiredString(input, "baseId");
        const recordId = requiredString(input, "recordId");
        const field = requiredString(input, "attachmentFieldIdOrName");
        const file = normaliseBase64(requiredString(input, "file"));
        const filename = requiredString(input, "filename");
        const contentType = requiredString(input, "contentType");
        return ok(
          await (
            await client()
          ).uploadAttachment(
            baseId,
            recordId,
            field,
            file,
            filename,
            contentType,
          ),
        );
      }),
  };
}
