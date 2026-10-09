/**
 * The environment this server runs on, and the error a human gets when part of
 * it is missing.
 *
 * TWO HALVES, AND NEITHER IS ENOUGH ALONE. The username and password are the
 * LiveOak login. The other four are where the REMEMBERED DEVICE lives: the
 * three keys Cognito mints when `confirm_device` completes an MFA challenge,
 * sealed with `LIVEOAK_STATE_ENCRYPTION_KEY` in a GCS object. A login with the
 * password and no device is asked for an SMS code every time; a device with no
 * password is nothing. Together they are a login that skips MFA, which is why
 * none of the six is ever logged, echoed in an error, or returned by a tool.
 *
 * THE PASSWORD NEVER LEAVES THIS PROCESS IN ANY FORM COGNITO DOES NOT ASK FOR.
 * The login is Secure Remote Password (SRP): what crosses the wire is a proof
 * derived from the password, not the password. Every error and log line a
 * caller could see is additionally scrubbed of the password's literal value
 * (`scrubber` in logging.ts), so an upstream that echoed it back still could
 * not put it in front of a model.
 */
import type { DownloadLinkConfig } from "./download-link.js";

export const ENV = {
  username: "LIVEOAK_USERNAME",
  password: "LIVEOAK_PASSWORD",
  /** 32 random bytes, base64 or hex. Seals the remembered-device state. */
  encryptionKey: "LIVEOAK_STATE_ENCRYPTION_KEY",
  /** The bucket the sealed device state lives in. */
  bucket: "LIVEOAK_GCS_BUCKET",
  /** A service account that can read, write and delete objects in it. */
  clientEmail: "LIVEOAK_GCS_CLIENT_EMAIL",
  privateKey: "LIVEOAK_GCS_PRIVATE_KEY",
  /** Optional. Object prefix inside the bucket. Default `liveoak`. */
  prefix: "LIVEOAK_GCS_PREFIX",
  /**
   * The GATEWAY slug this mount is served as, which a statement's download
   * link is addressed to. Not derivable — the slug and the mount's `path:`
   * need not be the same word. Unset means no download links.
   */
  publicSlug: "LIVEOAK_PUBLIC_SLUG",
} as const;

/** Rendered onto every bundle component by strad's renderer. */
const STRAD_PUBLIC_URL = "STRAD_PUBLIC_URL";
const STRAD_INTERNAL_TOKEN = "STRAD_INTERNAL_TOKEN";

/** The variables without which this server cannot log in at all. */
export const REQUIRED_ENV_NAMES = [
  ENV.username,
  ENV.password,
  ENV.encryptionKey,
  ENV.bucket,
  ENV.clientEmail,
  ENV.privateKey,
] as const;

export const DEFAULT_PREFIX = "liveoak";

export interface LiveOakConfig {
  username: string;
  password: string;
  /** Exactly 32 bytes. */
  encryptionKey: Buffer;
  bucket: string;
  clientEmail: string;
  privateKey: string;
  /** No leading or trailing slash. */
  prefix: string;
  /** Where statement download links point. Absent: no links, and the reason. */
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
  `Set them in strad's console (/ui/secrets) for this server: ` +
  `${ENV.username} / ${ENV.password} are the LiveOak login for ` +
  `secure.liveoak.bank, ${ENV.encryptionKey} is 32 random bytes ` +
  `(\`openssl rand -base64 32\`), ${ENV.bucket} a private GCS bucket, and ` +
  `${ENV.clientEmail} / ${ENV.privateKey} a service account holding ` +
  `roles/storage.objectAdmin on that bucket. See docs/servers/liveoak.`;

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LiveOakConfig {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new ConfigError(
      `LiveOak is not configured: ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } not set. ${HOW_TO_SET_THEM}`,
    );
  }

  const prefix = (read(env, ENV.prefix) ?? DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "");
  if (prefix === "") {
    throw new ConfigError(
      `${ENV.prefix} must name a folder, not the bucket root.`,
    );
  }

  return {
    username: read(env, ENV.username)!,
    // NOT trimmed: a password may legitimately end in a space. Only the
    // presence check above trims.
    password: env[ENV.password]!,
    encryptionKey: parseEncryptionKey(read(env, ENV.encryptionKey)!),
    bucket: read(env, ENV.bucket)!,
    clientEmail: read(env, ENV.clientEmail)!,
    // App Platform env vars carry a PEM with escaped newlines.
    privateKey: read(env, ENV.privateKey)!.replace(/\\n/g, "\n"),
    prefix,
    ...downloadLinkConfig(env),
  };
}

/**
 * Download links need all three. The first two are on every strad bundle
 * component, so their absence means this image is running outside strad; the
 * third is per deployment. Missing any is not an error: the statement is still
 * fetched and checksummed, and the tool says why there is no link.
 */
export function downloadLinkConfig(
  env: NodeJS.ProcessEnv,
): Pick<LiveOakConfig, "downloadLink" | "downloadUnavailable"> {
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
