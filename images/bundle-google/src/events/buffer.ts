/**
 * The ring buffer `events/poll` and webhook delivery are answered from: every
 * `message_received` occurrence this mailbox produced in the last N days, in
 * ingest order, deduplicated on the Gmail message id.
 *
 * Slack's buffer (`servers/bundle-api/fork/slack/src/events/buffer.ts`) is the
 * model, and the cursor, sequencing, eviction and merge rules are its rules:
 *
 *   - THE CURSOR IS A SEQUENCE NUMBER, `max(last + 1, now_ms * 1000)`, so it is
 *     monotonic in a process and above anything an earlier process minted. A
 *     cursor survives a deploy, and a lost buffer.
 *   - ORDER IS INGEST ORDER. A message recovered late is appended late.
 *   - TRUNCATION means an event above the client's cursor was evicted.
 *
 * WHAT IS DIFFERENT IS THE `query` ARGUMENT. Slack's filters are fields on the
 * event; a Gmail search is a question only Gmail can answer. So each event
 * carries a verdict per query (`q`), decided by asking Gmail (`ingest.ts`), and
 * an event can be UNDECIDED for a query a subscriber just started using. A
 * poll or a delivery never steps over an undecided event: it stops before it,
 * and `readyThrough` says how far it may go. That costs latency while Gmail's
 * search index catches up, and never an event.
 */
import { CURSOR_PREFIX, encodeCursor } from "./webhook/cursor.js";
import type { StoredEvent } from "./normalize.js";

export { encodeCursor };

export const DEFAULT_MAX_EVENTS = 100;
export const MAX_MAX_EVENTS = 1000;
/** A hard cap on the buffer whatever its age. */
export const MAX_BUFFERED_EVENTS = 20_000;
/** A query longer than this is refused: Gmail's own search box takes about this much. */
export const MAX_QUERY_CHARS = 1_000;

export class InvalidEventArguments extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEventArguments";
  }
}

export interface MessageReceivedArgs {
  /** A Gmail search, trimmed. Absent: every received message. */
  query?: string;
  include_automated: boolean;
}

const ARG_NAMES = new Set(["query", "include_automated"]);

/** Unknown keys are refused: a filter silently ignored widens a trigger. */
export function parseMessageReceivedArgs(raw: unknown): MessageReceivedArgs {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidEventArguments("arguments must be an object");
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!ARG_NAMES.has(key)) {
      throw new InvalidEventArguments(
        `unknown argument "${key}" for message_received; accepted: ${[...ARG_NAMES].join(", ")}`,
      );
    }
  }
  let query: string | undefined;
  if (o.query !== undefined && o.query !== null) {
    if (typeof o.query !== "string") throw new InvalidEventArguments("query must be a string");
    if (o.query.length > MAX_QUERY_CHARS) {
      throw new InvalidEventArguments(`query must be at most ${MAX_QUERY_CHARS} characters`);
    }
    query = o.query.trim() || undefined;
  }
  let includeAutomated = false;
  if (o.include_automated !== undefined && o.include_automated !== null) {
    if (typeof o.include_automated !== "boolean") {
      throw new InvalidEventArguments("include_automated must be a boolean");
    }
    includeAutomated = o.include_automated;
  }
  return { ...(query !== undefined ? { query } : {}), include_automated: includeAutomated };
}

/** True, false, or `undefined` while Gmail has not yet said whether `query` matches. */
export function matchesMessageReceived(e: StoredEvent, a: MessageReceivedArgs): boolean | undefined {
  if (!a.include_automated && e.data.is_automated) return false;
  if (a.query === undefined) return true;
  return e.q?.[a.query];
}

/** Null for a null/absent cursor ("from now"); throws for one this server did not mint. */
export function decodeCursor(cursor: unknown): number | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string" || !cursor.startsWith(CURSOR_PREFIX)) {
    throw new InvalidEventArguments("cursor is not one this server issued");
  }
  const seq = Number(cursor.slice(CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new InvalidEventArguments("cursor is not one this server issued");
  }
  return seq;
}

export interface BufferDoc {
  version: 1;
  last_seq: number;
  evicted_through: number;
  /** Epoch ms of the last complete read of the mailbox's history. */
  live_through: number | null;
  /** Gmail's history id that read reached. Null before the first one. */
  history_id: string | null;
  /** Epoch ms the current `users.watch` expires, or null. */
  watch_expiration: number | null;
  /** Every query a subscriber has used, with when it was last used. Evaluated at ingest. */
  queries: Record<string, number>;
  /**
   * Per query, the sequence ingest decides it from: the head when the query
   * was first used, or an older cursor a subscriber brought. Nothing below it
   * is decided in the background; a poll from an older cursor decides its own.
   */
  query_from?: Record<string, number>;
  events: StoredEvent[];
}

