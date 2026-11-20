/**
 * The ring buffer `events/poll` and webhook delivery are answered from: every
 * `message_received` occurrence the bridge saw arrive in the last N days, in
 * ingest order, deduplicated on the eventId.
 *
 * Slack's and Gmail's buffers (`servers/bundle-api/fork/slack/src/events/buffer.ts`,
 * `images/bundle-google/src/events/buffer.ts`) are the model, and the cursor,
 * sequencing, eviction and merge rules are theirs:
 *
 *   - THE CURSOR IS A SEQUENCE NUMBER, `max(last + 1, now_ms * 1000)`, so it is
 *     monotonic in a process and above anything an earlier process minted. A
 *     cursor survives a deploy, and a lost buffer.
 *   - ORDER IS INGEST ORDER, not the sender's clock. A message from a phone
 *     that was offline arrives stamped minutes early; it is appended late, so
 *     a cursor never steps over it.
 *   - TRUNCATION means an event above the client's cursor was evicted.
 *
 * Every argument is a field test on the event, decided at once, so nothing
 * here is ever undecided (Gmail's `query` is the case that can be).
 */
import { CURSOR_PREFIX, encodeCursor } from "./webhook/cursor.js";
import type { MediaType, MessageReceived } from "./normalize.js";

export { encodeCursor };

export const DEFAULT_MAX_EVENTS = 100;
export const MAX_MAX_EVENTS = 1000;
/** A hard cap on the buffer whatever its age. */
export const MAX_BUFFERED_EVENTS = 20_000;
/** Most chats one subscription may name. */
export const MAX_CHAT_IDS = 100;

/** A WhatsApp JID a subscriber may name: a group, a person, or a LID. Zimmer's own rule. */
const CHAT_ID = /^[0-9A-Za-z.:_-]+@(g\.us|s\.whatsapp\.net|lid|c\.us)$/;

export class InvalidEventArguments extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEventArguments";
  }
}

export interface MessageReceivedArgs {
  /** Only these chats (normalized JIDs), when present. */
  chat_ids?: string[];
  include_from_me: boolean;
  include_groups: boolean;
}

/** One buffered occurrence. `data` is the payload as delivered. */
export interface StoredEvent {
  eventId: string;
  /** ISO 8601: the message's own timestamp. */
  timestamp: string;
  seq: number;
  data: MessageReceived;
  /** The chat's other JID, for `chat_ids`. Not part of the payload. */
  chat_alt?: string;
}

const ARG_NAMES = new Set(["chat_ids", "include_from_me", "include_groups"]);

/** `123:4@s.whatsapp.net` → `123@s.whatsapp.net`, `@c.us` → `@s.whatsapp.net`. */
function normalizeChatId(jid: string): string {
  const at = jid.indexOf("@");
  const user = jid.slice(0, at).split(":")[0]!;
  const server = jid.slice(at + 1);
  return `${user}@${server === "c.us" ? "s.whatsapp.net" : server}`;
}

function optionalBoolean(o: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const v = o[name];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new InvalidEventArguments(`${name} must be a boolean`);
  return v;
}

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
  let chatIds: string[] | undefined;
  if (o.chat_ids !== undefined && o.chat_ids !== null) {
    if (!Array.isArray(o.chat_ids) || o.chat_ids.length === 0) {
      throw new InvalidEventArguments("chat_ids must be a non-empty array of chat ids");
    }
    if (o.chat_ids.length > MAX_CHAT_IDS) {
      throw new InvalidEventArguments(`chat_ids may name at most ${MAX_CHAT_IDS} chats`);
    }
    const ids = new Set<string>();
    for (const id of o.chat_ids) {
      if (typeof id !== "string" || !CHAT_ID.test(id.trim())) {
        throw new InvalidEventArguments(
          'each chat_ids entry must be a WhatsApp chat id ("…@g.us" for a group, "…@s.whatsapp.net" ' +
            "for a person), as whatsapp_list_chats returns it",
        );
      }
      ids.add(normalizeChatId(id.trim()));
    }
    chatIds = [...ids].sort();
  }
  return {
    ...(chatIds ? { chat_ids: chatIds } : {}),
    include_from_me: optionalBoolean(o, "include_from_me", false),
    include_groups: optionalBoolean(o, "include_groups", true),
  };
}

