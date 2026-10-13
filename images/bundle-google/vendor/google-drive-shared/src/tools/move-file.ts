import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { errorResult, type Tool } from '../tools.js';
import { parseFileId } from '../utils/file-id.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  file_id: 'The file or folder to move: its id (search_files returns it) or any Drive or Docs URL for it.',
  folder_id:
    'The folder to move it into: an id or folder URL, or "root" for the top of My Drive.',
} as const;

export const MoveFileSchema = z.object({
  file_id: z.string().min(1),
  folder_id: z.string().min(1),
});

const TOOL_DESCRIPTION = `Move a Drive file or folder into another folder. A moved folder takes its contents with it.

The file keeps its id, link and content. It leaves every folder it was in and ends
up in exactly one: folder_id.

**Returns:**

Moved "Q3 plan" to folder 0B7x...Zt
**ID:** 1hX9...Qk
**Was in:** 1Pq7...Wm
**Link:** https://docs.google.com/document/d/1hX9...Qk/edit

Pass the "Was in" folder back as folder_id to undo it.

Moving between My Drive and a shared drive, or between shared drives, moves who
owns the file, and Drive allows it only with organizer access there.

**Use cases:**
- File a finished report into its project folder
- Tidy loose files at the top of My Drive into folders
- Move a folder of drafts into an archive folder`;

export function moveFileTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'move_file',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: PARAM_DESCRIPTIONS.file_id },
        folder_id: { type: 'string', description: PARAM_DESCRIPTIONS.folder_id },
      },
      required: ['file_id', 'folder_id'],
    },
    annotations: {
      title: 'Move a Drive file',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args) => {
      try {
        const parsed = MoveFileSchema.parse(args ?? {});
        const client = clientFactory();
        const fileId = parseFileId(parsed.file_id);
        const folderId = parseFileId(parsed.folder_id);
        if (folderId === fileId) throw new Error('A folder cannot be moved into itself.');

        const file = await client.getFile(fileId);
        const from = file.parents ?? [];
        if (from.length === 1 && from[0] === folderId) {
          return { content: [{ type: 'text', text: `"${file.name}" is already in folder ${folderId}. Nothing moved.\n` }] };
        }
        const moved = await client.updateFile(fileId, {}, {
          addParents: folderId,
          removeParents: from.filter((p) => p !== folderId),
        });

        let output = `Moved "${moved.name ?? file.name}" to folder ${folderId}\n**ID:** ${moved.id}\n`;
        if (from.length > 0) output += `**Was in:** ${from.join(', ')}\n`;
        if (moved.webViewLink) output += `**Link:** ${moved.webViewLink}\n`;
        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('move-file-tool', error);
        return errorResult('Error moving Drive file', error);
      }
    },
  };
}
