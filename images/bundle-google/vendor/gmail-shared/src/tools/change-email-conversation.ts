import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory, IGmailClient } from '../server.js';
import { findLabelByName, type GmailLabel } from '../gmail-client/lib/labels.js';

const PARAM_DESCRIPTIONS = {
  email_id:
    'The unique identifier of the email to modify. ' +
    'Obtain this from list_email_conversations or search_email_conversations.',
  status: 'Mark the email as read, unread, or archived. ' + 'Options: read, unread, archived.',
  labels:
    'Labels to add to the email. Comma-separated list of label names or IDs, ' +
    'e.g. "STARRED, Receipts". A user label that does not exist yet is created. ' +
    'Names match case-insensitively. A name that itself contains a comma cannot be given here.',
  remove_labels:
    'Labels to remove from the email. Comma-separated list of label names or IDs, ' +
    'e.g. "UNREAD, Receipts". A name that matches no label is skipped and reported.',
  is_starred: 'Star or unstar the email. Set to true to star, false to unstar.',
} as const;

export const ChangeEmailConversationSchema = z.object({
  email_id: z.string().min(1).describe(PARAM_DESCRIPTIONS.email_id),
  status: z.enum(['read', 'unread', 'archived']).optional().describe(PARAM_DESCRIPTIONS.status),
  labels: z.string().optional().describe(PARAM_DESCRIPTIONS.labels),
  remove_labels: z.string().optional().describe(PARAM_DESCRIPTIONS.remove_labels),
  is_starred: z.boolean().optional().describe(PARAM_DESCRIPTIONS.is_starred),
});

const TOOL_DESCRIPTION = `Modify an email conversation's status, labels, or starred state.

**Parameters:**
- email_id: The unique identifier of the email (required)
- status: Mark as "read", "unread", or "archived" (optional)
- labels: Comma-separated labels to add, by name or ID (optional)
- remove_labels: Comma-separated labels to remove, by name or ID (optional)
- is_starred: Set to true to star, false to unstar (optional)

**Label operations:**
- Adding STARRED marks the email as starred
- Removing INBOX archives the email
- Adding/removing UNREAD marks email as unread/read
- A label may be given by name ("Added details to calendar") or by ID ("Label_12"). A name that matches no label is CREATED as a user label when adding, so labelling with a new name needs no separate step; when removing, it is skipped
- An ID of the user-label form ("Label_…") that does not exist is refused, never created as a name
- list_email_labels shows every label's name and ID; create_email_label creates one without applying it

**Use cases:**
- Mark an email as read/unread
- Star important emails
- Archive emails (remove from inbox)
- Apply custom labels for organization

**Note:** Get email_id from list_email_conversations or search_email_conversations first.`;

