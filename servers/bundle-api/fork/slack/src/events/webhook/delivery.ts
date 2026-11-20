/**
 * Webhook delivery (SEP-3415 webhook mode), for any event source.
 *
 * The engine knows events only as {@link DeliverableEvent}s in a sequenced
 * buffer and subscription arguments only as an opaque `A` the source filters
 * on, so one engine serves Slack's `message_posted`, Gmail's
 * `message_received` (`images/bundle-google/src/events/`) and WhatsApp's
 * `message_received` (`servers/whatsapp/shared/src/events/`). Each of those
 * trees carries a copy of this directory made by `npm run eventswebhook:sync`.
 * Edit it here.
 *
 * SUBSCRIBE is any process's job; DELIVERY is the lease holder's. A subscribe
 * verifies the endpoint if this principal has not verified that URL yet, then
 * writes the subscription into the persisted registry (registry.ts). The lease
 * holder re-reads the registry, and on every tick POSTs whatever each active
 * subscription has not been sent yet, straight from the durable ring buffer —
 * the same buffer `events/poll` reads, in the same cursor space.
 *
 * DELIVERY, PER SUBSCRIPTION:
 *
 *   - Events go out in buffer order, at most {@link MAX_IN_FLIGHT} at a time.
 *     Each is retried on its own: attempts at 0, 30 s, 2½ min, 7½ min and
 *     14½ min ({@link RETRY_DELAYS_MS}), the same `webhook-id` every time and a
 *     fresh timestamp and signature on each.
 *   - `2xx` is acknowledged. `410` and `413` are given up at once, as the draft
 *     says. Anything else, or no answer, is retried.
 *   - THE WATERMARK is the highest sequence at or below which every event has
 *     been acknowledged or given up. It is what each payload's `cursor` and
 *     each refresh's `cursor` carry, and it is persisted, so a restarted
 *     container resumes where the last one stopped.
 *   - SUSTAINED FAILURE SUSPENDS, IT DOES NOT DISCARD. An event whose retries
 *     run out is given up only if the endpoint has answered since that event's
 *     first attempt — the endpoint is up and refuses this one event. If it has
 *     not answered at all, the subscription is SUSPENDED (`active: false`)
 *     instead: nothing is given up, the watermark holds, and the next refresh
 *     reactivates it and delivery resumes from the watermark. A receiver that
 *     was down catches up from the buffer, for as long as the buffer keeps the
 *     events (7 days by default).
 *   - A GAP — the watermark fell behind what the buffer evicted — is announced
 *     with a signed `{"type":"gap","cursor":…}` envelope before delivery
 *     carries on from the oldest event still held.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { encodeCursor } from './cursor.js';
import {
  DEFAULT_TTL_MS,
  SECRET_GRACE_MS,
  VERIFIED_TTL_MS,
  grantTtl,
  keyOf,
  readRegistry,
  signingKeys,
  subscriptionId,
  subscriptionKey,
  updateRegistry,
  type RegistryDoc,
  type RegistryStore,
  type SubscriptionRecord,
} from './registry.js';
import { newMessageId, signatureHeader } from './signing.js';
import {
  DeliveryFailure,
  statusCategory,
  type DeliveryErrorCategory,
  type WebhookTransport,
} from './transport.js';

export { DEFAULT_TTL_MS };

/** Delays before attempts 2 to 5. Five attempts over 14½ minutes. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 300_000, 420_000] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** Deliveries outstanding per subscription. Keeps order close to buffer order. */
export const MAX_IN_FLIGHT = 10;
/** How often the lease holder re-reads the registry for subscriptions made elsewhere. */
export const RELOAD_MS = 15_000;
/** How often the lease holder writes delivery progress back. */
export const PERSIST_MS = 5_000;
/** Subscriptions this server will hold, across every principal. */
export const MAX_SUBSCRIPTIONS = 100;
/** Verification POSTs per destination host per minute. */
export const VERIFY_PER_HOST_PER_MINUTE = 5;

/** The draft's provisional `CallbackEndpointError`. */
export class CallbackEndpointError extends Error {
  constructor(readonly reason: DeliveryErrorCategory) {
    super(`the callback endpoint could not be verified: ${reason}`);
    this.name = 'CallbackEndpointError';
  }
}