export interface PollOutcome {
  events: StoredEvent[];
  cursor: number;
  truncated: boolean;
  hasMore: boolean;
}

/** A query nobody has polled or subscribed with for this long stops being evaluated at ingest. */
export const QUERY_IDLE_MS = 7 * 86_400_000;
/** Most queries evaluated at ingest. More than this and each poll decides its own. */
export const MAX_KNOWN_QUERIES = 20;

export class EventBuffer {
  private events: StoredEvent[] = [];
  private byId = new Map<string, StoredEvent>();
  private lastSeq = 0;
  private evictedThrough = 0;
  liveThrough: number | null = null;
  historyId: string | null = null;
  watchExpiration: number | null = null;
  private queries = new Map<string, number>();
  private queryFrom = new Map<string, number>();
  /** Bumped on every change; the persister flushes when it moves. */
  revision = 0;

  constructor(
    private readonly retentionMs: number,
    private readonly clock: () => number = Date.now,
    private readonly maxEvents: number = MAX_BUFFERED_EVENTS,
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

  get evictedThroughSeq(): number {
    return this.evictedThrough;
  }

  has(eventId: string): boolean {
    return this.byId.has(eventId);
  }

  /**
   * Records that `query` is in use, from `cursor` (null: from now). Returns
   * true when it is new. A new query is decided from the head, not from the
   * start of the buffer: a week of mail is not worth deciding for a query
   * nobody will read it with, and deciding it would starve every other query.
   */
  noteQuery(query: string, cursor: number | null = null): boolean {
    const fresh = !this.queries.has(query);
    const now = this.clock();
    const from = Math.min(this.queryFrom.get(query) ?? this.lastSeq, cursor ?? this.lastSeq);
    if (from !== this.queryFrom.get(query)) {
      this.queryFrom.set(query, from);
      this.revision++;
    }
    // A write per poll is not worth it; once an hour keeps the idle clock honest.
    if (fresh || now - this.queries.get(query)! > 3_600_000) {
      this.queries.set(query, now);
      this.revision++;
    }
    return fresh;
  }

  /** The queries ingest evaluates every new message against, most recently used first. */
  knownQueries(): string[] {
    return [...this.queries.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_KNOWN_QUERIES)
      .map(([q]) => q);
  }

  /** Where ingest decides `query` from. */
  decideFrom(query: string): number {
    return this.queryFrom.get(query) ?? this.lastSeq;
  }

  /** Events after `after` that are undecided for `query`, oldest first. */
  undecided(query: string, after = 0, limit = Number.MAX_SAFE_INTEGER): StoredEvent[] {
    const out: StoredEvent[] = [];
    for (let i = this.firstAfter(after); i < this.events.length && out.length < limit; i++) {
      const e = this.events[i]!;
      if (e.q?.[query] === undefined) out.push(e);
    }
    return out;
  }

  /** Records Gmail's verdict. A verdict is never changed once given: a poll's answer must be stable. */
  decide(eventId: string, query: string, matches: boolean): void {
    const e = this.byId.get(eventId);
    if (!e || e.q?.[query] !== undefined) return;
    e.q = { ...(e.q ?? {}), [query]: matches };
    this.revision++;
  }

  private firstAfter(after: number): number {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.events[mid]!.seq <= after) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Matching events after `after`, oldest first, at most `limit`, stopping
   * before the first event still undecided for these arguments.
   */
  eventsAfter(after: number, args: MessageReceivedArgs, limit: number): StoredEvent[] {
    const out: StoredEvent[] = [];
    for (let i = this.firstAfter(after); i < this.events.length && out.length < limit; i++) {
      const e = this.events[i]!;
      const m = matchesMessageReceived(e, args);
      if (m === undefined) break;
      if (m) out.push(e);
    }
    return out;
  }

  /** The highest sequence through which every match for `args` is decided. */
  readyThrough(args: MessageReceivedArgs, after = 0): number {
    for (let i = this.firstAfter(after); i < this.events.length; i++) {
      const e = this.events[i]!;
      if (matchesMessageReceived(e, args) === undefined) return e.seq - 1;
    }
    return this.lastSeq;
  }

  private nextSeq(): number {
    this.lastSeq = Math.max(this.lastSeq + 1, this.clock() * 1000);
    return this.lastSeq;
  }

  private expired(timestamp: string): boolean {
    return Date.parse(timestamp) < this.clock() - this.retentionMs;
  }

  /** Appends unless the id is already buffered or the message is past retention. */
  add(event: Omit<StoredEvent, "seq">): StoredEvent | null {
    if (this.byId.has(event.eventId) || this.expired(event.timestamp)) return null;
    const stored: StoredEvent = { ...event, seq: this.nextSeq() };
    this.events.push(stored);
    this.byId.set(stored.eventId, stored);
    this.revision++;
    this.prune();
    return stored;
  }

  /** Drops what is past retention, then whatever exceeds the cap; and forgets idle queries. */
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
    const now = this.clock();
    for (const [q, at] of this.queries) {
      if (now - at > QUERY_IDLE_MS) {
        this.queries.delete(q);
        this.queryFrom.delete(q);
        this.revision++;
      }
    }
  }

