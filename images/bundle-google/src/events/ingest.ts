/**
 * The Gmail events ingest: ONE reader of one mailbox's history, a sealed ring
 * buffer in strad's state store, and webhook delivery out of it.
 *
 * HOW NEW MAIL IS HEARD ABOUT.
 *   - PUSH, when the Pub/Sub pair is configured: `users.watch` on the topic,
 *     renewed daily (Gmail stops publishing after 7 days without one), and a
 *     long-poll of the pull subscription (`pubsub.ts`). A notification starts a
 *     read of the history at once. Gmail says notifications can be delayed or
 *     dropped, so the history is also read every {@link RECONCILE_PUSH_MS}.
 *   - POLL, otherwise: the history every {@link RECONCILE_POLL_MS}.
 *   Either way the READ is the same: `users.history.list` from the stored
 *   history id, `messageAdded` only. The notification says that something
 *   changed, never what, so a lost, repeated or out-of-order one costs latency
 *   and nothing else.
 *
 * A HISTORY ID TOO OLD TO READ (Gmail keeps about a week, and answers 404) is
 * recovered by searching for mail received since 10 minutes before the last
 * complete read, then restarting from the mailbox's current history id.
 *
 * A FIRST-EVER BOOT reads nothing older than itself: "from now" is the only
 * honest start for a buffer that has never been live.
 *
 * THE `query` ARGUMENT is decided by Gmail's own search, per message, the first
 * time a query needs it, and remembered (`buffer.ts`). An event Gmail's index
 * has not caught up with yet is UNDECIDED, and a poll or delivery stops before
 * it; after {@link INDEX_GIVE_UP_MS} an unindexed message is decided "no match".
 *
 * ONE PROCESS READS: the lease (`store.ts`). A superseded process stops
 * reading, watching and pulling, and answers polls from the owner's buffer.
 *
 * NOTHING HERE THROWS INTO THE HOST. A failure is a state and a log line; the
 * gmail tools never depend on any of it.
 */
import { GcsBlobStore, type BlobStore } from "./state-store.js";
import {
  DEFAULT_MAX_EVENTS,
  EventBuffer,
  InvalidEventArguments,
  MAX_MAX_EVENTS,
  decodeCursor,
  encodeCursor,
  parseMessageReceivedArgs,
  type BufferDoc,
  type MessageReceivedArgs,
} from "./buffer.js";
import {
  eventsRequested,
  GmailEventsConfigError,
  loadEventsConfig,
  missingEventsEnv,
  notConfiguredMessage,
  type EnvLike,
  type GmailEventsConfig,
} from "./config.js";
import { GmailApi, GmailApiError, type FetchLike } from "./gmail-api.js";
import { eventIdFor, toMessageReceived, type StoredEvent } from "./normalize.js";
import { PubSubError, PubSubPuller, type GmailNotification } from "./pubsub.js";
import { EventsStore, LEASE_CHECK_MS, SupersededError } from "./store.js";
import { readRegistry } from "./webhook/registry.js";
import { WebhookDelivery, type SubscribeInput, type SubscribeResult } from "./webhook/delivery.js";
import { HttpsWebhookTransport, type WebhookTransport } from "./webhook/transport.js";

export const MESSAGE_RECEIVED = "message_received";

export type IngestState =
  | "not_configured"
  | "config_error"
  | "starting"
  | "running"
  | "degraded"
  | "superseded"
  | "stopped";

