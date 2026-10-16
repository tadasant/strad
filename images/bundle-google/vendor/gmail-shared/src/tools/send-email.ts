import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import { buildGmailUrl, getHeader } from '../utils/email-helpers.js';
import {
  ATTACHMENTS_DESCRIPTION,
  ATTACHMENTS_JSON_SCHEMA,
  AttachmentsSchema,
  resolveAttachments,
  formatAttachmentList,
} from '../utils/attachments.js';
import {
  requestConfirmation,
  createConfirmationSchema,
  readElicitationConfig,
} from '@pulsemcp/mcp-elicitation';

const PARAM_DESCRIPTIONS = {
  to: 'Recipient email address(es). For multiple recipients, separate with commas.',
  subject: 'Subject line of the email.',
  plaintext_body:
    'Plain text body content of the email. Write each paragraph as one line and separate paragraphs with a blank line; do not hard-wrap. Lines that look hard-wrapped are joined back into paragraphs before sending; lists, quotes, indented and fenced blocks keep their line breaks. Sent alone, it also goes out as an HTML rendering of itself, so the recipient\'s client flows the paragraphs to the screen. When the email has links, send html_body too, saying the same thing. At least one of plaintext_body or html_body must be provided (unless sending a draft).',
  html_body:
    'HTML body content of the email. Use it whenever the email has a link: write each link as an <a href> anchor whose text says what it is ("<a href=\"https://…\">this session</a>"), not the raw URL. Send a plaintext_body with the same content beside it, with each URL after its anchor text ("this session: https://…"); the two are sent as one multipart message. Sent without plaintext_body, the email is HTML only. At least one of plaintext_body or html_body must be provided (unless sending a draft).',
  cc: 'CC recipient email address(es). For multiple, separate with commas.',
  bcc: 'BCC recipient email address(es). For multiple, separate with commas.',
  thread_id:
    'Thread ID to add this email to an existing conversation. ' +
    'Get this from get_email_conversation. If provided, the email will be a reply in that thread.',
  reply_to_email_id:
    'Email ID to reply to. If provided, the email will be formatted as a reply ' +
    'with proper In-Reply-To and References headers. Also requires thread_id.',
  from_draft_id:
    'Draft ID to send. If provided, sends the specified draft instead of composing a new email. ' +
    'When using this, other parameters (to, subject, plaintext_body, etc.) are ignored, and attachments are refused.',
  attachments: ATTACHMENTS_DESCRIPTION,
} as const;

export const SendEmailSchema = z
  .object({
    to: z.string().optional().describe(PARAM_DESCRIPTIONS.to),
    subject: z.string().optional().describe(PARAM_DESCRIPTIONS.subject),
    plaintext_body: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.plaintext_body),
    html_body: z.string().min(1).optional().describe(PARAM_DESCRIPTIONS.html_body),
    cc: z.string().optional().describe(PARAM_DESCRIPTIONS.cc),
    bcc: z.string().optional().describe(PARAM_DESCRIPTIONS.bcc),
    thread_id: z.string().optional().describe(PARAM_DESCRIPTIONS.thread_id),
    reply_to_email_id: z.string().optional().describe(PARAM_DESCRIPTIONS.reply_to_email_id),
    from_draft_id: z.string().optional().describe(PARAM_DESCRIPTIONS.from_draft_id),
    attachments: AttachmentsSchema,
  })
  .refine(
    (data) => {
      // Either from_draft_id is provided, OR to, subject, and one of plaintext_body/html_body are all provided
      if (data.from_draft_id) {
        // A draft carries its own attachments; silently dropping these would
        // let a caller believe it attached files to the send.
        return !data.attachments || data.attachments.length === 0;
      }
      return data.to && data.subject && (data.plaintext_body || data.html_body);
    },
    {
      message:
        'Either provide from_draft_id to send a draft (with no attachments — a draft carries its own), or provide to, subject, and at least one of plaintext_body or html_body to send a new email.',
    }
  );

const TOOL_DESCRIPTION = `Send an email immediately or send a previously created draft.

**Option 1: Send a new email**
- to: Recipient email address(es) (required)
- subject: Email subject line (required)
- plaintext_body: Plain text body content (at least one of plaintext_body or html_body required)
- html_body: HTML body content for rich text formatting (at least one of plaintext_body or html_body required)
- cc: CC recipients (optional)
- bcc: BCC recipients (optional)
- thread_id: Thread ID to reply to an existing conversation (optional)
- reply_to_email_id: Email ID to reply to, sets proper reply headers (optional)
- attachments: Files to attach, each given as an HTTPS \`url\` or as \`content_base64\` + \`filename\` (optional)

**Option 2: Send a draft**
- from_draft_id: ID of the draft to send (other parameters are ignored; attachments are refused, since the draft carries its own)

**Body content:**
At least one of plaintext_body or html_body must be provided. If both are provided, a multipart email is sent with both plain text and HTML versions; if only plaintext_body is, an HTML rendering of it is sent beside it.

**Links:** when the email links to anything, put the link in html_body as an \`<a href>\` anchor with descriptive text — \`<a href="https://…">this session</a>\`, not the raw URL pasted on its own line — and send a matching plaintext_body with the same words, each URL after its anchor text (\`this session: https://…\`). Use html_body the same way for bold text or lists.

In plaintext_body, write each paragraph as one line and put a blank line between paragraphs — do not hard-wrap at 72-80 columns. Lines that look hard-wrapped are joined back into paragraphs before sending, and a plaintext_body sent alone also goes out as HTML, so the email reads normally on a phone; list items, \`>\` quotes, indented lines and fenced code keep their line breaks.

**Attachments:**
Each attachment provides exactly one of \`url\` (an HTTPS link the server downloads, such as a signed artifact-store URL) or \`content_base64\` (the file bytes, with a required \`filename\`). \`mime_type\` is optional and inferred when omitted. Limits: up to 10 files, 17 MB total, one 60-second budget for every download.

**Sending a reply:**
To send a reply to an existing email:
1. Get the thread_id and email_id from get_email_conversation
2. Provide both thread_id and reply_to_email_id parameters

**Use cases:**
- Send a new email immediately
- Reply to an existing email conversation
- Send a draft that was created with upsert_draft_email

**Warning:** This action sends the email immediately and cannot be undone.`;

