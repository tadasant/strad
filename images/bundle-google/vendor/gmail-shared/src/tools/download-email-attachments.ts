import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import type { EmailPart } from '../types.js';

/**
 * Maximum total size (in bytes) returned in one call, in either mode (25 MB,
 * Gmail's own ceiling for a whole message).
 */
const MAX_TOTAL_SIZE = 25 * 1024 * 1024;

const PARAM_DESCRIPTIONS = {
  email_id:
    'The unique identifier of the email containing the attachment(s). ' +
    'Obtain this from list_email_conversations, search_email_conversations, or get_email_conversation.',
  filename:
    'Optional filename to download a specific attachment. ' +
    'If omitted, all attachments on the email are downloaded.',
  inline:
    'When true, return attachment content inside the text of the response (text-based files as text, binary as a base64 code block). ' +
    'When false (default), return each attachment as an MCP embedded resource, which clients such as Claude Code save to a local file.',
} as const;

export const DownloadEmailAttachmentsSchema = z.object({
  email_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.email_id),
  filename: z.string().optional().describe(PARAM_DESCRIPTIONS.filename),
  inline: z.boolean().optional().default(false).describe(PARAM_DESCRIPTIONS.inline),
});

const TOOL_DESCRIPTION = `Download attachment content from a specific email.

The bytes come back in the response itself. Nothing is written to the disk of the machine this server runs on, which is not the caller's machine.

**Parameters:**
- email_id: The unique identifier of the email (required)
- filename: Download only the attachment matching this filename (optional)
- inline: If true, return content inside the response text instead of as embedded resources (optional, default: false)

**Default behavior (inline=false):**
Returns a summary followed by one MCP embedded resource per attachment: binary files (PDF, images, etc.) as a base64 blob with their MIME type, text-based files (text/*, JSON, XML) as text. MCP clients that handle binary resources, Claude Code among them, save each blob to a local file and report its path. Best for PDFs and other binary files.

**Inline behavior (inline=true):**
Returns everything as one text block. Text-based attachments are decoded to text; binary attachments appear as a base64 code block. Use it only with a client that ignores embedded resources: a 1 MB PDF is about 1.4 MB of base64 text.

Total size is capped at 25 MB in both modes.

**Use cases:**
- Download invoices, receipts, or documents attached to emails
- Extract data from CSV or text file attachments
- Access PDF attachments for processing
- Batch-download all attachments from an email in one call

**Note:** Use get_email_conversation first to see attachment metadata (filenames, sizes, types) before downloading.`;

interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

/**
 * Recursively extracts attachment info (including attachmentId) from email parts
 */
function getAttachmentInfos(parts: EmailPart[] | undefined): AttachmentInfo[] {
  if (!parts) return [];

  const attachments: AttachmentInfo[] = [];

  for (const part of parts) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.body.size,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) {
      attachments.push(...getAttachmentInfos(part.parts));
    }
  }

  return attachments;
}

/**
 * Converts Gmail's base64url (padded or not) to canonical, padded standard
 * base64, the encoding an MCP resource `blob` is defined in.
 */
function base64UrlToBase64(data: string): string {
  return Buffer.from(data, 'base64url').toString('base64');
}

/**
 * Returns true if the MIME type represents text-based content
 */
function isTextMimeType(mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (mimeType === 'application/json') return true;
  if (mimeType === 'application/xml') return true;
  if (mimeType.endsWith('+json') || mimeType.endsWith('+xml')) return true;
  return false;
}

interface DownloadedAttachment extends AttachmentInfo {
  data: string;
}

/**
 * Builds inline response with attachment content in the response text
 */
function buildInlineResponse(results: DownloadedAttachment[]) {
  const outputParts: string[] = [];

  const summaryLines = results.map((r, i) => {
    const sizeKb = Math.round(r.size / 1024);
    return `${i + 1}. ${r.filename} (${r.mimeType}, ${sizeKb} KB)`;
  });
  outputParts.push(`# Downloaded Attachments (${results.length})\n\n${summaryLines.join('\n')}`);

  for (const result of results) {
    const base64Data = base64UrlToBase64(result.data);

    if (isTextMimeType(result.mimeType)) {
      const textContent = Buffer.from(base64Data, 'base64').toString('utf-8');
      outputParts.push(`---\n## ${result.filename}\n\n${textContent}`);
    } else {
      outputParts.push(
        `---\n## ${result.filename}\n\n` +
          `**MIME Type:** ${result.mimeType}\n` +
          `**Encoding:** base64\n\n` +
          `\`\`\`\n${base64Data}\n\`\`\``
      );
    }
  }

  return {
    content: [{ type: 'text', text: outputParts.join('\n\n') }],
  };
}