export class SubscriptionNotFound extends Error {
  constructor() {
    super('no webhook subscription matches this principal, delivery.url, name and arguments');
    this.name = 'SubscriptionNotFound';
  }
}

export class SubscriptionLimit extends Error {
  constructor(
    readonly limit: 'subscriptions' | 'verifications',
    readonly max: number
  ) {
    super(
      limit === 'subscriptions'
        ? `this server holds at most ${max} webhook subscriptions`
        : `at most ${max} endpoint verifications per minute to one host; retry shortly`
    );
    this.name = 'SubscriptionLimit';
  }
}

/** One buffered event, as delivery sees it. `data` is the payload, sent as is. */
export interface DeliverableEvent {
  eventId: string;
  /** ISO 8601. */
  timestamp: string;
  data: unknown;
  seq: number;
}

/** What delivery reads from the ring buffer. `A` is the source's parsed arguments. */
export interface DeliverySource<A> {
  head(): number;
  evictedThrough(): number;
  /** Matching events with `seq > after`, oldest first, at most `limit`. */
  eventsAfter(after: number, args: A, limit: number): DeliverableEvent[];
  /**
   * The highest sequence through which the source has DECIDED, for these
   * arguments, which events match. Absent: the head, which is right for a
   * source whose matching is synchronous. A source that decides some matches
   * asynchronously (Gmail asks Gmail's own search) answers lower while a
   * decision is outstanding, and `eventsAfter` stops there too, so delivery
   * never scans past an event it may yet owe. `after` is where this
   * subscription's scan already stands; nothing at or before it is asked about.
   */
  readyThrough?(args: A, after: number): number;
}

export interface SubscribeInput<A> {
  principal: string;
  /** The name as the subscriber knows it (strad's namespaced name). */
  name: string;
  eventType: string;
  arguments: Record<string, unknown>;
  parsedArguments: A;
  url: string;
  /** The parsed `whsec_` key bytes. */
  secret: Buffer;
  cursor: number | null;
  maxAgeMs: number | undefined;
  /** `undefined`: omitted. `null`: no expiry requested. */
  ttlMs: number | null | undefined;
}

export interface DeliveryStatus {
  active: boolean;
  lastDeliveryAt: string | null;
  lastError: DeliveryErrorCategory | null;
  failedSince?: string;
}

export interface SubscribeResult {
  id: string;
  refreshBefore: string;
  cursor: string;
  truncated: boolean;
  deliveryStatus?: DeliveryStatus;
}

interface Pending {
  seq: number;
  webhookId: string;
  attempts: number;
  nextAt: number;
  firstAt: number;
  sending: boolean;
  /** The body, minus the cursor, which is the watermark at send time. */
  envelope:
    | { kind: 'event'; event: DeliverableEvent }
    | { kind: 'gap' };
}

interface Live<A> {
  record: SubscriptionRecord;
  args: A;
  queue: Map<number, Pending>;
  /** Everything at or below this has been queued or skipped. */
  scannedThrough: number;
  /** Last time the endpoint answered at all (2xx, 410, 413). */
  lastContactAt: number | null;
  dirty: boolean;
}

/**
 * Headers for a callback's edge, from strad's configuration: a Cloudflare
 * Access service token for Zimmer's receiver. Attached only when the URL is
 * under a configured prefix — exactly that host, over https on the default
 * port, and a path under the prefix's path — never to a URL a subscriber
 * steered elsewhere, on that host or any other. No redirect is followed, so
 * they cannot be carried on. Outside the HMAC, which covers the body only.
 */
export function accessHeadersFor(
  access: AccessConfig | null,
  url: string
): Record<string, string> {
  if (!access) return {};
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return {};
  }
  // The default port only: `zimmer.tadasant.com:8443` is not the edge the token is for.
  if (target.protocol !== 'https:' || (target.port !== '' && target.port !== '443')) return {};
  // `URL` has already resolved `.` and `..` segments (and their %2e forms), so
  // a path cannot climb out of the prefix by spelling.
  const host = target.hostname.toLowerCase();
  const inside = access.prefixes.some((p) => p.host === host && target.pathname.startsWith(p.path));
  return inside ? { ...access.headers } : {};
}

