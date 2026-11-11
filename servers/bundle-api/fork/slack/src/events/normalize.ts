/**
 * One Slack message -> one `message_posted` occurrence, or nothing.
 *
 * Both ways in go through {@link toMessagePosted}: an `events_api` envelope off
 * the socket and a message read back by `conversations.history` /
 * `conversations.replies` during backfill. One function is what makes the two
 * produce the same `eventId` for the same message, which is the dedupe key.
 *
 * WHAT IS DROPPED, and why each:
 *   - the bot's OWN posts (its user id or its bot id): a trigger that fires on
 *     its own reply is a loop;
 *   - every subtype outside {@link POSTED_SUBTYPES}: an edit (`message_changed`),
 *     a delete, a join, a topic change and every `hidden: true` event are not a
 *     message being posted;
 *   - group DMs (`mpim`): out of scope for this event type;
 *   - anything without a channel and a `ts`, which cannot be addressed.
 */

export const MAX_TEXT_CHARS = 4000;

/** Subtypes that are a message somebody posted. Absent is the ordinary case. */
const POSTED_SUBTYPES = new Set(['bot_message', 'file_share', 'thread_broadcast', 'me_message']);

export type ChannelType = 'channel' | 'group' | 'im';

export interface MessagePostedData {
  channel_id: string;
  channel_type: ChannelType;
  ts: string;
  thread_ts?: string;
  user_id?: string;
  bot_id?: string;
  username?: string;
  is_dm: boolean;
  mentions_bot: boolean;
  permalink: string;
  text: string;
}

export interface StoredEvent {
  /** `slack:<channel_id>:<ts>`, exactly. */
  eventId: string;
  /** ISO 8601, from the message's own `ts`. */
  timestamp: string;
  data: MessagePostedData;
  /**
   * Ingest order. Monotonic within a process and time-based across processes
   * (see `EventBuffer.nextSeq`), so a cursor minted by one process is still
   * meaningful to the next.
   */
  seq: number;
}

/** Who the bot is, from `auth.test`. */
export interface BotIdentity {
  userId: string;
  botId?: string;
  /** `https://<workspace>.slack.com/`, for permalinks. */
  workspaceUrl: string;
}

/** The fields of a Slack message this reads. Both wire shapes carry them. */
export interface RawSlackMessage {
  type?: string;
  subtype?: string;
  hidden?: boolean;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
}

export function eventIdFor(channelId: string, ts: string): string {
  return `slack:${channelId}:${ts}`;
}

function normalizeChannelType(raw: string | undefined, channelId: string): ChannelType | null {
  switch (raw) {
    case 'channel':
    case 'group':
    case 'im':
      return raw;
    case 'mpim':
      return null;
    default:
      // The Events API always sends channel_type for message events. A message
      // without one — a backfill caller that forgot — falls back to the id's
      // first letter, which Slack documents as C/G/D for these three.
      if (channelId.startsWith('D')) return 'im';
      if (channelId.startsWith('G')) return 'group';
      if (channelId.startsWith('C')) return 'channel';
      return null;
  }
}

/** `https://ws.slack.com/archives/C123/p1700000000123456`, plus the thread for a reply. */
export function permalinkFor(
  workspaceUrl: string,
  channelId: string,
  ts: string,
  threadTs?: string
): string {
  const base = workspaceUrl.replace(/\/+$/, '');
  const link = `${base}/archives/${channelId}/p${ts.replace('.', '')}`;
  return threadTs ? `${link}?thread_ts=${threadTs}&cid=${channelId}` : link;
}

export function tsToIso(ts: string): string {
  const ms = Math.floor(Number(ts) * 1000);
  return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

export function toMessagePosted(
  raw: RawSlackMessage,
  bot: BotIdentity,
  channelHint?: { id: string; type?: string }
): Omit<StoredEvent, 'seq'> | null {
  if (raw.type !== undefined && raw.type !== 'message') return null;
  if (raw.hidden) return null;
  if (raw.subtype !== undefined && !POSTED_SUBTYPES.has(raw.subtype)) return null;

  const channelId = raw.channel ?? channelHint?.id;
  const ts = raw.ts;
  if (!channelId || !ts) return null;

  const channelType = normalizeChannelType(raw.channel_type ?? channelHint?.type, channelId);
  if (channelType === null) return null;

  if (raw.user !== undefined && raw.user === bot.userId) return null;
  if (raw.bot_id !== undefined && bot.botId !== undefined && raw.bot_id === bot.botId) return null;

  const text = raw.text ?? '';
  // A parent carries `thread_ts === ts` once it has replies — always when read
  // back by backfill, never when it arrives live. One payload per eventId: a
  // parent is top-level, and only a reply names a thread.
  const threadTs = raw.thread_ts && raw.thread_ts !== ts ? raw.thread_ts : undefined;

  const data: MessagePostedData = {
    channel_id: channelId,
    channel_type: channelType,
    ts,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(raw.user ? { user_id: raw.user } : {}),
    ...(raw.bot_id ? { bot_id: raw.bot_id } : {}),
    ...(raw.username ? { username: raw.username } : {}),
    is_dm: channelType === 'im',
    mentions_bot: text.includes(`<@${bot.userId}>`) || text.includes(`<@${bot.userId}|`),
    permalink: permalinkFor(bot.workspaceUrl, channelId, ts, threadTs),
    text: cut(text),
  };
  return { eventId: eventIdFor(channelId, ts), timestamp: tsToIso(ts), data };
}

/** At most MAX_TEXT_CHARS UTF-16 units, never ending on half a surrogate pair. */
function cut(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const end = /[\uD800-\uDBFF]/.test(text[MAX_TEXT_CHARS - 1]!) ? MAX_TEXT_CHARS - 1 : MAX_TEXT_CHARS;
  return text.slice(0, end);
}
