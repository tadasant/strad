/**
 * The environment this server runs on, and the error a human gets when part of
 * it is missing.
 *
 * WHY THERE IS NO CREDENTIAL FOR WHATSAPP ITSELF. A linked device has no token
 * to inject: its credential is the Signal state it mints while pairing, and that
 * state changes on nearly every message. So nothing here is "the WhatsApp
 * login". What strad injects is where that state lives (a GCS bucket and a
 * service account that can write it) and the key it is sealed with. The login
 * is made by `whatsapp_pair`, through strad, with no shell on the container.
 *
 * THE ENCRYPTION KEY AND THE STATE ARE, TOGETHER, THE ACCOUNT. Whoever holds
 * both reads every chat the paired account is in and posts as it. Neither is
 * ever logged, echoed in an error, or returned by a tool.
 */

export const ENV = {
  /** 32 random bytes, base64 or hex. Seals every object this server writes. */
  encryptionKey: "WHATSAPP_STATE_ENCRYPTION_KEY",
  /** The bucket the sealed state and message buffer live in. */
  bucket: "WHATSAPP_GCS_BUCKET",
  /** A service account that can read, write and delete objects in it. */
  clientEmail: "WHATSAPP_GCS_CLIENT_EMAIL",
  privateKey: "WHATSAPP_GCS_PRIVATE_KEY",
  /** Optional. Object prefix inside the bucket. Default `whatsapp`. */
  prefix: "WHATSAPP_GCS_PREFIX",
  /** Optional. Messages kept per chat. Default 1000. */
  bufferMaxMessages: "WHATSAPP_BUFFER_MAX_MESSAGES",
  /** Optional. Days a message is kept. Default 30. */
  bufferMaxAgeDays: "WHATSAPP_BUFFER_MAX_AGE_DAYS",
} as const;

/** The variables without which this server cannot hold a login at all. */
export const REQUIRED_ENV_NAMES = [
  ENV.encryptionKey,
  ENV.bucket,
  ENV.clientEmail,
  ENV.privateKey,
] as const;

export const DEFAULT_PREFIX = "whatsapp";
export const DEFAULT_BUFFER_MAX_MESSAGES = 1000;
export const DEFAULT_BUFFER_MAX_AGE_DAYS = 30;

export interface WhatsAppConfig {
  /** Exactly 32 bytes. */
  encryptionKey: Buffer;
  bucket: string;
  clientEmail: string;
  privateKey: string;
  /** No leading or trailing slash. */
  prefix: string;
  bufferMaxMessages: number;
  bufferMaxAgeDays: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const HOW_TO_SET_THEM =
  `Set them in strad's console (/ui/secrets) for this server: ` +
  `${ENV.encryptionKey} is 32 random bytes (\`openssl rand -base64 32\`), ` +
  `${ENV.bucket} a private GCS bucket, and ${ENV.clientEmail} / ` +
  `${ENV.privateKey} a service account holding roles/storage.objectAdmin on ` +
  `that bucket. See servers/whatsapp/README.md.`;

const read = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
};

/** The required variables this deployment is missing, in declaration order. */
export function missingCredentials(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return REQUIRED_ENV_NAMES.filter((name) => read(env, name) === undefined);
}

/**
 * The key, from base64 (standard or url-safe) or hex. Anything that does not
 * decode to exactly 32 bytes is refused: a short key would still "work", and
 * AES-256 with 16 bytes of key is not AES-256.
 */
export function parseEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  let key: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(value)) {
    key = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  }
  if (!key || key.length !== 32) {
    // The value is NEVER quoted: it is the key.
    throw new ConfigError(
      `${ENV.encryptionKey} must be exactly 32 bytes, as base64 (44 characters, ` +
        `\`openssl rand -base64 32\`) or hex (64 characters). The value set is ` +
        `neither.`,
    );
  }
  return key;
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ConfigError(
      `${name}="${raw}" must be a whole number between 1 and ${max}.`,
    );
  }
  return parsed;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppConfig {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new ConfigError(
      `WhatsApp is not configured: ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } not set. ${HOW_TO_SET_THEM}`,
    );
  }

  const prefix = (read(env, ENV.prefix) ?? DEFAULT_PREFIX).replace(
    /^\/+|\/+$/g,
    "",
  );
  if (prefix === "") {
    throw new ConfigError(
      `${ENV.prefix} must name a folder, not the bucket root: logout deletes ` +
        `everything under it.`,
    );
  }

  return {
    encryptionKey: parseEncryptionKey(read(env, ENV.encryptionKey)!),
    bucket: read(env, ENV.bucket)!,
    clientEmail: read(env, ENV.clientEmail)!,
    // App Platform env vars carry a PEM with escaped newlines.
    privateKey: read(env, ENV.privateKey)!.replace(/\\n/g, "\n"),
    prefix,
    bufferMaxMessages: positiveInt(
      env,
      ENV.bufferMaxMessages,
      DEFAULT_BUFFER_MAX_MESSAGES,
      10_000,
    ),
    bufferMaxAgeDays: positiveInt(
      env,
      ENV.bufferMaxAgeDays,
      DEFAULT_BUFFER_MAX_AGE_DAYS,
      365,
    ),
  };
}
