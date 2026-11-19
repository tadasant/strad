// MCP Events (draft SEP-3415, poll mode): the `message_posted` event type.
//
// What is pinned here, and why each is load-bearing:
//
//   1. The eventId is `slack:<channel_id>:<ts>` EXACTLY. Zimmer already dedupes
//      Slack messages on that key; a different spelling is every message
//      delivered twice the day a trigger moves onto events.
//   2. What is dropped: the bot's own posts (a trigger that fires on its own
//      reply is a loop), edits and other non-posting subtypes, hidden events,
//      and group DMs.
//   3. The cursor: null means "from now" and returns nothing; a narrow filter
//      still advances; a cursor below an evicted event says `truncated`.
//   4. A reconnect BACKFILLS from just before the last moment a socket was live,
//      and the newest process takes the lease from the old one.
//   5. Unconfigured is inert and honest: no extension advertised, no event
//      types listed, a poll that names the missing variable, and every existing
//      tool exactly where it was.
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { MemoryBlobStore } from '../src/events/state-store.js';
import {
  EventBuffer,
  decodeCursor,
  encodeCursor,
  parseMessagePostedArgs,
} from '../src/events/buffer.js';
import { SlackEventsIngest, type WebSocketLike } from '../src/events/ingest.js';
import { toMessagePosted, MAX_TEXT_CHARS } from '../src/events/normalize.js';
import { EVENTS_EXTENSION } from '../src/events/protocol.js';
import { createMCPServer } from '../src/server.js';

/** A message body long enough that no ciphertext contains it by chance. */
const SECRET_TEXT = 'a message the sealed buffer must never show in plaintext';

const BOT = { userId: 'UBOT', botId: 'BBOT', workspaceUrl: 'https://tadasant.slack.com/' };
const KEY = Buffer.alloc(32, 7).toString('base64');
const T0 = Date.parse('2026-10-29T12:00:00Z');
const ts = (ms: number, n = 0) => `${Math.floor(ms / 1000)}.${String(n).padStart(6, '0')}`;

const ENV = {
  SLACK_APP_TOKEN: 'xapp-1-test',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_EVENTS_STATE_ENCRYPTION_KEY: KEY,
  STRAD_STATE_GCS_BUCKET: 'bucket',
  STRAD_STATE_GCS_CLIENT_EMAIL: 'sa@example.iam.gserviceaccount.com',
  STRAD_STATE_GCS_PRIVATE_KEY: 'unused-by-the-memory-store',
};

// =============================================================================
// normalize
// =============================================================================

describe('toMessagePosted', () => {
  const base = { type: 'message', channel: 'C1', channel_type: 'channel', ts: '1700000000.000100' };

  it('maps a channel message to the contract payload, eventId exact', () => {
    const e = toMessagePosted({ ...base, user: 'U1', text: 'hi <@UBOT>' }, BOT)!;
    expect(e.eventId).toBe('slack:C1:1700000000.000100');
    expect(e.timestamp).toBe('2023-11-14T22:13:20.000Z');
    expect(e.data).toEqual({
      channel_id: 'C1',
      channel_type: 'channel',
      ts: '1700000000.000100',
      user_id: 'U1',
      is_dm: false,
      mentions_bot: true,
      permalink: 'https://tadasant.slack.com/archives/C1/p1700000000000100',
      text: 'hi <@UBOT>',
    });
  });

  it('marks a DM, and links a reply into its thread', () => {
    const e = toMessagePosted(
      { ...base, channel: 'D9', channel_type: 'im', user: 'U1', thread_ts: '1699999999.000001' },
      BOT
    )!;
    expect(e.data.is_dm).toBe(true);
    expect(e.data.channel_type).toBe('im');
    expect(e.data.thread_ts).toBe('1699999999.000001');
    expect(e.data.permalink).toBe(
      'https://tadasant.slack.com/archives/D9/p1700000000000100?thread_ts=1699999999.000001&cid=D9'
    );
  });

  it("drops the bot's own posts, by user id and by bot id", () => {
    expect(toMessagePosted({ ...base, user: 'UBOT' }, BOT)).toBeNull();
    expect(toMessagePosted({ ...base, subtype: 'bot_message', bot_id: 'BBOT' }, BOT)).toBeNull();
  });

  it('keeps other bots, with their username', () => {
    const e = toMessagePosted(
      { ...base, subtype: 'bot_message', bot_id: 'BOTHER', username: 'ci' },
      BOT
    )!;
    expect(e.data.bot_id).toBe('BOTHER');
    expect(e.data.username).toBe('ci');
    expect(e.data.user_id).toBeUndefined();
  });

  it('drops edits, deletes, joins, hidden events and group DMs', () => {
    for (const subtype of ['message_changed', 'message_deleted', 'channel_join', 'channel_topic']) {
      expect(toMessagePosted({ ...base, user: 'U1', subtype }, BOT)).toBeNull();
    }
    expect(toMessagePosted({ ...base, user: 'U1', hidden: true }, BOT)).toBeNull();
    expect(toMessagePosted({ ...base, user: 'U1', channel_type: 'mpim' }, BOT)).toBeNull();
  });

  it(`cuts text to ${MAX_TEXT_CHARS} characters`, () => {
    const e = toMessagePosted({ ...base, user: 'U1', text: 'x'.repeat(9000) }, BOT)!;
    expect(e.data.text).toHaveLength(MAX_TEXT_CHARS);
  });
});

