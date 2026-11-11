import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { errorResult, type Tool } from '../tools.js';
import { parseFileId } from '../utils/file-id.js';
import { describeMimeType, GOOGLE_SHORTCUT } from '../utils/mime.js';
import { FOLDER_MIME_TYPE } from '../drive-client/files.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  file_id: 'The file to copy: its id (search_files returns it) or any Drive or Docs URL for it.',
  name: 'The copy\'s name. Default: Drive\'s own, "Copy of <name>".',
  parent_folder_id: 'The folder to put the copy in: an id or folder URL. Default: the original\'s folder.',
} as const;

export const CopyFileSchema = z.object({
  file_id: z.string().min(1),
  name: z.string().trim().min(1).max(255).optional(),
  parent_folder_id: z.string().min(1).optional(),
});

const TOOL_DESCRIPTION = `Copy a Drive file into a new file with its own id. The original is not changed.

A copy of a Google Doc, Sheet or Slides deck is a full, editable copy, without
the original's comments. It does not carry over the original's own sharing, but
it does inherit the sharing of the folder it lands in: by default the original's
folder, and in a shared drive every member of that drive. Folders cannot be
copied, since Drive has no such call, and a shortcut is refused in favour of the
file it points to.

**Returns** the new file:

Copied "Proposal template" to "Acme proposal" (Google Doc)
**ID:** 1Ze4...Rt
**Link:** https://docs.google.com/document/d/1Ze4...Rt/edit

**Use cases:**
- Start a document from a template, under its own name and folder
- Duplicate a spreadsheet into another project's folder`;

export function copyFileTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'copy_file',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: PARAM_DESCRIPTIONS.file_id },
        name: { type: 'string', description: PARAM_DESCRIPTIONS.name },
        parent_folder_id: { type: 'string', description: PARAM_DESCRIPTIONS.parent_folder_id },
      },
      required: ['file_id'],
    },
    annotations: {
      title: 'Copy a Drive file',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (args) => {
      try {
        const parsed = CopyFileSchema.parse(args ?? {});
        const client = clientFactory();
        const source = await client.getFile(parseFileId(parsed.file_id));
        if (source.mimeType === FOLDER_MIME_TYPE) {
          throw new Error(
            `"${source.name}" is a folder, and Drive cannot copy a folder. Create one with create_folder ` +
              'and copy the files into it one at a time.'
          );
        }
        if (source.mimeType === GOOGLE_SHORTCUT) {
          throw new Error(
            `"${source.name}" is a shortcut. Copy the file it points to: ` +
              `file_id="${source.shortcutDetails?.targetId ?? '?'}".`
          );
        }
        const copy = await client.copyFile({
          fileId: source.id,
          name: parsed.name,
          parentId: parsed.parent_folder_id ? parseFileId(parsed.parent_folder_id) : undefined,
        });
        let output = `Copied "${source.name}" to "${copy.name ?? parsed.name}" (${describeMimeType(copy.mimeType ?? source.mimeType)})\n`;
        output += `**ID:** ${copy.id}\n`;
        if (copy.webViewLink) output += `**Link:** ${copy.webViewLink}\n`;
        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('copy-file-tool', error);
        return errorResult('Error copying Drive file', error);
      }
    },
  };
}
