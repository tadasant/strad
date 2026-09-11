import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import { mintDownloadToken } from '../download-link.js';
import type { ClientFactory } from '../server.js';

/** What this tool needs to mint a link. Built once in `createMCPServer`. */
export interface DownloadLinkConfig {
  /** The GATEWAY's slug for this mount, e.g. `slack-zimmer`. */
  publicSlug: string;
  /** Origin of the public gateway, no trailing slash. */
  publicBaseUrl: string;
  key: Buffer;
  ttlSeconds: number;
}

const PARAM_DESCRIPTIONS = {
  file_id:
    'The Slack file ID (e.g., "F1234567890"). ' +
    'File IDs are shown in message outputs next to uploaded files.',
} as const;

export const DownloadFileSchema = z.object({
  file_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.file_id),
});

const TOOL_DESCRIPTION = `Get a temporary download URL for a file attached to a Slack message.

Slack files require authentication to access, so this tool mints a short-lived signed URL
that serves the bytes without any credential of yours. Fetch it from your own shell — no
header, no token, no API key.

**Returns** JSON with the file's \`name\`, \`mime_type\` and \`size_bytes\`, plus:
- \`download_url\` — fetch this to get the bytes
- \`expires_at\` — when the URL stops working
- \`curl\` — a ready-made command; run it as-is

**The URL is single-use and expires in minutes.** Fetch it promptly. If it expires, has
already been used, or the download dies partway, just call this tool again — a fresh URL
costs nothing.

**Use cases:**
- Read a document, PDF or archive somebody attached to a message
- Pull down an image to look at it
- Retrieve any file attachment, at any size — the bytes stream, so a large archive works
  the same way a small screenshot does

**Note:** File IDs (e.g., "F1234567890") are shown in message outputs from slack_get_channel
and slack_get_thread.`;

export function downloadFileTool(
  server: Server,
  clientFactory: ClientFactory,
  ctx?: { downloadLink?: DownloadLinkConfig }
) {
  return {
    name: 'slack_download_file',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.file_id,
        },
      },
      required: ['file_id'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = DownloadFileSchema.parse(args);
        const link = ctx?.downloadLink;

        // No link config means nothing is in front of this process to serve the
        // URL. Say so, rather than minting one that would 404 — a dead URL is
        // the failure this whole tool was rewritten to stop producing.
        if (!link) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'This deployment cannot serve Slack file downloads: no public download route ' +
                  'is configured for this mount.',
              },
            ],
            isError: true,
          };
        }

        const client = clientFactory();

        // Fetched BEFORE minting so a bad file id fails here, with Slack's own
        // reason, rather than turning into a signed URL that 404s later.
        const fileInfo = await client.getFileInfo(parsed.file_id);

        if (!fileInfo.url_private_download && !fileInfo.url_private) {
          return {
            content: [
              {
                type: 'text',
                text: `File ${parsed.file_id} has no downloadable URL. It may have been deleted or is not accessible.`,
              },
            ],
            isError: true,
          };
        }

        const { token, expiresAt } = mintDownloadToken({
          key: link.key,
          fileId: parsed.file_id,
          ttlSeconds: link.ttlSeconds,
        });

        const url = `${link.publicBaseUrl}/mcp-download/${encodeURIComponent(link.publicSlug)}/${token}`;
        const name = fileInfo.name || fileInfo.title || parsed.file_id;
        const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  name,
                  mime_type: fileInfo.mimetype,
                  size_bytes: fileInfo.size,
                  download_url: url,
                  expires_at: expiresAt,
                  single_use: true,
                  curl: `curl -fSL -o '${safeName}' '${url}'`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error preparing file download: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
