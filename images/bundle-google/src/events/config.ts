/**
 * What the Gmail `message_received` ingest needs from the environment.
 *
 * ABSENT IS A SUPPORTED STATE, and the usual one. Every gmail mount on a bundle
 * runs this code, and only a mount whose OWN slug was given
 * `GMAIL_EVENTS_STATE_ENCRYPTION_KEY` starts an ingest. Every other mount lists
 * no event types, advertises no events extension, and calls Gmail exactly as
 * it did before this existed.
 *
 * PER MOUNT, NOT PER CONTAINER. The `GMAIL_EVENTS_*` names in
 * {@link GMAIL_EVENTS_OWN_ENV_NAMES} are read only under the mount's own slug
 * (the bundle host's `ownNameOnly`), never the bare name. The renderer puts every
 * slug's `env:` on the bare name too, so a bare fallback would start an ingest
 * on every gmail mount in the bundle, each watching its own mailbox, the moment
 * one slug was configured. The three `STRAD_STATE_GCS_*` are the deployment's
 * shared state store and are read the ordinary way.
 *
 * TWO WAYS TO HEAR ABOUT NEW MAIL, chosen by whether the Pub/Sub pair is set:
 *
 *   - PUSH: `GMAIL_EVENTS_PUBSUB_TOPIC` and `GMAIL_EVENTS_PUBSUB_SUBSCRIPTION`.
 *     The mount calls Gmail's `users.watch` on the topic and long-polls the
 *     subscription, so a new message is read seconds after Gmail publishes the
 *     notification. `history.list` still runs every minute as the catch-up for
 *     a notification Gmail delayed or dropped.
 *   - POLL: neither set. `history.list` every 15 seconds.
 *
 * Nothing here is ever logged, echoed or returned by a tool except the NAMES of
 * the variables that are missing.
 */
import {
  missingStateStoreEnv,
  namespacePrefix,
  parseStateKey,
  readStateStoreEnv,
  STATE_STORE_ENV,
  StateStoreConfigError,
} from "./state-store.js";

export type EnvLike = Readonly<Record<string, string | undefined>>;

export const GMAIL_EVENTS_ENV = {
  /** 32 random bytes, base64 or hex. Seals the buffer. This mount's own. */
  encryptionKey: "GMAIL_EVENTS_STATE_ENCRYPTION_KEY",
  /** Optional. This mount's folder in the shared state bucket. Default `gmail-events/<slug>`. */
  prefix: "GMAIL_EVENTS_STATE_PREFIX",
  /** Optional. Days an event is kept. Default 7. */
  retentionDays: "GMAIL_EVENTS_RETENTION_DAYS",
  /**
   * Optional, with the subscription. `projects/<project>/topics/<topic>`, in the
   * Google Cloud project that owns the mailbox's OAuth client: Gmail refuses a
   * watch on a topic in any other project.
   */
  pubsubTopic: "GMAIL_EVENTS_PUBSUB_TOPIC",
  /** Optional, with the topic. `projects/<project>/subscriptions/<name>`, a PULL subscription on it. */
  pubsubSubscription: "GMAIL_EVENTS_PUBSUB_SUBSCRIPTION",
  /** Optional. Comma-separated `https` URL prefixes whose webhook requests carry the Access token below. */
  webhookAccessPrefixes: "GMAIL_EVENTS_WEBHOOK_ACCESS_PREFIXES",
  /** Optional, with the prefixes: strad's Cloudflare Access service token for Zimmer's edge. */
  webhookAccessClientId: "ZIMMER_APPROVAL_CF_ACCESS_CLIENT_ID",
  webhookAccessClientSecret: "ZIMMER_APPROVAL_CF_ACCESS_CLIENT_SECRET",
} as const;

/**
 * The names a mount reads under its own slug only. Everything that switches an
 * ingest on, points it somewhere, or widens where its webhooks carry a token.
 */
export const GMAIL_EVENTS_OWN_ENV_NAMES = [
  GMAIL_EVENTS_ENV.encryptionKey,
  GMAIL_EVENTS_ENV.prefix,
  GMAIL_EVENTS_ENV.retentionDays,
  GMAIL_EVENTS_ENV.pubsubTopic,
  GMAIL_EVENTS_ENV.pubsubSubscription,
  GMAIL_EVENTS_ENV.webhookAccessPrefixes,
] as const;

