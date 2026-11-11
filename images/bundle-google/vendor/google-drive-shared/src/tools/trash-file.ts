import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { errorResult, type Tool } from '../tools.js';
import { parseFileId } from '../utils/file-id.js';
import { FOLDER_MIME_TYPE } from '../drive-client/files.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  file_id: 'The file or folder: its id (search_files returns it) or any Drive or Docs URL for it.',
} as const;

export const TrashFileSchema = z.object({ file_id: z.string().min(1) });

const TRASH_DESCRIPTION = `Move a Drive file or folder to the trash. A trashed folder takes what this account owns inside it along.

This is Drive's own trash, not a deletion. The file stays recoverable with
restore_file for 30 days, after which Drive deletes it for good. This server has
no tool that deletes a file permanently or empties the trash.

**Returns:**

Moved "old draft" to the trash
**ID:** 1hX9...Qk
Restore it with restore_file file_id="1hX9...Qk" within 30 days.

In My Drive only the file's owner may trash it, and in a shared drive only a
manager or content manager; anyone else gets a permission error.

**Use cases:**
- Clean up a file this conversation created by mistake
- Remove a superseded draft after replacing it
- Clear out an old folder of exports`;

const RESTORE_DESCRIPTION = `Take a Drive file or folder out of the trash, usually back into the folder it was trashed from.

Works for 30 days after trash_file (or a human) trashed it. To find a trashed
file's id, use search_files with include_trashed=true. A file that went to the
trash only because its folder did comes back by restoring the folder.

**Returns:**

Restored "old draft" from the trash
**ID:** 1hX9...Qk
**Link:** https://docs.google.com/document/d/1hX9...Qk/edit

**Use cases:**
- Undo a trash_file call
- Recover a file someone trashed by accident`;

function trashTool(clientFactory: ClientFactory, trashed: boolean): Tool {
  return {
    name: trashed ? 'trash_file' : 'restore_file',
    description: trashed ? TRASH_DESCRIPTION : RESTORE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string', description: PARAM_DESCRIPTIONS.file_id } },
      required: ['file_id'],
    },
    annotations: {
      title: trashed ? 'Trash a Drive file' : 'Restore a Drive file from the trash',
      readOnlyHint: false,
      destructiveHint: trashed,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args) => {
      try {
        const parsed = TrashFileSchema.parse(args ?? {});
        const file = await clientFactory().updateFile(parseFileId(parsed.file_id), { trashed });
        let output: string;
        if (trashed) {
          output = `Moved "${file.name}" to the trash\n**ID:** ${file.id}\n`;
          if (file.mimeType === FOLDER_MIME_TYPE) output += 'Everything in the folder that this account owns went with it.\n';
          output += `Restore it with restore_file file_id="${file.id}" within 30 days.\n`;
        } else {
          output = `Restored "${file.name}" from the trash\n**ID:** ${file.id}\n`;
          if (file.webViewLink) output += `**Link:** ${file.webViewLink}\n`;
        }
        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError(trashed ? 'trash-file-tool' : 'restore-file-tool', error);
        return errorResult(trashed ? 'Error trashing Drive file' : 'Error restoring Drive file', error);
      }
    },
  };
}

export function trashFileTool(clientFactory: ClientFactory): Tool {
  return trashTool(clientFactory, true);
}

export function restoreFileTool(clientFactory: ClientFactory): Tool {
  return trashTool(clientFactory, false);
}