// =============================================================================
// the buffer and the cursor
// =============================================================================

function msg(channel: string, t: string, extra: Record<string, unknown> = {}) {
  return toMessagePosted(
    { type: 'message', channel, channel_type: channel.startsWith('D') ? 'im' : 'channel', ts: t, user: 'U1', ...extra },
    BOT
  )!;
}

describe('EventBuffer', () => {
  const all = parseMessagePostedArgs({});

  it('a null cursor returns no events and a cursor that sees the next one', () => {
    let now = T0;
    const b = new EventBuffer(7 * 86_400_000, () => now);
    b.add(msg('C1', ts(T0 - 1000)));
    const first = b.poll({ cursor: null, args: all, maxEvents: 100 });
    expect(first.events).toEqual([]);
    now += 10;
    b.add(msg('C1', ts(T0, 1)));
    const next = b.poll({ cursor: first.cursor, args: all, maxEvents: 100 });
    expect(next.events.map((e) => e.eventId)).toEqual([`slack:C1:${ts(T0, 1)}`]);
    expect(b.poll({ cursor: next.cursor, args: all, maxEvents: 100 }).events).toEqual([]);
  });

  it('dedupes on channel:ts', () => {
    const b = new EventBuffer(7 * 86_400_000, () => T0);
    expect(b.add(msg('C1', ts(T0)))).not.toBeNull();
    expect(b.add(msg('C1', ts(T0)))).toBeNull();
    expect(b.size).toBe(1);
  });

  it('pages with maxEvents and hasMore, and a narrow filter still advances', () => {
    const b = new EventBuffer(7 * 86_400_000, () => T0);
    const start = b.poll({ cursor: null, args: all, maxEvents: 1 }).cursor;
    for (let i = 0; i < 5; i++) b.add(msg(i % 2 ? 'D1' : 'C1', ts(T0, i)));
    const p1 = b.poll({ cursor: start, args: all, maxEvents: 2 });
    expect(p1.events).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    const p2 = b.poll({ cursor: p1.cursor, args: all, maxEvents: 10 });
    expect(p2.events).toHaveLength(3);
    expect(p2.hasMore).toBe(false);

    const noDms = parseMessagePostedArgs({ include_dms: false, channel_ids: ['C1'] });
    const filtered = b.poll({ cursor: start, args: noDms, maxEvents: 10 });
    expect(filtered.events.every((e) => e.data.channel_id === 'C1')).toBe(true);
    expect(filtered.cursor).toBe(b.head);
  });

  it('filters: addressed_to_bot, thread_ts, top_level_only, include_bot_authors', () => {
    const b = new EventBuffer(7 * 86_400_000, () => T0);
    const start = b.poll({ cursor: null, args: all, maxEvents: 1 }).cursor;
    const parent = ts(T0, 1);
    b.add(msg('C1', parent, { text: 'plain' }));
    b.add(msg('C1', ts(T0, 2), { text: 'hey <@UBOT>', thread_ts: parent }));
    b.add(msg('D1', ts(T0, 3)));
    b.add(msg('C1', ts(T0, 4), { user: undefined, subtype: 'bot_message', bot_id: 'BX' }));
    const ids = (args: Record<string, unknown>) =>
      b
        .poll({ cursor: start, args: parseMessagePostedArgs(args), maxEvents: 10 })
        .events.map((e) => e.data.ts);
    expect(ids({ addressed_to_bot: true })).toEqual([ts(T0, 2), ts(T0, 3)]);
    expect(ids({ thread_ts: parent })).toEqual([parent, ts(T0, 2)]);
    expect(ids({ top_level_only: true })).toEqual([parent, ts(T0, 3), ts(T0, 4)]);
    expect(ids({ include_bot_authors: false })).toEqual([parent, ts(T0, 2), ts(T0, 3)]);
  });

  it('refuses an unknown argument and a cursor it did not mint', () => {
    expect(() => parseMessagePostedArgs({ channel: 'C1' })).toThrow(/unknown argument "channel"/);
    expect(() => parseMessagePostedArgs({ include_dms: 'yes' })).toThrow(/boolean/);
    expect(() => decodeCursor('abc')).toThrow(/not one this server issued/);
    expect(decodeCursor(encodeCursor(42))).toBe(42);
    expect(decodeCursor(null)).toBeNull();
  });

  it('evicts by age and reports truncated to a cursor older than the eviction', () => {
    let now = T0;
    const b = new EventBuffer(86_400_000, () => now);
    const start = b.poll({ cursor: null, args: all, maxEvents: 1 }).cursor;
    b.add(msg('C1', ts(T0)));
    now += 2 * 86_400_000;
    b.prune();
    expect(b.size).toBe(0);
    const p = b.poll({ cursor: start, args: all, maxEvents: 10 });
    expect(p.truncated).toBe(true);
    expect(b.poll({ cursor: p.cursor, args: all, maxEvents: 10 }).truncated).toBe(false);
    // And a message already past retention is never admitted.
    expect(b.add(msg('C1', ts(T0 - 1000)))).toBeNull();
  });

  it('a conflict merge re-sequences foreign events above every cursor already issued', () => {
    let now = T0;
    const mine = new EventBuffer(7 * 86_400_000, () => now);
    const theirs = new EventBuffer(7 * 86_400_000, () => now);
    theirs.add(msg('C1', ts(T0, 1))); // the old process's event, an early seq
    now += 1000;
    mine.add(msg('C1', ts(now, 2)));
    const held = mine.poll({ cursor: null, args: all, maxEvents: 10 }).cursor;
    mine.merge(theirs.toDoc(), { resequence: true });
    const got = mine.poll({ cursor: held, args: all, maxEvents: 10 });
    expect(got.events.map((e) => e.data.ts)).toEqual([ts(T0, 1)]);
    expect(got.truncated).toBe(false);
    // A boot merge keeps the numbers clients were handed.
    const booted = new EventBuffer(7 * 86_400_000, () => now);
    booted.merge(theirs.toDoc(), { resequence: false });
    expect(booted.poll({ cursor: held, args: all, maxEvents: 10 }).events).toEqual([]);
  });

  it('a parent backfilled with thread_ts === ts has the same payload as one seen live', () => {
    const live = msg('C1', ts(T0, 1));
    const backfilled = msg('C1', ts(T0, 1), { thread_ts: ts(T0, 1) });
    expect(backfilled.data).toEqual(live.data);
    expect(backfilled.data.thread_ts).toBeUndefined();
  });

  it('a fresh buffer starts above every cursor an older process minted', () => {
    let now = T0;
    const old = new EventBuffer(7 * 86_400_000, () => now);
    old.add(msg('C1', ts(T0)));
    const held = old.poll({ cursor: null, args: all, maxEvents: 1 }).cursor;
    now += 1000;
    const fresh = new EventBuffer(7 * 86_400_000, () => now);
    fresh.add(msg('C1', ts(now, 5)));
    expect(fresh.poll({ cursor: held, args: all, maxEvents: 10 }).events).toHaveLength(1);
  });
});

