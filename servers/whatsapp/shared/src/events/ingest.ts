/**
 * The WhatsApp `message_received` event: a sealed ring buffer of the messages
 * the bridge receives, `events/poll` over it, and webhook delivery out of it.
 *
 * THE BRIDGE IS THE SOURCE. It already holds the one socket on the linked
 * device, so there is nothing to poll and nothing to subscribe to upstream:
 * every message WhatsApp delivers live (`messages.upsert`) is handed to
 * {@link WhatsAppEvents.add} as it is buffered. A history sync — the backlog
 * the phone replays after pairing, or on demand — is not new, and is never
 * an event.
 *
 * NEVER AN EVENT, whatever the arguments: a message this bridge sent (Zimmer's
 * own posts, the self-loop), and a reaction. Zimmer's WhatsApp trigger drops
 * both (`WhatsappTriggerPollerJob#fires?`), and so does this.
 *
 * ONE WRITER: the process holding the bridge's lease (`events/store.ts`). A
 * process that is not it answers polls from the persisted buffer, re-read at
 * most every few seconds, and delivers nothing.
 *
 * NOTHING HERE THROWS INTO THE BRIDGE, and nothing here logs a message's text,
 * a name or a chat id. A failure is a state and a line that says what failed.
 */
import type { BlobStore } from "../state-store.js";
import { logWarning } from "../logging.js";
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
  loadEventsConfig,
  WhatsAppEventsConfigError,
  type EnvLike,
  type WhatsAppEventsConfig,
} from "./config.js";
import { eventIdFor, toMessageReceived, type IncomingMessage } from "./normalize.js";
import { EventsStore, EventsSuperseded } from "./store.js";
import { WebhookDelivery, type SubscribeInput, type SubscribeResult } from "./webhook/delivery.js";
import { HttpsWebhookTransport, type WebhookTransport } from "./webhook/transport.js";

export const MESSAGE_RECEIVED = "message_received";
export const NEXT_POLL_MS = 5_000;
export const WEBHOOK_TICK_MS = 1_000;
const FLUSH_DEBOUNCE_MS = 2_000;
const SUPERSEDED_RELOAD_MS = 5_000;
const BOOT_RETRY_START_MS = 1_000;
const BOOT_RETRY_MAX_MS = 60_000;

export type EventsState = "config_error" | "starting" | "running" | "degraded" | "standby" | "stopped";

export class EventsNotServed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventsNotServed";
  }
}
export { InvalidEventArguments };

/** What the event needs to know about the bridge's lease. */
export interface Ownership {
  /** True while this process holds the account: it receives, writes and delivers. */
  owns(): boolean;
  /** A fresh read of the lease, for settling a write conflict. */
  confirm(): Promise<boolean>;
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

export interface WhatsAppEventsDeps {
  env: EnvLike;
  blobs: BlobStore;
  /** WHATSAPP_STATE_ENCRYPTION_KEY, parsed. */
  key: Buffer;
  /** The bridge's state folder. */
  prefix: string;
  ownership: Ownership;
  webhookTransport?: WebhookTransport;
  clock?: () => number;
  /** Tests only: no timers; the periodic steps are driven by hand. */
  manualTimers?: boolean;
  warn?: (message: string) => void;
}

export class WhatsAppEvents {
  state: EventsState;
  private readonly config: WhatsAppEventsConfig | null;
  private readonly configProblem: string | null;
  private readonly clock: () => number;
  private readonly manual: boolean;
  private readonly warnFn: (message: string) => void;
  private readonly store: EventsStore;
  private readonly buffer: EventBuffer | null = null;
  private readonly webhooks: WebhookDelivery<MessageReceivedArgs> | null = null;

  private ready: Promise<void> | null = null;
  private booted = false;
  private stopped = false;
  private bootFailure: unknown = null;
  private bootBackoffMs = BOOT_RETRY_START_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private webhookTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushedRevision = -1;
  private flushing: Promise<void> | null = null;
  private lastStandbyReload = 0;


