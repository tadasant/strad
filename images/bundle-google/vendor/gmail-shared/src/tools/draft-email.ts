import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { buildGmailDraftsUrl, draftsAccountEmail, getHeader } from '../utils/email-helpers.js';
import {
  ATTACHMENTS_DESCRIPTION,
  ATTACHMENTS_JSON_SCHEMA,
  AttachmentsSchema,
  formatAttachmentList,
  resolveAttachments,
} from '../utils/attachments.js';

const PARAM_DESCRIPTIONS = {
  draft_id:
    'ID of an existing draft to update. If provided, the draft is replaced in-place ' +
    'with the new content. If omitted, a new draft is created. ' +
    'Get draft IDs from list_draft_emails or from a previous upsert_draft_email response. ' +
    'To delete a draft, use delete_draft_email.',
  to: 'Recipient email address(es). For multiple recipients, separate with commas.',
  subject: 'Subject line of the email.',
  plaintext_body:
    'Plain text body content of the email. Write each paragraph as one line and separate paragraphs with a blank line; do not hard-wrap. Lines that look hard-wrapped are joined back into paragraphs before sending; lists, quotes, indented and fenced blocks keep their line breaks. Sent alone, it also goes out as an HTML rendering of itself, so the recipient\'s client flows the paragraphs to the screen. When the email has links, send html_body too, saying the same thing. At least one of plaintext_body or html_body must be provided.',
  html_body:
    'HTML body content of the email. Use it whenever the email has a link: write each link as an <a href> anchor whose text says what it is ("<a href=\"https://…\">this session</a>"), not the raw URL. Send a plaintext_body with the same content beside it, with each URL after its anchor text ("this session: https://…"); the two are sent as one multipart message. Sent without plaintext_body, the email is HTML only. At least one of plaintext_body or html_body must be provided.',
  cc: 'CC recipient email address(es). For multiple, separate with commas.',
  bcc: 'BCC recipient email address(es). For multiple, separate with commas.',
  thread_id:
    'Thread ID to add this draft to an existing conversation. ' +
    'Get this from get_email_conversation. If provided, the draft will be a reply in that thread.',
  reply_to_email_id:
    'Email ID to reply to. If provided, the draft will be formatted as a reply ' +
    'with proper In-Reply-To and References headers. Also requires thread_id.',
  attachments: ATTACHMENTS_DESCRIPTION,
} as const;

export const UpsertDraftEmailSchema = z
  .object({
    draft_id: z.string().optional().describe(PARAM_DESCRIPTIONS.draft_id),
    to: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.to),
    subject: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.subject),
    plaintext_body: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.plaintext_body),
    html_body: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.html_body),
    cc: z.string().optional().describe(PARAM_DESCRIPTIONS.cc),
    bcc: z.string().optional().describe(PARAM_DESCRIPTIONS.bcc),
    thread_id: z.string().optional().describe(PARAM_DESCRIPTIONS.thread_id),
    reply_to_email_id: z.string().optional().describe(PARAM_DESCRIPTIONS.reply_to_email_id),
    attachments: AttachmentsSchema,
  })
  .superRefine((data, ctx) => {
    if (!data.to || !data.subject || (!data.plaintext_body && !data.html_body)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'to, subject, and at least one of plaintext_body or html_body must be provided.',
      });
    }
  });

const TOOL_DESCRIPTION = `Create or update a draft email.

**Parameters:**
- draft_id: ID of an existing draft to update (optional — omit to create a new draft)
- to: Recipient email address(es) (required)
- subject: Email subject line (required)
- plaintext_body: Plain text body content (at least one of plaintext_body or html_body required)
- html_body: HTML body content for rich text formatting (at least one of plaintext_body or html_body required)
- cc: CC recipients (optional)
- bcc: BCC recipients (optional)
- thread_id: Thread ID to reply to an existing conversation (optional)
- reply_to_email_id: Email ID to reply to, sets proper reply headers (optional)
- attachments: Files to attach, each given as an HTTPS \`url\` or as \`content_base64\` + \`filename\` (optional)

**Body content:**
At least one of plaintext_body or html_body must be provided. If both are provided, a multipart email is sent with both plain text and HTML versions; if only plaintext_body is, an HTML rendering of it is sent beside it.

**Links:** when the email links to anything, put the link in html_body as an \`<a href>\` anchor with descriptive text — \`<a href="https://…">this session</a>\`, not the raw URL pasted on its own line — and send a matching plaintext_body with the same words, each URL after its anchor text (\`this session: https://…\`). Use html_body the same way for bold text or lists.

In plaintext_body, write each paragraph as one line and put a blank line between paragraphs — do not hard-wrap at 72-80 columns. Lines that look hard-wrapped are joined back into paragraphs before sending, and a plaintext_body sent alone also goes out as HTML, so the email reads normally on a phone; list items, \`>\` quotes, indented lines and fenced code keep their line breaks.

**Attachments:**
Each attachment provides exactly one of \`url\` (an HTTPS link the server downloads, such as a signed artifact-store URL) or \`content_base64\` (the file bytes, with a required \`filename\`). \`mime_type\` is optional and inferred when omitted. Limits: up to 10 files, 17 MB total, one 60-second budget for every download. Updating a draft replaces its attachments too — include every attachment the draft should keep.

**Creating a reply:**
To create a draft reply to an existing email:
1. Get the thread_id and email_id from get_email_conversation
2. Provide both thread_id and reply_to_email_id parameters

**Updating a draft:**
To update an existing draft, provide the draft_id from a previous upsert_draft_email response or from list_draft_emails. The draft is replaced in-place — all fields must be provided (not just the ones you want to change).

**Deleting a draft:**
Use delete_draft_email with the draft_id. Do not leave a superseded draft behind: update it in place, or delete the old one once its replacement exists.

**Use cases:**
- Draft a new email for later review
- Prepare a reply to an email conversation
- Revise a draft after user feedback (without creating duplicates)
- Save an email without sending it immediately

**Note:** The draft will be saved in Gmail's Drafts folder. The response names the account and links that account's Drafts folder (\`https://mail.google.com/mail/?authuser=<email>#drafts\`); pass the link on to the user so they reach the draft in one click. Use send_email with from_draft_id to send it.`;

