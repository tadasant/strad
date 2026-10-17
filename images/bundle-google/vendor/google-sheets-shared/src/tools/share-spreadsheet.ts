import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { parseSpreadsheetId } from '../utils/parse-spreadsheet-id.js';
import { logError } from '../logging.js';

const PARAM_DESCRIPTIONS = {
  spreadsheet_id:
    'The spreadsheet id, or its full URL (https://docs.google.com/spreadsheets/d/{ID}/edit). ' +
    'An uploaded .xlsx/.csv in Drive can be shared too.',
  type:
    'Who gets access: "user" (one email address), "group" (a Google group\'s address), ' +
    '"domain" (everyone in a Workspace domain), or "anyone" (anyone with the link).',
  role: 'What they may do: "reader" (view), "commenter" (view and comment), or "writer" (edit).',
  email_address:
    'The person\'s or group\'s email address, e.g. "julie@example.com". Required when type is "user" or "group".',
  domain: 'The Workspace domain, e.g. "example.com". Required when type is "domain".',
  send_notification_email:
    "Whether Google emails the grantee a link. Defaults to Google's own default — true " +
    'for user and group, and always false for domain and anyone, which have no address ' +
    'to notify. Set false to share silently.',
} as const;

export const ShareSpreadsheetSchema = z
  .object({
    spreadsheet_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.spreadsheet_id),
    type: z.enum(['user', 'group', 'domain', 'anyone']).describe(PARAM_DESCRIPTIONS.type),
    role: z.enum(['reader', 'commenter', 'writer']).describe(PARAM_DESCRIPTIONS.role),
    // Checked as an address only where it is sent: an `anyone` or `domain`
    // grant drops it, so a stray one there is not worth refusing the grant.
    email_address: z.string().optional().describe(PARAM_DESCRIPTIONS.email_address),
    domain: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.domain),
    send_notification_email: z
      .boolean()
      .optional()
      .describe(PARAM_DESCRIPTIONS.send_notification_email),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'user' || data.type === 'group') {
      if (!data.email_address) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `email_address is required when type is "${data.type}"`,
          path: ['email_address'],
        });
      } else if (!z.string().email().safeParse(data.email_address).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${data.email_address}" is not an email address`,
          path: ['email_address'],
        });
      }
    }
    if (data.type === 'domain' && !data.domain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'domain is required when type is "domain"',
        path: ['domain'],
      });
    }
    // Google cannot email a domain or "anyone", and refuses the whole grant if
    // asked to. Saying so here is cheaper than its 400.
    if ((data.type === 'domain' || data.type === 'anyone') && data.send_notification_email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `send_notification_email cannot be true when type is "${data.type}" — there is no address to notify`,
        path: ['send_notification_email'],
      });
    }
  });

const TOOL_DESCRIPTION = `Share a Google Sheets spreadsheet with a person, a group, a Workspace domain, or anyone with the link.

Adds a Drive permission to the file, acting as this slug's Google account. This
GRANTS SOMEONE ELSE ACCESS, and nothing in this server takes it back — removing a
grant is a human's job, in the Sheets UI's Share dialog.

**Parameters:**
- spreadsheet_id: id or full Sheets URL (required)
- type: "user" | "group" | "domain" | "anyone" (required)
- role: "reader" | "commenter" | "writer" (required)
- email_address: required for "user" and "group"
- domain: required for "domain"
- send_notification_email: optional; Google's default emails a user or group

**Returns:** the permission id, what was granted to whom, and the spreadsheet URL.

**Example:** { "spreadsheet_id": "1Bxi…upms", "type": "user", "role": "writer", "email_address": "julie@example.com" }

type "anyone" makes a public link — prefer a named user. The account must own
the file or be an editor of it. Needs the https://www.googleapis.com/auth/drive
scope; a token without it fails naming the scope and the Reconnect step.`;

/** A refused argument reads as a sentence per issue, not as Zod's JSON dump. */
function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

export function shareSpreadsheetTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'share_spreadsheet',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: PARAM_DESCRIPTIONS.spreadsheet_id },
        type: {
          type: 'string',
          enum: ['user', 'group', 'domain', 'anyone'],
          description: PARAM_DESCRIPTIONS.type,
        },
        role: {
          type: 'string',
          enum: ['reader', 'commenter', 'writer'],
          description: PARAM_DESCRIPTIONS.role,
        },
        email_address: { type: 'string', description: PARAM_DESCRIPTIONS.email_address },
        domain: { type: 'string', description: PARAM_DESCRIPTIONS.domain },
        send_notification_email: {
          type: 'boolean',
          description: PARAM_DESCRIPTIONS.send_notification_email,
        },
      },
      required: ['spreadsheet_id', 'type', 'role'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = ShareSpreadsheetSchema.parse(args ?? {});
        const spreadsheetId = parseSpreadsheetId(parsed.spreadsheet_id);
        const client = clientFactory();

        const sendNotificationEmail =
          parsed.send_notification_email ??
          (parsed.type === 'anyone' || parsed.type === 'domain' ? false : undefined);

        const permission = await client.createPermission(spreadsheetId, {
          type: parsed.type,
          role: parsed.role,
          // Only the field the type uses: Drive rejects a stray emailAddress on
          // a domain grant rather than ignoring it.
          emailAddress:
            parsed.type === 'user' || parsed.type === 'group' ? parsed.email_address : undefined,
          domain: parsed.type === 'domain' ? parsed.domain : undefined,
          sendNotificationEmail,
        });

        const grantee =
          parsed.type === 'anyone'
            ? 'anyone with the link'
            : parsed.type === 'domain'
              ? `everyone in ${permission.domain ?? parsed.domain}`
              : `${permission.emailAddress ?? parsed.email_address} (${parsed.type})`;
        const lines = [
          `Shared spreadsheet ${spreadsheetId}: ${grantee} is now a ${permission.role ?? parsed.role}.`,
          '',
          `- **Permission ID:** ${permission.id ?? '(not returned)'}`,
          ...(sendNotificationEmail === undefined
            ? []
            : [`- **Notification email:** ${sendNotificationEmail ? 'sent' : 'not sent'}`]),
          `- **URL:** https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        ];

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        logError('share-spreadsheet-tool', error);
        return {
          content: [{ type: 'text', text: `Error sharing spreadsheet: ${describeError(error)}` }],
          isError: true,
        };
      }
    },
  };
}
