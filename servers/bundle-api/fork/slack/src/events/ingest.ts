/**
 * The Slack events ingest: ONE Socket Mode connection, a sealed ring buffer in
 * GCS, and the backfill that makes a reconnect lose nothing it can recover.
 *
 * LIFECYCLE.
 *   1. Configured? (config.ts) If not, it stays `not_configured` forever and
 *      touches nothing — no socket, no GCS, no Slack call.
 *   2. Load the persisted buffer, then CLAIM the lease (store.ts): the newest
 *      process owns the socket.
 *   3. `auth.test` on the bot token: who the bot is, so its own posts are
 *      dropped, and the workspace URL permalinks are built from.
 *   4. `apps.connections.open` on the app token, then the WebSocket. Every
 *      `events_api` envelope is ACKED FIRST (Slack retries an envelope it does
 *      not see acked within 3 seconds) and buffered second.
 *   5. On every `hello` — the first connection and every reconnect — backfill
 *      from just before `live_through`, the last moment any process held a live
 *      socket. And once more a little after the lease check interval, which is
 *      what recovers the events Slack spread onto the OLD process's socket while
 *      a deploy overlapped the two.
 *   6. Slack closes a Socket Mode connection every few hours on purpose
 *      (`disconnect`, `refresh_requested`). Any close reconnects, with a backoff
 *      that resets once a connection says hello.
 *
 * NOTHING HERE THROWS INTO THE HOST. A failure is a state on the status tool
 * and a log line; the other Slack tools never depend on any of it.
 */
import { logError, logWarning } from '../logging.js';
import { GcsBlobStore, type BlobStore } from './state-store.js';
import {
  DEFAULT_MAX_EVENTS,
  EventBuffer,
  InvalidEventArguments,
  MAX_MAX_EVENTS,
  decodeCursor,
  encodeCursor,
  parseMessagePostedArgs,
  type BufferDoc,
} from './buffer.js';
import {
  EventsConfigError,
  loadEventsConfig,
  missingEventsEnv,
  notConfiguredMessage,
  type EventsConfig,
} from './config.js';
import { toMessagePosted, type BotIdentity, type RawSlackMessage } from './normalize.js';
import { SlackApi, SlackApiError, type FetchLike } from './slack-api.js';
import { EventsStore, LEASE_CHECK_MS, SupersededError } from './store.js';

/** The structural slice of a WebSocket this uses. Node 22's global `WebSocket` satisfies it. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: 'error', listener: (ev: unknown) => void): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export type IngestState =
  | 'not_configured'
  | 'config_error'
  | 'starting'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'superseded'
  | 'stopped';

/** Backfill reaches this far before the gap for parents whose THREADS may have moved. */
export const THREAD_LOOKBACK_MS = 48 * 3600_000;
/** Re-read from this long before `live_through`, to cover a clock edge and an unacked tail. */
const BACKFILL_OVERLAP_MS = 120_000;
const BACKFILL_MAX_PAGES = 10;
const FLUSH_DEBOUNCE_MS = 2_000;
const LIVE_HEARTBEAT_MS = 60_000;
/**
 * How stale `live_through` may get before advancing it is worth a write of its
 * own. The buffer is one object, so a write is the whole buffer; between those,
 * the moment rides along with whatever flush the next event causes.
 */
const LIVE_PERSIST_MS = 5 * 60_000;
/** A connection that lived this long earns a reset backoff; a flapping one does not. */
const STABLE_CONNECTION_MS = 60_000;
/** While a backfill is owed, retry it at most this often. */
const BACKFILL_RETRY_MS = 5 * 60_000;
/** Take the lease back once its owner's heartbeat is this old. */
const LEASE_STALE_MS = LEASE_CHECK_MS * 3;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** A credential Slack refused does not get better in a second. */
const AUTH_FAILURE_RETRY_MS = 5 * 60_000;
const SUPERSEDED_RELOAD_MS = 5_000;
export const NEXT_POLL_MS = 5_000;
const AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'not_allowed_token_type',
  'missing_scope',
]);

