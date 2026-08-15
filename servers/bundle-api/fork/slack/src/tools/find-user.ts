import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import type { ClientFactory } from '../server.js';
import type { UserMatch } from '../types.js';
import { looksLikeEmail, userLabel } from './resolve-user.js';

const PARAM_DESCRIPTIONS = {
  query:
    'What to search for: a handle with or without the "@" ("@tadas"), part of a ' +
    'display or real name ("tadas", "Antanavicius"), or a full email address ' +
    '("tadas@example.com" — matched exactly, and only when the token holds the ' +
    'users:read.email scope). Matching is case-insensitive.',
  limit: 'Maximum number of matches to return, best match first. Default: 10. Maximum: 50.',
} as const;

export const FindUserSchema = z.object({
  query: z.string().min(1).describe(PARAM_DESCRIPTIONS.query),
  limit: z.number().min(1).max(50).default(10).describe(PARAM_DESCRIPTIONS.limit),
});

const MATCH_QUALITY: Record<number, string> = {
  0: 'exact',
  1: 'starts with',
  2: 'contains',
};

const TOOL_DESCRIPTION = `Find workspace members by handle, name or email.

Turns "who is Tadas" into the user ID the DM tools want. Matches are returned
best-first: exact, then starts-with, then contains.

**Returns:**
A list of matching members, each with:
- Real name, handle and user ID (e.g. "Tadas Antanavicius (@tadas, U0BFTSUN8MD)")
- Which field matched, and how closely
- Whether the account is a bot

**Use cases:**
- Get a user ID before sending a DM, when a name might be ambiguous
- Check who a handle actually belongs to
- Confirm someone is in the workspace at all
- Resolve an email address to a Slack account

**Notes:**
- slack_send_dm and slack_get_dm accept the same identifiers directly, so this
  tool is for when you want to LOOK before you send. Use it when a name is
  ambiguous — those tools refuse to guess between two people.
- Deactivated accounts are omitted; they cannot receive a DM.
- Slack has no server-side user search, so this lists the workspace directory and
  filters it. That costs a call per 200 members and it needs the users:read scope.`;

export function findUserTool(server: Server, clientFactory: ClientFactory) {
  return {
    name: 'slack_find_user',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: PARAM_DESCRIPTIONS.query,
        },
        limit: {
          type: 'number',
          default: 10,
          minimum: 1,
          maximum: 50,
          description: PARAM_DESCRIPTIONS.limit,
        },
      },
      required: ['query'],
    },
    handler: async (args: unknown) => {
      try {
        const parsed = FindUserSchema.parse(args);
        const client = clientFactory();
        const query = parsed.query.trim();

        // An email is exact by construction, and users.lookupByEmail answers it in
        // one call instead of a full directory scan.
        let matches: UserMatch[];
        let truncated = false;
        if (looksLikeEmail(query)) {
          const user = await client.lookupUserByEmail(query);
          matches = user ? [{ user, rank: 0, field: 'email' }] : [];
        } else {
          ({ matches, truncated } = await client.findUsers(query));
        }

        if (matches.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `No workspace member matches "${query}". Try a shorter query — a first ` +
                  'name or the start of a handle — or check the spelling.',
              },
            ],
          };
        }

        const shown = matches.slice(0, parsed.limit);
        const list = shown
          .map(
            (m) =>
              `• ${userLabel(m.user)}\n   Matched: ${MATCH_QUALITY[m.rank] ?? 'partial'} on ${m.field}`
          )
          .join('\n');

        const more =
          matches.length > shown.length
            ? `\n\n_${matches.length - shown.length} more match(es). Narrow the query or raise limit._`
            : '';

        // Say it out loud: a search over part of a directory cannot promise that
        // the person it did not read is not the better match.
        const capped = truncated
          ? '\n\n⚠️ The workspace directory was larger than this tool reads in one search, so ' +
            'these are the matches from the part it saw. Another member may match better.'
          : '';

        return {
          content: [
            {
              type: 'text',
              text:
                `Found ${matches.length} member(s) matching "${query}":\n\n${list}${more}${capped}\n\n` +
                'Pass a user ID to slack_send_dm or slack_get_dm to address one of them.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error finding user: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
