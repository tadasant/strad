/**
 * The ring buffer `events/poll` is answered from: every `message_posted`
 * occurrence this workspace produced in the last N days, in ingest order,
 * deduplicated on `channel:ts`.
 *
 * THE CURSOR IS A SEQUENCE NUMBER, and the sequence is time-based on purpose.
 * `nextSeq` is `max(last + 1, now_ms * 1000)`, so it is monotonic inside a
 * process AND larger than anything an earlier process minted (clock skew
 * aside). That is what keeps a cursor meaningful across a deploy, and across a
 * buffer that was lost entirely: a fresh process starts above every cursor a
 * client holds, so the client is handed what arrived since rather than being
 * told to wait for the sequence to catch up with it. 1.7e15 is well inside
 * `Number.MAX_SAFE_INTEGER`.
 *
 * ORDER IS INGEST ORDER, NOT MESSAGE ORDER. A message recovered by backfill is
 * appended when it is recovered, with its own (older) `timestamp`. Per the
 * draft spec, ordering is per subscription and what a client must not miss is
 * an event after its cursor — which ingest order guarantees and message order
 * would not.
 *
 * TRUNCATION is the one signal that something was skipped: an event evicted
 * (by age or by the size cap) with a sequence above the client's cursor.
 * `evictedThrough` is the largest evicted sequence, which is exactly the test.
 */
import type { MessagePostedData, StoredEvent } from './normalize.js';

export const DEFAULT_MAX_EVENTS = 100;
export const MAX_MAX_EVENTS = 1000;
/** A hard cap on the buffer whatever its age, so one burst cannot grow the object without bound. */
export const MAX_BUFFERED_EVENTS = 20_000;

const CURSOR_PREFIX = 'v1.';

export class InvalidEventArguments extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventArguments';
  }
}

export interface MessagePostedArgs {
  addressed_to_bot?: boolean;
  channel_ids?: string[];
  include_dms: boolean;
  thread_ts?: string;
  top_level_only?: boolean;
  include_bot_authors: boolean;
}

const ARG_NAMES = new Set([
  'addressed_to_bot',
  'channel_ids',
  'include_dms',
  'thread_ts',
  'top_level_only',
  'include_bot_authors',
]);

/**
 * The subscription arguments, checked by hand rather than by a schema library
 * so the error names the argument. An unknown key is refused: a filter that is
 * silently ignored widens a trigger without anyone being told.
 */
export function parseMessagePostedArgs(raw: unknown): MessagePostedArgs {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidEventArguments('arguments must be an object');
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!ARG_NAMES.has(key)) {
      throw new InvalidEventArguments(
        `unknown argument "${key}" for message_posted; accepted: ${[...ARG_NAMES].join(', ')}`
      );
    }
  }
  const bool = (key: string): boolean | undefined => {
    const v = o[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'boolean') throw new InvalidEventArguments(`${key} must be a boolean`);
    return v;
  };
  let channelIds: string[] | undefined;
  if (o.channel_ids !== undefined && o.channel_ids !== null) {
    if (!Array.isArray(o.channel_ids) || o.channel_ids.some((c) => typeof c !== 'string')) {
      throw new InvalidEventArguments('channel_ids must be an array of channel id strings');
    }
    channelIds = o.channel_ids as string[];
  }
  let threadTs: string | undefined;
  if (o.thread_ts !== undefined && o.thread_ts !== null) {
    if (typeof o.thread_ts !== 'string' || !/^\d+\.\d+$/.test(o.thread_ts)) {
      throw new InvalidEventArguments('thread_ts must be a Slack timestamp like "1700000000.123456"');
    }
    threadTs = o.thread_ts;
  }
  return {
    addressed_to_bot: bool('addressed_to_bot'),
    channel_ids: channelIds,
    include_dms: bool('include_dms') ?? true,
    thread_ts: threadTs,
    top_level_only: bool('top_level_only'),
    include_bot_authors: bool('include_bot_authors') ?? true,
  };
}

/** Every argument narrows; an absent one does not. */
export function matchesMessagePosted(d: MessagePostedData, a: MessagePostedArgs): boolean {
  if (a.addressed_to_bot === true && !(d.is_dm || d.mentions_bot)) return false;
  if (a.channel_ids !== undefined && !a.channel_ids.includes(d.channel_id)) return false;
  if (!a.include_dms && d.is_dm) return false;
  if (a.thread_ts !== undefined && d.thread_ts !== a.thread_ts && d.ts !== a.thread_ts) return false;
  if (a.top_level_only === true && d.thread_ts !== undefined && d.thread_ts !== d.ts) return false;
  if (!a.include_bot_authors && (d.bot_id !== undefined || d.user_id === undefined)) return false;
  return true;
}

export function encodeCursor(seq: number): string {
  return `${CURSOR_PREFIX}${seq}`;
}

/** Null for a null/absent cursor ("from now"); throws for one this server did not mint. */
export function decodeCursor(cursor: unknown): number | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX)) {
    throw new InvalidEventArguments('cursor is not one this server issued');
  }
  const seq = Number(cursor.slice(CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new InvalidEventArguments('cursor is not one this server issued');
  }
  return seq;
}

export interface BufferDoc {
  version: 1;
  last_seq: number;
  evicted_through: number;
  /**
   * Epoch ms up to which SOME process held a live socket. A reconnect backfills
   * from just before it, which is what closes the gap a restart opens.
   */
  live_through: number | null;
  events: StoredEvent[];
}

export interface PollOutcome {
  events: StoredEvent[];
  cursor: number;
  truncated: boolean;
  hasMore: boolean;
}

