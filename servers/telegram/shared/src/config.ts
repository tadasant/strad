/**
 * The three environment variables this server runs on, and the error a human
 * gets when one is missing.
 *
 * WHY A USER SESSION AND NOT A BOT TOKEN. The driving requirement is reading a
 * group Tadas has JOINED but does not administer. The Bot API cannot do that at
 * all: a bot receives no message history from before it joined, and a non-admin
 * bot runs with privacy mode on, so it only ever sees messages that address it.
 * MTProto with a user session is the only protocol that answers the requirement,
 * so the credentials here are an api id/hash pair from my.telegram.org plus a
 * session string minted by a login as the account itself.
 *
 * THE SESSION STRING IS THE ACCOUNT. Anything the account can read or do, a
 * holder of that string can read or do — it is not scoped, not expiring, and not
 * revocable except by terminating the session from a Telegram client. It is
 * never logged, never echoed in an error, and never returned by a tool.
 */

export const ENV = {
  apiId: "TELEGRAM_API_ID",
  apiHash: "TELEGRAM_API_HASH",
  stringSession: "TELEGRAM_STRING_SESSION",
} as const;

export interface TelegramConfig {
  /** Numeric app id from my.telegram.org. */
  apiId: number;
  /** App hash from the same page. Secret. */
  apiHash: string;
  /** A logged-in user session. Secret, and equivalent to the account. */
  stringSession: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * How to get the three values. Repeated in every credential error because the
 * error is the only documentation an agent mid-call can see.
 */
const HOW_TO_GET_THEM =
  `${ENV.apiId} and ${ENV.apiHash} come from https://my.telegram.org -> API ` +
  `development tools. ${ENV.stringSession} comes from a one-time interactive ` +
  `login as the ACCOUNT that is in the group (see servers/telegram/README.md). ` +
  `A bot token cannot be substituted: the Bot API cannot read a group's history, ` +
  `and a non-admin bot sees only messages addressed to it.`;

/** The variables this deployment is missing, in declaration order. */
export function missingCredentials(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return Object.values(ENV).filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === "";
  });
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): TelegramConfig {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new ConfigError(
      `Telegram is not configured: ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } not set. ${HOW_TO_GET_THEM}`,
    );
  }

  const rawId = env[ENV.apiId]!.trim();
  const apiId = Number(rawId);
  if (!Number.isInteger(apiId) || apiId <= 0) {
    // The value itself is safe to quote — the app id is public, it is the hash
    // and the session that are not — and quoting it is what makes a pasted
    // "12345678 " or a swapped id/hash pair diagnosable.
    throw new ConfigError(
      `${ENV.apiId}="${rawId}" is not a positive integer. It is the numeric app ` +
        `id from my.telegram.org, not the api hash.`,
    );
  }

  return {
    apiId,
    apiHash: env[ENV.apiHash]!.trim(),
    stringSession: env[ENV.stringSession]!.trim(),
  };
}