/** This ingest's top-level folder in the shared bucket. */
export const STATE_ROOT = "gmail-events";
export const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 30;

const TOPIC = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~%+-]{2,254}$/;
const SUBSCRIPTION =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/subscriptions\/[A-Za-z][A-Za-z0-9._~%+-]{2,254}$/;

export interface PushConfig {
  topic: string;
  subscription: string;
}

export interface WebhookAccess {
  prefixes: { host: string; path: string }[];
  headers: Record<string, string>;
}

export interface GmailEventsConfig {
  /** Exactly 32 bytes. */
  encryptionKey: Buffer;
  bucket: string;
  /** The state store's service account. Also what pulls the Pub/Sub subscription. */
  clientEmail: string;
  privateKey: string;
  /** No leading or trailing slash. */
  prefix: string;
  retentionDays: number;
  /** Null: no Pub/Sub, `history.list` polling only. */
  push: PushConfig | null;
  /** Why `push` is null although part of it is set. Not fatal: polling still runs. */
  pushProblem: string | null;
  webhookAccess: WebhookAccess | null;
  webhookAccessProblem: string | null;
}

export class GmailEventsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailEventsConfigError";
  }
}

const read = (env: EnvLike, name: string): string | undefined => {
  const value = env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
};

/** True when this mount was asked to serve events at all: its own key is set. */
export function eventsRequested(env: EnvLike): boolean {
  return read(env, GMAIL_EVENTS_ENV.encryptionKey) !== undefined;
}

/** The required variables this environment lacks, in report order. */
export function missingEventsEnv(env: EnvLike): string[] {
  const own = read(env, GMAIL_EVENTS_ENV.encryptionKey) === undefined ? [GMAIL_EVENTS_ENV.encryptionKey] : [];
  return [...own, ...missingStateStoreEnv(env)];
}

function asConfigError<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    if (err instanceof StateStoreConfigError) throw new GmailEventsConfigError(err.message);
    throw err;
  }
}

/**
 * `slug` names the default folder, `gmail-events/<slug>`: two mounts that each
 * serve events (two mailboxes) must never share a buffer, and the slug is
 * already unique.
 */
export function loadEventsConfig(env: EnvLike, slug: string | undefined): GmailEventsConfig {
  const missing = missingEventsEnv(env);
  if (missing.length > 0) throw new GmailEventsConfigError(notConfiguredMessage(missing));

  const rawDays = read(env, GMAIL_EVENTS_ENV.retentionDays);
  let retentionDays = DEFAULT_RETENTION_DAYS;
  if (rawDays !== undefined) {
    const parsed = Number(rawDays);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RETENTION_DAYS) {
      throw new GmailEventsConfigError(
        `${GMAIL_EVENTS_ENV.retentionDays}="${rawDays}" must be a whole number between 1 and ${MAX_RETENTION_DAYS}.`,
      );
    }
    retentionDays = parsed;
  }
  const withDefault =
    read(env, GMAIL_EVENTS_ENV.prefix) === undefined && slug
      ? { ...env, [GMAIL_EVENTS_ENV.prefix]: `${STATE_ROOT}/${slug}` }
      : env;
  const prefix = asConfigError(() =>
    namespacePrefix(withDefault, { variable: GMAIL_EVENTS_ENV.prefix, root: STATE_ROOT }),
  );
  const store = asConfigError(() => readStateStoreEnv(env));
  const key = asConfigError(() =>
    parseStateKey(read(env, GMAIL_EVENTS_ENV.encryptionKey)!, GMAIL_EVENTS_ENV.encryptionKey),
  );

  let push: PushConfig | null = null;
  let pushProblem: string | null = null;
  try {
    push = readPush(env);
  } catch (err) {
    pushProblem = err instanceof Error ? err.message : String(err);
  }
  let webhookAccess: WebhookAccess | null = null;
  let webhookAccessProblem: string | null = null;
  try {
    webhookAccess = readWebhookAccess(env);
  } catch (err) {
    webhookAccessProblem = err instanceof Error ? err.message : String(err);
  }
  return {
    encryptionKey: key,
    bucket: store.bucket,
    clientEmail: store.clientEmail,
    privateKey: store.privateKey,
    prefix,
    retentionDays,
    push,
    pushProblem,
    webhookAccess,
    webhookAccessProblem,
  };
}