export function sendEmailTool(server: Server, clientFactory: ClientFactory) {
  return {
    name: 'send_email',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
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
        from_draft_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.from_draft_id,
        },
        attachments: ATTACHMENTS_JSON_SCHEMA,
      },
      required: [],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = SendEmailSchema.parse(args ?? {});
        const client = clientFactory();

        // Download/decode attachments up front so bad input fails before confirmation.
        // A draft send has none: the schema refuses them alongside from_draft_id.
        const attachments = await resolveAttachments(parsed.attachments);

        // Build a human-readable summary for the elicitation prompt
        const elicitationConfig = readElicitationConfig();
        if (elicitationConfig.enabled) {
          let confirmMessage: string;
          if (parsed.from_draft_id) {
            confirmMessage = `About to send draft (ID: ${parsed.from_draft_id}). This action cannot be undone.`;
          } else {
            confirmMessage =
              `About to send an email:\n` +
              `  To: ${parsed.to}\n` +
              `  Subject: ${parsed.subject}\n` +
              (parsed.cc ? `  CC: ${parsed.cc}\n` : '') +
              (parsed.bcc ? `  BCC: ${parsed.bcc}\n` : '') +
              (attachments.length > 0
                ? `  Attachments: ${formatAttachmentList(attachments)}\n`
                : '') +
              `\nThis action cannot be undone.`;
          }

          const confirmation = await requestConfirmation(
            {
              server,
              message: confirmMessage,
              requestedSchema: createConfirmationSchema(
                'Send this email?',
                'Confirm that you want to send this email immediately.'
              ),
              meta: {
                'com.pulsemcp/tool-name': 'send_email',
              },
            },
            elicitationConfig
          );

          // Fail-safe: only proceed on explicit 'accept'.
          // Any other action (decline, cancel, expired, or unrecognized) blocks the send.
          if (confirmation.action !== 'accept') {
            if (confirmation.action === 'expired') {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Email sending confirmation expired. Please try again.',
                  },
                ],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: 'text',
                  text: 'Email sending was cancelled by the user.',
                },
              ],
            };
          }

          // We reach here only when action === 'accept'.
          // Still check if the user explicitly unchecked the confirm checkbox.
          if (
            confirmation.content &&
            'confirm' in confirmation.content &&
            confirmation.content.confirm === false
          ) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Email sending was not confirmed. The email was not sent.',
                },
              ],
            };
          }
        }

        // Option 2: Send a draft
        if (parsed.from_draft_id) {
          const sentEmail = await client.sendDraft(parsed.from_draft_id);
          const accountEmail = await client.getAccountEmail();

          return {
            content: [
              {
                type: 'text',
                text:
                  `Draft sent successfully!\n\n**Message ID:** ${sentEmail.id}\n` +
                  `**Thread ID:** ${sentEmail.threadId}\n` +
                  `**Gmail URL:** ${buildGmailUrl(accountEmail, sentEmail.id)}\n\n` +
                  `The draft has been sent and removed from Drafts.`,
              },
            ],
          };
        }

        // Option 1: Send a new email
        // TypeScript knows these are defined due to the refine check
        const to = parsed.to!;
        const subject = parsed.subject!;

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

        const sentEmail = await client.sendMessage({
          to,
          subject,
          plaintextBody: parsed.plaintext_body,
          htmlBody: parsed.html_body,
          cc: parsed.cc,
          bcc: parsed.bcc,
          threadId: parsed.thread_id,
          inReplyTo,
          references,
          attachments,
        });

        const accountEmail = await client.getAccountEmail();
        let responseText =
          `Email sent successfully!\n\n**Message ID:** ${sentEmail.id}\n` +
          `**Thread ID:** ${sentEmail.threadId}\n` +
          `**Gmail URL:** ${buildGmailUrl(accountEmail, sentEmail.id)}`;

        if (parsed.thread_id) {
          responseText += '\n\nThis email was sent as a reply in an existing conversation.';
        }

        responseText += `\n\n**To:** ${to}`;
        responseText += `\n**Subject:** ${subject}`;
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
        if (attachments.length > 0) {
          responseText += `\n**Attachments:** ${formatAttachmentList(attachments)}`;
        }

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error sending email: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
