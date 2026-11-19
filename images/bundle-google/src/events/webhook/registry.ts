// GENERATED — DO NOT EDIT.
// Vendored from servers/bundle-api/fork/slack/src/events/webhook by `npm run eventswebhook:sync`.
// Edit the source, run the sync, and commit both. CI fails if these drift.
/**
 * Webhook subscriptions, as persisted: one sealed document in this ingest's
 * folder of strad's state store, `{prefix}/webhooks.bin`.
 *
 * WHY PERSISTED. Draft SEP-3415 lets a server that grants short TTLs keep
 * subscriptions in memory and rely on the client's next refresh after a
 * restart. Here a deploy restarts the container that delivers, and the gap
 * until the next refresh is a gap in delivery. So the subscriptions, their
 * secrets, their verification and their delivery watermark survive a restart,
 * and the new container resumes delivering from the watermark on its own.
 *
 * ANY PROCESS MAY WRITE IT. A subscribe can land on a container that does not
 * hold the lease (a deploy overlap), so every change is a read-modify-write
 * conditional on the generation it read, retried on a race. Only the lease
 * holder DELIVERS; it re-reads the document to learn of subscriptions made
 * elsewhere.
 *
 * THE SECRETS ARE IN HERE. Sealed under this ingest's own key like the buffer,
 * never logged, never returned by any tool or method.
 */
import { createHash } from 'node:crypto';
import { PreconditionFailed } from '../state-store.js';
import type { DeliveryErrorCategory } from './transport.js';

export const REGISTRY_OBJECT = 'webhooks.bin';

/** The grant when the client suggests nothing. */
export const DEFAULT_TTL_MS = 60 * 60_000;
/** The floor: a shorter suggestion is clamped up, to keep refresh traffic sane. */
export const MIN_TTL_MS = 60_000;
/** The ceiling, and what `ttlMs: null` (no expiry) is granted instead. */
export const MAX_TTL_MS = 24 * 60 * 60_000;
/** How long a rotated-out secret keeps signing beside its replacement. */
export const SECRET_GRACE_MS = 10 * 60_000;
/** How long a verified `(principal, url)` stays verified with no subscription using it. */
export const VERIFIED_TTL_MS = MAX_TTL_MS;

export interface SubscriptionRecord {
  /** `sub_` + 32 hex: SHA-256 over the key. Stable across refreshes and restarts. */
  id: string;
  principal: string;
  url: string;
  /** The event name as the SUBSCRIBER knows it — strad's namespaced name. */
  name: string;
  /** The upstream event type this is a subscription to, e.g. `message_posted`. */
  eventType: string;
  arguments: Record<string, unknown>;
  /** base64 of the key bytes, current first. */
  secrets: string[];
  /** Epoch ms after which `secrets[1..]` stop signing. */
  previousSecretUntil: number | null;
  /** Epoch ms the grant expires. */
  refreshBefore: number;
  createdAt: number;
  /** Every buffered event at or below this sequence is acknowledged or abandoned. */
  watermark: number;
  /** Events older than this (epoch ms) are not delivered: the subscribe's `maxAgeMs` floor. */
  notBefore: number | null;
  active: boolean;
  /**
   * Epoch ms of the last refresh, on whichever process it landed. A refresh
   * newer than `suspendedAt` reactivates; one older does not. Times rather
   * than a flag, because the refresh and the suspension are written by
   * different processes and either can be the one not yet persisted.
   */
  refreshedAt: number | null;
  /** Epoch ms the lease holder suspended delivery, or null while active. */
  suspendedAt: number | null;
  lastDeliveryAt: number | null;
  lastError: DeliveryErrorCategory | null;
  failedSince: number | null;
}

export interface VerifiedEndpoint {
  principal: string;
  url: string;
  verifiedAt: number;
  /** Refreshed by every subscribe that relies on it. */
  until: number;
}

export interface RegistryDoc {
  version: 1;
  subscriptions: SubscriptionRecord[];
  verified: VerifiedEndpoint[];
}

export const emptyRegistry = (): RegistryDoc => ({ version: 1, subscriptions: [], verified: [] });

/** JSON with every object's keys sorted, so equal arguments serialise equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The subscription key, `(principal, delivery.url, name, arguments)`, serialised. */
export function subscriptionKey(
  principal: string,
  url: string,
  name: string,
  args: Record<string, unknown>
): string {
  return canonicalJson([principal, url, name, args]);
}

/** The routing handle: deterministic over the key, and not a capability. */
export function subscriptionId(key: string): string {
  return `sub_${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * The grant. Omitted: the default. Shorter than the floor: the floor. Longer
 * than a day, or `null` (no expiry): a day. The draft lets a server decline
 * no-expiry by answering with a finite `refreshBefore`, and this one does —
 * a subscriber that stops refreshing is collected within a day.
 */
export function grantTtl(suggested: unknown): number {
  if (suggested === undefined) return DEFAULT_TTL_MS;
  if (suggested === null) return MAX_TTL_MS;
  if (typeof suggested !== 'number' || !Number.isFinite(suggested)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(suggested)));
}

export function keyOf(r: Pick<SubscriptionRecord, 'principal' | 'url' | 'name' | 'arguments'>): string {
  return subscriptionKey(r.principal, r.url, r.name, r.arguments);
}

/** The signing keys in force at `now`: the current secret, and the previous one inside its grace. */
export function signingKeys(r: SubscriptionRecord, now: number): Buffer[] {
  const keys = r.secrets.map((s) => Buffer.from(s, 'base64'));
  if (r.previousSecretUntil === null || now > r.previousSecretUntil) return keys.slice(0, 1);
  return keys;
}

export interface RegistryStore {
  readDoc<T>(suffix: string): Promise<{ doc: T | null; generation: string | null }>;
  writeDoc(suffix: string, doc: unknown, ifGeneration: string | null): Promise<string>;
}

const MAX_CAS_TRIES = 6;

/**
 * Read, change, write conditionally; on a race, read again and re-apply.
 * `change` may run more than once and must be a pure function of the doc it
 * is given. Returns what its last run returned.
 */
export async function updateRegistry<T>(
  store: RegistryStore,
  change: (doc: RegistryDoc) => T
): Promise<{ result: T; doc: RegistryDoc }> {
  for (let attempt = 1; ; attempt++) {
    const { doc, generation } = await store.readDoc<RegistryDoc>(REGISTRY_OBJECT);
    const working: RegistryDoc =
      doc && doc.version === 1 ? structuredClone(doc) : emptyRegistry();
    const result = change(working);
    try {
      await store.writeDoc(REGISTRY_OBJECT, working, generation);
      return { result, doc: working };
    } catch (err) {
      if (!(err instanceof PreconditionFailed) || attempt >= MAX_CAS_TRIES) throw err;
    }
  }
}

export async function readRegistry(store: RegistryStore): Promise<RegistryDoc> {
  const { doc } = await store.readDoc<RegistryDoc>(REGISTRY_OBJECT);
  return doc && doc.version === 1 ? doc : emptyRegistry();
}
