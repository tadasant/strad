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
import type { DownloadLinkConfig } from "./download-link.js";
import {
  missingStateStoreEnv,
  namespacePrefix,
  parseStateKey,
  readStateStoreEnv,
  STATE_STORE_ENV,
  StateStoreConfigError,
} from "./state-store.js";

export const ENV = {
  /** 32 random bytes, base64 or hex. Seals every object this server writes. */
  encryptionKey: "WHATSAPP_STATE_ENCRYPTION_KEY",
  /**
   * Optional. This account's folder in the shared state bucket: `whatsapp`, or
   * a folder under it (`whatsapp/prod`). Default `whatsapp`.
   */
  prefix: "WHATSAPP_STATE_PREFIX",
  /** Optional. Messages kept per chat. Default 1000. */
  bufferMaxMessages: "WHATSAPP_BUFFER_MAX_MESSAGES",
  /** Optional. Days a message is kept. Default 30. */
  bufferMaxAgeDays: "WHATSAPP_BUFFER_MAX_AGE_DAYS",
  /**
   * The GATEWAY slug this mount is served as (`whatsapp-tadas`), which an
   * attachment's download link is addressed to. Not derivable: every
   * WhatsApp slug is served at `path: /whatsapp`, so this process cannot know
   * which one the gateway routes to it. Unset means no download links.
   */
  publicSlug: "WHATSAPP_PUBLIC_SLUG",
} as const;

/**
 * The names this server read before its bucket became strad's shared state
 * store. Production still holds them — `WHATSAPP_GCS_*` in two slugs'
 * namespaces, `WHATSAPP_GCS_PREFIX` as a literal on four slugs — so each is
 * read when its successor is unset, and a deployment that never touches them
 * keeps working with no re-seed. Two that disagree about WHERE the state is
 * (bucket, folder) are refused, never resolved: see `readStateStoreEnv`.
 */
export const LEGACY_ENV = {
  bucket: "WHATSAPP_GCS_BUCKET",
  clientEmail: "WHATSAPP_GCS_CLIENT_EMAIL",
  privateKey: "WHATSAPP_GCS_PRIVATE_KEY",
  prefix: "WHATSAPP_GCS_PREFIX",
} as const;

/** This server's top-level folder in the shared bucket. */
export const STATE_ROOT = "whatsapp";

/** Rendered onto every bundle component by strad's renderer. */
const STRAD_PUBLIC_URL = "STRAD_PUBLIC_URL";
const STRAD_INTERNAL_TOKEN = "STRAD_INTERNAL_TOKEN";

/**
 * The variables without which this server cannot hold a login at all, by the
 * names to set today. A legacy `WHATSAPP_GCS_*` name stands in for its shared
 * successor.
 */
export const REQUIRED_ENV_NAMES = [
  ENV.encryptionKey,
  STATE_STORE_ENV.bucket,
  STATE_STORE_ENV.clientEmail,
  STATE_STORE_ENV.privateKey,
] as const;

export const DEFAULT_PREFIX = STATE_ROOT;
export const DEFAULT_BUFFER_MAX_MESSAGES = 1000;
export const DEFAULT_BUFFER_MAX_AGE_DAYS = 30;

export interface WhatsAppConfig {
  /** Exactly 32 bytes. */
  encryptionKey: Buffer;
  bucket: string;
  clientEmail: string;
  privateKey: string;
  /** Which variable the private key was read from, for the error naming it. */
  privateKeyVariable?: string;
  /** No leading or trailing slash. */
  prefix: string;
  bufferMaxMessages: number;
  bufferMaxAgeDays: number;
  /** Where attachment download links point. Absent: no links, and the reason. */
  downloadLink?: DownloadLinkConfig;
  downloadUnavailable?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const HOW_TO_SET_THEM =
  `Set them in strad's console (/ui/secrets): ${ENV.encryptionKey} for this ` +
  `server, 32 random bytes (\`openssl rand -base64 32\`); and strad's shared ` +
  `state store, ${STATE_STORE_ENV.bucket} a private GCS bucket and ` +
  `${STATE_STORE_ENV.clientEmail} / ${STATE_STORE_ENV.privateKey} a service ` +
  `account holding roles/storage.objectAdmin on it. See ` +
  `servers/whatsapp/README.md.`;

const read = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
};

/** The required variables this deployment is missing, in declaration order. */
export function missingCredentials(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    ...(read(env, ENV.encryptionKey) === undefined ? [ENV.encryptionKey] : []),
    ...missingStateStoreEnv(env, LEGACY_ENV),
  ];
}

/** The key, from base64 (standard or url-safe) or hex: exactly 32 bytes. */
export function parseEncryptionKey(raw: string): Buffer {
  return asConfigError(() => parseStateKey(raw, ENV.encryptionKey));
}

/** The shared module's refusal, as this server's own error type. */
function asConfigError<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    if (err instanceof StateStoreConfigError) throw new ConfigError(err.message);
    throw err;
  }
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

  const prefix = asConfigError(() =>
    namespacePrefix(env, {
      variable: ENV.prefix,
      legacyVariable: LEGACY_ENV.prefix,
      root: STATE_ROOT,
    }),
  );
  const store = asConfigError(() => readStateStoreEnv(env, LEGACY_ENV));

  return {
    encryptionKey: parseEncryptionKey(read(env, ENV.encryptionKey)!),
    bucket: store.bucket,
    clientEmail: store.clientEmail,
    privateKey: store.privateKey,
    privateKeyVariable:
      read(env, STATE_STORE_ENV.privateKey) !== undefined
        ? STATE_STORE_ENV.privateKey
        : LEGACY_ENV.privateKey,
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
    ...downloadLinkConfig(env),
  };
}

/**
 * Download links need all three. The first two are on every strad bundle
 * component, so their absence means this image is running outside strad; the
 * third is per deployment. Missing any is not an error: attachments are still
 * read, and the tool says why there is no link.
 */
export function downloadLinkConfig(
  env: NodeJS.ProcessEnv,
): Pick<WhatsAppConfig, "downloadLink" | "downloadUnavailable"> {
  const publicBaseUrl = read(env, STRAD_PUBLIC_URL);
  const internalToken = read(env, STRAD_INTERNAL_TOKEN);
  const publicSlug = read(env, ENV.publicSlug);
  const missing = [
    publicBaseUrl ? null : STRAD_PUBLIC_URL,
    internalToken ? null : STRAD_INTERNAL_TOKEN,
    publicSlug ? null : ENV.publicSlug,
  ].filter((n): n is string => n !== null);
  if (missing.length > 0 || !publicBaseUrl || !internalToken || !publicSlug) {
    return {
      downloadUnavailable:
        `no download link: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} ` +
        `not set on this deployment`,
    };
  }
  return {
    downloadLink: {
      publicBaseUrl: publicBaseUrl.replace(/\/+$/, ""),
      internalToken,
      publicSlug,
    },
  };
}
