import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { errorResult, type Tool } from '../tools.js';
import { parseFileId } from '../utils/file-id.js';
import { CONVERT_TO, describeMimeType, GOOGLE_DOC, GOOGLE_SHEET, GOOGLE_SHORTCUT } from '../utils/mime.js';
import { decodeContent, MAX_UPLOAD_BYTES } from '../utils/content.js';
import { FOLDER_MIME_TYPE } from '../drive-client/files.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  file_id:
    'The file to overwrite: its id (search_files returns it) or any Drive or Docs URL for it, e.g. ' +
    'https://docs.google.com/document/d/1hX9.../edit.',
  content: 'The new content, UTF-8 text. Pass this OR content_base64.',
  content_base64:
    'The new content as standard base64 (not base64url), for a binary file such as a PNG. Pass this OR content.',
  mime_type:
    'What the content is. For a Google Doc: text/markdown (default), text/plain or text/html, and ' +
    'Drive converts it into the Doc. For any other file: the file\'s own type, which is the default; ' +
    'a different type is refused.',
} as const;

export const ReplaceFileContentSchema = z
  .object({
    file_id: z.string().min(1),
    content: z.string().optional(),
    content_base64: z.string().optional(),
    mime_type: z.string().min(1).optional(),
  })
  .refine((v) => (v.content === undefined) !== (v.content_base64 === undefined), {
    message: 'pass exactly one of content or content_base64',
    path: ['content'],
  });

const TOOL_DESCRIPTION = `Overwrite the whole content of an existing Drive file, keeping its id, name, folder and sharing.

A **Google Doc** is rebuilt from text, Markdown or HTML: Markdown headings, lists,
links and tables become Doc formatting. Everything in the Doc is replaced, so
read it first (read_file, format="markdown"), edit that text, and send all of it
back. Comments anchored to replaced text lose their anchor. A **stored file**
(.md, .txt, .csv, .json, an image, …) gets the new bytes as they are, and keeps
its type.

Refused: folders, shortcuts (pass the target's id), Google Sheets (a CSV upload
would replace every tab with one, and drop formulas and formatting; edit cells
with the google-sheets server instead), and Slides, Forms and Drawings, which
Drive cannot build from text.

**Returns** what was written:

Replaced the content of "Q3 plan" (Google Doc, converted from text/markdown)
**ID:** 1hX9...Qk
**Modified:** 2026-10-13T09:12:44.000Z
**Link:** https://docs.google.com/document/d/1hX9...Qk/edit
The previous content is in the file's version history.

**Undo:** Drive keeps the earlier version. A Doc's is under File → Version
history, and a stored file's under Manage versions (kept 30 days).

**Limits:** ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB decoded. Editing a file someone else made needs the full
drive scope. Under drive.file, only files this server created can be overwritten.

**Use cases:**
- Rewrite a Google Doc from an edited Markdown draft
- Update a notes.md or data.json file in place, keeping its link
- Replace a chart image that other documents link to`;

export function replaceFileContentTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'replace_file_content',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: PARAM_DESCRIPTIONS.file_id },
        content: { type: 'string', description: PARAM_DESCRIPTIONS.content },
        content_base64: { type: 'string', description: PARAM_DESCRIPTIONS.content_base64 },
        mime_type: { type: 'string', description: PARAM_DESCRIPTIONS.mime_type },
      },
      required: ['file_id'],
    },
    annotations: {
      title: 'Replace a Drive file\'s content',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args) => {
      try {
        const parsed = ReplaceFileContentSchema.parse(args ?? {});
        const content = decodeContent(parsed.content, parsed.content_base64, 'replace_file_content');
        const client = clientFactory();
        const file = await client.getFile(parseFileId(parsed.file_id));
        const current = file.mimeType ?? '';

        let mimeType: string;
        if (current === GOOGLE_DOC) {
          mimeType = parsed.mime_type ?? 'text/markdown';
          if (!(CONVERT_TO.document.from as readonly string[]).includes(mimeType)) {
            throw new Error(
              `A Google Doc is rebuilt from ${CONVERT_TO.document.from.join(', ')}, not ${mimeType}.`
            );
          }
        } else if (current === FOLDER_MIME_TYPE) {
          throw new Error(`"${file.name}" is a folder, which has no content. Rename it with update_file_metadata.`);
        } else if (current === GOOGLE_SHORTCUT) {
          throw new Error(
            `"${file.name}" is a shortcut. Pass the file it points to: file_id="${file.shortcutDetails?.targetId ?? '?'}".`
          );
        } else if (current === GOOGLE_SHEET) {
          throw new Error(
            'A Google Sheet is not overwritten here: a CSV upload would replace every tab with one and ' +
              'drop formulas and formatting. Edit its cells with the google-sheets server, or ' +
              'create_file a new Sheet from CSV.'
          );
        } else if (current.startsWith('application/vnd.google-apps.')) {
          throw new Error(`Drive cannot rebuild a ${describeMimeType(current)} from uploaded content.`);
        } else {
          mimeType = parsed.mime_type ?? current;
          if (mimeType !== current) {
            throw new Error(
              `"${file.name}" is ${current}, and replace_file_content keeps a stored file's type. ` +
                `To store ${mimeType}, create_file a new file instead.`
            );
          }
        }

        const updated = await client.updateFileContent(file.id, mimeType, content);
        const kind = describeMimeType(updated.mimeType ?? current);
        let output = `Replaced the content of "${updated.name ?? file.name}" (${kind}`;
        output += current === GOOGLE_DOC ? `, converted from ${mimeType})\n` : ')\n';
        output += `**ID:** ${updated.id}\n`;
        if (updated.modifiedTime) output += `**Modified:** ${updated.modifiedTime}\n`;
        if (updated.webViewLink) output += `**Link:** ${updated.webViewLink}\n`;
        output += "The previous content is in the file's version history.\n";
        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('replace-file-content-tool', error);
        return errorResult('Error replacing Drive file content', error);
      }
    },
  };
}