export function matchesMessageReceived(e: StoredEvent, a: MessageReceivedArgs): boolean {
  const d = e.data;
  if (d.from_me && !a.include_from_me) return false;
  if (d.is_group && !a.include_groups) return false;
  if (a.chat_ids && !a.chat_ids.includes(d.chat_id) && !(e.chat_alt && a.chat_ids.includes(e.chat_alt))) {
    return false;
  }
  return true;
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
  events: StoredEvent[];
}

export interface PollOutcome {
  events: StoredEvent[];
  cursor: number;
  truncated: boolean;
  hasMore: boolean;
}

export type { MediaType };

export class EventBuffer {
  private events: StoredEvent[] = [];
  private byId = new Map<string, StoredEvent>();
  private lastSeq = 0;
  private evictedThrough = 0;
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

  get evictedThroughSeq(): number {
    return this.evictedThrough;
  }

  has(eventId: string): boolean {
    return this.byId.has(eventId);
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

  /** Matching events after `after`, oldest first, at most `limit`. */
  eventsAfter(after: number, args: MessageReceivedArgs, limit: number): StoredEvent[] {
    const out: StoredEvent[] = [];
    for (let i = this.firstAfter(after); i < this.events.length && out.length < limit; i++) {
      const e = this.events[i]!;
      if (matchesMessageReceived(e, args)) out.push(e);
    }
    return out;
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

  /** Drops what is past retention, then whatever exceeds the cap. */
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
    this.byId.delete(e.eventId);
    this.evictedThrough = Math.max(this.evictedThrough, e.seq);
  }

  /**
   * Forgets every event, as a logout or a different account's pairing does.
   * The sequence keeps counting and everything up to the head counts as
   * evicted, so a cursor from before reports `truncated` instead of silently
   * reading on.
   */
  clear(): void {
    for (const e of this.events) this.evict(e);
    this.events = [];
    this.byId.clear();
    this.evictedThrough = Math.max(this.evictedThrough, this.lastSeq);
    this.revision++;
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
    for (let i = this.firstAfter(from); i < this.events.length; i++) {
      const e = this.events[i]!;
      if (Date.parse(e.timestamp) < notBefore) continue;
      if (!matchesMessageReceived(e, opts.args)) continue;
      if (out.length >= opts.maxEvents) {
        hasMore = true;
        break;
      }
      out.push(e);
    }
    const cursor = hasMore ? out[out.length - 1]!.seq : Math.max(from, this.lastSeq);
    return { events: out, cursor, truncated, hasMore };
  }

  toDoc(): BufferDoc {
    return {
      version: 1,
      last_seq: this.lastSeq,
      evicted_through: this.evictedThrough,
      events: this.events,
    };
  }

  /**
   * Folds a persisted document in: the union by event id. `resequence`, as in
   * Slack's buffer: true after a write conflict, so another live process's
   * events land after every cursor this one has handed out.
   */
  merge(doc: BufferDoc, opts: { resequence: boolean }): void {
    if (doc.version !== 1) return;
    this.lastSeq = Math.max(this.lastSeq, doc.last_seq);
    this.evictedThrough = Math.max(this.evictedThrough, doc.evicted_through);
    const foreign = [...doc.events].sort((a, b) => a.seq - b.seq);
    for (const e of foreign) {
      if (this.byId.has(e.eventId)) continue;
      const added = opts.resequence ? { ...e, seq: this.nextSeq() } : { ...e };
      this.events.push(added);
      this.byId.set(added.eventId, added);
    }
    this.events.sort((a, b) => a.seq - b.seq);
    this.revision++;
    this.prune();
  }

  /**
   * The boot load: becomes the persisted document, then appends whatever was
   * added in memory before it loaded, sequenced after the document's head. No
   * cursor was handed out before the load (a poll waits for it), so nothing
   * held in memory can land below one a client holds, whatever the previous
   * owner's clock said.
   */
  adopt(doc: BufferDoc): void {
    if (doc.version !== 1) return;
    const early = this.events;
    this.replace(doc);
    for (const e of early) {
      if (this.byId.has(e.eventId)) continue;
      const added = { ...e, seq: this.nextSeq() };
      this.events.push(added);
      this.byId.set(added.eventId, added);
    }
    this.prune();
  }

  /** Becomes exactly the document: what a superseded process answers polls from. */
  replace(doc: BufferDoc): void {
    if (doc.version !== 1) return;
    this.events = [...doc.events].sort((a, b) => a.seq - b.seq);
    this.byId = new Map(this.events.map((e) => [e.eventId, e]));
    this.lastSeq = doc.last_seq;
    this.evictedThrough = doc.evicted_through;
    this.revision++;
  }
}
