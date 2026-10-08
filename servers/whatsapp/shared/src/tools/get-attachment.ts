import { capUtf8, inlineKind, MAX_INLINE_IMAGE_BYTES, MAX_TEXT_BYTES, pdfText } from "../attachment.js";
import { errMessage } from "../logging.js";
import {
  args,
  CHAT_ID_DESCRIPTION,
  guard,
  requiredString,
  UNOFFICIAL,
  type BridgeFactory,
  type ToolDefinition,
  type ToolResult,
} from "./shared.js";

export const PRIVATE_FILES =
  "These are the PRIVATE FILES of the paired WhatsApp account — whatever " +
  "anyone sent to it or it sent: contracts, IDs, photos. Read only what the " +
  "task needs, and do not copy them anywhere they were not meant to go.";

/**
 * Read one attachment. The bytes are fetched from WhatsApp's CDN and
 * decrypted for this call; nothing is stored. What comes back is the text (a
 * PDF or a text file), the image (an image block), and a single-use link to
 * the file itself, whatever it is.
 */
export function getAttachmentTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "whatsapp_get_attachment",
    description:
      "Download one attachment (document, image, video, audio or sticker) from " +
      "a buffered WhatsApp message and read it. Pass the `chat_id` and the " +
      "message `id` from whatsapp_get_messages, where a media message carries an " +
      "`attachment` object (`file_name`, `mime_type`, `size_bytes`, `available`).\n\n" +
      `${PRIVATE_FILES}\n\n` +
      "Returns, as the first text block, JSON: the file's name, type and size, " +
      "and `download_url` — a single-use link that expires in 15 minutes and " +
      "needs no credential (`curl` is a ready command). Then: for a PDF or a " +
      `text file, its extracted text (at most ${MAX_TEXT_BYTES / 1024} KB, and ` +
      "`text_truncated: true` says when there was more); for an image, an " +
      "image block. Video and audio are the link only.\n\n" +
      "Files above 25 MB are refused, and a download is abandoned after 60 s. " +
      "If WhatsApp's copy has expired, the phone is asked to upload it again, " +
      "which needs the phone online. A message buffered before this tool " +
      "existed has to be asked of the phone first, best effort; when it cannot " +
      "be, the error says why.\n\n" +
      `${UNOFFICIAL}\n\n` +
      'Example: {"chat_id":"15557654321@s.whatsapp.net","message_id":"3EB0C0FFEE",' +
      '"file_name":"Contract.pdf","mime_type":"application/pdf","size_bytes":182311,' +
      '"page_count":4,"caption":"Here is the contract","download_url":' +
      '"https://strad.example.com/mcp-download/whatsapp-tadas/…","expires_at":' +
      '"2026-10-08T12:15:00.000Z","single_use":true,"curl":"curl -fSL -o …",' +
      '"inline":"text","text_truncated":false} followed by the text.',
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: CHAT_ID_DESCRIPTION },
        message_id: {
          type: "string",
          description: "The message's `id` from whatsapp_get_messages.",
        },
      },
      required: ["chat_id", "message_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const b = await bridge();
        const a = await b.getAttachment({
          chat_id: requiredString(input, "chat_id"),
          message_id: requiredString(input, "message_id"),
        });
        const link = b.downloadLink(a.chat_id, a.message_id, a.file_name);
        const kind = inlineKind(a.type, a.mime_type);

        const extra: ToolResult["content"] = [];
        let inline: "text" | "image" | "none" = "none";
        let truncated = false;
        let note: string | undefined;
        let pageCount = a.page_count;
        if (kind === "pdf") {
          try {
            const pdf = await pdfText(a.bytes);
            pageCount = pageCount ?? pdf.pages;
            if (pdf.text.trim().replace(/--- page \d+ of \d+ ---/g, "").trim() === "") {
              note =
                "The PDF has no extractable text (most likely a scan). Use the " +
                "download link and read it as an image.";
            } else {
              inline = "text";
              truncated = pdf.truncated;
              extra.push({ type: "text", text: pdf.text });
            }
          } catch (err) {
            note = `The PDF's text could not be extracted (${errMessage(err)}). Use the download link.`;
          }
        } else if (kind === "text") {
          const capped = capUtf8(a.bytes.toString("utf8"));
          inline = "text";
          truncated = capped.truncated;
          extra.push({ type: "text", text: capped.text });
        } else if (kind === "image") {
          if (a.bytes.length <= MAX_INLINE_IMAGE_BYTES) {
            inline = "image";
            extra.push({
              type: "image",
              data: a.bytes.toString("base64"),
              mimeType: a.mime_type.split(";")[0]!.trim(),
            });
          } else {
            note =
              `The image is larger than ${MAX_INLINE_IMAGE_BYTES / 1024 / 1024} MB, ` +
              "so it is not returned inline. Use the download link.";
          }
        } else {
          note = "This kind of file is not read inline. Use the download link.";
        }
        if (truncated) {
          note =
            `The text was cut at ${MAX_TEXT_BYTES / 1024} KB. The download link ` +
            "has the whole file.";
        }

        const payload = {
          chat_id: a.chat_id,
          message_id: a.message_id,
          type: a.type,
          file_name: a.file_name,
          mime_type: a.mime_type,
          size_bytes: a.size_bytes,
          ...(pageCount ? { page_count: pageCount } : {}),
          caption: a.caption,
          ...link,
          inline,
          text_truncated: truncated,
          ...(note ? { note } : {}),
          ...(a.recovered_from_phone ? { recovered_from_phone: true } : {}),
          ...(a.reuploaded ? { reuploaded_by_phone: true } : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }, ...extra],
          structuredContent: payload,
        };
      }),
  };
}