export class EventsNotServed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventsNotServed';
  }
}
export { InvalidEventArguments };

export interface PollParams {
  arguments?: unknown;
  cursor?: unknown;
  maxEvents?: unknown;
  maxAgeMs?: unknown;
}

export interface PollResult {
  events: { eventId: string; name: string; timestamp: string; data: Record<string, unknown> }[];
  cursor: string;
  truncated: boolean;
  hasMore: boolean;
  nextPollMs: number;
}

export interface IngestDeps {
  env?: NodeJS.ProcessEnv;
  blobs?: BlobStore;
  fetch?: FetchLike;
  slackBaseUrl?: string;
  webSocket?: WebSocketFactory;
  clock?: () => number;
  /** Tests only: no timers, every periodic step driven by hand. */
  manualTimers?: boolean;
}

export const MESSAGE_POSTED = 'message_posted';

export class SlackEventsIngest {
  state: IngestState;
  private readonly config: EventsConfig | null;
  private readonly configProblem: string | null;
  private readonly clock: () => number;
  private readonly store: EventsStore | null;
  private readonly buffer: EventBuffer | null;
  private readonly api: SlackApi | null;
  private readonly wsFactory: WebSocketFactory | null;
  private readonly manual: boolean;
  private bot: BotIdentity | null = null;
  private ws: WebSocketLike | null = null;
  private stopped = false;
  private ready: Promise<void> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushedRevision = -1;
  private flushing: Promise<void> | null = null;
  private backoffMs = BACKOFF_START_MS;
  private lastSupersededReload = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private bootFailure: unknown = null;
  private connectLoopRunning = false;
  /**
   * True from a `hello` until a backfill for that connection completes with no
   * conversation failing. While it is, `live_through` does not move: advancing
   * it past a gap nobody re-read is how a gap is lost for good.
   */
  private backfillPending = false;
  private backfillChain: Promise<void> = Promise.resolve();
  private lastBackfillAttempt = 0;
  private livePersistedAt = 0;

  // What the status tool reports.
  private connectedSince: number | null = null;
  private lastEventAt: number | null = null;
  private lastError: string | null = null;
  private lastFlushAt: number | null = null;
  private lastFlushError: string | null = null;
  private lastBackfill: {
    at: number;
    since: number | null;
    conversations: number;
    added: number;
    incomplete: number;
    failed: number;
    error?: string;
  } | null = null;
  private envelopes = 0;