export class EventBuffer {
  private events: StoredEvent[] = [];
  private ids = new Set<string>();
  private lastSeq = 0;
  private evictedThrough = 0;
  liveThrough: number | null = null;
  /** Bumped on every change; the persister flushes when it moves. */
  revision = 0;

  constructor(
    private readonly retentionMs: number,
    private readonly clock: () => number = Date.now,
    private readonly maxEvents: number = MAX_BUFFERED_EVENTS
  ) {}

  get size(): number {
    return this.events.length;
  }

  get head(): number {
    return this.lastSeq;
  }

  get oldest(): StoredEvent | undefined {
    return this.events[0];
  }

  get newest(): StoredEvent | undefined {
    return this.events[this.events.length - 1];
  }

  has(eventId: string): boolean {
    return this.ids.has(eventId);
  }

  private nextSeq(): number {
    this.lastSeq = Math.max(this.lastSeq + 1, this.clock() * 1000);
    return this.lastSeq;
  }

  /** Too old to keep: never admitted, so a backfill cannot resurrect what retention dropped. */
  private expired(timestamp: string): boolean {
    return Date.parse(timestamp) < this.clock() - this.retentionMs;
  }

  /** Appends unless the id is already buffered or the message is past retention. */
  add(event: Omit<StoredEvent, 'seq'>): StoredEvent | null {
    if (this.ids.has(event.eventId) || this.expired(event.timestamp)) return null;
    const stored: StoredEvent = { ...event, seq: this.nextSeq() };
    this.events.push(stored);
    this.ids.add(stored.eventId);
    this.revision++;
    this.prune();
    return stored;
  }

  /** Drops what is past retention, then whatever exceeds the cap, oldest-ingested first. */
  prune(): void {
    const before = this.events.length;
    const kept: StoredEvent[] = [];
    for (const e of this.events) {
      if (this.expired(e.timestamp)) this.evict(e);
      else kept.push(e);
    }
    while (kept.length > this.maxEvents) this.evict(kept.shift()!);
    this.events = kept;
    if (this.events.length !== before) this.revision++;
  }

  private evict(e: StoredEvent): void {
    this.ids.delete(e.eventId);
    this.evictedThrough = Math.max(this.evictedThrough, e.seq);
  }

  poll(opts: {
    cursor: number | null;
    args: MessagePostedArgs;
    maxEvents: number;
    maxAgeMs?: number;
  }): PollOutcome {
    if (opts.cursor === null) {
      return { events: [], cursor: this.lastSeq, truncated: false, hasMore: false };
    }
    const from = opts.cursor;
    const truncated = from < this.evictedThrough;
    const notBefore = opts.maxAgeMs !== undefined ? this.clock() - opts.maxAgeMs : -Infinity;
    const out: StoredEvent[] = [];
    let hasMore = false;
    for (const e of this.events) {
      if (e.seq <= from) continue;
      if (Date.parse(e.timestamp) < notBefore) continue;
      if (!matchesMessagePosted(e.data, opts.args)) continue;
      if (out.length >= opts.maxEvents) {
        hasMore = true;
        break;
      }
      out.push(e);
    }
    // Stopped early: resume after the last one handed out. Otherwise everything
    // up to the head was scanned, matched or not, and the cursor moves there —
    // which is how a narrow filter keeps advancing through traffic it ignores.
    const cursor = hasMore ? out[out.length - 1]!.seq : Math.max(from, this.lastSeq);
    return { events: out, cursor, truncated, hasMore };
  }

  toDoc(): BufferDoc {
    return {
      version: 1,
      last_seq: this.lastSeq,
      evicted_through: this.evictedThrough,
      live_through: this.liveThrough,
      events: this.events,
    };
  }

  /**
   * Folds a persisted document in: the union by event id.
   *
   * `resequence` decides what a FOREIGN event's sequence number is. At boot
   * (false) the document is the past, its numbers are the ones clients were
   * handed, and they are kept. After a write CONFLICT (true) the document is
   * another live process's — the old one, during a deploy overlap — and its
   * numbers may sit below a cursor this process has already handed out, so a
   * client would never see those events and nothing would say so. Each event
   * new to this buffer is given a fresh sequence, in its own order, which puts
   * it after every cursor issued so far.
   */
  merge(doc: BufferDoc, opts: { resequence: boolean }): void {
    if (doc.version !== 1) return;
    this.lastSeq = Math.max(this.lastSeq, doc.last_seq);
    this.evictedThrough = Math.max(this.evictedThrough, doc.evicted_through);
    const foreign = [...doc.events].sort((a, b) => a.seq - b.seq);
    for (const e of foreign) {
      if (this.ids.has(e.eventId)) continue;
      this.events.push(opts.resequence ? { ...e, seq: this.nextSeq() } : e);
      this.ids.add(e.eventId);
    }
    this.events.sort((a, b) => a.seq - b.seq);
    if (doc.live_through !== null) {
      this.liveThrough = Math.max(this.liveThrough ?? 0, doc.live_through);
    }
    this.revision++;
    this.prune();
  }

  /**
   * Becomes exactly the document: the owner's buffer, numbers and all. A
   * superseded process answers polls this way, so the cursors it hands out are
   * the owner's and stay valid when the next poll lands on the owner.
   */
  replace(doc: BufferDoc): void {
    if (doc.version !== 1) return;
    this.events = [...doc.events].sort((a, b) => a.seq - b.seq);
    this.ids = new Set(this.events.map((e) => e.eventId));
    this.lastSeq = doc.last_seq;
    this.evictedThrough = doc.evicted_through;
    this.liveThrough = doc.live_through;
    this.revision++;
  }
}