export interface AccessConfig {
  prefixes: readonly { host: string; path: string }[];
  headers: Record<string, string>;
}

export interface WebhookDeliveryDeps<A> {
  store: RegistryStore;
  source: DeliverySource<A>;
  transport: WebhookTransport;
  parseArgs: (raw: unknown) => A;
  /** Edge credentials for configured URL prefixes; see {@link accessHeadersFor}. */
  access?: AccessConfig | null;
  clock?: () => number;
  warn?: (message: string) => void;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export class WebhookDelivery<A> {
  private readonly store: RegistryStore;
  private readonly source: DeliverySource<A>;
  private readonly transport: WebhookTransport;
  private readonly parseArgs: (raw: unknown) => A;
  private readonly access: WebhookDeliveryDeps<A>['access'];
  private readonly clock: () => number;
  private readonly warn: (message: string) => void;
  private live = new Map<string, Live<A>>();
  private loadedAt: number | null = null;
  private lastPersistAt = 0;
  private registryDirty = false;
  private ticking: Promise<void> | null = null;
  private sends = new Set<Promise<void>>();
  private verifications = new Map<string, number[]>();

  constructor(deps: WebhookDeliveryDeps<A>) {
    this.store = deps.store;
    this.source = deps.source;
    this.transport = deps.transport;
    this.parseArgs = deps.parseArgs;
    this.access = deps.access ?? null;
    this.clock = deps.clock ?? Date.now;
    this.warn = deps.warn ?? (() => {});
  }

  // --- subscribe / unsubscribe -------------------------------------------------

  async subscribe(input: SubscribeInput<A>): Promise<SubscribeResult> {
    const now = this.clock();
    const key = subscriptionKey(input.principal, input.url, input.name, input.arguments);
    const id = subscriptionId(key);
    const secretB64 = input.secret.toString('base64');
    const ttl = grantTtl(input.ttlMs);
    const before = await readRegistry(this.store);
    const verified = before.verified.some(
      (v) => v.principal === input.principal && v.url === input.url && v.until > now
    );
    if (!verified) await this.verify(input.url, id, input.secret);

    const { result } = await updateRegistry(this.store, (doc) => {
      const at = this.clock();
      doc.subscriptions = doc.subscriptions.filter((s) => s.refreshBefore > at);
      doc.verified = doc.verified.filter((v) => v.until > at);
      const existing = doc.subscriptions.find((s) => s.id === id && keyOf(s) === key);
      const verification = doc.verified.find(
        (v) => v.principal === input.principal && v.url === input.url
      );
      if (verification) verification.until = at + VERIFIED_TTL_MS;
      else {
        doc.verified.push({
          principal: input.principal,
          url: input.url,
          verifiedAt: at,
          until: at + VERIFIED_TTL_MS,
        });
      }
      if (existing) return this.refresh(existing, secretB64, ttl, at);
      if (doc.subscriptions.length >= MAX_SUBSCRIPTIONS) {
        throw new SubscriptionLimit('subscriptions', MAX_SUBSCRIPTIONS);
      }
      return this.create(doc, input, id, secretB64, ttl, at);
    });
    // A subscription made on this process is delivered without waiting for the
    // next scheduled re-read, when this process is the one delivering.
    this.loadedAt = null;
    return result;
  }

  private refresh(
    record: SubscriptionRecord,
    secretB64: string,
    ttl: number,
    now: number
  ): SubscribeResult {
    const live = this.live.get(record.id);
    // The lease holder's memory is fresher than the persisted record.
    const current = live?.record ?? record;
    const status: DeliveryStatus = {
      active: current.active,
      lastDeliveryAt: iso(current.lastDeliveryAt),
      lastError: current.lastError,
      ...(current.failedSince !== null ? { failedSince: iso(current.failedSince)! } : {}),
    };
    if (record.secrets[0] !== secretB64) {
      record.secrets = [secretB64, record.secrets[0]!];
      record.previousSecretUntil = now + SECRET_GRACE_MS;
    }
    record.refreshBefore = now + ttl;
    // A refresh is the subscriber's liveness signal: it reactivates a
    // suspension older than itself, here or wherever the suspension is still
    // only in the lease holder's memory (see `reconcile` and `persist`).
    record.refreshedAt = now;
    if (!current.active || !record.active) {
      record.active = true;
      record.failedSince = null;
      record.suspendedAt = null;
    }
    return {
      id: record.id,
      refreshBefore: new Date(record.refreshBefore).toISOString(),
      cursor: encodeCursor(Math.max(record.watermark, current.watermark)),
      truncated: false,
      deliveryStatus: status,
    };
  }

  private create(
    doc: RegistryDoc,
    input: SubscribeInput<A>,
    id: string,
    secretB64: string,
    ttl: number,
    now: number
  ): SubscribeResult {
    const evicted = this.source.evictedThrough();
    let watermark: number;
    let truncated = false;
    let notBefore: number | null = null;
    if (input.cursor === null) {
      watermark = this.source.head();
    } else {
      // A cursor ahead of the head would skip whatever arrives up to it.
      watermark = Math.min(input.cursor, this.source.head());
      if (watermark < evicted) {
        truncated = true;
        watermark = evicted;
      }
      if (input.maxAgeMs !== undefined) {
        notBefore = now - input.maxAgeMs;
        const skipped = this.source
          .eventsAfter(watermark, input.parsedArguments, Number.MAX_SAFE_INTEGER)
          .some((e) => Date.parse(e.timestamp) < notBefore!);
        if (skipped) truncated = true;
      }
    }
    doc.subscriptions.push({
      id,
      principal: input.principal,
      url: input.url,
      name: input.name,
      eventType: input.eventType,
      arguments: input.arguments,
      secrets: [secretB64],
      previousSecretUntil: null,
      refreshBefore: now + ttl,
      createdAt: now,
      watermark,
      notBefore,
      active: true,
      refreshedAt: now,
      suspendedAt: null,
      lastDeliveryAt: null,
      lastError: null,
      failedSince: null,
    });
    return {
      id,
      refreshBefore: new Date(now + ttl).toISOString(),
      cursor: encodeCursor(watermark),
      truncated,
    };
  }

  async unsubscribe(input: {
    principal: string;
    name: string;
    url: string;
    arguments: Record<string, unknown>;
  }): Promise<void> {
    const key = subscriptionKey(input.principal, input.url, input.name, input.arguments);
    const id = subscriptionId(key);
    const { result: found } = await updateRegistry(this.store, (doc) => {
      const before = doc.subscriptions.length;
      doc.subscriptions = doc.subscriptions.filter((s) => !(s.id === id && keyOf(s) === key));
      return doc.subscriptions.length !== before;
    });
    if (!found) throw new SubscriptionNotFound();
    this.live.delete(id);
    this.loadedAt = null;
  }

  /**
   * The challenge-echo handshake: a signed `verification` envelope carrying a
   * single-use nonce, answered by `2xx {"challenge":"<nonce>"}`, compared in
   * constant time. Anything else is `challenge_failed`; no answer at all is the
   * connection's own category. Nothing the endpoint said is repeated.
   */
  private async verify(url: string, id: string, secret: Buffer): Promise<void> {
    const host = new URL(url).host;
    const now = this.clock();
    const recent = (this.verifications.get(host) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= VERIFY_PER_HOST_PER_MINUTE) {
      throw new SubscriptionLimit('verifications', VERIFY_PER_HOST_PER_MINUTE);
    }
    recent.push(now);
    this.verifications.set(host, recent);

    const challenge = randomBytes(24).toString('base64url');
    const body = JSON.stringify({ type: 'verification', challenge });
    let answer: string;
    try {
      const res = await this.transport.post(
        url,
        { ...accessHeadersFor(this.access ?? null, url), ...this.headers(id, [secret], 'verification', body) },
        body
      );
      if (statusCategory(res.status) !== null) throw new CallbackEndpointError('challenge_failed');
      answer = res.body;
    } catch (err) {
      if (err instanceof CallbackEndpointError) throw err;
      if (err instanceof DeliveryFailure) throw new CallbackEndpointError(err.category);
      throw new CallbackEndpointError('connection_refused');
    }
    let echoed: unknown;
    try {
      echoed = (JSON.parse(answer) as { challenge?: unknown }).challenge;
    } catch {
      echoed = undefined;
    }
    const want = Buffer.from(challenge, 'utf8');
    const got = Buffer.from(typeof echoed === 'string' ? echoed : '', 'utf8');
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new CallbackEndpointError('challenge_failed');
    }
  }

