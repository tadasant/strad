/**
 * Standard Webhooks, as draft SEP-3415 profiles it: the client's `whsec_…`
 * secret, and the three headers every POST carries.
 *
 *   webhook-id         msg_<random>, reused across retries of one message
 *   webhook-timestamp  Unix seconds, regenerated on every attempt
 *   webhook-signature  v1,<base64 HMAC-SHA256(secret, id + "." + ts + "." + body)>
 *
 * The secret is the client's. This server never generates one, never logs
 * one, and never returns one.
 */
import { createHmac, randomBytes } from 'node:crypto';

const SECRET_PREFIX = 'whsec_';
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;

export class InvalidWebhookSecret extends Error {
  constructor() {
    super(
      'delivery.secret must be a Standard Webhooks secret: "whsec_" followed by the base64 ' +
        `of ${MIN_SECRET_BYTES} to ${MAX_SECRET_BYTES} random bytes.`
    );
    this.name = 'InvalidWebhookSecret';
  }
}

/** The secret's key bytes. Throws {@link InvalidWebhookSecret}, which never quotes the value. */
export function parseWebhookSecret(raw: unknown): Buffer {
  if (typeof raw !== 'string' || !raw.startsWith(SECRET_PREFIX)) throw new InvalidWebhookSecret();
  const b64 = raw.slice(SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new InvalidWebhookSecret();
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length < MIN_SECRET_BYTES || key.length > MAX_SECRET_BYTES) {
    throw new InvalidWebhookSecret();
  }
  return key;
}

/**
 * A `webhook-id`: high-entropy, header-safe, and never derived from the
 * event's id. Control envelopes are `msg_<type>_<random>`.
 */
export function newMessageId(type?: string): string {
  const random = randomBytes(18).toString('base64url');
  return type ? `msg_${type}_${random}` : `msg_${random}`;
}

/**
 * `webhook-signature`: one `v1,` entry per key, space-separated. Two keys is
 * a secret rotation's grace window, when either must verify.
 */
export function signatureHeader(
  keys: readonly Buffer[],
  messageId: string,
  timestamp: number,
  body: string
): string {
  const signed = `${messageId}.${timestamp}.${body}`;
  return keys
    .map((key) => `v1,${createHmac('sha256', key).update(signed, 'utf8').digest('base64')}`)
    .join(' ');
}