export function changeEmailConversationTool(server: Server, clientFactory: ClientFactory) {
  return {
    name: 'change_email_conversation',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        email_id: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.email_id,
        },
        status: {
          type: 'string',
          enum: ['read', 'unread', 'archived'],
          description: PARAM_DESCRIPTIONS.status,
        },
        labels: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.labels,
        },
        remove_labels: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.remove_labels,
        },
        is_starred: {
          type: 'boolean',
          description: PARAM_DESCRIPTIONS.is_starred,
        },
      },
      required: ['email_id'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = ChangeEmailConversationSchema.parse(args ?? {});
        const client = clientFactory();

        const addLabelIds: string[] = [];
        const removeLabelIds: string[] = [];

        // Handle status
        if (parsed.status === 'read') {
          removeLabelIds.push('UNREAD');
        } else if (parsed.status === 'unread') {
          addLabelIds.push('UNREAD');
        } else if (parsed.status === 'archived') {
          removeLabelIds.push('INBOX');
        }

        // Handle is_starred
        if (parsed.is_starred === true) {
          addLabelIds.push('STARRED');
        } else if (parsed.is_starred === false) {
          removeLabelIds.push('STARRED');
        }

        // Labels by name or ID (strad FORK.md delta 8). Every token in both
        // lists is resolved before any label is created, so a bad token
        // refuses the call with nothing created. A label created here stays
        // if the modify below then fails; the create is idempotent, so a
        // retry reuses it.
        const resolver = new LabelResolver(client);
        const notes: string[] = [];
        const removed = await resolver.resolve(splitLabels(parsed.remove_labels), 'remove');
        const added = await resolver.resolve(splitLabels(parsed.labels), 'add');
        removeLabelIds.push(...removed.ids);
        notes.push(...removed.notes);
        const createdIds = await resolver.createMissing(added.missing, notes);
        addLabelIds.push(...new Set([...added.ids, ...createdIds]));

        // Only make API call if there are changes to make
        if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  'No changes specified. Provide at least one of: status, labels, remove_labels, or is_starred.',
                  ...notes,
                ].join('\n'),
              },
            ],
          };
        }

        const updatedEmail = await client.modifyMessage(parsed.email_id, {
          addLabelIds: addLabelIds.length > 0 ? addLabelIds : undefined,
          removeLabelIds: removeLabelIds.length > 0 ? removeLabelIds : undefined,
        });

        const changes: string[] = [];
        if (addLabelIds.length > 0) {
          changes.push(`Added labels: ${addLabelIds.map((id) => resolver.describe(id)).join(', ')}`);
        }
        if (removeLabelIds.length > 0) {
          changes.push(
            `Removed labels: ${removeLabelIds.map((id) => resolver.describe(id)).join(', ')}`
          );
        }
        changes.push(...notes);

        return {
          content: [
            {
              type: 'text',
              text: `Email ${parsed.email_id} updated successfully.\n\n${changes.join('\n')}\n\nCurrent labels: ${updatedEmail.labelIds?.map((id) => resolver.describe(id)).join(', ') || 'None'}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error modifying email: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}

/**
 * Gmail's system label IDs. A token that is one of these goes straight to the
 * API, so a call that only stars, archives or marks read never lists labels.
 */
const SYSTEM_LABEL_IDS = new Set([
  'INBOX',
  'SPAM',
  'TRASH',
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'SENT',
  'DRAFT',
  'CHAT',
]);

/** The ID shape Gmail gives a user label. One that is not found is refused, never created as a name. */
const USER_LABEL_ID = /^Label_\d+$/;

function isSystemLabelId(token: string): boolean {
  return SYSTEM_LABEL_IDS.has(token) || /^CATEGORY_[A-Z]+$/.test(token);
}

export function splitLabels(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Turns the label tokens a caller wrote into label IDs: an ID passes through,
 * a name is looked up (case-insensitively), and a missing name being ADDED is
 * created as a user label. Resolving lists the mailbox's labels at most once
 * per call, and only when some token is not a system label ID. Each label
 * created lists them again, inside the idempotent create.
 */
export class LabelResolver {
  private labels: GmailLabel[] | null = null;

  constructor(private readonly client: IGmailClient) {}

  private async all(): Promise<GmailLabel[]> {
    if (!this.labels) this.labels = await this.client.listLabels();
    return this.labels;
  }

  /**
   * Resolves tokens without creating anything. `missing` holds the names being
   * added that match no label, for {@link createMissing}.
   */
  async resolve(tokens: string[], mode: 'add' | 'remove'): Promise<{ ids: string[]; missing: string[]; notes: string[] }> {
    const ids: string[] = [];
    const missing: string[] = [];
    const notes: string[] = [];
    for (const token of tokens) {
      if (isSystemLabelId(token)) {
        ids.push(token);
        continue;
      }
      const labels = await this.all();
      const match = labels.find((l) => l.id === token) ?? findLabelByName(labels, token);
      if (match) {
        ids.push(match.id);
        continue;
      }
      if (USER_LABEL_ID.test(token)) {
        throw new Error(
          `No label with ID "${token}" in this mailbox. Call list_email_labels for the names and IDs, ` +
            'or pass a label name instead.'
        );
      }
      if (mode === 'remove') {
        notes.push(`Skipped "${token}": no label by that name or ID, so there was nothing to remove.`);
        continue;
      }
      missing.push(token);
    }
    return { ids: [...new Set(ids)], missing, notes };
  }

  /** Creates (or finds, if one appeared meanwhile) each missing label, and returns their IDs. */
  async createMissing(names: string[], notes: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names) {
      const { label, created } = await this.client.createLabel(name);
      (await this.all()).push(label);
      ids.push(label.id);
      if (created) notes.push(`Created label "${label.name}" (${label.id}).`);
    }
    return ids;
  }

  /** `Name (id)` for a user label this call looked up, the bare ID otherwise. */
  describe(id: string): string {
    const label = this.labels?.find((l) => l.id === id);
    return label && label.name !== id ? `${label.name} (${id})` : id;
  }
}
