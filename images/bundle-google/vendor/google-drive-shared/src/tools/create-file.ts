import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { errorResult, type Tool } from '../tools.js';
import { parseFileId } from '../utils/file-id.js';
import { CONVERT_TO, describeMimeType, inferMimeType } from '../utils/mime.js';
import { decodeContent, MAX_UPLOAD_BYTES } from '../utils/content.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  name: 'The new file\'s name, with its extension, e.g. "meeting-notes.md" or "q3.csv".',
  content: 'The file\'s text, UTF-8. Pass this OR content_base64.',
  content_base64:
    'The file\'s bytes, standard base64 (not base64url), for a binary file such as a PNG. Pass this OR content.',
  mime_type:
    'The type of the content, e.g. "text/markdown" or "image/png". Default: inferred from the name\'s ' +
    'extension (.txt, .md, .csv, .tsv, .json, .html, .pdf, .png, .jpg, .gif, .webp, .svg), else ' +
    'text/plain for content and application/octet-stream for content_base64.',
  parent_folder_id:
    'The folder to create it in: an id or folder URL. Default: the top of My Drive. Under the ' +
    'least-privileged credential this has to be a folder this server created.',
  convert_to:
    'Convert the upload into a Google-native file on the way in. document: a Google Doc, from ' +
    'text/plain, text/markdown or text/html. spreadsheet: a Google Sheet, from text/csv or ' +
    'text/tab-separated-values. Default: none, the file is stored as uploaded.',
} as const;

export const CreateFileSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    content: z.string().optional(),
    content_base64: z.string().optional(),
    mime_type: z.string().min(1).optional(),
    parent_folder_id: z.string().min(1).optional(),
    convert_to: z.enum(['document', 'spreadsheet']).optional(),
  })
  .refine((v) => (v.content === undefined) !== (v.content_base64 === undefined), {
    message: 'pass exactly one of content or content_base64',
    path: ['content'],
  });

const TOOL_DESCRIPTION = `Create a new file in Google Drive from text or bytes.

Always creates a NEW file with a new id. It never overwrites, edits or replaces
an existing file, even one with the same name in the same folder — Drive allows
duplicate names, so a retried call leaves two files. To change a file that
already exists, use replace_file_content, where this server offers it.

**Returns** the new file's id and link:

Created "meeting-notes.md" (Google Doc, converted from text/markdown)
**ID:** 1Ze4...Rt
**Link:** https://docs.google.com/document/d/1Ze4...Rt/edit

**convert_to** turns the upload into a Google-native file: text, Markdown or HTML
into a formatted Google Doc, CSV or TSV into a Google Sheet. Without it the file
is stored exactly as given. The name is kept as given, extension included.

**Limits:** ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB decoded. Which parent folders work: with the
least-privileged credential (scope drive.file) only folders this server created,
or the top of My Drive.

**Use cases:**
- Save a report or meeting notes as a Google Doc (convert_to="document")
- Export a table as a Google Sheet (CSV content, convert_to="spreadsheet")
- Store a generated JSON or CSV file as-is
- Save a chart image (content_base64, mime_type="image/png")`;

export function createFileTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'create_file',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: PARAM_DESCRIPTIONS.name },
        content: { type: 'string', description: PARAM_DESCRIPTIONS.content },
        content_base64: { type: 'string', description: PARAM_DESCRIPTIONS.content_base64 },
        mime_type: { type: 'string', description: PARAM_DESCRIPTIONS.mime_type },
        parent_folder_id: { type: 'string', description: PARAM_DESCRIPTIONS.parent_folder_id },
        convert_to: {
          type: 'string',
          enum: ['document', 'spreadsheet'],
          description: PARAM_DESCRIPTIONS.convert_to,
        },
      },
      required: ['name'],
    },
    annotations: {
      title: 'Create a Drive file',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (args) => {
      try {
        const parsed = CreateFileSchema.parse(args ?? {});
        const content = decodeContent(parsed.content, parsed.content_base64, 'create_file');

        const mimeType = parsed.mime_type ?? inferMimeType(parsed.name, parsed.content_base64 !== undefined);
        let convertTo: string | undefined;
        if (parsed.convert_to) {
          const target = CONVERT_TO[parsed.convert_to];
          if (!(target.from as readonly string[]).includes(mimeType)) {
            throw new Error(
              `convert_to="${parsed.convert_to}" builds from ${target.from.join(', ')}, not ${mimeType}. ` +
                'Set mime_type, or name the file with a matching extension.'
            );
          }
          convertTo = target.mimeType;
        }
        const file = await clientFactory().createFile({
          name: parsed.name,
          mimeType,
          content,
          parentId: parsed.parent_folder_id ? parseFileId(parsed.parent_folder_id) : undefined,
          convertTo,
        });

        let output = `Created "${file.name ?? parsed.name}" (${describeMimeType(file.mimeType ?? convertTo ?? mimeType)}`;
        output += convertTo ? `, converted from ${mimeType})\n` : ')\n';
        output += `**ID:** ${file.id}\n`;
        if (file.webViewLink) output += `**Link:** ${file.webViewLink}\n`;
        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('create-file-tool', error);
        return errorResult('Error creating Drive file', error);
      }
    },
  };
}
