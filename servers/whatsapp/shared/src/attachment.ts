/**
 * What `whatsapp_get_attachment` makes of a decrypted file: the metadata a
 * reader sees in `whatsapp_get_messages`, and the text it can read inline.
 *
 * NOTHING here logs a byte, a filename or a line of extracted text. These are
 * the private files of the paired account — a contract, a passport scan — and
 * the only place their contents go is the tool result of the caller who asked.
 *
 * PDF text comes from `unpdf`, a packaging of Mozilla's pdf.js with no native
 * dependency and no network: it runs offline, in this process. The bundled
 * pdf.js (6.x) is well past the fix for CVE-2024-4367, the font-eval path a
 * crafted PDF could run code through, and font faces are not loaded at all
 * here, because only text is wanted.
 */
import type { MediaDescriptor, MessageType, StoredMessage } from "./normalize.js";
import { MEDIA_TYPES } from "./normalize.js";

/** Largest file this bridge downloads. Checked before AND during the download. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** How long one download may take, re-upload included. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Inline text, at most. The download link carries the rest. */
export const MAX_TEXT_BYTES = 200 * 1024;
/** Largest image returned as an inline image block. Above it, the link only. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** How long PDF text extraction may run before what it has is returned. */
export const PDF_EXTRACT_TIMEOUT_MS = 20_000;

/** The `attachment` object on a media message in `whatsapp_get_messages`. */
export interface AttachmentMeta {
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  page_count?: number;
  /** Whether whatsapp_get_attachment can fetch it from what this bridge holds. */
  available: boolean;
  /** Why not, when `available` is false. */
  unavailable_reason?: string;
}

export const NO_DESCRIPTOR_REASON =
  "This message was buffered before the bridge kept what a download needs. " +
  "whatsapp_get_attachment asks the paired phone to send it again (best " +
  "effort: the phone must be online and still have the message).";

export function isMediaType(type: MessageType): boolean {
  return MEDIA_TYPES.has(type);
}

export function attachmentMeta(m: StoredMessage): AttachmentMeta | undefined {
  if (!isMediaType(m.type)) return undefined;
  const d = m.media;
  if (!d) {
    return {
      file_name: null,
      mime_type: null,
      size_bytes: null,
      available: false,
      unavailable_reason: NO_DESCRIPTOR_REASON,
    };
  }
  const tooBig = d.file_length !== null && d.file_length > MAX_ATTACHMENT_BYTES;
  return {
    file_name: d.file_name,
    mime_type: d.mimetype,
    size_bytes: d.file_length,
    ...(d.page_count ? { page_count: d.page_count } : {}),
    available: !tooBig,
    ...(tooBig ? { unavailable_reason: tooBigReason(d.file_length!) } : {}),
  };
}

export function tooBigReason(size: number): string {
  return (
    `The file is ${(size / 1024 / 1024).toFixed(1)} MB; this bridge downloads at ` +
    `most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB. Open it on the phone.`
  );
}

/** A filename for the download, never empty: the message id stands in. */
export function fileNameOf(d: MediaDescriptor, messageId: string): string {
  if (d.file_name) return d.file_name;
  const sub = d.mimetype?.split(";")[0]?.split("/")[1]?.replace(/[^a-z0-9]/gi, "");
  return sub ? `${messageId}.${sub}` : messageId;
}

const baseMime = (mime: string | null): string =>
  (mime ?? "").split(";")[0]!.trim().toLowerCase();

const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/csv",
  "application/x-yaml",
  "application/yaml",
  "application/x-ndjson",
]);

export type Inline =
  | { kind: "text"; text: string; truncated: boolean; source: "pdf" | "text" }
  | { kind: "image"; mimeType: string }
  | { kind: "none"; note: string };

export function inlineKind(type: MessageType, mime: string | null): "pdf" | "text" | "image" | null {
  const m = baseMime(mime);
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("text/") || TEXT_MIMES.has(m)) return "text";
  if ((type === "image" || type === "sticker") && m.startsWith("image/")) return "image";
  return null;
}

/** Cut to at most `max` UTF-8 bytes, on a character boundary. */
export function capUtf8(text: string, max = MAX_TEXT_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { text, truncated: false };
  let cut = bytes.subarray(0, max).toString("utf8");
  // A cut through a multi-byte character decodes to U+FFFD; drop it.
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/**
 * The text of a PDF, page by page, stopping once the cap is reached or the
 * clock runs out — a 25 MB scan of four hundred pages does not get to hold
 * the process for minutes to produce text nobody will be shown.
 */
export async function pdfText(
  data: Buffer,
  { maxBytes = MAX_TEXT_BYTES, timeoutMs = PDF_EXTRACT_TIMEOUT_MS } = {},
): Promise<{ text: string; truncated: boolean; pages: number }> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(data), {
    disableFontFace: true,
    useSystemFonts: false,
  });
  const pages = doc.numPages;
  const deadline = Date.now() + timeoutMs;
  const parts: string[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (let i = 1; i <= pages; i++) {
      if (Date.now() > deadline || size > maxBytes) {
        truncated = true;
        break;
      }
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => {
          const t = item as { str?: string; hasEOL?: boolean };
          return (t.str ?? "") + (t.hasEOL ? "\n" : "");
        })
        .join("")
        .trim();
      const part = `--- page ${i} of ${pages} ---\n${text}`;
      parts.push(part);
      size += Buffer.byteLength(part) + 2;
    }
  } finally {
    await doc.loadingTask.destroy().catch(() => {});
  }
  const capped = capUtf8(parts.join("\n\n"), maxBytes);
  return { text: capped.text, truncated: truncated || capped.truncated, pages };
}
