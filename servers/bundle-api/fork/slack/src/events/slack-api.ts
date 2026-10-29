/**
 * The handful of Slack Web API calls the events ingest makes, on Node's own
 * `fetch`, injectable for tests.
 *
 *   auth.test               who the bot is (to drop its own posts) and the workspace URL
 *   apps.connections.open   a Socket Mode WebSocket URL, on the APP-level token
 *   users.conversations     the conversations the bot is in, for backfill
 *   conversations.history   a conversation's messages since a point, for backfill
 *   conversations.replies   a thread's replies since a point, for backfill
 *
 * A 429 is waited out (Slack's `Retry-After`, capped) and retried a bounded
 * number of times; any other `ok: false` is a {@link SlackApiError} carrying
 * Slack's error code and nothing else — never a token.
 */

export type FetchLike = typeof fetch;

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string
  ) {
    super(`Slack ${method} failed: ${code}`);
    this.name = 'SlackApiError';
  }
}

const BASE = 'https://slack.com/api';
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface SlackApiOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class SlackApi {
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly botToken: string,
    private readonly appToken: string,
    opts: SlackApiOptions = {}
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.base = (opts.baseUrl ?? BASE).replace(/\/+$/, '');
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async call<T>(
    method: string,
    token: string,
    params: Record<string, string | number | boolean | undefined> = {}
  ): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.base}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const after = Number(res.headers.get('retry-after'));
        await this.sleep(
          Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000, MAX_RETRY_AFTER_MS)
        );
        continue;
      }
      if (!res.ok) throw new SlackApiError(method, `http_${res.status}`);
      const json = (await res.json()) as { ok?: boolean; error?: string } & T;
      if (!json.ok) throw new SlackApiError(method, json.error ?? 'unknown_error');
      return json;
    }
  }

  async authTest(): Promise<{ user_id: string; bot_id?: string; url: string; team_id?: string }> {
    return this.call('auth.test', this.botToken);
  }

  async openConnection(): Promise<string> {
    const res = await this.call<{ url: string }>('apps.connections.open', this.appToken);
    return res.url;
  }

  /** Public and private channels and one-to-one DMs the bot is a member of. Group DMs are out of scope. */
  async memberConversations(maxPages = 20): Promise<{ id: string; type: 'channel' | 'group' | 'im' }[]> {
    const out: { id: string; type: 'channel' | 'group' | 'im' }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.call<{
        channels: { id: string; is_im?: boolean; is_private?: boolean; is_mpim?: boolean }[];
        response_metadata?: { next_cursor?: string };
      }>('users.conversations', this.botToken, {
        types: 'public_channel,private_channel,im',
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const c of res.channels ?? []) {
        if (c.is_mpim) continue;
        out.push({ id: c.id, type: c.is_im ? 'im' : c.is_private ? 'group' : 'channel' });
      }
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return out;
  }

  /** Messages with `ts` after `oldest`, newest first (Slack's order), up to `maxPages` pages of 200. */
  async history(
    channel: string,
    oldest: string,
    maxPages: number
  ): Promise<{ messages: SlackHistoryMessage[]; complete: boolean }> {
    return this.paged('conversations.history', { channel, oldest }, maxPages);
  }

  async replies(
    channel: string,
    ts: string,
    oldest: string,
    maxPages: number
  ): Promise<{ messages: SlackHistoryMessage[]; complete: boolean }> {
    return this.paged('conversations.replies', { channel, ts, oldest }, maxPages);
  }

  private async paged(
    method: string,
    params: Record<string, string>,
    maxPages: number
  ): Promise<{ messages: SlackHistoryMessage[]; complete: boolean }> {
    const messages: SlackHistoryMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.call<{
        messages?: SlackHistoryMessage[];
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      }>(method, this.botToken, { ...params, limit: 200, inclusive: false, cursor });
      messages.push(...(res.messages ?? []));
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!res.has_more || !cursor) return { messages, complete: true };
    }
    return { messages, complete: false };
  }
}

export interface SlackHistoryMessage {
  type?: string;
  subtype?: string;
  hidden?: boolean;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
}
