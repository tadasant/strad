/**
 * What every tool file needs: the tool shape, the result envelope, argument
 * parsing, and the one error path.
 */
import {
  GcsHttpError,
  isTransientTransportError,
  TokenFetchFailed,
  TransientStoreError,
} from "../state-store.js";
import { BridgeError, type WhatsAppBridge } from "../bridge.js";
import { ConfigError } from "../config.js";
import { SealError } from "../crypto.js";
import { redact } from "../logging.js";
import { RateLimited } from "../pacing.js";
import { SupersededError } from "../store.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  structuredContent?: Record<string, unknown>;
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
 * The bridge, built on first use. It throws a ConfigError when the deployment
 * is missing a variable, which every tool reports by name.
 */
export type BridgeFactory = () => Promise<WhatsAppBridge>;

/**
 * Said in every tool description, because a tool description is the only
 * documentation an agent reads before it acts.
 */
export const UNOFFICIAL =
  "This is an UNOFFICIAL WhatsApp client (a linked device, like WhatsApp Web, " +
  "driven by the Baileys library). Automating a personal account is against " +
  "WhatsApp's Terms of Service, and WhatsApp can ban the account for it.";

export const CHAT_ID_DESCRIPTION =
  'The chat\'s WhatsApp JID, from whatsapp_list_chats: "…@g.us" for a group, ' +
  '"…@s.whatsapp.net" (or "…@lid") for a person.';

/**
 * The contract: the result as JSON in `structuredContent` AND the same JSON as
 * the first text item, so a client that reads either sees one answer.
 */
export function ok(payload: object): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

export function fail(err: unknown): ToolResult {
  // Redacted: much of what reaches here was written by Baileys or the GCS
  // client, and an error must never carry key material back to a caller.
  const message = redact(err instanceof Error ? err.message : String(err));
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * `sends`: the tool posts to WhatsApp, so a dropped connection may have come
 * after the message went out, and "retry" could post it twice.
 */
export async function guard(
  run: () => Promise<ToolResult>,
  { sends = false }: { sends?: boolean } = {},
): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (
      err instanceof ConfigError ||
      err instanceof BridgeError ||
      err instanceof SealError ||
      err instanceof RateLimited ||
      err instanceof SupersededError ||
      err instanceof TransientStoreError ||
      // GCS's own refusal (403, 401, a bad key): an object name in it could
      // carry "429" and read as a WhatsApp rate limit below.
      err instanceof GcsHttpError ||
      err instanceof TokenFetchFailed
    ) {
      return fail(err);
    }
    // A dropped connection that reached here without passing through the
    // store's retry: say what it is, not the transport's raw wording.
    if (isTransientTransportError(err)) {
      return fail(
        new Error(
          sends
            ? "A network connection closed before WhatsApp confirmed the send, so " +
                "the message may or may not have gone out. Check " +
                "whatsapp_get_messages for it (sent_by_bridge: true) before retrying."
            : "A network connection this bridge depends on closed before it " +
                "answered. This is a transient network error: transient; retry the call.",
        ),
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/rate-overlimit|429/i.test(message)) {
      return fail(
        new Error(
          `WhatsApp is rate-limiting this account (${message}). Stop sending ` +
            `for a while: repeated rate limits are how an unofficial client gets ` +
            `banned.`,
        ),
      );
    }
    return fail(err);
  }
}

export function args(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export function requiredString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new BridgeError(`\`${key}\` is required and must be a non-empty string.`);
  }
  return value;
}

export function optionalString(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new BridgeError(`\`${key}\` must be a string.`);
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
    throw new BridgeError(`\`${key}\` must be a whole number between 1 and ${max}.`);
  }
  return Math.min(parsed, max);
}

/** A UNIX timestamp in seconds; 0 is allowed ("from the beginning"). */
export function optionalSeconds(
  raw: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 0) {
    throw new BridgeError(
      `\`${key}\` must be a UNIX timestamp in whole SECONDS (not milliseconds).`,
    );
  }
  if (parsed > 100_000_000_000) {
    throw new BridgeError(
      `\`${key}\`=${parsed} looks like milliseconds. Pass UNIX SECONDS.`,
    );
  }
  return parsed;
}