/**
 * The URI an attachment's embedded resource carries. It names the attachment;
 * it is not fetchable. The filename is percent-encoded so a name with `/`,
 * `#` or spaces stays one path segment.
 */
export function attachmentUri(emailId: string, filename: string): string {
  return `gmail-attachment://${encodeURIComponent(emailId)}/${encodeURIComponent(filename)}`;
}

/**
 * Builds the default response: a text summary, then one embedded resource per
 * attachment. A remote caller shares no filesystem with this server, so the
 * bytes travel in the result and the client decides where they land.
 */
function buildResourceResponse(results: DownloadedAttachment[], emailId: string) {
  const summaryLines = results.map((r, i) => {
    const sizeKb = Math.round(r.size / 1024);
    return `${i + 1}. ${r.filename} (${r.mimeType}, ${sizeKb} KB)`;
  });
  const summary =
    `# Downloaded Attachments (${results.length})\n\n${summaryLines.join('\n')}\n\n` +
    'Each attachment follows as an embedded resource. A client that saves binary resources ' +
    'reports a local path for each one; if yours shows none, call again with inline=true.';

  const resources = results.map((r) => {
    const base64Data = base64UrlToBase64(r.data);
    const uri = attachmentUri(emailId, r.filename);
    if (isTextMimeType(r.mimeType)) {
      return {
        type: 'resource' as const,
        resource: {
          uri,
          mimeType: r.mimeType,
          text: Buffer.from(base64Data, 'base64').toString('utf-8'),
        },
      };
    }
    return {
      type: 'resource' as const,
      resource: { uri, mimeType: r.mimeType || 'application/octet-stream', blob: base64Data },
    };
  });

  return {
    content: [{ type: 'text' as const, text: summary }, ...resources],
  };
}

export function downloadEmailAttachmentsTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: 'download_email_attachments',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        email_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.email_id,
        },
        filename: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.filename,
        },
        inline: {
          type: 'boolean',
          description: PARAM_DESCRIPTIONS.inline,
        },
      },
      required: ['email_id'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = DownloadEmailAttachmentsSchema.parse(args ?? {});
        const client = clientFactory();

        // Fetch the email to discover attachments
        const email = await client.getMessage(parsed.email_id, { format: 'full' });
        const allAttachments: AttachmentInfo[] = [];

        // Check payload-level attachment (single-part email with attachment)
        if (email.payload?.filename && email.payload?.body?.attachmentId) {
          allAttachments.push({
            filename: email.payload.filename,
            mimeType: email.payload.mimeType,
            size: email.payload.body.size,
            attachmentId: email.payload.body.attachmentId,
          });
        }

        // Check nested parts for attachments
        allAttachments.push(...getAttachmentInfos(email.payload?.parts));

        if (allAttachments.length === 0) {
          return {
            content: [{ type: 'text', text: 'No attachments found on this email.' }],
          };
        }

        // Filter by filename if specified
        let targetAttachments = allAttachments;
        if (parsed.filename) {
          targetAttachments = allAttachments.filter((a) => a.filename === parsed.filename);
          if (targetAttachments.length === 0) {
            const available = allAttachments.map((a) => a.filename).join(', ');
            return {
              content: [
                {
                  type: 'text',
                  text: `Attachment "${parsed.filename}" not found. Available attachments: ${available}`,
                },
              ],
              isError: true,
            };
          }
        }

        // Both modes carry the bytes in the response, so both are capped
        const totalSize = targetAttachments.reduce((sum, a) => sum + a.size, 0);
        if (totalSize > MAX_TOTAL_SIZE) {
          const totalMb = (totalSize / (1024 * 1024)).toFixed(1);
          return {
            content: [
              {
                type: 'text',
                text:
                  `Total attachment size (${totalMb} MB) exceeds the 25 MB limit for one call. ` +
                  `Use the filename parameter to download attachments individually.`,
              },
            ],
            isError: true,
          };
        }

        // Download all target attachments concurrently
        const results = await Promise.all(
          targetAttachments.map(async (att) => {
            const data = await client.getAttachment(parsed.email_id, att.attachmentId);
            return { ...att, data: data.data };
          })
        );

        if (parsed.inline) {
          return buildInlineResponse(results);
        }
        return buildResourceResponse(results, parsed.email_id);
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error downloading attachment(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