  private headers(
    id: string,
    keys: Buffer[],
    messageIdOrType: string | { id: string },
    body: string
  ): Record<string, string> {
    const messageId =
      typeof messageIdOrType === 'string' ? newMessageId(messageIdOrType) : messageIdOrType.id;
    const timestamp = Math.floor(this.clock() / 1000);
    return {
      'webhook-id': messageId,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': signatureHeader(keys, messageId, timestamp, body),
      'x-mcp-subscription-id': id,
    };
  }

  // --- delivery (lease holder only) ---------------------------------------------

  /**
   * One pass. `owner` false drops every in-memory delivery: a process that
   * lost the lease must stop POSTing, and the new holder resumes from the
   * persisted watermark. Never throws.
   */
  async tick(owner: boolean): Promise<void> {
    if (!owner) {
      this.live.clear();
      this.loadedAt = null;
      return;
    }
    if (this.ticking) return this.ticking;
    this.ticking = this.tickOnce()
      .catch((err: unknown) => this.warn(`webhook delivery tick failed: ${errText(err)}`))
      .finally(() => {
        this.ticking = null;
      });
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    const now = this.clock();
    // Memory's `refreshBefore` can be up to RELOAD_MS stale, and a refresh may
    // have landed on another process: read again before collecting anything.
    const expiring = [...this.live.values()].some((l) => l.record.refreshBefore <= now);
    let fresh = false;
    if (this.loadedAt === null || now - this.loadedAt >= RELOAD_MS || expiring) {
      this.reconcile(await readRegistry(this.store));
      this.loadedAt = now;
      fresh = true;
    }
    for (const [id, live] of this.live) {
      if (live.record.refreshBefore <= now) {
        // Expired: the subscriber stopped refreshing. Collected, not delivered to.
        if (fresh) {
          this.live.delete(id);
          this.registryDirty = true;
        }
        continue;
      }
      if (!live.record.active) continue;
      this.fill(live, now);
      for (const pending of live.queue.values()) {
        if (!pending.sending && pending.nextAt <= now) this.send(live, pending);
      }
    }
    if (
      (this.registryDirty || [...this.live.values()].some((l) => l.dirty)) &&
      now - this.lastPersistAt >= PERSIST_MS
    ) {
      await this.persist();
    }
  }

