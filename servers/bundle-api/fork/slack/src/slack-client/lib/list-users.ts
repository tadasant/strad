import type { User, UserDirectory } from '../../types.js';
import { slackApiError } from './slack-error.js';

interface UsersListResponse {
  ok: boolean;
  members?: Array<User & { deleted?: boolean }>;
  error?: string;
  needed?: string;
  response_metadata?: {
    next_cursor?: string;
  };
}

/** Slack's own page ceiling for `users.list`. */
const PAGE_SIZE = 200;

/**
 * How many pages a single scan will walk before giving up. Slack has no
 * server-side user search, so "who is @tadas" is answered by listing the
 * workspace and filtering here — which is fine for a workspace of tens and
 * unbounded for a workspace of tens of thousands. Ten pages is 2,000 users; past
 * that a caller should pass the user ID it already has.
 */
const MAX_PAGES = 10;

/**
 * Lists the workspace's active members, and says whether it saw all of them.
 *
 * Deleted accounts are dropped: they cannot receive a DM, and leaving them in
 * makes a departed colleague's handle resolve to a channel nobody reads.
 *
 * `truncated` is returned rather than swallowed because the caller's question is
 * "is this the only match", and a scan that stopped at the page cap cannot
 * answer it. A silent cap turns "exactly one member matched" into "exactly one
 * member matched on the pages I happened to read", which is the same sentence
 * right up until it delivers a private message to the wrong person.
 */
export async function listUsers(
  baseUrl: string,
  headers: Record<string, string>,
  options?: { maxPages?: number }
): Promise<UserDirectory> {
  const users: User[] = [];
  const maxPages = options?.maxPages ?? MAX_PAGES;
  let cursor: string | undefined;
  let page = 0;

  do {
    const params = new URLSearchParams({ limit: PAGE_SIZE.toString() });
    if (cursor) {
      params.set('cursor', cursor);
    }

    const response = await fetch(`${baseUrl}/users.list?${params}`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to list users: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as UsersListResponse;

    if (!data.ok) {
      throw slackApiError('users.list', data);
    }

    for (const member of data.members ?? []) {
      if (!member.deleted) {
        users.push(member);
      }
    }

    cursor = data.response_metadata?.next_cursor || undefined;
    page += 1;
  } while (cursor && page < maxPages);

  return { users, truncated: cursor !== undefined };
}
