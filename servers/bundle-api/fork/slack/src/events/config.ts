/**
 * What the events ingest needs from the environment, and the answer when part
 * of it is missing.
 *
 * ABSENT IS A SUPPORTED STATE. Every container that runs this tree mounts
 * `/slack`, and only the one whose slug was given an app-level token opens a
 * socket. Everywhere else — and on `slack-zimmer` until the token is seeded —
 * the mount lists no event types, advertises no events extension, and the
 * existing tools behave exactly as they did before this existed.
 *
 * WHERE THE BUFFER LIVES is strad's shared state store (`state-store.ts`): the
 * deployment's one bucket and service account, `STRAD_STATE_GCS_*`. What is
 * this ingest's own is its folder in that bucket (`slack-events`, or a folder
 * under it) and its own key. The key is never shared with another consumer:
 * with one bucket credential, a consumer's key is all that keeps its objects
 * from every other container that holds the credential.
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
} from './state-store.js';

export const EVENTS_ENV = {
  /** The Slack app-level token (`xapp-…`), scope `connections:write`. Opens Socket Mode. */
  appToken: 'SLACK_APP_TOKEN',
  /** The bot token every other tool already uses. Backfill and `auth.test` run on it. */
  botToken: 'SLACK_BOT_TOKEN',
  /** 32 random bytes, base64 or hex. Seals the buffer. This ingest's own. */
  encryptionKey: 'SLACK_EVENTS_STATE_ENCRYPTION_KEY',
  /** Optional. This ingest's folder in the shared state bucket. Default `slack-events`. */
  prefix: 'SLACK_EVENTS_STATE_PREFIX',
  /** Optional. Days an event is kept. Default 7. */
  retentionDays: 'SLACK_EVENTS_RETENTION_DAYS',
  /**
   * Optional. Comma-separated URL prefixes — `https://zimmer.tadasant.com/webhooks/mcp_events/`
   * — whose webhook requests carry the Cloudflare Access service token below.
   * A host AND a path: the token goes only to a callback URL under one of
   * them, never elsewhere on the same host.
   */
  webhookAccessPrefixes: 'SLACK_EVENTS_WEBHOOK_ACCESS_PREFIXES',
  /**
   * Optional, with the prefixes. strad's Access service token for them —
   * the same token, under the same names, a deployment already seeds per slug
   * for strad's confirmation calls to Zimmer (`confirmationHeaders:`).
   */
  webhookAccessClientId: 'ZIMMER_APPROVAL_CF_ACCESS_CLIENT_ID',
  webhookAccessClientSecret: 'ZIMMER_APPROVAL_CF_ACCESS_CLIENT_SECRET',
} as const;

/** Without these, there is no ingest at all. Declaration order is report order. */
export const REQUIRED_EVENTS_ENV = [
  EVENTS_ENV.appToken,
  EVENTS_ENV.botToken,
  EVENTS_ENV.encryptionKey,
  STATE_STORE_ENV.bucket,
  STATE_STORE_ENV.clientEmail,
  STATE_STORE_ENV.privateKey,
] as const;

/** This ingest's top-level folder in the shared bucket, and the default prefix. */
export const STATE_ROOT = 'slack-events';
export const DEFAULT_PREFIX = STATE_ROOT;
export const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 30;

export interface EventsConfig {
  appToken: string;
  botToken: string;
  /** Exactly 32 bytes. */
  encryptionKey: Buffer;
  bucket: string;
  clientEmail: string;
  privateKey: string;
  /** No leading or trailing slash. */
  prefix: string;
  retentionDays: number;
  /** Extra headers for requests under these URL prefixes, and no other. Null: none. */
  webhookAccess: WebhookAccess | null;
  /**
   * Why `webhookAccess` is null when its variables are only partly set. Not a
   * config error: polling, and webhooks to every other host, still work.
   */
  webhookAccessProblem: string | null;
}

export interface WebhookAccess {
  /** Lowercase hostname (default https port only) and a path ending in `/`. */
  prefixes: { host: string; path: string }[];
  headers: Record<string, string>;
}

export class EventsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventsConfigError';
  }
}

const read = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
};

/** The required variables this environment is missing, in declaration order. */
export function missingEventsEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const own = [EVENTS_ENV.appToken, EVENTS_ENV.botToken, EVENTS_ENV.encryptionKey].filter(
    (name) => read(env, name) === undefined
  );
  return [...own, ...missingStateStoreEnv(env)];
}

/** The shared module's refusal, as this ingest's own error type. */
function asConfigError<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    if (err instanceof StateStoreConfigError) throw new EventsConfigError(err.message);
    throw err;
  }
}

/**
 * The key, from base64 (standard or url-safe) or hex. Anything that does not
 * decode to exactly 32 bytes is refused — and the value is never quoted.
 */
export function parseEncryptionKey(raw: string): Buffer {
  return asConfigError(() => parseStateKey(raw, EVENTS_ENV.encryptionKey));
}