// =============================================================================
// the ingest: socket, ack, backfill, lease
// =============================================================================

class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private listeners: Record<string, ((ev: never) => void)[]> = {};
  addEventListener(type: string, listener: (ev: never) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, ev: unknown): void {
    for (const l of this.listeners[type] ?? []) l(ev as never);
  }
  frame(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
}

interface FakeSlack {
  fetch: typeof fetch;
  calls: string[];
  history: Record<string, Record<string, unknown>[]>;
  replies: Record<string, Record<string, unknown>[]>;
}

function fakeSlack(): FakeSlack {
  const s: FakeSlack = {
    calls: [],
    history: {},
    replies: {},
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const method = String(input).split('/').pop()!;
      const params = new URLSearchParams(String(init?.body ?? ''));
      s.calls.push(method);
      const ok = (body: unknown) =>
        new Response(JSON.stringify({ ok: true, ...(body as object) }), { status: 200 });
      switch (method) {
        case 'auth.test':
          return ok({ user_id: 'UBOT', bot_id: 'BBOT', url: 'https://tadasant.slack.com/' });
        case 'apps.connections.open':
          return ok({ url: 'wss://fake/link' });
        case 'users.conversations':
          return ok({
            channels: Object.keys(s.history).map((id) => ({ id, is_im: id.startsWith('D') })),
          });
        case 'conversations.history': {
          const oldest = params.get('oldest')!;
          const msgs = (s.history[params.get('channel')!] ?? []).filter(
            (m) => String(m.ts) > oldest
          );
          return ok({ messages: [...msgs].reverse(), has_more: false });
        }
        case 'conversations.replies':
          return ok({ messages: s.replies[`${params.get('channel')}:${params.get('ts')}`] ?? [] });
        default:
          return ok({});
      }
    }) as typeof fetch,
  };
  return s;
}