export function upsertDraftEmailTool(server: Server, clientFactory: ClientFactory) {
  return {
    name: 'upsert_draft_email',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        draft_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.draft_id,
        },
        to: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.to,
        },
        subject: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.subject,
        },
        plaintext_body: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.plaintext_body,
        },
        html_body: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.html_body,
        },
        cc: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.cc,
        },
        bcc: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.bcc,
        },
        thread_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.thread_id,
        },
        reply_to_email_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.reply_to_email_id,
        },
        attachments: ATTACHMENTS_JSON_SCHEMA,
      },
      required: [],
    },
    handler: async (args: unknown) => {
      try {
        // Zod strips an unknown key, so a caller still sending upstream's
        // `delete: true` with a full draft would get an update instead.
        if (args && typeof args === 'object' && 'delete' in args) {
          throw new Error(
            'upsert_draft_email does not delete drafts. Use delete_draft_email with the draft_id.'
          );
        }
        const parsed = UpsertDraftEmailSchema.parse(args ?? {});
        const client = clientFactory();

        const attachments = await resolveAttachments(parsed.attachments);

        let inReplyTo: string | undefined;
        let references: string | undefined;

        // If replying to an email, get the Message-ID for proper threading
        if (parsed.reply_to_email_id && parsed.thread_id) {
          const originalEmail = await client.getMessage(parsed.reply_to_email_id, {
            format: 'metadata',
            metadataHeaders: ['Message-ID', 'References'],
          });

          const messageId = getHeader(originalEmail, 'Message-ID');
          const originalReferences = getHeader(originalEmail, 'References');

          if (messageId) {
            inReplyTo = messageId;
            // Build references chain
            references = originalReferences ? `${originalReferences} ${messageId}` : messageId;
          }
        }

        const draftOptions = {
          to: parsed.to!,
          subject: parsed.subject!,
          plaintextBody: parsed.plaintext_body,
          htmlBody: parsed.html_body,
          cc: parsed.cc,
          bcc: parsed.bcc,
          threadId: parsed.thread_id,
          inReplyTo,
          references,
          attachments,
        };

        const isUpdate = Boolean(parsed.draft_id);
        const draft = isUpdate
          ? await client.updateDraft(parsed.draft_id!, draftOptions)
          : await client.createDraft(draftOptions);

        const action = isUpdate ? 'updated' : 'created';
        const accountEmail = await draftsAccountEmail(client);
        let responseText = `Draft ${action} successfully!\n\n**Draft ID:** ${draft.id}`;
        if (accountEmail) {
          responseText += `\n**Drafts folder (${accountEmail}):** ${buildGmailDraftsUrl(accountEmail)}`;
        }

        if (parsed.thread_id) {
          responseText += `\n**Thread ID:** ${parsed.thread_id}`;
          responseText += '\n\nThis draft is a reply in an existing conversation.';
        }

        responseText += `\n\n**To:** ${parsed.to}`;
        responseText += `\n**Subject:** ${parsed.subject}`;
        const format =
          parsed.plaintext_body && parsed.html_body
            ? 'Multipart (plain text + HTML)'
            : parsed.html_body
              ? 'HTML'
              : 'Plain text (+ HTML rendering)';
        responseText += `\n**Format:** ${format}`;
        if (parsed.cc) {
          responseText += `\n**CC:** ${parsed.cc}`;
        }
        if (parsed.bcc) {
          responseText += `\n**BCC:** ${parsed.bcc}`;
        }
        if (attachments.length > 0) {
          responseText += `\n**Attachments:** ${formatAttachmentList(attachments)}`;
        }

        responseText += accountEmail
          ? `\n\nUse send_email with from_draft_id parameter to send this draft, or open it from the Drafts folder link above. Give the user that link.`
          : "\n\nUse send_email with from_draft_id parameter to send this draft, or find it in Gmail's Drafts folder.";

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      } catch (error) {
        const typedArgs = args as Record<string, unknown>;
        const errorAction = typedArgs?.draft_id ? 'updating' : 'creating';
        return {
          content: [
            {
              type: 'text',
              text: `Error ${errorAction} draft: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
