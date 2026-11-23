import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ClientFactory } from '../server.js';
import type { GmailLabel } from '../gmail-client/lib/labels.js';

const TOOL_DESCRIPTION = `List the mailbox's labels, with each label's name and ID.

**Parameters:** none.

**Returns:** the user labels (the ones the mailbox's owner made), then Gmail's system labels (INBOX, STARRED, UNREAD, CATEGORY_*, …), each as name and ID.

**Use cases:**
- Find the ID behind a label name
- Check whether a label exists before applying it

**Note:** change_email_conversation takes label NAMES as well as IDs, and creates a missing user label when adding it, so a lookup is not required to label mail. Use create_email_label to create a label without applying it.`;

function line(l: GmailLabel): string {
  return `- ${l.name} — id: ${l.id}`;
}

export function listEmailLabelsTool(server: Server, clientFactory: ClientFactory) {
  return {
    name: 'list_email_labels',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    handler: async () => {
      try {
        const labels = await clientFactory().listLabels();
        const byName = (a: GmailLabel, b: GmailLabel) => a.name.localeCompare(b.name);
        const user = labels.filter((l) => l.type !== 'system').sort(byName);
        const system = labels.filter((l) => l.type === 'system').sort(byName);

        const sections = [
          `## User labels (${user.length})`,
          user.length ? user.map(line).join('\n') : '(none)',
          '',
          `## System labels (${system.length})`,
          system.length ? system.map(line).join('\n') : '(none)',
        ];
        return { content: [{ type: 'text', text: sections.join('\n') }] };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing labels: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