  private evict(e: StoredEvent): void {
    this.byId.delete(e.eventId);
    this.evictedThrough = Math.max(this.evictedThrough, e.seq);
  }

  poll(opts: {
    cursor: number | null;
    args: MessageReceivedArgs;
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
    let stoppedAt: number | null = null;
    for (let i = this.firstAfter(from); i < this.events.length; i++) {
      const e = this.events[i]!;
      if (Date.parse(e.timestamp) < notBefore) continue;
      const m = matchesMessageReceived(e, opts.args);
      if (m === undefined) {
        // Undecided: the cursor stops just before it, and the next poll asks again.
        stoppedAt = e.seq - 1;
        break;
      }
      if (!m) continue;
      if (out.length >= opts.maxEvents) {
        hasMore = true;
        break;
      }
      out.push(e);
    }
    const cursor = hasMore
      ? out[out.length - 1]!.seq
      : stoppedAt !== null
        ? Math.max(from, stoppedAt)
        : Math.max(from, this.lastSeq);
    return { events: out, cursor, truncated, hasMore };
  }

  toDoc(): BufferDoc {
    return {
      version: 1,
      last_seq: this.lastSeq,
      evicted_through: this.evictedThrough,
      live_through: this.liveThrough,
      history_id: this.historyId,
      watch_expiration: this.watchExpiration,
      queries: Object.fromEntries(this.queries),
      query_from: Object.fromEntries(this.queryFrom),
      events: this.events,
    };
  }

  /**
   * Folds a persisted document in: the union by event id, and the union of
   * their verdicts. `resequence`, as in Slack's buffer: true after a write
   * conflict, so another live process's events land after every cursor this
   * one has handed out.
   */
  merge(doc: BufferDoc, opts: { resequence: boolean }): void {
    if (doc.version !== 1) return;
    this.lastSeq = Math.max(this.lastSeq, doc.last_seq);
    this.evictedThrough = Math.max(this.evictedThrough, doc.evicted_through);
    const foreign = [...doc.events].sort((a, b) => a.seq - b.seq);
    for (const e of foreign) {
      const mine = this.byId.get(e.eventId);
      if (mine) {
        if (e.q) mine.q = { ...e.q, ...(mine.q ?? {}) };
        continue;
      }
      const added = opts.resequence ? { ...e, seq: this.nextSeq() } : { ...e };
      this.events.push(added);
      this.byId.set(added.eventId, added);
    }
    this.events.sort((a, b) => a.seq - b.seq);
    if (doc.live_through !== null) this.liveThrough = Math.max(this.liveThrough ?? 0, doc.live_through);
    // History ids only grow; the larger one has read further.
    if (doc.history_id !== null && (this.historyId === null || BigInt(doc.history_id) > BigInt(this.historyId))) {
      this.historyId = doc.history_id;
    }
    if (doc.watch_expiration !== null) {
      this.watchExpiration = Math.max(this.watchExpiration ?? 0, doc.watch_expiration);
    }
    for (const [q, at] of Object.entries(doc.queries ?? {})) {
      this.queries.set(q, Math.max(this.queries.get(q) ?? 0, at));
    }
    for (const [q, from] of Object.entries(doc.query_from ?? {})) {
      this.queryFrom.set(q, Math.min(this.queryFrom.get(q) ?? from, from));
    }
    this.revision++;
    this.prune();
  }

  /** Becomes exactly the document: what a superseded process answers polls from. */
  replace(doc: BufferDoc): void {
    if (doc.version !== 1) return;
    this.events = [...doc.events].sort((a, b) => a.seq - b.seq);
    this.byId = new Map(this.events.map((e) => [e.eventId, e]));
    this.lastSeq = doc.last_seq;
    this.evictedThrough = doc.evicted_through;
    this.liveThrough = doc.live_through;
    this.historyId = doc.history_id;
    this.watchExpiration = doc.watch_expiration;
    this.queries = new Map(Object.entries(doc.queries ?? {}));
    this.queryFrom = new Map(Object.entries(doc.query_from ?? {}));
    this.revision++;
  }
}