/** History read this often when Pub/Sub is pushing: the catch-up for a dropped notification. */
export const RECONCILE_PUSH_MS = 60_000;
/** History read this often without Pub/Sub. 2 quota units a read; Gmail allows 6,000 a minute. */
export const RECONCILE_POLL_MS = 15_000;
/** How often the scheduler looks at what is due. */
export const SCHEDULER_TICK_MS = 1_000;
/** Renew the watch once it has less than this left. Gmail's grant is 7 days; renewing daily is its advice. */
export const WATCH_RENEW_BEFORE_MS = 6 * 86_400_000;
const WATCH_RETRY_MS = 10 * 60_000;
/** A message Gmail's search has not indexed by this age is decided "no match" for every query. */
export const INDEX_GIVE_UP_MS = 30 * 60_000;
/** Re-ask an unindexed message at most this often. */
const INDEX_RETRY_MS = 15_000;
/** How far before the last complete read a recovery search reaches. */
const RECOVERY_OVERLAP_MS = 10 * 60_000;
/** A recovery reads at most this many messages; past it the oldest are lost, and the status says so. */
const RECOVERY_MAX_MESSAGES = 5_000;
/** 500 records a page. Past this, a read is recovered by search instead. */
const HISTORY_MAX_PAGES = 200;
/** Search calls one evaluation pass may make. */
const EVALUATION_BUDGET = 40;
/** Search calls a poll may make deciding its own query before it answers. */
const POLL_EVALUATION_BUDGET = 20;
const REGISTRY_QUERY_RELOAD_MS = 60_000;
const FLUSH_DEBOUNCE_MS = 2_000;
const LEASE_STALE_MS = LEASE_CHECK_MS * 3;
const SUPERSEDED_RELOAD_MS = 5_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** A Pub/Sub refusal (403, 404) does not get better in a second. */
const PULL_REFUSED_RETRY_MS = 5 * 60_000;
/** The least time between two pulls when the first came back empty at once. */
const MIN_EMPTY_PULL_MS = 1_000;
export const NEXT_POLL_MS = 5_000;
export const WEBHOOK_TICK_MS = 1_000;

export class EventsNotServed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventsNotServed";
  }
}
export { InvalidEventArguments };

/** What pulls notifications. Tests substitute one. */
export interface NotificationSource {
  pull(signal?: AbortSignal): Promise<GmailNotification[]>;
  lastAckError?: string | null;
}

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

export interface GmailIngestDeps {
  /** The mount's own environment view. */
  env: EnvLike;
  /** The mount's slug: names the default state folder. */
  slug?: string;
  /** Request headers for the mailbox, from the mount's own Gmail client. Throws when it has no credential. */
  authHeaders: () => Promise<Record<string, string>>;
  blobs?: BlobStore;
  fetch?: FetchLike;
  gmailBase?: string;
  notifications?: NotificationSource;
  webhookTransport?: WebhookTransport;
  clock?: () => number;
  /** Tests only: no timers; every periodic step driven by hand. */
  manualTimers?: boolean;
  warn?: (message: string) => void;
}

export class GmailEventsIngest {
  state: IngestState;
  private readonly config: GmailEventsConfig | null;
  private readonly configProblem: string | null;
  private readonly clock: () => number;
  private readonly manual: boolean;
  private readonly warnFn: (message: string) => void;
  private readonly store: EventsStore | null = null;
  private readonly buffer: EventBuffer | null = null;
  private readonly api: GmailApi | null = null;
  private readonly puller: NotificationSource | null = null;
  private readonly webhooks: WebhookDelivery<MessageReceivedArgs> | null = null;

  private ready: Promise<void> | null = null;
  private booted = false;
  private stopped = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private bootFailure: unknown = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushedRevision = -1;
  private flushing: Promise<void> | null = null;
  private lastSupersededReload = 0;
  private bootBackoffMs = BACKOFF_START_MS;

  private email: string | null = null;
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private lastSyncAt = 0;
  private lastWatchAttempt = 0;
  private evaluating: Promise<void> | null = null;
  private lastEvaluationAt = 0;
  private lastRegistryQueriesAt = 0;
  /** The queries live webhook subscriptions use, from the registry. Always decided at ingest. */
  private subscriptionQueries = new Set<string>();
  private pullAbort: AbortController | null = null;
  private pullLoopRunning = false;

  // What `status()` reports.
  private lastError: string | null = null;
  private lastSync: { at: number; added: number; recovered: boolean; error?: string } | null = null;
  private lastEventAt: number | null = null;
  private lastFlushAt: number | null = null;
  private lastFlushError: string | null = null;
  private lastWatch: { at: number; error: string | null } | null = null;
  private notificationsReceived = 0;
  private lastNotificationAt: number | null = null;
  private lastPullError: string | null = null;
  private lastRecoveryCut = false;
  /**
   * Bumped whenever ownership changes hands. A history read started under one
   * ownership never writes under another: a read that outlived a lost and
   * reclaimed lease would otherwise set the history id over a reloaded buffer
   * and skip what the read had added to the buffer it replaced.
   */
  private epoch = 0;

