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
 * The `conversations.open` failures worth retrying as a scan.
 *
 * Each one means "this token may not OPEN a conversation" rather than "this user
 * cannot be reached" — and a token that can list an existing DM and post into it
 * can still deliver the message.
 */
const CANNOT_OPEN = new Set(['missing_scope', 'not_allowed_token_type', 'restricted_action']);

/** What a bounded scan found: the channel, or why the answer is not "no". */
interface DmScan {
  channelId: string | null;
  truncated: boolean;
}

async function scanForDm(
  baseUrl: string,
  headers: Record<string, string>,
  userId: string
): Promise<DmScan> {
  const { channels, truncated } = await listDmChannels(baseUrl, headers);
  return { channelId: channels.find((c) => c.user === userId)?.id ?? null, truncated };
}

/**
 * The existing DM channel with a user, or null if they have never had one.
 *
 * The read-only half of `openDm`: it creates nothing, so it is what the
 * read-only tools use. `conversations.open` would be one call rather than a
 * scan, but it OPENS a conversation, and a tier that promises to read must not
 * leave a new row in anyone's sidebar.
 *
 * A scan that hit its page cap throws rather than returning null. "No such
 * conversation" and "I stopped looking" are different answers, and only one of
 * them should make a caller believe a DM does not exist.
 */
export async function findDmChannel(
  baseUrl: string,
  headers: Record<string, string>,
  userId: string
): Promise<string | null> {
  const { channelId, truncated } = await scanForDm(baseUrl, headers, userId);

  if (channelId === null && truncated) {
    throw new Error(
      `Could not tell whether a DM with ${userId} exists: the conversation listing was cut ` +
        'off at this tool\'s page cap before the whole list was read. Pass the DM channel id ' +
        '(channel_id) directly if you have it.'
    );
  }

  return channelId;
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
 * do, so a refusal to open is retried as a scan of the DMs that already exist.
 * The scan cannot conjure a FIRST conversation, so the error raised when it
 * finds nothing says exactly that, and repeats the scope Slack named.
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

  if (!CANNOT_OPEN.has(data.error ?? '')) {
    throw slackApiError('conversations.open', data);
  }

  const { channelId, truncated } = await scanForDm(baseUrl, headers, userId);
  if (channelId) {
    return { channelId, via: 'conversations.list' };
  }

  const scope = data.needed ?? 'im:write';
  throw new Error(
    `Cannot open a DM with ${userId}: conversations.open was refused (${data.error}` +
      `, needs "${scope}"), and ` +
      (truncated
        ? 'the scan of existing DM conversations was cut off at this tool\'s page cap before ' +
          'it could find one. Pass the DM channel id to slack_post_message directly if you ' +
          'have it, or add the scope. '
        : 'no DM channel with that user exists yet to fall back on. ') +
      `Add "${scope}" to the Slack app's bot token scopes and reinstall the app, or have the ` +
      'user DM the bot once — either one creates the conversation.'
  );
}
