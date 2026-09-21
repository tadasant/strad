import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  title: "The new spreadsheet's file name.",
  sheets:
    'The tabs to create, in order. Omit it and Google makes one tab named "Sheet1". ' +
    'Each is { title, headers? }: headers, if given, fill row 1 and freeze it.',
} as const;

/** Sheets' own ceiling on columns (ZZZ), so a header row past it is refused here. */
const MAX_COLUMNS = 18278;

export const CreateSpreadsheetSchema = z.object({
  title: z.string().trim().min(1).describe(PARAM_DESCRIPTIONS.title),
  sheets: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        headers: z.array(z.string()).max(MAX_COLUMNS).optional(),
      })
    )
    .optional()
    .describe(PARAM_DESCRIPTIONS.sheets)
    // Sheets refuses two tabs whose titles differ only by case, and it refuses
    // the whole create for it. Saying which title here is cheaper than a 400.
    .superRefine((sheets, ctx) => {
      const seen = new Set<string>();
      for (const sheet of sheets ?? []) {
        const key = sheet.title.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Two tabs are titled "${sheet.title}". Tab titles must be unique, ignoring case.`,
          });
        }
        seen.add(key);
      }
    }),
});

const TOOL_DESCRIPTION = `Create a new, native Google Sheets spreadsheet owned by this slug's Google account.

**Parameters:**
- title: the file name (required)
- sheets: the tabs, in order — each { title, headers? }. headers fill row 1 and freeze it. Default: one tab, "Sheet1"

**Returns:** the new spreadsheet's id and URL, and each tab's title and gid.

The file lands in the root of the account's Google Drive and is shared with no
one. This server cannot move it into a folder or share it: both are Drive
operations, and it asks for no Drive write scope.

EVERY CALL MAKES A NEW FILE. It is not idempotent: if a call fails or times out,
look for the file before calling again, or you may leave a duplicate behind.
Nothing here deletes a spreadsheet, so a stray one is a human's to remove.`;

/** A refused argument reads as a sentence per issue, not as Zod's JSON dump. */
function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

export function createSpreadsheetTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'create_spreadsheet',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: PARAM_DESCRIPTIONS.title },
        sheets: {
          type: 'array',
          description: PARAM_DESCRIPTIONS.sheets,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: "The tab's title." },
              headers: {
                type: 'array',
                items: { type: 'string' },
                description: 'Column headers for row 1, left to right. Row 1 is frozen.',
              },
            },
            required: ['title'],
          },
        },
      },
      required: ['title'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = CreateSpreadsheetSchema.parse(args ?? {});
        const client = clientFactory();

        const created = await client.createSpreadsheet({
          title: parsed.title,
          sheets: parsed.sheets,
        });

        const id = created.spreadsheetId;
        const url = created.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${id}/edit`;
        const lines = [
          `Created spreadsheet "${created.properties?.title ?? parsed.title}".`,
          '',
          `- **ID:** ${id}`,
          `- **URL:** ${url}`,
          '',
          '**Tabs:**',
          ...(created.sheets ?? []).map((sheet) => {
            const p = sheet.properties ?? {};
            return `- **${p.title ?? '(untitled)'}** — gid ${p.sheetId ?? '?'}`;
          }),
        ];

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        logError('create-spreadsheet-tool', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error creating spreadsheet: ${describeError(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