async function bootIngest(blobs: MemoryBlobStore, slack: FakeSlack, clock: () => number) {
  const sockets: FakeSocket[] = [];
  const ingest = new SlackEventsIngest({
    env: ENV,
    blobs,
    fetch: slack.fetch,
    clock,
    manualTimers: true,
    webSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  await ingest.start();
  const connected = ingest.connectOnce();
  await new Promise((r) => setImmediate(r));
  return { ingest, sockets, connected };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('SlackEventsIngest', () => {
  it('acks every envelope, buffers a posted message, and drops its own echo', async () => {
    const blobs = new MemoryBlobStore();
    const slack = fakeSlack();
    let now = T0;
    const { ingest, sockets } = await bootIngest(blobs, slack, () => now);
    const sock = sockets[0]!;
    sock.frame({ type: 'hello' });
    await settle();
    expect(ingest.state).toBe('connected');
    const { cursor } = await ingest.poll({ cursor: null });

    now += 1000;
    sock.frame({
      envelope_id: 'env-1',
      type: 'events_api',
      payload: {
        event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: ts(now), text: SECRET_TEXT },
      },
    });
    sock.frame({
      envelope_id: 'env-2',
      type: 'events_api',
      payload: {
        event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UBOT', ts: ts(now, 1), text: 'me' },
      },
    });
    expect(sock.sent.map((s) => JSON.parse(s).envelope_id)).toEqual(['env-1', 'env-2']);

    const got = await ingest.poll({ cursor, arguments: {} });
    expect(got.events.map((e) => e.eventId)).toEqual([`slack:C1:${ts(now)}`]);
    expect(got.events[0]!.name).toBe('message_posted');
    expect(got.nextPollMs).toBeGreaterThan(0);

    await ingest.close();
    expect(blobs.objects.has('slack-events/buffer.bin')).toBe(true);
    // Sealed: the text does not appear in the object. The text is long on
    // purpose: a two-letter needle turns up in a kilobyte of ciphertext by
    // chance about once in seventy runs.
    expect(blobs.objects.get('slack-events/buffer.bin')!.data.toString('latin1')).not.toContain(SECRET_TEXT);
  });

  it('a new process takes the lease, backfills the gap, and the old one stands down', async () => {
    const blobs = new MemoryBlobStore();
    const slack = fakeSlack();
    let now = T0;
    const a = await bootIngest(blobs, slack, () => now);
    a.sockets[0]!.frame({ type: 'hello' });
    await settle();
    await a.ingest.liveTick(); // live_through = T0, persisted
    const cursor = (await a.ingest.poll({ cursor: null })).cursor;

    // Process A dies without flushing anything newer. While nobody is
    // connected, two messages land: one top-level, one reply to an older thread.
    const parent = ts(T0 - 3600_000);
    now = T0 + 10 * 60_000;
    slack.history.C1 = [
      { type: 'message', ts: parent, user: 'U2', text: 'parent', latest_reply: ts(now, 2) },
      { type: 'message', ts: ts(now, 1), user: 'U2', text: 'missed' },
    ];
    slack.replies[`C1:${parent}`] = [
      { type: 'message', ts: parent, user: 'U2', text: 'parent' },
      { type: 'message', ts: ts(now, 2), thread_ts: parent, user: 'U3', text: 'missed reply' },
    ];

    const b = await bootIngest(blobs, slack, () => now);
    b.sockets[0]!.frame({ type: 'hello' });
    await settle();
    const got = await b.ingest.poll({ cursor });
    expect(got.events.map((e) => e.data.text)).toEqual(['missed', 'missed reply']);
    // The parent predates the gap: replies re-read it, and it is not an event.
    expect(got.events.some((e) => e.data.ts === parent)).toBe(false);

    await a.ingest.leaseTick(); // inside the interval: no read yet
    now += 31_000;
    await a.ingest.leaseTick();
    expect(a.ingest.state).toBe('superseded');
    expect(a.sockets[0]!.closed).not.toBeNull();
    expect((a.ingest.status().lease as { superseded: boolean }).superseded).toBe(true);

    await b.ingest.close();
  });

  it('a backfill that fails for one conversation reads the rest and does not advance live_through', async () => {
    const blobs = new MemoryBlobStore();
    const slack = fakeSlack();
    let now = T0;
    const a = await bootIngest(blobs, slack, () => now);
    a.sockets[0]!.frame({ type: 'hello' });
    await settle();
    await a.ingest.liveTick();
    await a.ingest.close();

    now = T0 + 10 * 60_000;
    slack.history.C1 = [{ type: 'message', ts: ts(now, 1), user: 'U2', text: 'recovered' }];
    slack.history.C2 = [];
    const real = slack.fetch;
    slack.fetch = (async (input: string | URL, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body ?? ''));
      if (String(input).endsWith('conversations.history') && params.get('channel') === 'C2') {
        return new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }));
      }
      return real(input, init);
    }) as typeof fetch;

    const b = await bootIngest(blobs, slack, () => now);
    b.sockets[0]!.frame({ type: 'hello' });
    await settle();
    const status = b.ingest.status() as {
      backfill: { conversations_failed: number; events_added: number; gap_still_owed: boolean };
      buffer: { live_through: string };
    };
    expect(status.backfill).toMatchObject({ conversations_failed: 1, events_added: 1, gap_still_owed: true });
    now += 60_000;
    await b.ingest.liveTick();
    // Still the old moment: the next reconnect re-reads the whole gap.
    expect((b.ingest.status().buffer as { live_through: string }).live_through).toBe(
      new Date(T0).toISOString()
    );
    await b.ingest.close();
  });

  it('a superseded process takes the lease back once the owner stops heartbeating', async () => {
    const blobs = new MemoryBlobStore();
    const slack = fakeSlack();
    let now = T0;
    const a = await bootIngest(blobs, slack, () => now);
    a.sockets[0]!.frame({ type: 'hello' });
    await settle();
    const b = await bootIngest(blobs, slack, () => now);
    now += 31_000;
    await a.ingest.leaseTick();
    expect(a.ingest.state).toBe('superseded');

    // B is alive and heartbeating: A stays down.
    await b.ingest.leaseTick();
    now += 31_000;
    await a.ingest.leaseTick();
    expect(a.ingest.state).toBe('superseded');

    // B dies without a word. Past three check intervals, A takes it back.
    now += 100_000;
    await a.ingest.leaseTick();
    expect(a.ingest.state).toBe('reconnecting');
    expect((a.ingest.status().lease as { superseded: boolean }).superseded).toBe(false);
    // And B, if it were still running, would learn it lost.
    now += 31_000;
    await b.ingest.leaseTick();
    expect(b.ingest.state).toBe('superseded');
    await a.ingest.close();
    await b.ingest.close();
  });

  it('a first-ever boot backfills nothing: from now is the only honest start', async () => {
    const slack = fakeSlack();
    slack.history.C1 = [{ type: 'message', ts: ts(T0 - 60_000), user: 'U2', text: 'old' }];
    const { ingest, sockets } = await bootIngest(new MemoryBlobStore(), slack, () => T0);
    sockets[0]!.frame({ type: 'hello' });
    await settle();
    expect(slack.calls).not.toContain('conversations.history');
    expect(ingest.status().buffer).toMatchObject({ events: 0 });
    await ingest.close();
  });

  it('reconnects when Slack asks it to refresh', async () => {
    const { ingest, sockets, connected } = await bootIngest(
      new MemoryBlobStore(),
      fakeSlack(),
      () => T0
    );
    sockets[0]!.frame({ type: 'hello' });
    sockets[0]!.frame({ type: 'disconnect', reason: 'refresh_requested' });
    await connected;
    expect(sockets[0]!.closed?.code).toBe(1000);
    expect(ingest.state).toBe('reconnecting');
    await ingest.close();
  });
});

