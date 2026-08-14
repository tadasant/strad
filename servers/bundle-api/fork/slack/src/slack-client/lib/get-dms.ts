import type { DirectMessage, User } from '../../types.js';
import { listUsers } from './list-users.js';
import { slackApiError } from './slack-error.js';

interface DmChannel {
  id: string;
  created: number;
  updated?: number;
  is_im?: boolean;
  is_mpim?: boolean;
  is_archived?: boolean;
  is_user_deleted?: boolean;
  /** Present on `im` conversations only: the other member. */
  user?: string;
  /** Present on `mpim` conversations only: `mpdm-tadas--julie--zimmer-1`. */
  name?: string;
}

interface ConversationsListResponse {
  ok: boolean;
  channels?: DmChannel[];
  error?: string;
  needed?: string;
  response_metadata?: {
    next_cursor?: string;
  };
}

const PAGE_SIZE = 200;
const MAX_PAGES = 5;

/**
 * Lists the DM conversations the token can see, unenriched.
 *
 * `types=im` needs `im:read`. Group DMs are a SECOND scope (`mpim:read`) and
 * Slack fails the whole call rather than the mpim half of it, so a token holding
 * only `im:read` gets `missing_scope` for `types=im,mpim` and nothing at all —
 * which is why group DMs are opt-in rather than the default.
 */
export async function listDmChannels(
  baseUrl: string,
  headers: Record<string, string>,
  options?: { includeGroupDms?: boolean; maxPages?: number }
): Promise<DmChannel[]> {
  const types = options?.includeGroupDms ? 'im,mpim' : 'im';
  const maxPages = options?.maxPages ?? MAX_PAGES;
  const channels: DmChannel[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    const params = new URLSearchParams({
      types,
      limit: PAGE_SIZE.toString(),
      exclude_archived: 'true',
    });
    if (cursor) {
      params.set('cursor', cursor);
    }

    const response = await fetch(`${baseUrl}/conversations.list?${params}`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to list DMs: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as ConversationsListResponse;

    if (!data.ok) {
      throw slackApiError('conversations.list', data);
    }

    channels.push(...(data.channels ?? []));

    cursor = data.response_metadata?.next_cursor || undefined;
    page += 1;
  } while (cursor && page < maxPages);

  return channels;
}

/**
 * The DM conversations the bot is part of, most recently active first, with the
 * other member resolved to a name.
 *
 * The enrichment is best-effort: a token that can read `im` but not `users` gets
 * the conversations with bare ids rather than an error, because a DM list with
 * ids in it is still usable and an error is not.
 */
export async function getDms(
  baseUrl: string,
  headers: Record<string, string>,
  options?: { includeGroupDms?: boolean; limit?: number }
): Promise<DirectMessage[]> {
  const channels = await listDmChannels(baseUrl, headers, {
    includeGroupDms: options?.includeGroupDms,
  });

  let byId = new Map<string, User>();
  if (channels.some((c) => c.user)) {
    try {
      byId = new Map((await listUsers(baseUrl, headers)).map((u) => [u.id, u]));
    } catch {
      // users:read is absent. Ids still address a DM; names are a nicety.
    }
  }

  const dms: DirectMessage[] = channels.map((channel) => ({
    id: channel.id,
    isGroup: channel.is_mpim === true,
    userId: channel.user,
    user: channel.user ? byId.get(channel.user) : undefined,
    name: channel.name,
    created: channel.created,
    updated: channel.updated,
    isUserDeleted: channel.is_user_deleted === true,
  }));

  dms.sort((a, b) => (b.updated ?? b.created * 1000) - (a.updated ?? a.created * 1000));

  return options?.limit === undefined ? dms : dms.slice(0, options.limit);
}
