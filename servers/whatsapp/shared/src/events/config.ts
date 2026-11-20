/**
 * What the WhatsApp `message_received` event needs from the environment.
 *
 * OFF BY DEFAULT. The event is served only when the slug's `env:` sets
 * `WHATSAPP_EVENTS_ENABLED` to `true`. Without it the mount lists no event
 * types, advertises no events extension, and buffers nothing new.
 *
 * NO NEW SECRET. The event buffer and the webhook registry are sealed under
 * this server's own `WHATSAPP_STATE_ENCRYPTION_KEY`, beside the chats they
 * are cut from, in the same folder of strad's shared state bucket. That key
 * already seals every message the bridge holds, so a second key would protect
 * nothing the first does not. Each object's name is its associated data
 * (`crypto.ts`), so an event object never opens as a chat object, or back.
 *
 * Nothing here is ever logged except the NAMES of variables and a malformed
 * value of a non-secret one.
 */

export type EnvLike = Readonly<Record<string, string | undefined>>;

export const WHATSAPP_EVENTS_ENV = {
  /** `true` switches the event on for this slug. Anything else, or unset: off. */
  enabled: "WHATSAPP_EVENTS_ENABLED",
  /** Optional. Days an event is kept. Default 7. */
  retentionDays: "WHATSAPP_EVENTS_RETENTION_DAYS",
  /** Optional. Comma-separated `https` URL prefixes whose webhook requests carry the Access token below. */
  webhookAccessPrefixes: "WHATSAPP_EVENTS_WEBHOOK_ACCESS_PREFIXES",
  /** Optional, with the prefixes: strad's Cloudflare Access service token for Zimmer's edge. */
  webhookAccessClientId: "ZIMMER_APPROVAL_CF_ACCESS_CLIENT_ID",
  webhookAccessClientSecret: "ZIMMER_APPROVAL_CF_ACCESS_CLIENT_SECRET",
} as const;

export const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 30;

export interface WebhookAccess {
  prefixes: { host: string; path: string }[];
  headers: Record<string, string>;
}

export interface WhatsAppEventsConfig {
  retentionDays: number;
  webhookAccess: WebhookAccess | null;
  /** Why `webhookAccess` is null although part of it is set. Not fatal: delivery runs without it. */
  webhookAccessProblem: string | null;
}

export class WhatsAppEventsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppEventsConfigError";
  }
}

const read = (env: EnvLike, name: string): string | undefined => {
  const value = env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
};

/** True when this slug asked for the event. Only the literal `true` (any case) counts. */
export function eventsRequested(env: EnvLike): boolean {
  return read(env, WHATSAPP_EVENTS_ENV.enabled)?.toLowerCase() === "true";
}

/** Throws {@link WhatsAppEventsConfigError} for a malformed retention; Access problems are reported, not thrown. */
export function loadEventsConfig(env: EnvLike): WhatsAppEventsConfig {
  const rawDays = read(env, WHATSAPP_EVENTS_ENV.retentionDays);
  let retentionDays = DEFAULT_RETENTION_DAYS;
  if (rawDays !== undefined) {
    const parsed = Number(rawDays);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RETENTION_DAYS) {
      throw new WhatsAppEventsConfigError(
        `${WHATSAPP_EVENTS_ENV.retentionDays}="${rawDays}" must be a whole number between 1 and ${MAX_RETENTION_DAYS}.`,
      );
    }
    retentionDays = parsed;
  }
  let webhookAccess: WebhookAccess | null = null;
  let webhookAccessProblem: string | null = null;
  try {
    webhookAccess = readWebhookAccess(env);
  } catch (err) {
    webhookAccessProblem = err instanceof Error ? err.message : String(err);
  }
  return { retentionDays, webhookAccess, webhookAccessProblem };
}

/**
 * The Cloudflare Access service token for callback URLs behind Access, and
 * the URL prefixes it may be sent to: a host AND a path, over https on the
 * default port. All three variables or none. Gmail's ingest reads the same
 * rule from its own prefixes variable (`images/bundle-google/src/events/config.ts`).
 */
export function readWebhookAccess(env: EnvLike): WebhookAccess | null {
  const prefixes = read(env, WHATSAPP_EVENTS_ENV.webhookAccessPrefixes);
  if (prefixes === undefined) return null;
  const id = read(env, WHATSAPP_EVENTS_ENV.webhookAccessClientId);
  const secret = read(env, WHATSAPP_EVENTS_ENV.webhookAccessClientSecret);
  const missing = ([
    id === undefined ? WHATSAPP_EVENTS_ENV.webhookAccessClientId : null,
    secret === undefined ? WHATSAPP_EVENTS_ENV.webhookAccessClientSecret : null,
  ] as (string | null)[]).filter((n): n is string => n !== null);
  if (missing.length > 0) {
    throw new WhatsAppEventsConfigError(
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
        throw new WhatsAppEventsConfigError(
          `${WHATSAPP_EVENTS_ENV.webhookAccessPrefixes} must be https URL prefixes with a path ending in "/", ` +
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