/** Both or neither. A malformed one is refused by name; its value is not secret, and is quoted. */
export function readPush(env: EnvLike): PushConfig | null {
  const topic = read(env, GMAIL_EVENTS_ENV.pubsubTopic);
  const subscription = read(env, GMAIL_EVENTS_ENV.pubsubSubscription);
  if (topic === undefined && subscription === undefined) return null;
  if (topic === undefined || subscription === undefined) {
    throw new GmailEventsConfigError(
      `Gmail push needs both ${GMAIL_EVENTS_ENV.pubsubTopic} and ${GMAIL_EVENTS_ENV.pubsubSubscription}; ` +
        `${topic === undefined ? GMAIL_EVENTS_ENV.pubsubTopic : GMAIL_EVENTS_ENV.pubsubSubscription} is not set. ` +
        "Polling history.list every 15 seconds instead.",
    );
  }
  if (!TOPIC.test(topic)) {
    throw new GmailEventsConfigError(
      `${GMAIL_EVENTS_ENV.pubsubTopic}="${topic}" is not a topic name (projects/<project>/topics/<topic>). ` +
        "Polling history.list every 15 seconds instead.",
    );
  }
  if (!SUBSCRIPTION.test(subscription)) {
    throw new GmailEventsConfigError(
      `${GMAIL_EVENTS_ENV.pubsubSubscription}="${subscription}" is not a subscription name ` +
        "(projects/<project>/subscriptions/<name>). Polling history.list every 15 seconds instead.",
    );
  }
  return { topic, subscription };
}

/**
 * The Cloudflare Access service token for callback URLs behind Access, and
 * the URL prefixes it may be sent to: a host AND a path, over https on the
 * default port. All three variables or none. Slack's ingest reads the same
 * rule from its own prefixes variable (`fork/slack/src/events/config.ts`).
 */
export function readWebhookAccess(env: EnvLike): WebhookAccess | null {
  const prefixes = read(env, GMAIL_EVENTS_ENV.webhookAccessPrefixes);
  // The token is only looked at once a prefix asks for it: without one, a
  // mount that merely holds the confirmation-header token is not misconfigured.
  if (prefixes === undefined) return null;
  const id = read(env, GMAIL_EVENTS_ENV.webhookAccessClientId);
  const secret = read(env, GMAIL_EVENTS_ENV.webhookAccessClientSecret);
  const missing = ([
    id === undefined ? GMAIL_EVENTS_ENV.webhookAccessClientId : null,
    secret === undefined ? GMAIL_EVENTS_ENV.webhookAccessClientSecret : null,
  ] as (string | null)[]).filter((n): n is string => n !== null);
  if (missing.length > 0) {
    throw new GmailEventsConfigError(
      `Webhook Access headers need all three variables; ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set.`,
    );
  }
  const list = prefixes
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((raw) => {
      let url: URL | undefined;
      try {
        url = new URL(raw);
      } catch {
        url = undefined;
      }
      const ok =
        url !== undefined &&
        url.protocol === "https:" &&
        (url.port === "" || url.port === "443") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.length > 1 &&
        url.pathname.endsWith("/") &&
        url.href === raw.replace(/:443\//, "/");
      if (!ok) {
        throw new GmailEventsConfigError(
          `${GMAIL_EVENTS_ENV.webhookAccessPrefixes} must be https URL prefixes with a path ending in "/", ` +
            `comma-separated (https://zimmer.tadasant.com/webhooks/mcp_events/); "${raw}" is not one.`,
        );
      }
      return { host: url!.hostname.toLowerCase(), path: url!.pathname };
    });
  return {
    prefixes: list,
    headers: { "CF-Access-Client-Id": id!, "CF-Access-Client-Secret": secret! },
  };
}

export function notConfiguredMessage(missing: readonly string[]): string {
  return (
    `Gmail events are not configured on this mount: ${missing.join(", ")} ` +
    `${missing.length === 1 ? "is" : "are"} not set. ${GMAIL_EVENTS_ENV.encryptionKey}, ` +
    "this slug's own, seals the 7-day event buffer, which is kept in strad's shared state store " +
    `(${STATE_STORE_ENV.bucket}, ${STATE_STORE_ENV.clientEmail}, ${STATE_STORE_ENV.privateKey}). ` +
    "Every gmail tool works without them."
  );
}
