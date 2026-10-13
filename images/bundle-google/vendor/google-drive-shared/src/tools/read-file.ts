import { z } from 'zod';
import type { ClientFactory, IGoogleDriveClient } from '../server.js';
import { errorResult, type Tool, type ToolResult } from '../tools.js';
import { parseFileId } from '../utils/file-id.js';
import {
  describeMimeType,
  EXPORT_FORMATS,
  exportMimeType,
  GOOGLE_SHEET,
  GOOGLE_SHORTCUT,
  IMAGE_MIME_TYPES,
  isTextMimeType,
  type ReadFormat,
} from '../utils/mime.js';
import { FOLDER_MIME_TYPE } from '../drive-client/files.js';
import type { DriveFile } from '../types.js';
import { logError } from '../logging.js';

/** Google's own ceiling on an export, and the same bound for a stored text file. */
export const MAX_TEXT_BYTES = 10 * 1024 * 1024;
/** An image is returned whole, base64 in the result, so it gets a tighter bound. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 25_000;
export const MAX_MAX_CHARS = 100_000;

const PARAM_DESCRIPTIONS = {
  file_id: 'The file: its id (search_files returns it) or any Drive or Docs URL for it.',
  format:
    'For a Google-native file, the text format to export it as. A Google Doc: markdown (default), ' +
    'text or html. A Google Sheet: csv (the first tab only). Google Slides: text. Ignored for any ' +
    'other file, which is returned as stored.',
  start_char: 'The character to start at, for reading a long file in pages. Default: 0.',
  max_chars: `The most characters to return in one call. Default: ${DEFAULT_MAX_CHARS}. Max: ${MAX_MAX_CHARS}.`,
} as const;

export const ReadFileSchema = z.object({
  file_id: z.string().min(1),
  format: z.enum(['markdown', 'text', 'html', 'csv']).optional(),
  start_char: z.number().int().min(0).default(0),
  max_chars: z.number().int().min(1).max(MAX_MAX_CHARS).default(DEFAULT_MAX_CHARS),
});

const TOOL_DESCRIPTION = `Read the content of a Drive file as text, or see an image.

- **Google Docs** export as Markdown by default (headings, lists, tables and links
  survive), or as plain text or HTML.
- **Google Sheets** export as CSV — Drive exports the FIRST TAB only. For other
  tabs, ranges or formulas use the google-sheets server.
- **Google Slides** export as plain text, slide by slide.
- **Stored text files** (.txt, .md, .csv, .json, .xml, .html, source code) come back
  as stored.
- **Images** (PNG, JPEG, GIF, WebP, up to 5MB) come back as an image you can see.
- Anything else — PDF, .docx, .xlsx, video, zip — is refused with the file's link.
  get_file says in advance which of these a file is.

A shortcut is followed to the file it points to.

**Long files are paged.** The result starts with a line such as

  Google Doc "Q3 plan", exported as markdown — characters 0 to 25000 of 81234. More: start_char=25000

and you read on by calling again with that start_char.

**Use cases:**
- Summarise or quote a document someone linked
- Read a meeting-notes doc found with search_files
- Pull a CSV or JSON file's data into the conversation
- Look at a diagram or screenshot stored in Drive`;

async function resolveShortcut(client: IGoogleDriveClient, file: DriveFile): Promise<DriveFile> {
  if (file.mimeType !== GOOGLE_SHORTCUT) return file;
  const target = file.shortcutDetails?.targetId;
  if (!target) throw new Error(`"${file.name}" is a shortcut whose target Drive did not return.`);
  return client.getFile(target);
}

function page(file: DriveFile, how: string, text: string, start: number, max: number, note?: string): ToolResult {
  const total = text.length;
  if (start > 0 && start >= total) {
    return {
      content: [{ type: 'text', text: `start_char=${start} is past the end of "${file.name}", which has ${total} characters.` }],
      isError: true,
    };
  }
  const end = Math.min(start + max, total);
  let header = `${describeMimeType(file.mimeType)} "${file.name ?? file.id}", ${how}`;
  header +=
    start === 0 && end === total
      ? ` — all ${total} characters.`
      : ` — characters ${start} to ${end} of ${total}.${end < total ? ` More: start_char=${end}` : ''}`;
  if (note) header += `\n${note}`;
  return { content: [{ type: 'text', text: `${header}\n\n${text.slice(start, end)}` }] };
}

const decoder = new TextDecoder('utf-8');

export function readFileTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'read_file',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: PARAM_DESCRIPTIONS.file_id },
        format: { type: 'string', enum: ['markdown', 'text', 'html', 'csv'], description: PARAM_DESCRIPTIONS.format },
        start_char: { type: 'number', minimum: 0, description: PARAM_DESCRIPTIONS.start_char },
        max_chars: { type: 'number', minimum: 1, maximum: MAX_MAX_CHARS, description: PARAM_DESCRIPTIONS.max_chars },
      },
      required: ['file_id'],
    },
    annotations: {
      title: 'Read a Drive file',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args) => {
      try {
        const parsed = ReadFileSchema.parse(args ?? {});
        const client = clientFactory();
        const file = await resolveShortcut(client, await client.getFile(parseFileId(parsed.file_id)));
        const mime = file.mimeType ?? '';

        if (mime === FOLDER_MIME_TYPE) {
          throw new Error(`"${file.name}" is a folder. List what is in it with search_files folder_id="${file.id}".`);
        }

        const formats = EXPORT_FORMATS[mime];
        if (formats) {
          const format: ReadFormat = parsed.format ?? formats[0];
          if (!formats.includes(format)) {
            throw new Error(`A ${describeMimeType(mime)} exports as ${formats.join(' or ')}, not ${format}.`);
          }
          const bytes = await client.exportFile(file.id, exportMimeType(format), MAX_TEXT_BYTES);
          const note =
            mime === GOOGLE_SHEET
              ? 'Drive exports only the FIRST TAB of a spreadsheet. For other tabs, use the google-sheets server.'
              : undefined;
          return page(file, `exported as ${format}`, decoder.decode(bytes), parsed.start_char, parsed.max_chars, note);
        }

        if (mime.startsWith('application/vnd.google-apps.')) {
          throw new Error(
            `A ${describeMimeType(mime)} cannot be exported as text. Open it in the browser: ${file.webViewLink ?? file.id}`
          );
        }

        if (isTextMimeType(mime)) {
          const bytes = await client.downloadFile(file.id, MAX_TEXT_BYTES);
          return page(file, 'as stored', decoder.decode(bytes), parsed.start_char, parsed.max_chars);
        }

        if (IMAGE_MIME_TYPES.has(mime)) {
          const bytes = await client.downloadFile(file.id, MAX_IMAGE_BYTES);
          return {
            content: [
              { type: 'text', text: `Image "${file.name ?? file.id}" (${mime}, ${bytes.byteLength} bytes).` },
              { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: mime },
            ],
          };
        }

        throw new Error(
          `"${file.name}" is a ${describeMimeType(mime)}, which read_file does not convert to text. ` +
            `Open it in the browser: ${file.webViewLink ?? file.id}`
        );
      } catch (error) {
        logError('read-file-tool', error);
        return errorResult('Error reading Drive file', error);
      }
    },
  };
}
