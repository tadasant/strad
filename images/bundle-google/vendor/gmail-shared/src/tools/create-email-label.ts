import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';

const PARAM_DESCRIPTIONS = {
  name:
    'Name of the user label to create, e.g. "Receipts" or "Travel/2026" ("/" nests it). ' +
    'Matched case-insensitively against existing labels.',
} as const;

export const CreateEmailLabelSchema = z.object({
  name: z.string().trim().min(1, 'name cannot be empty').describe(PARAM_DESCRIPTIONS.name),
});

const TOOL_DESCRIPTION = `Create a user label in the mailbox, or return the existing one with that name.

**Parameters:**
- name: The label's name (required). "/" nests it under a parent, as in Gmail.

**Idempotent:** if a label with this name already exists (Gmail compares names without regard to case), it is returned unchanged and nothing is created. Calling it twice is safe.

**Returns:** the label's name and ID, and whether it was created or already existed.

**Note:** This creates the label only; it applies it to no message. To label a message, pass the name to change_email_conversation's labels parameter, which also creates a missing label, so calling this first is optional.`;

export function createEmailLabelTool(server: Server, clientFactory: ClientFactory) {
  return {
    name: 'create_email_label',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.name,
        },
      },
      required: ['name'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = CreateEmailLabelSchema.parse(args ?? {});
        const { label, created } = await clientFactory().createLabel(parsed.name);
        const verdict = created ? 'Label created.' : 'Label already exists; nothing was created.';
        return {
          content: [
            {
              type: 'text',
              text: `${verdict}\n\n**Name:** ${label.name}\n**ID:** ${label.id}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error creating label: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