  /** Tests and shutdown: wait for every POST in flight to finish. */
  async settle(): Promise<void> {
    while (this.sends.size > 0) await Promise.allSettled([...this.sends]);
  }

  /** Writes delivery progress now. The host calls it on shutdown. */
  async flush(): Promise<void> {
    await this.settle();
    if (this.registryDirty || [...this.live.values()].some((l) => l.dirty)) await this.persist();
  }

  /** Folds the persisted registry into memory, keeping what only memory knows. */
  private reconcile(doc: RegistryDoc): void {
    const seen = new Set<string>();
    for (const record of doc.subscriptions) {
      seen.add(record.id);
      const existing = this.live.get(record.id);
      // Same id, different subscription: it was unsubscribed and subscribed
      // again elsewhere, with its own start. Start over from the new record.
      const live = existing && existing.record.createdAt === record.createdAt ? existing : undefined;
      if (!live) {
        let args: A;
        try {
          args = this.parseArgs(record.arguments);
        } catch {
          continue;
        }
        this.live.set(record.id, {
          record: structuredClone(record),
          args,
          queue: new Map(),
          scannedThrough: record.watermark,
          lastContactAt: record.lastDeliveryAt,
          dirty: false,
        });
        continue;
      }
      // What the subscriber controls comes from the registry.
      live.record.secrets = record.secrets;
      live.record.previousSecretUntil = record.previousSecretUntil;
      live.record.refreshBefore = record.refreshBefore;
      live.record.refreshedAt = record.refreshedAt;
      if (!live.record.active && (record.refreshedAt ?? 0) > (live.record.suspendedAt ?? 0)) {
        this.reactivate(live);
      }
    }
    for (const id of [...this.live.keys()]) if (!seen.has(id)) this.live.delete(id);
  }