  constructor(private readonly deps: GmailIngestDeps) {
    this.clock = deps.clock ?? Date.now;
    this.manual = deps.manualTimers === true;
    this.warnFn = deps.warn ?? ((message) => console.warn(`[gmail-events${deps.slug ? ` ${deps.slug}` : ""}] ${message}`));
    const env = deps.env;
    if (!eventsRequested(env)) {
      this.config = null;
      this.configProblem = notConfiguredMessage(missingEventsEnv(env));
      this.state = "not_configured";
      return;
    }
    const missing = missingEventsEnv(env);
    let config: GmailEventsConfig | null = null;
    let problem: string | null = null;
    if (missing.length > 0) {
      problem = notConfiguredMessage(missing);
      this.state = "not_configured";
    } else {
      try {
        config = loadEventsConfig(env, deps.slug);
        this.state = "starting";
      } catch (err) {
        problem = err instanceof GmailEventsConfigError ? err.message : String(err);
        this.state = "config_error";
      }
    }
    this.config = config;
    this.configProblem = problem;
    if (problem) this.warn(problem);
    if (!config) return;

    const blobs =
      deps.blobs ??
      new GcsBlobStore({
        bucket: config.bucket,
        clientEmail: config.clientEmail,
        privateKey: config.privateKey,
        who: "the Gmail events ingest",
        warn: (message) => this.warn(message),
      });
    this.store = new EventsStore(blobs, config.encryptionKey, config.prefix, this.clock);
    this.buffer = new EventBuffer(config.retentionDays * 86_400_000, this.clock);
    this.api = new GmailApi(deps.authHeaders, deps.fetch, deps.gmailBase);
    if (config.push) {
      this.puller =
        deps.notifications ??
        new PubSubPuller(config.push.subscription, {
          clientEmail: config.clientEmail,
          privateKey: config.privateKey,
          fetch: deps.fetch,
          clock: this.clock,
        });
    }
    if (config.pushProblem) this.warn(config.pushProblem);
    if (config.webhookAccessProblem) this.warn(`webhook Access headers are off: ${config.webhookAccessProblem}`);
    const buffer = this.buffer;
    this.webhooks = new WebhookDelivery<MessageReceivedArgs>({
      store: this.store,
      source: {
        head: () => buffer.head,
        evictedThrough: () => buffer.evictedThroughSeq,
        eventsAfter: (after, args, limit) => buffer.eventsAfter(after, args, limit),
        readyThrough: (args, after) => buffer.readyThrough(args, after),
      },
      transport: deps.webhookTransport ?? new HttpsWebhookTransport(),
      parseArgs: parseMessageReceivedArgs,
      access: config.webhookAccess,
      clock: this.clock,
      warn: (message) => this.warn(message),
    });
  }

  /** True when this mount serves `message_received` at all. */
  get configured(): boolean {
    return this.config !== null;
  }

  /** True when the mount was given its key, configured or not: worth saying why on a poll. */
  get requested(): boolean {
    return eventsRequested(this.deps.env);
  }

  get unavailableReason(): string | null {
    return this.configProblem;
  }

  private warn(message: string): void {
    this.warnFn(message);
  }

  // --- lifecycle ----------------------------------------------------------------

