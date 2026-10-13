import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { errorResult, type Tool } from '../tools.js';
import { parseFileId } from '../utils/file-id.js';
import { describeMimeType, EXPORT_FORMATS, GOOGLE_SHORTCUT, IMAGE_MIME_TYPES, isTextMimeType } from '../utils/mime.js';
import { formatBytes, formatUser } from '../utils/render.js';
import { FOLDER_MIME_TYPE } from '../drive-client/files.js';
import type { DriveFile } from '../types.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  file_id:
    'The file or folder: its id (search_files returns it) or any Drive or Docs URL for it, e.g. ' +
    'https://docs.google.com/document/d/1hX9.../edit.',
} as const;

export const GetFileSchema = z.object({
  file_id: z.string().min(1),
});

const TOOL_DESCRIPTION = `Describe one Drive file or folder: what it is, where it lives, who owns it and who it is shared with.

Reads metadata only, never content — use read_file for that.

**Returns**, for example:

# Q3 board deck
**ID:** 1hX9...Qk
**Type:** Google Slides
**Modified:** 2026-10-02T16:04:11.000Z by Ana Ruiz <ana@example.com>
**Owner:** Ana Ruiz <ana@example.com>
**Parent folder(s):** 0B7x...Zt
**Link:** https://docs.google.com/presentation/d/1hX9...Qk/edit
**Shared with:** anyone with the link (reader); ben@example.com (writer)
**This account can:** comment, download
**read_file:** text

"Shared with" lists the sharing entries Drive returns to this account. Drive
omits them where the account may not see the sharing list (often in a shared
drive), and the output says so rather than claiming the file is private.

**Use cases:**
- Check who a document is shared with before quoting from it
- Find the folder a file is in (then search_files with folder_id)
- See whether read_file can read it, and in which formats
- Resolve a shortcut to the file it points to`;

function sharingSummary(file: DriveFile): string {
  if (file.permissions === undefined) {
    return file.shared ? 'shared, but Drive did not return the sharing list to this account' : 'not returned to this account';
  }
  const entries = file.permissions
    .filter((p) => p.role !== 'owner')
    .map((p) => {
      const who =
        p.type === 'anyone'
          ? 'anyone with the link'
          : p.type === 'domain'
            ? `everyone at ${p.domain}`
            : (p.emailAddress ?? p.displayName ?? p.type ?? 'unknown');
      return `${who} (${p.role})`;
    });
  return entries.length === 0 ? 'only the owner' : entries.join('; ');
}

/** What read_file can do with this file, in one phrase. */
export function readability(file: DriveFile): string {
  const mime = file.mimeType ?? '';
  if (mime === FOLDER_MIME_TYPE) return 'a folder has no content; list it with search_files folder_id';
  if (mime === GOOGLE_SHORTCUT) return `follows the shortcut to ${file.shortcutDetails?.targetId ?? 'its target'}`;
  const formats = EXPORT_FORMATS[mime];
  if (formats) return formats.join(', ');
  if (isTextMimeType(mime)) return 'text';
  if (IMAGE_MIME_TYPES.has(mime)) return 'image';
  return 'not readable as text or an image; open the link';
}

export function getFileTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'get_file',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string', description: PARAM_DESCRIPTIONS.file_id } },
      required: ['file_id'],
    },
    annotations: {
      title: 'Describe a Drive file',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args) => {
      try {
        const parsed = GetFileSchema.parse(args ?? {});
        const file = await clientFactory().getFile(parseFileId(parsed.file_id));

        const lines = [`# ${file.name ?? '(untitled)'}`, `**ID:** ${file.id}`, `**Type:** ${describeMimeType(file.mimeType)}`];
        const size = formatBytes(file.size);
        if (size) lines.push(`**Size:** ${size}`);
        if (file.description) lines.push(`**Description:** ${file.description}`);
        if (file.createdTime) lines.push(`**Created:** ${file.createdTime}`);
        if (file.modifiedTime) {
          const by = formatUser(file.lastModifyingUser);
          lines.push(`**Modified:** ${file.modifiedTime}${by ? ` by ${by}` : ''}`);
        }
        const owners = (file.owners ?? []).map(formatUser).filter(Boolean);
        if (owners.length > 0) lines.push(`**Owner:** ${owners.join(', ')}`);
        if (file.driveId) lines.push(`**Shared drive:** ${file.driveId}`);
        if (file.parents?.length) lines.push(`**Parent folder(s):** ${file.parents.join(', ')}`);
        if (file.webViewLink) lines.push(`**Link:** ${file.webViewLink}`);
        if (file.shortcutDetails?.targetId) {
          lines.push(
            `**Shortcut to:** ${file.shortcutDetails.targetId} (${describeMimeType(file.shortcutDetails.targetMimeType)})`
          );
        }
        lines.push(`**Shared with:** ${sharingSummary(file)}`);
        const can = Object.entries(file.capabilities ?? {})
          .filter(([, v]) => v === true)
          .map(([k]) => k.replace(/^can/, '').toLowerCase());
        if (file.capabilities) lines.push(`**This account can:** ${can.length > 0 ? can.join(', ') : 'view only'}`);
        if (file.starred) lines.push('**Starred**');
        if (file.trashed) lines.push('**In the trash**');
        lines.push(`**read_file:** ${readability(file)}`);

        return { content: [{ type: 'text', text: `${lines.join('\n')}\n` }] };
      } catch (error) {
        logError('get-file-tool', error);
        return errorResult('Error describing Drive file', error);
      }
    },
  };
}
