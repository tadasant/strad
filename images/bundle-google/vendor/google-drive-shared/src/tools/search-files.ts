import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { errorResult, type Tool } from '../tools.js';
import { FILE_TYPES } from '../utils/mime.js';
import { parseFileId } from '../utils/file-id.js';
import { buildQuery, ORDER_BY, resolveOrderBy } from '../utils/query.js';
import { fileLine } from '../utils/render.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  query:
    'Words to find in a file\'s name OR its content (Drive full-text search), e.g. "Q3 board deck" ' +
    'or "invoice 4471". Results come back by relevance, and order_by cannot be combined with it.',
  name_contains: 'Only files whose NAME contains this text, e.g. "budget". Case-insensitive.',
  type:
    'Only one kind of file. folder | document (Google Doc) | spreadsheet (Google Sheet) | ' +
    'presentation (Google Slides) | pdf | image | video. Cannot be combined with mime_type.',
  mime_type: 'Only files of this exact mime type, e.g. "text/csv" or "application/zip". Use type for the common kinds.',
  folder_id:
    'Only the direct children of this folder: its id or its Drive URL. Not recursive. ' +
    'With no other filter this lists the folder.',
  modified_after: 'Only files modified after this time. ISO 8601, e.g. "2026-10-01" or "2026-10-01T09:00:00Z".',
  shared_with_me: 'If true, only files other people shared with this account ("Shared with me"). Default: false.',
  include_trashed: 'If true, files in the trash are included. Default: false.',
  order_by:
    'Sort order when no query is given. modified (default): most recently modified first. ' +
    'created: newest first. name: alphabetical.',
  limit: 'How many files to return. Default: 25. Max: 100.',
  page_token: 'The next_page_token from a previous call, to get the next page of the same search.',
} as const;

export const SearchFilesSchema = z.object({
  query: z.string().min(1).optional(),
  name_contains: z.string().min(1).optional(),
  type: z.enum(Object.keys(FILE_TYPES) as [keyof typeof FILE_TYPES, ...Array<keyof typeof FILE_TYPES>]).optional(),
  mime_type: z.string().min(1).optional(),
  folder_id: z.string().min(1).optional(),
  modified_after: z.string().min(1).optional(),
  shared_with_me: z.boolean().default(false),
  include_trashed: z.boolean().default(false),
  order_by: z.enum(Object.keys(ORDER_BY) as ['modified', 'created', 'name']).optional(),
  limit: z.number().int().min(1).max(100).default(25),
  page_token: z.string().min(1).optional(),
});

const TOOL_DESCRIPTION = `Find files and folders in Google Drive, or list what is in a folder.

Searches every drive the account can see — My Drive, "Shared with me" and shared
drives. Call it first whenever you do not already have a file's id: get_file,
read_file and the create tools all take the id it returns.

With no arguments it returns the 25 most recently modified files. Filters combine
with AND.

**Returns** one line per file — name, id, kind, size, modified time, owner, link:

- **Q3 board deck** — id \`1hX9...Qk\`, Google Slides, modified 2026-10-02T16:04:11.000Z, owner Ana Ruiz <ana@example.com>
  https://docs.google.com/presentation/d/1hX9...Qk/edit

and, when there are more, a next_page_token to pass back as page_token.

**Use cases:**
- "Find the 2026 budget spreadsheet": name_contains="budget", type="spreadsheet"
- "Which docs mention Acme?": query="Acme", type="document"
- "What is in this folder?": folder_id=<id or folder URL>
- "What changed this week?": modified_after="2026-10-06"
- "What did people share with me?": shared_with_me=true

Folders are files here (type="folder"); a shortcut is listed with the id of the
file it points to. Searching is not recursive: folder_id lists direct children.`;

export function searchFilesTool(clientFactory: ClientFactory): Tool {
  return {
    name: 'search_files',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: PARAM_DESCRIPTIONS.query },
        name_contains: { type: 'string', description: PARAM_DESCRIPTIONS.name_contains },
        type: { type: 'string', enum: Object.keys(FILE_TYPES), description: PARAM_DESCRIPTIONS.type },
        mime_type: { type: 'string', description: PARAM_DESCRIPTIONS.mime_type },
        folder_id: { type: 'string', description: PARAM_DESCRIPTIONS.folder_id },
        modified_after: { type: 'string', description: PARAM_DESCRIPTIONS.modified_after },
        shared_with_me: { type: 'boolean', description: PARAM_DESCRIPTIONS.shared_with_me },
        include_trashed: { type: 'boolean', description: PARAM_DESCRIPTIONS.include_trashed },
        order_by: { type: 'string', enum: Object.keys(ORDER_BY), description: PARAM_DESCRIPTIONS.order_by },
        limit: { type: 'number', minimum: 1, maximum: 100, description: PARAM_DESCRIPTIONS.limit },
        page_token: { type: 'string', description: PARAM_DESCRIPTIONS.page_token },
      },
    },
    annotations: {
      title: 'Search Google Drive',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args) => {
      try {
        const parsed = SearchFilesSchema.parse(args ?? {});
        const q = buildQuery({
          query: parsed.query,
          nameContains: parsed.name_contains,
          type: parsed.type,
          mimeType: parsed.mime_type,
          folderId: parsed.folder_id ? parseFileId(parsed.folder_id) : undefined,
          modifiedAfter: parsed.modified_after,
          sharedWithMe: parsed.shared_with_me,
          includeTrashed: parsed.include_trashed,
        });
        const orderBy = resolveOrderBy(parsed.query !== undefined, parsed.order_by);

        const result = await clientFactory().listFiles({
          q,
          pageSize: parsed.limit,
          pageToken: parsed.page_token,
          orderBy,
        });

        const files = result.files ?? [];
        let output = files.length === 0 ? 'No files matched.\n' : `${files.length} file(s):\n\n${files.map(fileLine).join('\n')}\n`;
        if (result.incompleteSearch) {
          output +=
            '\n**Incomplete search:** Drive searched only part of this account\'s shared drives, so a ' +
            'file missing from these results may still exist. Narrow the search (folder_id, type) and retry.\n';
        }
        if (result.nextPageToken) {
          output += `\nMore results: call again with page_token="${result.nextPageToken}" and the same filters.\n`;
        }
        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        logError('search-files-tool', error);
        return errorResult('Error searching Drive', error);
      }
    },
  };
}
