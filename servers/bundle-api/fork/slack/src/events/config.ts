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
 * Nothing here is ever logged, echoed or returned by a tool except the NAMES of
 * the variables that are missing.
 */

export const EVENTS_ENV = {
  /** The Slack app-level token (`xapp-…`), scope `connections:write`. Opens Socket Mode. */
  appToken: 'SLACK_APP_TOKEN',
  /** The bot token every other tool already uses. Backfill and `auth.test` run on it. */
  botToken: 'SLACK_BOT_TOKEN',
  /** 32 random bytes, base64 or hex. Seals the buffer and the lease's neighbours. */
  encryptionKey: 'SLACK_EVENTS_ENCRYPTION_KEY',
  /** The bucket the sealed ring buffer and the lease live in. */
  bucket: 'SLACK_EVENTS_GCS_BUCKET',
  /** A service account that can read, write and delete objects in it. */
  clientEmail: 'SLACK_EVENTS_GCS_CLIENT_EMAIL',
  privateKey: 'SLACK_EVENTS_GCS_PRIVATE_KEY',
  /** Optional. Object prefix inside the bucket. Default `slack-events`. */
  prefix: 'SLACK_EVENTS_GCS_PREFIX',
  /** Optional. Days an event is kept. Default 7. */
  retentionDays: 'SLACK_EVENTS_RETENTION_DAYS',
} as const;

/** Without these, there is no ingest at all. Declaration order is report order. */
export const REQUIRED_EVENTS_ENV = [
  EVENTS_ENV.appToken,
  EVENTS_ENV.botToken,
  EVENTS_ENV.encryptionKey,
  EVENTS_ENV.bucket,
  EVENTS_ENV.clientEmail,
  EVENTS_ENV.privateKey,
] as const;

export const DEFAULT_PREFIX = 'slack-events';
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
  return REQUIRED_EVENTS_ENV.filter((name) => read(env, name) === undefined);
}

/**
 * The key, from base64 (standard or url-safe) or hex. Anything that does not
 * decode to exactly 32 bytes is refused — and the value is never quoted.
 */
export function parseEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  let key: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex');
  } else if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(value)) {
    key = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  if (!key || key.length !== 32) {
    throw new EventsConfigError(
      `${EVENTS_ENV.encryptionKey} must be exactly 32 bytes, as base64 (44 characters, ` +
        '`openssl rand -base64 32`) or hex (64 characters). The value set is neither.'
    );
  }
  return key;
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
  const prefix = (read(env, EVENTS_ENV.prefix) ?? DEFAULT_PREFIX).replace(/^\/+|\/+$/g, '');
  return {
    appToken,
    botToken: read(env, EVENTS_ENV.botToken)!,
    encryptionKey: parseEncryptionKey(read(env, EVENTS_ENV.encryptionKey)!),
    bucket: read(env, EVENTS_ENV.bucket)!,
    clientEmail: read(env, EVENTS_ENV.clientEmail)!,
    // A PEM pasted into a single-line secret field arrives with literal `\n`s.
    privateKey: read(env, EVENTS_ENV.privateKey)!.replace(/\\n/g, '\n'),
    prefix: prefix || DEFAULT_PREFIX,
    retentionDays,
  };
}

export function notConfiguredMessage(missing: readonly string[]): string {
  return (
    `Slack events are not configured on this deployment: ${missing.join(', ')} ` +
    `${missing.length === 1 ? 'is' : 'are'} not set. ${EVENTS_ENV.appToken} is the Slack ` +
    `app-level token (\`xapp-…\`, scope \`connections:write\`) that opens Socket Mode; the ` +
    `${EVENTS_ENV.encryptionKey} and SLACK_EVENTS_GCS_* variables are where the 7-day ` +
    `event buffer is kept. Seed them in strad's console (/ui/secrets) for this slug. ` +
    `Every other Slack tool works without them.`
  );
}