export function loadEventsConfig(env: NodeJS.ProcessEnv = process.env): EventsConfig {
  const missing = missingEventsEnv(env);
  if (missing.length > 0) {
    throw new EventsConfigError(notConfiguredMessage(missing));
  }
  const appToken = read(env, EVENTS_ENV.appToken)!;
  if (!appToken.startsWith('xapp-')) {
    throw new EventsConfigError(
      `${EVENTS_ENV.appToken} is set but is not an app-level token (they start ` +
        '`xapp-`). Generate one under the Slack app\'s Basic Information > App-Level ' +
        'Tokens with the `connections:write` scope.'
    );
  }
  const rawDays = read(env, EVENTS_ENV.retentionDays);
  let retentionDays = DEFAULT_RETENTION_DAYS;
  if (rawDays !== undefined) {
    const parsed = Number(rawDays);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RETENTION_DAYS) {
      throw new EventsConfigError(
        `${EVENTS_ENV.retentionDays}="${rawDays}" must be a whole number between 1 and ` +
          `${MAX_RETENTION_DAYS}.`
      );
    }
    retentionDays = parsed;
  }
  const prefix = asConfigError(() =>
    namespacePrefix(env, { variable: EVENTS_ENV.prefix, root: STATE_ROOT })
  );
  const store = asConfigError(() => readStateStoreEnv(env));
  let webhookAccess: WebhookAccess | null = null;
  let webhookAccessProblem: string | null = null;
  try {
    webhookAccess = readWebhookAccess(env);
  } catch (err) {
    webhookAccessProblem = err instanceof Error ? err.message : String(err);
  }
  return {
    appToken,
    botToken: read(env, EVENTS_ENV.botToken)!,
    encryptionKey: parseEncryptionKey(read(env, EVENTS_ENV.encryptionKey)!),
    bucket: store.bucket,
    clientEmail: store.clientEmail,
    privateKey: store.privateKey,
    prefix,
    retentionDays,
    webhookAccess,
    webhookAccessProblem,
  };
}

/**
 * The Cloudflare Access service token for the callback URLs that sit behind
 * Access (Zimmer's receiver does). Read from strad's own configuration, never
 * from a subscribe request, and attached only to a request whose URL is under
 * a configured prefix — a host AND a path. A subscriber picks its URL, so a
 * token sent to any URL is a token handed to whoever subscribes; a token sent
 * to any PATH on the host lets a subscriber present it to whatever else that
 * host's edge admits it to. All three variables or none.
 */
export function readWebhookAccess(env: NodeJS.ProcessEnv): WebhookAccess | null {
  const prefixes = read(env, EVENTS_ENV.webhookAccessPrefixes);
  const id = read(env, EVENTS_ENV.webhookAccessClientId);
  const secret = read(env, EVENTS_ENV.webhookAccessClientSecret);
  if (prefixes === undefined && id === undefined && secret === undefined) return null;
  const missing = ([
    prefixes === undefined ? EVENTS_ENV.webhookAccessPrefixes : null,
    id === undefined ? EVENTS_ENV.webhookAccessClientId : null,
    secret === undefined ? EVENTS_ENV.webhookAccessClientSecret : null,
  ] as (string | null)[]).filter((n): n is string => n !== null);
  if (missing.length > 0) {
    throw new EventsConfigError(
      `Webhook Access headers need all three variables; ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set.`
    );
  }
  const list = prefixes!
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((raw) => {
      let url: URL | undefined;
      try {
        url = new URL(raw);
      } catch {
        url = undefined;
      }
      const ok =
        url !== undefined &&
        url.protocol === 'https:' &&
        (url.port === '' || url.port === '443') &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.length > 1 &&
        url.pathname.endsWith('/') &&
        url.href === raw.replace(/:443\//, '/');
      if (!ok) {
        throw new EventsConfigError(
          `${EVENTS_ENV.webhookAccessPrefixes} must be https URL prefixes with a path ending in "/", ` +
            `comma-separated (https://zimmer.tadasant.com/webhooks/mcp_events/); "${raw}" is not one.`
        );
      }
      return { host: url!.hostname.toLowerCase(), path: url!.pathname };
    });
  return {
    prefixes: list,
    headers: { 'CF-Access-Client-Id': id!, 'CF-Access-Client-Secret': secret! },
  };
}

export function notConfiguredMessage(missing: readonly string[]): string {
  return (
    `Slack events are not configured on this deployment: ${missing.join(', ')} ` +
    `${missing.length === 1 ? 'is' : 'are'} not set. ${EVENTS_ENV.appToken} is the Slack ` +
    `app-level token (\`xapp-…\`, scope \`connections:write\`) that opens Socket Mode; the ` +
    `${EVENTS_ENV.encryptionKey} seals the 7-day event buffer, which is kept in strad's ` +
    `shared state store (${STATE_STORE_ENV.bucket}, ${STATE_STORE_ENV.clientEmail}, ` +
    `${STATE_STORE_ENV.privateKey}). Seed them in strad's console (/ui/secrets). ` +
    `Every other Slack tool works without them.`
  );
}