  /** Idempotent. Resolves once the persisted buffer is loaded and the lease claimed. */
  start(): Promise<void> {
    if (!this.config || this.stopped) return Promise.resolve();
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
      this.booted = true;
      this.state = "running";
    } catch (err) {
      // Serving from an empty buffer would hand every client "no mail"; the
      // state says otherwise, and the boot is retried.
      this.fail(`loading the buffer from GCS: ${errText(err)}`);
      this.state = "degraded";
      this.ready = null;
      this.bootFailure = err;
      if (!this.manual && !this.stopped) {
        const wait = this.bootBackoffMs;
        this.bootBackoffMs = Math.min(this.bootBackoffMs * 2, BACKOFF_MAX_MS);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.start().catch(() => {});
        }, wait);
        this.retryTimer.unref?.();
      }
      throw err;
    }
    if (this.stopped) return;
    if (!this.manual) {
      this.timers.push(
        setInterval(() => void this.leaseTick(), LEASE_CHECK_MS),
        setInterval(() => void this.schedulerTick(), SCHEDULER_TICK_MS),
        setInterval(() => void this.webhookTick(), WEBHOOK_TICK_MS),
      );
      for (const t of this.timers) t.unref?.();
      void this.requestSync();
      this.startPullLoop();
    }
  }

  /** Flushes and stops. The host calls it on SIGTERM. */
  async close(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pullAbort?.abort();
    try {
      await this.syncing;
      await this.flush();
      await this.webhooks?.flush();
    } catch (err) {
      this.warn(`close: ${errText(err)}`);
    }
    if (this.state !== "not_configured" && this.state !== "config_error") this.state = "stopped";
  }

  private get owner(): boolean {
    return this.booted && !this.stopped && !this.store!.superseded;
  }

  // --- the periodic work ------------------------------------------------------------

  /** What is due: a history read, the watch, deciding queries. Exposed for tests; the interval calls it. */
  async schedulerTick(): Promise<void> {
    if (!this.owner) return;
    const now = this.clock();
    // Push only counts while it works end to end: the watch, and the pull.
    const pushing = this.puller !== null && this.lastWatch?.error === null && this.lastPullError === null;
    const interval = pushing ? RECONCILE_PUSH_MS : RECONCILE_POLL_MS;
    if (now - this.lastSyncAt >= interval) await this.requestSync();
    if (now - this.lastEvaluationAt >= INDEX_RETRY_MS) await this.evaluatePending();
  }

  /** One history read, serialised: a request during a read runs once more after it. */
  requestSync(): Promise<void> {
    if (!this.owner) return Promise.resolve();
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.syncAgain = false;
          await this.syncOnce();
        } while (this.syncAgain && this.owner);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    const api = this.api!;
    const buffer = this.buffer!;
    const started = this.clock();
    const epoch = this.epoch;
    this.lastSyncAt = started;
    let added = 0;
    let recovered = false;
    try {
      if (!this.email || buffer.historyId === null) {
        const profile = await api.profile();
        this.email = profile.emailAddress.toLowerCase();
        if (buffer.historyId === null) {
          // First-ever boot: start from now.
          buffer.historyId = profile.historyId;
          buffer.liveThrough = started;
          buffer.revision++;
          this.scheduleFlush();
        }
      }
      await this.maybeWatch();
      let historyId = buffer.historyId!;
      const candidates: { id: string; labelIds: string[] }[] = [];
      let pageToken: string | undefined;
      let pages = 0;
      let tooOld = false;
      try {
        do {
          const page = await api.history(buffer.historyId!, pageToken);
          candidates.push(...page.added);
          historyId = page.historyId;
          pageToken = page.nextPageToken;
          pages++;
        } while (pageToken && pages < HISTORY_MAX_PAGES);
        if (pageToken) tooOld = true; // more history than a read should hold: search instead
      } catch (err) {
        if (!(err instanceof GmailApiError && err.status === 404)) throw err;
        tooOld = true;
      }
      if (tooOld) {
        recovered = true;
        const recovery = await this.recover(epoch);
        added = recovery.added;
        historyId = recovery.historyId;
      } else {
        added = await this.ingestCandidates(candidates, epoch);
      }
      if (!this.owner || epoch !== this.epoch) return;
      buffer.historyId = historyId;
      buffer.liveThrough = started;
      buffer.revision++;
      this.scheduleFlush();
      this.lastSync = { at: started, added, recovered };
      if (this.state === "degraded") this.state = "running";
      this.lastError = null;
    } catch (err) {
      // Nothing advanced: the next read starts from the same history id.
      this.lastSync = { at: started, added, recovered, error: errText(err) };
      this.state = "degraded";
      this.fail(`reading the mailbox's history: ${errText(err)}`);
    }
    if (added > 0) await this.evaluatePending();
  }

  /** Reads each new message's metadata, oldest first, and buffers the ones that are events. */
  private async ingestCandidates(candidates: { id: string; labelIds: string[] }[], epoch: number): Promise<number> {
    const seen = new Set<string>();
    let added = 0;
    for (const c of candidates) {
      // Lost the lease mid-read: stop spending quota on a buffer nobody will write.
      if (!this.owner || epoch !== this.epoch) return added;
      if (seen.has(c.id) || this.buffer!.has(eventIdFor(c.id))) continue;
      seen.add(c.id);
      // A draft or a sent copy is never an event; skipping it here saves the read.
      if (c.labelIds.some((l) => l === "DRAFT" || l === "SENT")) continue;
      if (await this.ingestMessage(c.id, epoch)) added++;
    }
    return added;
  }

  private async ingestMessage(id: string, epoch: number): Promise<boolean> {
    let meta;
    try {
      meta = await this.api!.metadata(id);
    } catch (err) {
      // Deleted (or moved out of reach) between the history and the read.
      if (err instanceof GmailApiError && err.status === 404) return false;
      throw err;
    }
    if (!this.owner || epoch !== this.epoch) return false;
    const event = toMessageReceived(meta, this.email!);
    if (!event) return false;
    const stored = this.buffer!.add(event);
    if (!stored) return false;
    this.lastEventAt = this.clock();
    this.scheduleFlush();
    return true;
  }

  /**
   * The history id was too old to read. Take the mailbox's current id FIRST,
   * so nothing arriving during the search falls between the two; then search
   * for everything received since just before the last complete read.
   */
  private async recover(epoch: number): Promise<{ added: number; historyId: string }> {
    const api = this.api!;
    const profile = await api.profile();
    const since = (this.buffer!.liveThrough ?? this.clock()) - RECOVERY_OVERLAP_MS;
    const ids = await api.search(`after:${Math.floor(since / 1000)}`, { max: RECOVERY_MAX_MESSAGES });
    const cut = ids.length >= RECOVERY_MAX_MESSAGES;
    this.lastRecoveryCut = cut;
    this.warn(
      `the stored history id could not be read through; recovered by searching mail since ${new Date(since).toISOString()} ` +
        `(${ids.length} message${ids.length === 1 ? "" : "s"})` +
        (cut ? `. CUT at ${RECOVERY_MAX_MESSAGES}: older messages in that window are not events` : ""),
    );
    // Search lists newest first; ingest oldest first.
    const added = await this.ingestCandidates(
      ids.reverse().map((id) => ({ id, labelIds: [] })),
      epoch,
    );
    return { added, historyId: profile.historyId };
  }

  /** Calls `users.watch` when push is configured and the watch is missing or due for renewal. */
  private async maybeWatch(): Promise<void> {
    const push = this.config!.push;
    if (!push || !this.owner) return;
    const now = this.clock();
    const expiration = this.buffer!.watchExpiration;
    const due = expiration === null || expiration - now < WATCH_RENEW_BEFORE_MS || this.lastWatch === null;
    if (!due || now - this.lastWatchAttempt < WATCH_RETRY_MS) return;
    this.lastWatchAttempt = now;
    try {
      const res = await this.api!.watch(push.topic);
      this.buffer!.watchExpiration = Number(res.expiration);
      this.buffer!.revision++;
      this.scheduleFlush();
      this.lastWatch = { at: now, error: null };
    } catch (err) {
      // Polling carries on at the push-less interval until a watch succeeds.
      this.lastWatch = { at: now, error: errText(err) };
      this.warn(`users.watch on ${push.topic} failed; reading history every ${RECONCILE_POLL_MS / 1000}s until it works: ${errText(err)}`);
    }
  }

  // --- push ------------------------------------------------------------------------

  private startPullLoop(): void {
    if (!this.puller || this.pullLoopRunning || this.manual) return;
    this.pullLoopRunning = true;
    void this.pullLoop().finally(() => {
      this.pullLoopRunning = false;
    });
  }

  private async pullLoop(): Promise<void> {
    let backoff = BACKOFF_START_MS;
    while (this.owner) {
      this.pullAbort = new AbortController();
      let wait = 0;
      const pulledAt = this.clock();
      try {
        const notes = await this.puller!.pull(this.pullAbort.signal);
        this.lastPullError = this.puller!.lastAckError ?? null;
        backoff = BACKOFF_START_MS;
        if (notes.length > 0) this.onNotifications(notes);
        // An empty answer that came straight back would make this a busy loop.
        else if (this.clock() - pulledAt < MIN_EMPTY_PULL_MS) wait = MIN_EMPTY_PULL_MS;
      } catch (err) {
        if (!this.owner) break;
        this.lastPullError = errText(err);
        this.warn(`pulling ${this.config!.push!.subscription}: ${errText(err)}`);
        if (err instanceof PubSubError && (err.status === 403 || err.status === 404)) wait = PULL_REFUSED_RETRY_MS;
        else {
          wait = backoff;
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        }
      }
      if (wait > 0 && this.owner) await new Promise((r) => setTimeout(r, wait).unref?.());
    }
  }

  /** Exposed for tests. A notification for another mailbox on a shared topic is ignored. */
  onNotifications(notes: GmailNotification[]): void {
    const mine = notes.filter(
      (n) => n.emailAddress === null || this.email === null || n.emailAddress.toLowerCase() === this.email,
    );
    if (mine.length === 0) return;
    this.notificationsReceived += mine.length;
    this.lastNotificationAt = this.clock();
    void this.requestSync();
  }

  // --- queries -----------------------------------------------------------------------

  /**
   * Decides undecided events for every query in use, within a budget of
   * search calls. Owner only: its verdicts are persisted with the buffer.
   */
  async evaluatePending(): Promise<void> {
    if (!this.owner) return;
    if (this.evaluating) return this.evaluating;
    this.evaluating = (async () => {
      this.lastEvaluationAt = this.clock();
      await this.loadRegistryQueries();
      // Every live subscription's query, then the most recently polled ones. A
      // subscription's must never fall off the list: delivery waits on it.
      const queries = [...new Set([...this.subscriptionQueries, ...this.buffer!.knownQueries()])];
      // Shared, not first-come: one query with a backlog must not starve the rest.
      const share = Math.max(2, Math.floor(EVALUATION_BUDGET / Math.max(1, queries.length)));
      for (const query of queries) {
        await this.decide(query, this.buffer!.decideFrom(query), share);
      }
    })()
      .catch((err: unknown) => this.warn(`deciding queries: ${errText(err)}`))
      .finally(() => {
        this.evaluating = null;
      });
    return this.evaluating;
  }

  /** Every query a webhook subscription uses, so ingest decides it without waiting for a poll. */
  private async loadRegistryQueries(force = false): Promise<void> {
    const now = this.clock();
    if (!force && now - this.lastRegistryQueriesAt < REGISTRY_QUERY_RELOAD_MS) return;
    this.lastRegistryQueriesAt = now;
    try {
      const doc = await readRegistry(this.store!);
      const queries = new Set<string>();
      for (const s of doc.subscriptions) {
        if (s.refreshBefore <= now) continue;
        try {
          const args = parseMessageReceivedArgs(s.arguments);
          if (args.query !== undefined) {
            queries.add(args.query);
            // Delivery resumes from the watermark, so deciding has to start there.
            this.buffer!.noteQuery(args.query, s.watermark);
          }
        } catch {
          // A subscription this version cannot parse delivers nothing either.
        }
      }
      this.subscriptionQueries = queries;
    } catch (err) {
      this.warn(`reading webhook subscriptions for their queries: ${errText(err)}`);
    }
  }

  /** Decides `query` for undecided events after `after`, oldest first. Returns the budget left. */
  private async decide(query: string, after: number, budget: number): Promise<number> {
    const buffer = this.buffer!;
    for (const e of buffer.undecided(query, after)) {
      if (budget <= 0) break;
      const { verdict, calls } = await this.evaluate(e, query);
      budget -= calls;
      if (verdict === undefined) break; // not indexed yet: later events will not be either
      buffer.decide(e.eventId, query, verdict);
      if (this.owner) this.scheduleFlush();
    }
    return budget;
  }

  /**
   * Asks Gmail whether `e` matches `query`: the query AND the message's own
   * RFC 822 Message-ID, so the answer is about this message and costs one
   * search. A miss is only a "no" once the message is in the index at all;
   * until then it is undecided, and after {@link INDEX_GIVE_UP_MS} it is a "no".
   */
  private async evaluate(e: StoredEvent, query: string): Promise<{ verdict: boolean | undefined; calls: number }> {
    const api = this.api!;
    const id = e.data.message_id;
    const sec = Math.floor(Date.parse(e.timestamp) / 1000);
    const self = e.rfc822 ? `rfc822msgid:${e.rfc822}` : `after:${sec - 1} before:${sec + 2}`;
    try {
      const hits = await api.search(`(${query}) ${self}`, { max: 20 });
      if (hits.includes(id)) return { verdict: true, calls: 1 };
      const indexed = await api.search(self, { max: 20, includeSpamTrash: true });
      if (indexed.includes(id)) return { verdict: false, calls: 2 };
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 400 && (await this.queryRefused(query))) {
        // The query alone is refused: it can never match anything.
        return { verdict: false, calls: 2 };
      }
      this.warn(`deciding a query for ${e.eventId}: ${errText(err)}`);
      return { verdict: undefined, calls: 2 };
    }
    // Measured from when the message was READ, not its internalDate: imported
    // mail carries its old Date header there, and would be given up at once.
    if (this.clock() - Math.max(Date.parse(e.timestamp), e.seq / 1000) > INDEX_GIVE_UP_MS) {
      this.warn(`${e.eventId} is still not in Gmail's search index after 30 minutes; decided as not matching`);
      return { verdict: false, calls: 2 };
    }
    return { verdict: undefined, calls: 2 };
  }

  /** True when Gmail refuses `query` on its own, so a 400 is the query's and not the message's. */
  private async queryRefused(query: string): Promise<boolean> {
    try {
      await this.api!.search(`(${query})`, { max: 1 });
      return false;
    } catch (err) {
      return err instanceof GmailApiError && err.status === 400;
    }
  }

  // --- persistence and the lease --------------------------------------------------------

  /** Exposed for tests; the interval calls it. */
  async leaseTick(): Promise<void> {
    if (!this.store || this.stopped || !this.booted) return;
    try {
      if (this.store.superseded) {
        if (await this.store.reclaimIfStale(LEASE_STALE_MS)) {
          this.epoch++;
          const doc = await this.store.readBuffer();
          if (doc) this.buffer!.replace(doc);
          this.flushedRevision = this.buffer!.revision;
          this.state = "running";
          this.lastError = null;
          this.warn("took the lease back from an owner that stopped heartbeating");
          void this.requestSync();
          this.startPullLoop();
        }
        return;
      }
      if (!(await this.store.checkLease())) this.onSuperseded();
    } catch (err) {
      this.warn(`lease check failed: ${errText(err)}`);
    }
  }

  private onSuperseded(): void {
    this.epoch++;
    this.syncAgain = false;
    this.state = "superseded";
    this.lastError = new SupersededError().message;
    this.pullAbort?.abort();
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
    if (!this.store || !this.buffer || this.store.superseded || !this.booted) return;
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
        this.warn(`buffer flush failed: ${errText(err)}`);
      })
      .finally(() => {
        this.flushing = null;
      });
    await this.flushing;
  }

  // --- webhook delivery ------------------------------------------------------------------

  /** Delivers what is due, when this process holds the lease. Exposed for tests. */
  async webhookTick(): Promise<void> {
    if (!this.webhooks || this.stopped) return;
    await this.webhooks.tick(this.owner);
  }

  /** Tests: wait for every webhook POST in flight. */
  async webhooksSettled(): Promise<void> {
    await this.webhooks?.settle();
  }

  async subscribe(input: Omit<SubscribeInput<MessageReceivedArgs>, "parsedArguments">): Promise<SubscribeResult> {
    const webhooks = await this.served();
    const args = parseMessageReceivedArgs(input.arguments);
    if (args.query !== undefined) {
      this.buffer!.noteQuery(args.query, input.cursor);
      this.subscriptionQueries.add(args.query);
      // A cursor from the past: decide what delivery will start from now, rather than a tick later.
      if (input.cursor !== null) await this.decide(args.query, input.cursor, POLL_EVALUATION_BUDGET);
      if (this.owner) this.scheduleFlush();
    }
    return webhooks.subscribe({ ...input, parsedArguments: args });
  }

  async unsubscribe(input: { principal: string; name: string; url: string; arguments: Record<string, unknown> }): Promise<void> {
    const webhooks = await this.served();
    await webhooks.unsubscribe(input);
  }

  private async served(): Promise<WebhookDelivery<MessageReceivedArgs>> {
    if (!this.config || !this.webhooks) {
      throw new EventsNotServed(this.configProblem ?? "Gmail events are not configured on this mount.");
    }
    try {
      await this.start();
    } catch (err) {
      throw new EventsNotServed(
        `The Gmail events buffer could not be loaded from GCS (${errText(err)}). This is retried automatically.`,
      );
    }
    await this.refreshIfSuperseded();
    return this.webhooks;
  }

  // --- events/poll -------------------------------------------------------------------------

  async poll(params: PollParams): Promise<PollResult> {
    if (!this.config) {
      throw new EventsNotServed(this.configProblem ?? "Gmail events are not configured on this mount.");
    }
    const args = parseMessageReceivedArgs(params.arguments);
    const cursor = decodeCursor(params.cursor);
    let maxEvents = DEFAULT_MAX_EVENTS;
    if (params.maxEvents !== undefined && params.maxEvents !== null) {
      if (typeof params.maxEvents !== "number" || !Number.isInteger(params.maxEvents) || params.maxEvents < 1) {
        throw new InvalidEventArguments("maxEvents must be a positive integer");
      }
      maxEvents = Math.min(params.maxEvents, MAX_MAX_EVENTS);
    }
    let maxAgeMs: number | undefined;
    if (params.maxAgeMs !== undefined && params.maxAgeMs !== null) {
      if (typeof params.maxAgeMs !== "number" || !(params.maxAgeMs >= 0)) {
        throw new InvalidEventArguments("maxAgeMs must be a non-negative number");
      }
      maxAgeMs = params.maxAgeMs;
    }
    await this.served();
    const buffer = this.buffer!;
    if (args.query !== undefined) {
      buffer.noteQuery(args.query, cursor);
      if (cursor !== null) {
        try {
          await this.decide(args.query, cursor, POLL_EVALUATION_BUDGET);
        } catch (err) {
          this.warn(`deciding a poll's query: ${errText(err)}`);
        }
      }
      if (this.owner) this.scheduleFlush();
    }
    const out = buffer.poll({ cursor, args, maxEvents, maxAgeMs });
    return {
      events: out.events.map((e) => ({
        eventId: e.eventId,
        name: MESSAGE_RECEIVED,
        timestamp: e.timestamp,
        data: e.data as unknown as Record<string, unknown>,
      })),
      cursor: encodeCursor(out.cursor),
      truncated: out.truncated,
      hasMore: out.hasMore,
      nextPollMs: NEXT_POLL_MS,
    };
  }

  /** A superseded process answers from the owner's persisted buffer, re-read at most every few seconds. */
  private async refreshIfSuperseded(): Promise<void> {
    if (!this.store!.superseded) return;
    if (this.clock() - this.lastSupersededReload < SUPERSEDED_RELOAD_MS) return;
    this.lastSupersededReload = this.clock();
    try {
      const doc = await this.store!.readBuffer();
      if (doc) this.buffer!.replace(doc);
    } catch (err) {
      this.warn(`superseded re-read failed: ${errText(err)}`);
    }
  }

  // --- status --------------------------------------------------------------------------------

  status(): Record<string, unknown> {
    const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
    if (!this.config) return { state: this.state, events_served: false, reason: this.configProblem };
    const b = this.buffer!;
    return {
      state: this.state,
      events_served: true,
      event_types: [MESSAGE_RECEIVED],
      mode: this.puller ? "push" : "poll",
      push_problem: this.config.pushProblem,
      last_error: this.lastError,
      last_sync: this.lastSync && { ...this.lastSync, at: iso(this.lastSync.at) },
      last_recovery_cut: this.lastRecoveryCut,
      watch: {
        expires_at: iso(b.watchExpiration),
        last_attempt_at: iso(this.lastWatch?.at),
        last_error: this.lastWatch?.error ?? null,
      },
      notifications: {
        received: this.notificationsReceived,
        last_at: iso(this.lastNotificationAt),
        last_error: this.lastPullError,
      },
      buffer: {
        events: b.size,
        retention_days: this.config.retentionDays,
        history_id: b.historyId,
        live_through: iso(b.liveThrough),
        last_event_buffered_at: iso(this.lastEventAt),
        last_flush_at: iso(this.lastFlushAt),
        last_flush_error: this.lastFlushError,
        queries_in_use: b.knownQueries().length,
        gcs_prefix: this.config.prefix,
      },
      lease: this.store!.lease,
      webhook_subscriptions: this.webhooks?.status() ?? [],
    };
  }

  /** A failure that repeats every read (a mount with no token yet) is said once, not every 15 seconds. */
  private fail(message: string): void {
    if (message !== this.lastError) this.warn(message);
    this.lastError = message;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
