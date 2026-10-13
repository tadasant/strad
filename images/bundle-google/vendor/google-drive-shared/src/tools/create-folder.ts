import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { errorResult, type Tool } from '../tools.js';
import { parseFileId } from '../utils/file-id.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  name: 'The new folder\'s name, e.g. "2026 receipts".',
  parent_folder_id:
    'The folder to create it in: an id or folder URL. Default: the top of My Drive. Under the ' +
    'least-privileged credential this has to be a folder this server created.',
} as const;

export const CreateFolderSchema = z.object({
  name: z.string().trim().min(1).max(255),
  parent_folder_id: z.string().min(1).optional(),
});

const TOOL_DESCRIPTION = `Create a new, empty folder in Google Drive.

Always creates: it never reuses or renames an existing folder, so two calls with
the same name make two folders. Check with search_files (type="folder") first if
one may already exist.

**Returns** the new folder's id and link:

Created folder "2026 receipts"
**ID:** 1Pq7...Wm
**Link:** https://drive.google.com/drive/folders/1Pq7...Wm

Pass that id as parent_folder_id to create_folder or create_file to fill it.

**Which parent folders work.** With the least-privileged credential (scope
drive.file) this server may write only into folders it created itself, or the top
of My Drive. A folder someone made by hand in Drive is refused; create a folder
here and work inside it.

**Use cases:**
- Make a home for files this conversation will produce
- Organise generated reports by month
- Start a project folder, then add notes with create_file`;

export function createFolderTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'create_folder',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: PARAM_DESCRIPTIONS.name },
        parent_folder_id: { type: 'string', description: PARAM_DESCRIPTIONS.parent_folder_id },
      },
      required: ['name'],
    },
    annotations: {
      title: 'Create a Drive folder',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (args) => {
      try {
        const parsed = CreateFolderSchema.parse(args ?? {});
        const parent = parsed.parent_folder_id ? parseFileId(parsed.parent_folder_id) : undefined;
        const folder = await clientFactory().createFolder(parsed.name, parent);
        let output = `Created folder "${folder.name ?? parsed.name}"\n**ID:** ${folder.id}\n`;
        if (folder.webViewLink) output += `**Link:** ${folder.webViewLink}\n`;
        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('create-folder-tool', error);
        return errorResult('Error creating Drive folder', error);
      }
    },
  };
}
