import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { errorResult, type Tool } from '../tools.js';
import { parseFileId } from '../utils/file-id.js';
import type { FileMetadataPatch } from '../drive-client/files.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  file_id: 'The file or folder: its id (search_files returns it) or any Drive or Docs URL for it.',
  name: 'The new name, e.g. "Q3 plan (final)". Keep the extension on a stored file ("notes.md"). Default: unchanged.',
  description:
    'The new description, shown in Drive\'s details pane. An empty string clears it. Default: unchanged.',
} as const;

export const UpdateFileMetadataSchema = z
  .object({
    file_id: z.string().min(1),
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(25000).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'pass name, description, or both',
    path: ['name'],
  });

const TOOL_DESCRIPTION = `Rename a Drive file or folder, or change its description. The content is not touched.

**Returns** the file as it is now:

Updated "Q3 plan (final)"
**ID:** 1hX9...Qk
**Was named:** Q3 plan
**Link:** https://docs.google.com/document/d/1hX9...Qk/edit

Drive allows two files with the same name in one folder, so a rename never fails
on a clash. To move a file to another folder, use move_file.

**Use cases:**
- Rename a draft once it is final
- Give a generated report a dated name
- Note on a file what it is for, in its description`;

export function updateFileMetadataTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'update_file_metadata',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: PARAM_DESCRIPTIONS.file_id },
        name: { type: 'string', description: PARAM_DESCRIPTIONS.name },
        description: { type: 'string', description: PARAM_DESCRIPTIONS.description },
      },
      required: ['file_id'],
    },
    annotations: {
      title: 'Rename or describe a Drive file',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args) => {
      try {
        const parsed = UpdateFileMetadataSchema.parse(args ?? {});
        const client = clientFactory();
        const fileId = parseFileId(parsed.file_id);
        // Read first, so the result can say what it overwrote: a rename or a
        // new description is undone by setting the old one back, and only this
        // call knows what that was.
        const before = await client.getFile(fileId);
        const patch: FileMetadataPatch = {};
        if (parsed.name !== undefined) patch.name = parsed.name;
        if (parsed.description !== undefined) patch.description = parsed.description;
        const file = await client.updateFile(fileId, patch);

        let output = `Updated "${file.name ?? parsed.name ?? fileId}"\n**ID:** ${file.id}\n`;
        if (parsed.name !== undefined && before.name !== file.name) output += `**Was named:** ${before.name}\n`;
        if (parsed.description !== undefined) {
          output += parsed.description === '' ? '**Description:** cleared\n' : `**Description:** ${parsed.description}\n`;
          if (before.description && before.description !== parsed.description) {
            output += `**Was described as:** ${before.description}\n`;
          }
        }
        if (file.webViewLink) output += `**Link:** ${file.webViewLink}\n`;
        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('update-file-metadata-tool', error);
        return errorResult('Error updating Drive file', error);
      }
    },
  };
}