  private reactivate(live: Live<A>): void {
    const now = this.clock();
    live.record.active = true;
    live.record.failedSince = null;
    live.record.suspendedAt = null;
    // Time spent suspended does not count against an event's retry window.
    for (const p of live.queue.values()) {
      p.attempts = 0;
      p.firstAt = now;
      p.nextAt = now;
    }
    live.dirty = true;
  }

  /** Queues what is due, oldest first, up to the in-flight cap. */
  private fill(live: Live<A>, now: number): void {
    const evicted = this.source.evictedThrough();
    if (live.scannedThrough < evicted) {
      live.queue.set(evicted, {
        seq: evicted,
        webhookId: newMessageId('gap'),
        attempts: 0,
        nextAt: now,
        firstAt: now,
        sending: false,
        envelope: { kind: 'gap' },
      });
      live.scannedThrough = evicted;
    }
    const room = MAX_IN_FLIGHT - live.queue.size;
    if (room <= 0) return;
    const notBefore = live.record.notBefore;
    const due: DeliverableEvent[] = [];
    let scanned = live.scannedThrough;
    // With no age floor, `room` events is all this pass can use. With one, events
    // under it are skipped rather than queued, so the scan cannot stop at `room`.
    const limit = notBefore === null ? room : Number.MAX_SAFE_INTEGER;
    for (const e of this.source.eventsAfter(live.scannedThrough, live.args, limit)) {
      if (due.length >= room) break;
      scanned = e.seq;
      if (notBefore !== null && Date.parse(e.timestamp) < notBefore) continue;
      due.push(e);
    }
    for (const e of due) {
      live.queue.set(e.seq, {
        seq: e.seq,
        webhookId: newMessageId(),
        attempts: 0,
        nextAt: now,
        firstAt: now,
        sending: false,
        envelope: { kind: 'event', event: e },
      });
    }
    // Room left over means every matching event up to what the source has
    // decided was seen: the head, unless a match is still being decided.
    const ready = this.source.readyThrough?.(live.args, scanned) ?? this.source.head();
    live.scannedThrough = due.length < room ? Math.max(scanned, ready) : scanned;
    this.advance(live);
  }

  /**
   * A gap envelope's cursor: the eviction point, but never past an event still
   * outstanding, or a receiver that persists it would replay past that event.
   */
  private gapCursor(live: Live<A>, evicted: number): number {
    const others = [...live.queue.keys()].filter((seq) => seq !== evicted);
    return others.length > 0 ? Math.min(evicted, Math.min(...others) - 1) : evicted;
  }

  /** Recomputes the watermark from what is still outstanding. */
  private advance(live: Live<A>): void {
    const outstanding = [...live.queue.keys()];
    const next = outstanding.length > 0 ? Math.min(...outstanding) - 1 : live.scannedThrough;
    if (next > live.record.watermark) {
      live.record.watermark = next;
      live.dirty = true;
    }
  }

  private send(live: Live<A>, pending: Pending): void {
    pending.sending = true;
    const record = live.record;
    const cursor = encodeCursor(record.watermark);
    const body =
      pending.envelope.kind === 'event'
        ? JSON.stringify({
            eventId: pending.envelope.event.eventId,
            name: record.name,
            timestamp: pending.envelope.event.timestamp,
            data: pending.envelope.event.data,
            cursor,
          })
        : JSON.stringify({ type: 'gap', cursor: encodeCursor(this.gapCursor(live, pending.seq)) });
    const headers = this.headers(
      record.id,
      signingKeys(record, this.clock()),
      { id: pending.webhookId },
      body
    );
    const attempt = this.transport
      .post(record.url, { ...accessHeadersFor(this.access ?? null, record.url), ...headers }, body)
      .then(
        (res) => this.settled(live, pending, res.status, statusCategory(res.status)),
        (err: unknown) =>
          this.settled(
            live,
            pending,
            null,
            err instanceof DeliveryFailure ? err.category : 'connection_refused'
          )
      )
      .finally(() => {
        pending.sending = false;
        this.sends.delete(attempt);
      });
    this.sends.add(attempt);
  }

