/**
 * The pieces every tool file needs: the tool shape, the JSON envelope, and the
 * parameter copy that must read identically wherever it appears.
 */

import { ConfigError } from "../config.js";
import { UnknownChatError, type TelegramGateway } from "../gateway.js";
import { redact } from "../logging.js";

export interface ToolResult {
  /** The SDK's `ServerResult` is open-ended; the index signature is what makes
   * this assignable to it without a cast at the registration site. */
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: Record<string, boolean>;
  handler: (args: unknown) => Promise<ToolResult>;
}

/**
 * Built on the first tool call, not at boot.
 *
 * This server shares a process with nineteen others. Connecting to Telegram at
 * import time would make a missing credential — or a Telegram outage — a boot
 * failure for all of them.
 */
export type GatewayFactory = () => Promise<TelegramGateway>;

/** The `chat` parameter copy. Every tool that takes one uses this text. */
export const CHAT_DESCRIPTION =
  'Which chat, as: a numeric id from list_chats ("-1001234567890" or ' +
  '"1234567890" — either form of a supergroup id works), a public "@username", ' +
  'or a t.me link — public ("t.me/name") or the private-supergroup form ' +
  '("t.me/c/1234567890/42"). A private INVITE link ("t.me/+…") is not a chat ' +
  "reference. When you have no id yet, call list_chats first — it is also what " +
  "teaches this session about a chat it has never opened.";

export const LIMIT_DESCRIPTION = (fallback: number, max: number): string =>
  `How many messages to return (1-${max}). Default: ${fallback}. Messages come ` +
  `back OLDEST first; use next_offset_id from the result to page further BACK ` +
  `in time.`;

export const OFFSET_DESCRIPTION =
  "Return only messages OLDER than this message id. Omit for the most recent " +
  "page; then pass the `next_offset_id` from the previous result to continue " +
  "backwards. A result with no next_offset_id has reached the start of the chat.";

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function fail(err: unknown): ToolResult {
  // REDACTED, because most of what reaches here was written by the MTProto
  // library rather than by this server, and an error that quotes the session
  // string back at a caller would hand over the account.
  const message = redact(err instanceof Error ? err.message : String(err));
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * The one error path every tool shares, and the reason it is not a bare
 * `catch`: the interesting failures here are classified, and each has a
 * different next move.
 *
 *   - config     nobody can fix this from the agent side; name the variables.
 *   - unknown chat  the recovery is list_chats, and the message already says so.
 *   - AUTH_KEY / SESSION_REVOKED  the session string is dead; a human must mint
 *     a new one, and no retry will help.
 *   - FLOOD_WAIT  Telegram is rate-limiting; the wait is in the message.
 */
export async function guard(
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ConfigError || err instanceof UnknownChatError) {
      return fail(err);
    }
    const message = err instanceof Error ? err.message : String(err);

    if (/AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/i.test(message)) {
      return fail(
        new Error(
          `Telegram rejected this session (${message}). The TELEGRAM_STRING_SESSION ` +
            `this server holds is no longer valid — it was revoked from a Telegram ` +
            `client, or the account was deactivated. Retrying will not help; a human ` +
            `must mint a new session string and redeploy.`,
        ),
      );
    }
    if (/FLOOD_WAIT/i.test(message)) {
      return fail(
        new Error(
          `Telegram is rate-limiting this account (${message}). Wait the number of ` +
            `seconds in that error before calling again, and prefer one larger read ` +
            `over many small ones.`,
        ),
      );
    }
    if (/CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL/i.test(message)) {
      return fail(
        new Error(
          `Telegram refused this on permissions (${message}). The account can be a ` +
            `member of a chat and still not be allowed to post in it.`,
        ),
      );
    }
    return fail(err);
  }
}

/** Arguments arrive as `unknown` from the SDK. */
export function args(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export function requiredString(
  raw: Record<string, unknown>,
  key: string,
): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`\`${key}\` is required and must be a non-empty string.`);
  }
  return value;
}

export function boundedInt(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`\`${key}\` must be a whole number between 1 and ${max}.`);
  }
  // Clamped rather than refused: an agent that asks for 500 wants "as many as
  // you can", and failing the call teaches it nothing the result would not.
  return Math.min(parsed, max);
}

export function optionalInt(
  raw: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`\`${key}\` must be a positive whole message id.`);
  }
  return parsed;
}