// =============================================================================
// the wire: events/list, events/poll, and the extension
// =============================================================================

async function connect(created: ReturnType<typeof createMCPServer>) {
  const server = new Server({ name: 'slack', version: '0' }, { capabilities: { tools: {} } });
  await created.registerHandlers(server, () => {
    throw new Error('no Slack client in this test');
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(b);
  return client;
}

const Loose = ResultSchema.passthrough();

describe('events over MCP', () => {
  it('unconfigured: no extension, no event types, a poll that names the missing token, tools intact', async () => {
    const created = createMCPServer({ version: '0', events: { env: { SLACK_BOT_TOKEN: 'xoxb-x' } } });
    const client = await connect(created);
    expect(client.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION]).toBeUndefined();

    const list = await client.request({ method: 'events/list', params: {} }, Loose);
    expect(list.events).toEqual([]);

    await expect(
      client.request(
        { method: 'events/poll', params: { name: 'message_posted', arguments: {}, cursor: null } },
        Loose
      )
    ).rejects.toMatchObject({ code: -32023, message: expect.stringContaining('SLACK_APP_TOKEN') });

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(14);
    expect(tools.map((t) => t.name)).toContain('slack_events_status');
    expect(tools.map((t) => t.name)).toContain('slack_post_message');

    const status = await client.callTool({ name: 'slack_events_status', arguments: {} });
    const body = JSON.parse((status.content as { text: string }[])[0]!.text);
    expect(body).toMatchObject({ state: 'not_configured', events_served: false });
    expect(body.reason).toContain('SLACK_APP_TOKEN');
    expect(JSON.stringify(body)).not.toContain('xoxb-x');
  });

  it('configured: advertises the extension and lists message_posted with its schemas', async () => {
    const ingest = new SlackEventsIngest({
      env: ENV,
      blobs: new MemoryBlobStore(),
      fetch: fakeSlack().fetch,
      manualTimers: true,
      webSocket: () => new FakeSocket(),
    });
    const created = createMCPServer({ version: '0', events: ingest });
    const client = await connect(created);
    expect(client.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION]).toEqual({});

    const list = await client.request({ method: 'events/list', params: {} }, Loose);
    const [descriptor] = list.events as {
      name: string;
      delivery: string[];
      inputSchema: { properties: Record<string, unknown> };
    }[];
    expect(descriptor!.name).toBe('message_posted');
    expect(descriptor!.delivery).toEqual(['poll', 'webhook']);
    expect(Object.keys(descriptor!.inputSchema.properties).sort()).toEqual([
      'addressed_to_bot',
      'channel_ids',
      'include_bot_authors',
      'include_dms',
      'thread_ts',
      'top_level_only',
    ]);

    const fresh = await client.request(
      { method: 'events/poll', params: { name: 'message_posted', arguments: {}, cursor: null } },
      Loose
    );
    expect(fresh).toMatchObject({ events: [], truncated: false, hasMore: false });
    expect(typeof fresh.cursor).toBe('string');

    await expect(
      client.request({ method: 'events/poll', params: { name: 'nope', arguments: {}, cursor: null } }, Loose)
    ).rejects.toMatchObject({ code: -32023 });
    await expect(
      client.request(
        { method: 'events/poll', params: { name: 'message_posted', arguments: { bogus: 1 }, cursor: null } },
        Loose
      )
    ).rejects.toMatchObject({ code: -32602 });
    await ingest.close();
  });
});
