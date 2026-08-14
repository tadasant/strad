import { listDmChannels } from './get-dms.js';
import { slackApiError } from './slack-error.js';

interface ConversationsOpenResponse {
  ok: boolean;
  channel?: { id: string };
  already_open?: boolean;
  error?: string;
  needed?: string;
}

export interface OpenDmResult {
  /** The DM channel id — `D…` — that `chat.postMessage` takes. */
  channelId: string;
  /** Which call produced it. `conversations.list` means the fallback ran. */
  via: 'conversations.open' | 'conversations.list';
}

/**
 * The existing DM channel with a user, or null if they have never had one.
 *
 * The read-only half of `openDm`: it creates nothing, so it is what the
 * read-only tools use. `conversations.open` would be one call rather than a
 * scan, but it OPENS a conversation, and a tier that promises to read must not
 * leave a new row in anyone's sidebar.
 */
export async function findDmChannel(
  baseUrl: string,
  headers: Record<string, string>,
  userId: string
): Promise<string | null> {
  const existing = (await listDmChannels(baseUrl, headers)).find((c) => c.user === userId);
  return existing?.id ?? null;
}

/**
 * Resolves a user id to the DM channel id that addresses them, opening the
 * conversation if it does not exist yet.
 *
 * `conversations.open` is idempotent and silent: re-opening an existing DM
 * returns the same channel and notifies nobody. Nothing is sent until a caller
 * posts to the id it returns.
 *
 * **The fallback.** `conversations.open` needs `im:write`, a scope a bot token
 * built for channel posting does not carry — and a token can hold `im:read` and
 * `chat:write` (so it can list an existing DM and post into it) while lacking
 * it. Failing the send in that case would be refusing work the token can plainly
 * do, so a `missing_scope` is retried as a scan of the DMs that already exist.
 * The scan cannot conjure a FIRST conversation, so the error raised when it
 * finds nothing says exactly that, and names the scope that fixes it.
 */
export async function openDm(
  baseUrl: string,
  headers: Record<string, string>,
  userId: string
): Promise<OpenDmResult> {
  const response = await fetch(`${baseUrl}/conversations.open`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ users: userId }),
  });

  if (!response.ok) {
    throw new Error(`Failed to open DM: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as ConversationsOpenResponse;

  if (data.ok && data.channel) {
    return { channelId: data.channel.id, via: 'conversations.open' };
  }

  if (data.error !== 'missing_scope') {
    throw slackApiError('conversations.open', data);
  }

  const existing = await findDmChannel(baseUrl, headers, userId);
  if (existing) {
    return { channelId: existing, via: 'conversations.list' };
  }

  throw new Error(
    `Cannot open a DM with ${userId}: the bot token lacks the "im:write" scope, and no DM ` +
      'channel with that user exists yet to fall back on. Add "im:write" to the Slack app\'s ' +
      'bot token scopes and reinstall the app, or have the user DM the bot once — either one ' +
      'creates the conversation.'
  );
}