  private settled(
    live: Live<A>,
    pending: Pending,
    status: number | null,
    failure: DeliveryErrorCategory | null
  ): void {
    const now = this.clock();
    const record = live.record;
    if (this.live.get(record.id) !== live) return; // unsubscribed or lost the lease meanwhile
    if (failure === null) {
      live.queue.delete(pending.seq);
      live.lastContactAt = now;
      record.lastDeliveryAt = now;
      record.lastError = null;
      record.failedSince = null;
      live.dirty = true;
      this.advance(live);
      return;
    }
    live.dirty = true;
    if (status === 410 || status === 413) {
      // The receiver does not want this one, and said so: it answered, so the
      // endpoint is healthy, and an earlier error is cleared as a 2xx clears
      // it — a receiver reads a non-null `lastError` on a refresh as an
      // unhealthy subscription.
      live.queue.delete(pending.seq);
      live.lastContactAt = now;
      record.lastError = null;
      record.failedSince = null;
      this.advance(live);
      return;
    }
    record.lastError = failure;
    record.failedSince ??= now;
    pending.attempts++;
    if (pending.attempts < MAX_ATTEMPTS) {
      pending.nextAt = now + RETRY_DELAYS_MS[pending.attempts - 1]!;
      return;
    }
    if (live.lastContactAt !== null && live.lastContactAt >= pending.firstAt) {
      // The endpoint is up and has refused this event five times: give it up.
      live.queue.delete(pending.seq);
      this.advance(live);
      return;
    }
    // Five attempts and not one answer from the endpoint: suspend, keep everything.
    record.active = false;
    record.suspendedAt = now;
    this.warn(`webhook subscription ${record.id} suspended after sustained delivery failure (${failure})`);
  }

  private async persist(): Promise<void> {
    const now = this.clock();
    this.lastPersistAt = now;
    // Cleared BEFORE the snapshot: a POST that settles while the write is in
    // flight marks its subscription dirty again, and is written next time.
    const wasDirty = this.registryDirty;
    this.registryDirty = false;
    const dirty = [...this.live.values()].filter((l) => l.dirty);
    for (const l of dirty) l.dirty = false;
    const snapshot = new Map([...this.live].map(([id, l]) => [id, structuredClone(l.record)]));
    try {
      await updateRegistry(this.store, (doc) => {
        const at = this.clock();
        doc.subscriptions = doc.subscriptions.filter((s) => s.refreshBefore > at);
        doc.verified = doc.verified.filter((v) => v.until > at);
        for (const s of doc.subscriptions) {
          const mine = snapshot.get(s.id);
          // Not this process's record, or a different subscription under the same id.
          if (!mine || mine.createdAt !== s.createdAt) continue;
          s.watermark = Math.max(s.watermark, mine.watermark);
          s.lastDeliveryAt = mine.lastDeliveryAt;
          s.lastError = mine.lastError;
          // A suspension stands only if it is newer than the last refresh,
          // which may have been written by another process since this one read.
          const suspended =
            !mine.active && (mine.suspendedAt ?? 0) > (s.refreshedAt ?? 0);
          s.active = !suspended;
          s.suspendedAt = suspended ? mine.suspendedAt : null;
          s.failedSince = suspended || mine.active ? mine.failedSince : null;
        }
      });
    } catch (err) {
      this.registryDirty ||= wasDirty;
      for (const l of dirty) l.dirty = true;
      this.warn(`webhook registry write failed: ${errText(err)}`);
    }
  }

  // --- status ----------------------------------------------------------------------

  /** For a status tool. No URL path, no secret: the host is enough to recognise one. */
  status(): Record<string, unknown>[] {
    return [...this.live.values()].map((l) => ({
      id: l.record.id,
      name: l.record.name,
      host: safeHost(l.record.url),
      active: l.record.active,
      refresh_before: iso(l.record.refreshBefore),
      last_delivery_at: iso(l.record.lastDeliveryAt),
      last_error: l.record.lastError,
      failed_since: iso(l.record.failedSince),
      in_flight: l.queue.size,
      cursor: encodeCursor(l.record.watermark),
    }));
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