  constructor(private readonly deps: WhatsAppEventsDeps) {
    this.clock = deps.clock ?? Date.now;
    this.manual = deps.manualTimers === true;
    this.warnFn = deps.warn ?? ((message) => logWarning(`events: ${message}`));
    this.store = new EventsStore(deps.blobs, deps.key, deps.prefix);
    let config: WhatsAppEventsConfig | null = null;
    let problem: string | null = null;
    try {
      config = loadEventsConfig(deps.env);
      this.state = "starting";
    } catch (err) {
      problem = err instanceof WhatsAppEventsConfigError ? err.message : String(err);
      this.state = "config_error";
    }
    this.config = config;
    this.configProblem = problem;
    if (problem) this.warn(problem);
    if (!config) return;
    if (config.webhookAccessProblem) {
      this.warn(`webhook Access headers are off: ${config.webhookAccessProblem}`);
    }
    const buffer = new EventBuffer(config.retentionDays * 86_400_000, this.clock);
    this.buffer = buffer;
    this.webhooks = new WebhookDelivery<MessageReceivedArgs>({
      store: this.store,
      source: {
        head: () => buffer.head,
        evictedThrough: () => buffer.evictedThroughSeq,
        eventsAfter: (after, args, limit) => buffer.eventsAfter(after, args, limit),
      },
      transport: deps.webhookTransport ?? new HttpsWebhookTransport(),
      parseArgs: parseMessageReceivedArgs,
      access: config.webhookAccess,
      clock: this.clock,
      warn: (message) => this.warn(message),
    });
  }

  /** True when the event is served: requested, and its configuration parsed. */
  get configured(): boolean {
    return this.config !== null;
  }

  get unavailableReason(): string | null {
    return this.configProblem;
  }

  private warn(message: string): void {
    this.warnFn(message);
  }

  private get owner(): boolean {
    return this.booted && !this.stopped && this.deps.ownership.owns();
  }

  // --- lifecycle --------------------------------------------------------------------

  /** Idempotent. Resolves once the persisted buffer is loaded. */
  start(): Promise<void> {
    if (!this.config || this.stopped) return Promise.resolve();
    if (this.retryTimer) return Promise.reject(this.bootFailure);
    this.ready ??= this.boot();
    return this.ready;
  }

