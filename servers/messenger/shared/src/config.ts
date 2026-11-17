/**
 * The environment this server runs on, and the error a human gets when part of
 * it is missing.
 *
 * NO CREDENTIAL FOR FACEBOOK ITSELF. The login is made by
 * `messenger_login_start` / `messenger_login_submit`, through strad, and what it
 * mints — a Messenger app session, and the end-to-end encryption keys of the
 * device it registers — lives in the bridge's database, which is snapshotted
 * into strad's shared state bucket sealed under this server's key. So what a
 * deployment injects is where that state lives and the key it is sealed with.
 *
 * THE KEY AND THE SNAPSHOT ARE, TOGETHER, THE ACCOUNT. Whoever holds both reads
 * every chat the account is in. Neither is ever logged, echoed in an error, or
 * returned by a tool.
 */
import {
  missingStateStoreEnv,
  namespacePrefix,
  parseStateKey,
  readStateStoreEnv,
  STATE_STORE_ENV,
  StateStoreConfigError,
} from "./state-store.js";

export const ENV = {
  /** 32 random bytes, base64 or hex. Seals the snapshot. */
  encryptionKey: "MESSENGER_STATE_ENCRYPTION_KEY",
  /** Optional. This account's folder in the shared bucket. Default `messenger`. */
  prefix: "MESSENGER_STATE_PREFIX",
  /** Optional. Days a message is kept in the buffer. Default 30. */
  bufferMaxAgeDays: "MESSENGER_BUFFER_MAX_AGE_DAYS",
  /**
   * Optional. An HTTP(S) or SOCKS5 proxy URL every connection to Meta goes
   * through — the lever for a checkpoint Meta raises against a datacenter IP.
   * A secret when it carries credentials.
   */
  proxy: "MESSENGER_PROXY",
} as const;

/** This server's top-level folder in the shared state bucket. */
export const STATE_ROOT = "messenger";

export const REQUIRED_ENV_NAMES = [
  ENV.encryptionKey,
  STATE_STORE_ENV.bucket,
  STATE_STORE_ENV.clientEmail,
  STATE_STORE_ENV.privateKey,
] as const;

export const DEFAULT_BUFFER_MAX_AGE_DAYS = 30;

export interface MessengerConfig {
  encryptionKey: Buffer;
  bucket: string;
  clientEmail: string;
  privateKey: string;
  privateKeyVariable?: string;
  /** No leading or trailing slash. */
  prefix: string;
  bufferMaxAgeDays: number;
  proxy?: string;
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
  `state store, ${STATE_STORE_ENV.bucket}, ${STATE_STORE_ENV.clientEmail} and ` +
  `${STATE_STORE_ENV.privateKey}. See docs/servers/messenger.`;

const read = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
};

/** The required variables this environment lacks, in declaration order. */
export function missingCredentials(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (!read(env, ENV.encryptionKey)) missing.push(ENV.encryptionKey);
  missing.push(...missingStateStoreEnv(env));
  return missing;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MessengerConfig {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new ConfigError(
      `Messenger is not configured on this deployment: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set. ${HOW_TO_SET_THEM}`,
    );
  }
  try {
    const location = readStateStoreEnv(env);
    const prefix = namespacePrefix(env, { variable: ENV.prefix, root: STATE_ROOT });
    const encryptionKey = parseStateKey(read(env, ENV.encryptionKey)!, ENV.encryptionKey);
    const rawDays = read(env, ENV.bufferMaxAgeDays);
    const bufferMaxAgeDays = rawDays === undefined ? DEFAULT_BUFFER_MAX_AGE_DAYS : Number(rawDays);
    if (!Number.isInteger(bufferMaxAgeDays) || bufferMaxAgeDays < 1 || bufferMaxAgeDays > 365) {
      throw new ConfigError(`${ENV.bufferMaxAgeDays} must be a whole number of days from 1 to 365.`);
    }
    const proxy = read(env, ENV.proxy);
    if (proxy !== undefined && !/^(https?|socks5h?):\/\//.test(proxy)) {
      // The value is a credential when it carries one: never quote it.
      throw new ConfigError(`${ENV.proxy} must be an http://, https:// or socks5:// URL.`);
    }
    return {
      encryptionKey,
      bucket: location.bucket,
      clientEmail: location.clientEmail,
      privateKey: location.privateKey,
      privateKeyVariable: location.privateKeyVariable,
      prefix,
      bufferMaxAgeDays,
      ...(proxy !== undefined ? { proxy } : {}),
    };
  } catch (err) {
    if (err instanceof StateStoreConfigError) throw new ConfigError(err.message);
    throw err;
  }
}