  constructor(deps: IngestDeps = {}) {
    const env = deps.env ?? process.env;
    this.clock = deps.clock ?? Date.now;
    this.manual = deps.manualTimers === true;
    const missing = missingEventsEnv(env);
    let config: EventsConfig | null = null;
    let problem: string | null = null;
    if (missing.length > 0) {
      problem = notConfiguredMessage(missing);
      this.state = 'not_configured';
    } else {
      try {
        config = loadEventsConfig(env);
        this.state = 'starting';
      } catch (err) {
        problem = err instanceof EventsConfigError ? err.message : String(err);
        this.state = 'config_error';
      }
    }
    this.config = config;
    this.configProblem = problem;
    if (!config) {
      this.store = null;
      this.buffer = null;
      this.api = null;
      this.wsFactory = null;
      return;
    }
    const blobs =
      deps.blobs ??
      new GcsBlobStore({
        bucket: config.bucket,
        clientEmail: config.clientEmail,
        privateKey: config.privateKey,
        who: 'the Slack events ingest',
        warn: (message) => logWarning('slack-events', message),
      });
    this.store = new EventsStore(blobs, config.encryptionKey, config.prefix, this.clock);
    this.buffer = new EventBuffer(config.retentionDays * 86_400_000, this.clock);
    this.api = new SlackApi(config.botToken, config.appToken, {
      fetch: deps.fetch,
      baseUrl: deps.slackBaseUrl,
    });
    this.wsFactory =
      deps.webSocket ??
      ((url: string) =>
        new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url));
  }

  /** True when this process can serve `message_posted` at all: configured, whatever the socket's state. */
  get configured(): boolean {
    return this.config !== null;
  }

  /** Why events are not served here, or null when they are. */
  get unavailableReason(): string | null {
    return this.configProblem;
  }

  /** Idempotent. Resolves once the persisted buffer is loaded; the socket keeps going on its own. */
  start(): Promise<void> {
    if (!this.config || this.stopped) return Promise.resolve();
    // A failed boot owns ONE retry timer. Until it fires, a caller is told the
    // stored failure rather than starting a second boot — and a second chain of
    // retries behind it.
    if (this.retryTimer) return Promise.reject(this.bootFailure);
    this.ready ??= this.boot();
    return this.ready;
  }

  private async boot(): Promise<void> {
    const store = this.store!;
    const buffer = this.buffer!;
    try {
      const doc = await store.readBuffer();
      if (doc) buffer.merge(doc, { resequence: false });
      this.flushedRevision = buffer.revision;
      await store.claimLease();
      this.bootFailure = null;
    } catch (err) {
      // The buffer could not be read. Serving from an empty one would hand
      // every client "nothing happened"; the state and the error say otherwise,
      // and the connect loop retries the whole boot.
      this.fail(`loading the buffer from GCS: ${errText(err)}`);
      this.state = 'reconnecting';
      this.ready = null;
      this.bootFailure = err;
      if (!this.manual && !this.stopped) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.start().catch(() => {});
        }, this.nextBackoff());
        this.retryTimer.unref?.();
      }
      throw err;
    }
    if (this.stopped) return;
    if (!this.manual) {
      this.timers.push(
        setInterval(() => void this.leaseTick(), LEASE_CHECK_MS),
        setInterval(() => void this.liveTick(), LIVE_HEARTBEAT_MS)
      );
      for (const t of this.timers) t.unref?.();
      void this.connectLoop();
    }
  }

  // --- the socket -------------------------------------------------------------

  /** One connection attempt, resolving when that connection closes. Exposed for tests. */
  async connectOnce(): Promise<void> {
    const api = this.api!;
    if (this.stopped || this.store!.superseded) return;
    this.state = this.connectedSince === null && this.envelopes === 0 ? 'connecting' : 'reconnecting';
    if (!this.bot) {
      const who = await api.authTest();
      this.bot = { userId: who.user_id, botId: who.bot_id, workspaceUrl: who.url };
    }
    const url = await api.openConnection();
    if (this.stopped || this.store!.superseded) return;
    const ws = this.wsFactory!(url);
    this.ws = ws;
    await new Promise<void>((resolve) => {
      ws.addEventListener('message', (ev) => this.onFrame(ws, ev.data));
      ws.addEventListener('error', () => {
        // The close that follows carries what there is to know.
      });
      ws.addEventListener('close', (ev) => {
        if (this.ws === ws) {
          this.ws = null;
          if (
            this.connectedSince !== null &&
            this.clock() - this.connectedSince >= STABLE_CONNECTION_MS
          ) {
            this.backoffMs = BACKOFF_START_MS;
          }
          this.connectedSince = null;
          if (this.settleTimer) clearTimeout(this.settleTimer);
          this.settleTimer = null;
          if (!this.stopped && !this.store!.superseded) this.state = 'reconnecting';
          if (ev.code !== undefined && ev.code !== 1000) {
            this.lastError = `socket closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`;
          }
        }
        resolve();
      });
    });
  }

  private async connectLoop(): Promise<void> {
    if (this.connectLoopRunning) return;
    this.connectLoopRunning = true;
    try {
      await this.connectLoopBody();
    } finally {
      this.connectLoopRunning = false;
    }
  }

  private async connectLoopBody(): Promise<void> {
    while (!this.stopped && !this.store!.superseded) {
      let wait: number;
      try {
        await this.connectOnce();
        wait = this.nextBackoff();
      } catch (err) {
        this.fail(`connecting: ${errText(err)}`);
        wait =
          err instanceof SlackApiError && AUTH_ERRORS.has(err.code)
            ? AUTH_FAILURE_RETRY_MS
            : this.nextBackoff();
      }
      if (this.stopped || this.store!.superseded) break;
      await new Promise((r) => setTimeout(r, wait).unref?.());
    }
  }

  private nextBackoff(): number {
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    return wait;
  }

  private onFrame(ws: WebSocketLike, raw: unknown): void {
    let frame: {
      type?: string;
      envelope_id?: string;
      reason?: string;
      payload?: { event?: RawSlackMessage & { type?: string } };
    };
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8'));
    } catch {
      return;
    }
    // Ack first, whatever it is: an unacked envelope is redelivered, and the
    // dedupe would drop the copy, but the retry header would also tell Slack
    // this app is unhealthy.
    if (frame.envelope_id) {
      try {
        ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
      } catch {
        // A socket closing under us; the close handler reconnects.
      }
    }
    switch (frame.type) {
      case 'hello': {
        this.state = 'connected';
        const connectedAt = this.clock();
        this.connectedSince = connectedAt;
        this.lastError = null;
        this.backfillPending = true;
        void this.runBackfill();
        // The settle pass: what Slack handed the OLD process's socket while a
        // deploy overlapped the two, which that process will not write. It
        // reads from before this connection opened, whatever the first pass
        // did to `live_through`.
        if (!this.manual) {
          if (this.settleTimer) clearTimeout(this.settleTimer);
          this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            void this.runBackfill(connectedAt);
          }, LEASE_CHECK_MS * 2 + 15_000);
          this.settleTimer.unref?.();
        }
        return;
      }
      case 'disconnect':
        // `refresh_requested` is routine; `link_disabled` means Socket Mode was
        // turned off for the app, which the close and the next open will say.
        ws.close(1000, frame.reason ?? 'disconnect');
        return;
      case 'events_api': {
        this.envelopes++;
        const event = frame.payload?.event;
        if (event) this.ingest(event);
        return;
      }
      default:
        return;
    }
  }

  private ingest(raw: RawSlackMessage, hint?: { id: string; type?: string }): boolean {
    if (!this.bot || this.store!.superseded) return false;
    const event = toMessagePosted(raw, this.bot, hint);
    if (!event) return false;
    const added = this.buffer!.add(event);
    if (!added) return false;
    this.lastEventAt = this.clock();
    this.scheduleFlush();
    return true;
  }

  // --- backfill ---------------------------------------------------------------

  /**
   * Re-reads every conversation the bot is in from just before `live_through`.
   *
   * A first-ever boot (no `live_through`) backfills nothing: "from now" is the
   * only honest start for a buffer that has never been live. Top-level messages
   * come from `conversations.history`; replies need `conversations.replies`,
   * asked only for a parent whose `latest_reply` is inside the gap — and a
   * parent is only seen if it is younger than {@link THREAD_LOOKBACK_MS} before
   * the gap. Bounded at {@link BACKFILL_MAX_PAGES} pages per read; a read cut
   * short is counted as `incomplete` on the status tool.
   */
  /**
   * Backfills are serialised: a `hello`, its settle pass and a retry never read
   * the same conversations at once. `notAfter` caps the start of the window at
   * that moment (the settle pass's connection time).
   */
  runBackfill(notAfter?: number): Promise<void> {
    this.backfillChain = this.backfillChain.then(async () => {
      if (this.stopped) return;
      this.lastBackfillAttempt = this.clock();
      const complete = await this.backfill(notAfter);
      if (complete && this.backfillPending) {
        this.backfillPending = false;
        this.markLive(true);
      }
    });
    return this.backfillChain;
  }

  /**
   * Re-reads every conversation the bot is in from just before `live_through`.
   * True when every conversation was read; a failed one is counted, the rest
   * still run, and `live_through` stays where it was so the gap is re-read.
   */
  async backfill(notAfter?: number): Promise<boolean> {
    if (!this.config || !this.bot || this.store!.superseded || this.stopped) return false;
    const buffer = this.buffer!;
    const api = this.api!;
    const now = this.clock();
    const retentionStart = now - this.config.retentionDays * 86_400_000;
    const record: NonNullable<SlackEventsIngest['lastBackfill']> = {
      at: now,
      since: null,
      conversations: 0,
      added: 0,
      incomplete: 0,
      failed: 0,
    };
    if (buffer.liveThrough === null) {
      this.lastBackfill = record;
      return true;
    }
    const from = notAfter !== undefined ? Math.min(buffer.liveThrough, notAfter) : buffer.liveThrough;
    const since = Math.max(from - BACKFILL_OVERLAP_MS, retentionStart);
    record.since = since;
    const sinceTs = toSlackTs(since);
    const lookbackTs = toSlackTs(Math.max(since - THREAD_LOOKBACK_MS, retentionStart));
    let conversations: { id: string; type: 'channel' | 'group' | 'im' }[];
    try {
      conversations = await api.memberConversations();
    } catch (err) {
      this.lastBackfill = { ...record, failed: 1, error: errText(err) };
      logWarning('slack-events', `backfill could not list conversations: ${errText(err)}`);
      return false;
    }
    record.conversations = conversations.length;
    for (const conv of conversations) {
      if (this.stopped || this.store!.superseded) return false;
      const hint = { id: conv.id, type: conv.type };
      try {
        // Collected, then ingested in message order, so a recovered reply is
        // sequenced after the top-level messages that preceded it.
        const found = new Map<string, RawSlackMessage>();
        const history = await api.history(conv.id, lookbackTs, BACKFILL_MAX_PAGES);
        if (!history.complete) record.incomplete++;
        for (const m of history.messages) {
          if (m.ts && m.ts > sinceTs) found.set(m.ts, m);
          if (m.latest_reply && m.latest_reply > sinceTs && m.ts) {
            const replies = await api.replies(conv.id, m.ts, sinceTs, BACKFILL_MAX_PAGES);
            if (!replies.complete) record.incomplete++;
            // `replies` always includes the parent; whether it is new was
            // decided by the history read above.
            for (const r of replies.messages) {
              if (r.ts && r.ts !== m.ts && r.ts > sinceTs) found.set(r.ts, r);
            }
          }
        }
        for (const t of [...found.keys()].sort()) {
          if (this.ingest(found.get(t)!, hint)) record.added++;
        }
      } catch (err) {
        record.failed++;
        record.error ??= `${conv.id}: ${errText(err)}`;
      }
    }
    this.lastBackfill = record;
    if (record.failed > 0) {
      logWarning(
        'slack-events',
        `backfill read ${record.conversations - record.failed}/${record.conversations} ` +
          `conversations; first failure: ${record.error}`
      );
    }
    return record.failed === 0;
  }

  // --- persistence and the lease -----------------------------------------------

  /**
   * Moves `live_through` to now — never while a backfill is owed. `persist`
   * forces a write; otherwise one is only worth it every LIVE_PERSIST_MS, and
   * the moment rides along with the next event's flush in between.
   */
  private markLive(persist = false): void {
    if (this.state !== 'connected' || this.store!.superseded || this.backfillPending) return;
    const now = this.clock();
    this.buffer!.liveThrough = now;
    if (persist || now - this.livePersistedAt >= LIVE_PERSIST_MS) {
      this.livePersistedAt = now;
      this.buffer!.revision++;
      this.scheduleFlush();
    }
  }

  /** Exposed for tests; the interval calls it. */
  async liveTick(): Promise<void> {
    if (
      this.backfillPending &&
      this.state === 'connected' &&
      this.clock() - this.lastBackfillAttempt >= BACKFILL_RETRY_MS
    ) {
      void this.runBackfill();
    }
    this.markLive();
    this.buffer?.prune();
    await this.flush();
  }

  /** Exposed for tests; the interval calls it. */
  async leaseTick(): Promise<void> {
    if (!this.store || this.stopped) return;
    try {
      if (this.store.superseded) {
        await this.tryReclaim();
        return;
      }
      if (!(await this.store.checkLease())) this.onSuperseded();
    } catch (err) {
      logWarning('slack-events', `lease check failed: ${errText(err)}`);
    }
  }

  /**
   * The newer process that took the lease has stopped heartbeating — its
   * container died, or its deploy rolled back. Take the socket back, from the
   * buffer it last wrote, rather than leaving the feed down until a restart.
   */
  private async tryReclaim(): Promise<void> {
    const store = this.store!;
    if (!(await store.reclaimIfStale(LEASE_STALE_MS))) return;
    const doc = await store.readBuffer();
    if (doc) this.buffer!.replace(doc);
    this.flushedRevision = this.buffer!.revision;
    this.state = 'reconnecting';
    this.lastError = null;
    logWarning('slack-events', 'took the lease back from an owner that stopped heartbeating');
    if (!this.manual) void this.connectLoop();
  }

  private onSuperseded(): void {
    this.state = 'superseded';
    this.lastError = new SupersededError().message;
    this.ws?.close(1000, 'superseded');
    this.ws = null;
    this.connectedSince = null;
  }

  private scheduleFlush(): void {
    if (this.manual || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  /** Writes the buffer if it changed since the last write. Never throws. */
  async flush(): Promise<void> {
    if (!this.store || !this.buffer || this.store.superseded) return;
    if (this.flushing) {
      await this.flushing;
      if (this.buffer.revision === this.flushedRevision) return;
    }
    if (this.buffer.revision === this.flushedRevision) return;
    const buffer = this.buffer;
    const revision = buffer.revision;
    this.flushing = this.store
      .writeBuffer(buffer.toDoc(), (theirs: BufferDoc) => {
        buffer.merge(theirs, { resequence: true });
        return buffer.toDoc();
      })
      .then(() => {
        this.flushedRevision = Math.max(this.flushedRevision, revision);
        this.lastFlushAt = this.clock();
        this.lastFlushError = null;
      })
      .catch((err: unknown) => {
        if (err instanceof SupersededError) {
          this.onSuperseded();
          return;
        }
        this.lastFlushError = errText(err);
        logWarning('slack-events', `buffer flush failed: ${errText(err)}`);
      })
      .finally(() => {
        this.flushing = null;
      });
    await this.flushing;
  }

  /** Flushes and closes the socket. The host calls it on SIGTERM. */
  async close(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const t of [this.retryTimer, this.settleTimer]) if (t) clearTimeout(t);
    this.retryTimer = null;
    this.settleTimer = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.ws?.close(1000, 'shutdown');
    this.ws = null;
    try {
      await this.flush();
    } catch (err) {
      logError('slack-events close', err);
    }
    if (this.state !== 'not_configured' && this.state !== 'config_error') this.state = 'stopped';
  }

  // --- what events/poll and the status tool see ----------------------------------

  async poll(params: PollParams): Promise<PollResult> {
    if (!this.config) {
      throw new EventsNotServed(this.configProblem ?? 'Slack events are not configured.');
    }
    const args = parseMessagePostedArgs(params.arguments);
    const cursor = decodeCursor(params.cursor);
    let maxEvents = DEFAULT_MAX_EVENTS;
    if (params.maxEvents !== undefined && params.maxEvents !== null) {
      if (
        typeof params.maxEvents !== 'number' ||
        !Number.isInteger(params.maxEvents) ||
        params.maxEvents < 1
      ) {
        throw new InvalidEventArguments('maxEvents must be a positive integer');
      }
      maxEvents = Math.min(params.maxEvents, MAX_MAX_EVENTS);
    }
    let maxAgeMs: number | undefined;
    if (params.maxAgeMs !== undefined && params.maxAgeMs !== null) {
      if (typeof params.maxAgeMs !== 'number' || !(params.maxAgeMs >= 0)) {
        throw new InvalidEventArguments('maxAgeMs must be a non-negative number');
      }
      maxAgeMs = params.maxAgeMs;
    }
    try {
      await this.start();
    } catch (err) {
      throw new EventsNotServed(
        `The Slack events buffer could not be loaded from GCS (${errText(err)}). ` +
          'This is retried automatically; slack_events_status shows the state.'
      );
    }
    await this.refreshIfSuperseded();
    const out = this.buffer!.poll({ cursor, args, maxEvents, maxAgeMs });
    return {
      events: out.events.map((e) => ({
        eventId: e.eventId,
        name: MESSAGE_POSTED,
        timestamp: e.timestamp,
        data: e.data as unknown as Record<string, unknown>,
      })),
      cursor: encodeCursor(out.cursor),
      truncated: out.truncated,
      hasMore: out.hasMore,
      nextPollMs: NEXT_POLL_MS,
    };
  }

  /**
   * A superseded process can still be routed a poll while a deploy overlaps,
   * and its memory stops at the moment it stopped writing. It answers from the
   * live owner's persisted buffer instead — replaced, not merged, so its cursors
   * are the owner's — re-read at most every few seconds.
   */
  private async refreshIfSuperseded(): Promise<void> {
    if (!this.store!.superseded) return;
    if (this.clock() - this.lastSupersededReload < SUPERSEDED_RELOAD_MS) return;
    this.lastSupersededReload = this.clock();
    try {
      const doc = await this.store!.readBuffer();
      if (doc) this.buffer!.replace(doc);
    } catch (err) {
      logWarning('slack-events', `superseded re-read failed: ${errText(err)}`);
    }
  }

  status(): Record<string, unknown> {
    const iso = (ms: number | null | undefined) =>
      ms === null || ms === undefined ? null : new Date(ms).toISOString();
    if (!this.config) {
      return {
        state: this.state,
        events_served: false,
        reason: this.configProblem,
      };
    }
    const b = this.buffer!;
    const lease = this.store!.lease;
    return {
      state: this.state,
      events_served: true,
      event_types: [MESSAGE_POSTED],
      bot_user_id: this.bot?.userId ?? null,
      socket: {
        connected_since: iso(this.connectedSince),
        envelopes_received: this.envelopes,
        last_event_buffered_at: iso(this.lastEventAt),
        last_error: this.lastError,
      },
      backfill: this.lastBackfill && {
        at: iso(this.lastBackfill.at),
        since: iso(this.lastBackfill.since),
        conversations: this.lastBackfill.conversations,
        events_added: this.lastBackfill.added,
        reads_cut_short: this.lastBackfill.incomplete,
        conversations_failed: this.lastBackfill.failed,
        gap_still_owed: this.backfillPending,
        error: this.lastBackfill.error ?? null,
      },
      buffer: {
        events: b.size,
        retention_days: this.config.retentionDays,
        oldest_event_at: b.oldest?.timestamp ?? null,
        newest_event_at: b.newest?.timestamp ?? null,
        live_through: iso(b.liveThrough),
        last_flush_at: iso(this.lastFlushAt),
        last_flush_error: this.lastFlushError,
        gcs_prefix: this.config.prefix,
      },
      lease: {
        this_instance: lease.instanceId,
        owner: lease.owner,
        superseded: lease.superseded,
      },
    };
  }

  private fail(message: string): void {
    this.lastError = message;
    logWarning('slack-events', message);
  }
}

/** Slack's `ts` for an epoch-ms moment: seconds, six decimals. Comparable as a string at fixed width. */
export function toSlackTs(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(6);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