  private async boot(): Promise<void> {
    const buffer = this.buffer!;
    try {
      const doc = await this.store.readBuffer();
      // Anything the bridge handed over while this read was in flight is
      // re-sequenced after the document's head (`adopt`).
      if (doc) buffer.adopt(doc);
      this.booted = true;
      this.bootFailure = null;
      this.state = "running";
    } catch (err) {
      // Serving from an empty buffer would answer every poll "nothing new"
      // while events sit in GCS; the state says so, and the load is retried.
      this.warn(`loading the event buffer from GCS: ${errText(err)}`);
      this.state = "degraded";
      this.ready = null;
      this.bootFailure = err;
      if (!this.manual && !this.stopped) {
        const wait = this.bootBackoffMs;
        this.bootBackoffMs = Math.min(this.bootBackoffMs * 2, BOOT_RETRY_MAX_MS);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.start().catch(() => {});
        }, wait);
        this.retryTimer.unref?.();
      }
      throw err;
    }
    if (this.stopped) return;
    // Events added before the load are written now that the generation is known.
    if (buffer.revision !== this.flushedRevision) this.scheduleFlush();
    if (!this.manual && !this.webhookTimer) {
      this.webhookTimer = setInterval(() => void this.webhookTick(), WEBHOOK_TICK_MS);
      this.webhookTimer.unref?.();
    }
  }

  /** Flushes and stops. The bridge's `close` path calls it on SIGTERM. */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.webhookTimer) clearInterval(this.webhookTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.webhookTimer = this.retryTimer = this.flushTimer = null;
    try {
      await this.flushNow();
      await this.webhooks?.flush();
    } catch (err) {
      this.warn(`close: ${errText(err)}`);
    }
    if (this.state !== "config_error") this.state = "stopped";
  }

  // --- from the bridge --------------------------------------------------------------

  /**
   * One message WhatsApp delivered live. Synchronous and never throws: the
   * bridge's ingest must not wait on GCS or fail because of the event.
   */
  add(incoming: IncomingMessage): void {
    if (!this.buffer || this.stopped) return;
    const m = incoming.message;
    if (m.sent_by_bridge || m.type === "reaction") return;
    try {
      const added = this.buffer.add({
        eventId: eventIdFor(m.chat_id, m.id),
        timestamp: new Date(m.timestamp * 1000).toISOString(),
        data: toMessageReceived(incoming),
        ...(incoming.chat_alt_id ? { chat_alt: incoming.chat_alt_id } : {}),
      });
      if (added) this.scheduleFlush();
    } catch (err) {
      this.warn(`could not buffer an event: ${errText(err)}`);
    }
  }

  /**
   * The account was logged out, or a different one paired: the event buffer
   * goes with the chats. Subscriptions stay (they hold no message content); a
   * cursor from before reads as truncated.
   */
  async wipe(): Promise<void> {
    if (!this.buffer) return;
    // A boot read in flight would fold the pre-wipe document back in.
    await this.ready?.catch(() => {});
    await this.flushing;
    this.buffer.clear();
    try {
      await this.store.deleteBuffer();
    } catch (err) {
      this.warn(`could not delete the event buffer: ${errText(err)}`);
    }
    // The emptied buffer is written as the new state, so its sequence and
    // eviction mark survive and a cursor from before is told it was truncated.
    this.flushedRevision = -1;
    await this.flushNow();
  }

  // --- persistence --------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.manual || this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  /** Writes the buffer if it changed since the last write and this process owns it. Never throws. */
  async flushNow(): Promise<void> {
    if (!this.buffer || !this.booted || !this.deps.ownership.owns()) return;
    if (this.flushing) {
      await this.flushing;
      if (this.buffer.revision === this.flushedRevision) return;
    }
    if (this.buffer.revision === this.flushedRevision) return;
    const buffer = this.buffer;
    const revision = buffer.revision;
    this.flushing = this.store
      .writeBuffer(
        buffer.toDoc(),
        (theirs: BufferDoc) => {
          buffer.merge(theirs, { resequence: true });
          return buffer.toDoc();
        },
        () => this.deps.ownership.confirm(),
      )
      .then(() => {
        this.flushedRevision = Math.max(this.flushedRevision, revision);
      })
      .catch((err: unknown) => {
        if (err instanceof EventsSuperseded) {
          this.state = "standby";
          return;
        }
        this.warn(`event buffer flush failed (will retry): ${errText(err)}`);
        this.scheduleFlush();
      })
      .finally(() => {
        this.flushing = null;
      });
    await this.flushing;
  }

  // --- webhook delivery -------------------------------------------------------------

  /** Delivers what is due when this process holds the account. Exposed for tests. */
  async webhookTick(): Promise<void> {
    if (!this.webhooks || this.stopped) return;
    await this.webhooks.tick(this.owner);
  }

  /** Tests: wait for every webhook POST in flight. */
  async webhooksSettled(): Promise<void> {
    await this.webhooks?.settle();
  }

  async subscribe(
    input: Omit<SubscribeInput<MessageReceivedArgs>, "parsedArguments">,
  ): Promise<SubscribeResult> {
    const webhooks = await this.served();
    const args = parseMessageReceivedArgs(input.arguments);
    return webhooks.subscribe({ ...input, parsedArguments: args });
  }

  async unsubscribe(input: {
    principal: string;
    name: string;
    url: string;
    arguments: Record<string, unknown>;
  }): Promise<void> {
    const webhooks = await this.served();
    await webhooks.unsubscribe(input);
  }

  private async served(): Promise<WebhookDelivery<MessageReceivedArgs>> {
    if (!this.config || !this.webhooks) {
      throw new EventsNotServed(this.configProblem ?? "WhatsApp events are not configured on this mount.");
    }
    try {
      await this.start();
    } catch (err) {
      throw new EventsNotServed(
        `The WhatsApp event buffer could not be loaded from GCS (${errText(err)}). This is retried automatically.`,
      );
    }
    await this.reloadIfStandby();
    return this.webhooks;
  }

  // --- events/poll ----------------------------------------------------------------------

  async poll(params: PollParams): Promise<PollResult> {
    if (!this.config) {
      throw new EventsNotServed(this.configProblem ?? "WhatsApp events are not configured on this mount.");
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
    const out = this.buffer!.poll({ cursor, args, maxEvents, maxAgeMs });
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

  /**
   * A process that does not hold the account answers from the owner's
   * persisted buffer, re-read at most every few seconds.
   */
  private async reloadIfStandby(): Promise<void> {
    if (this.deps.ownership.owns()) {
      if (this.state === "standby") this.state = "running";
      return;
    }
    if (this.clock() - this.lastStandbyReload < SUPERSEDED_RELOAD_MS) return;
    this.lastStandbyReload = this.clock();
    try {
      const doc = await this.store.readBuffer();
      if (doc) this.buffer!.replace(doc);
      this.flushedRevision = this.buffer!.revision;
    } catch (err) {
      this.warn(`re-reading the owner's event buffer failed: ${errText(err)}`);
    }
  }
}

/** True when this slug asked for the event at all. */
export { eventsRequested };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
