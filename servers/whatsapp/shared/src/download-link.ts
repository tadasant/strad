/**
 * The signed, single-use download link an attachment is handed over as.
 *
 * The same shape as the Slack fork's (`servers/bundle-api/fork/slack/src/
 * download-link.ts`, and `docs/servers/slack-attachments` for the reasoning):
 * the caller of `whatsapp_get_attachment` is on another machine and holds no
 * strad key, so the URL itself is the credential, served through core's
 * `/mcp-download/:slug/:token` and this mount's `/download/:token`.
 *
 * ONE DIFFERENCE, AND WHY. A Slack file id says nothing about anyone. What
 * names a WhatsApp attachment is a chat JID — a phone number, or a group —
 * and the token rides in a URL path that reaches the edge access log. So the
 * payload is SEALED (AES-256-GCM), not merely signed: the token is opaque, and
 * nothing in a log says whose chat it came from.
 *
 * THE KEY IS DERIVED, NOT SEEDED: an HMAC of the component's own
 * `STRAD_INTERNAL_TOKEN` over the gateway slug and a fingerprint of the
 * account's `WHATSAPP_STATE_ENCRYPTION_KEY`. Two accounts are two keys (prod
 * runs `whatsapp-zimmer` and `whatsapp-tadas` on two components), so a link
 * presented to the wrong container fails to open rather than resolving
 * against the wrong account's buffer. Rotating either input voids every
 * outstanding link, which at fifteen minutes nobody notices.
 *
 * THE BYTES ARE NEVER STORED. The link names a message; the mount fetches and
 * decrypts it from WhatsApp's CDN when the link is presented.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { open, seal } from "./crypto.js";

export const DOWNLOAD_TTL_SECONDS = 15 * 60;

const KEY_DOMAIN = "strad-whatsapp-download-v1";
/** The AAD every token is sealed under. A new payload shape gets a new one. */
const AAD = "whatsapp-download-v1";

export interface DownloadLinkConfig {
  /** The GATEWAY slug this mount is served as, e.g. `whatsapp-tadas`. */
  publicSlug: string;
  /** Origin of the public gateway, no trailing slash. */
  publicBaseUrl: string;
  internalToken: string;
}

interface Payload {
  c: string;
  m: string;
  exp: number;
  n: string;
}

export type VerifiedLink =
  | { ok: true; chatId: string; messageId: string; nonce: string; expiresAtMs: number }
  | { ok: false; status: number; error: string };

export function deriveDownloadKey(
  internalToken: string,
  publicSlug: string,
  stateKey: Buffer,
): Buffer {
  const account = createHash("sha256").update(stateKey).digest("base64url");
  return createHmac("sha256", internalToken)
    .update(`${KEY_DOMAIN}:${publicSlug}:${account}`)
    .digest();
}

export function mintDownloadToken(
  key: Buffer,
  chatId: string,
  messageId: string,
  now = Date.now(),
  ttlSeconds = DOWNLOAD_TTL_SECONDS,
): { token: string; expiresAt: string } {
  const exp = now + ttlSeconds * 1000;
  const payload: Payload = { c: chatId, m: messageId, exp, n: randomBytes(12).toString("base64url") };
  const token = seal(key, AAD, Buffer.from(JSON.stringify(payload))).toString("base64url");
  return { token, expiresAt: new Date(exp).toISOString() };
}

export function verifyDownloadToken(key: Buffer, token: string, now = Date.now()): VerifiedLink {
  let payload: Payload;
  try {
    payload = JSON.parse(open(key, AAD, Buffer.from(token, "base64url")).toString("utf8")) as Payload;
  } catch {
    // Forged, truncated, or minted by another mount: all the same answer.
    return { ok: false, status: 403, error: "invalid_token" };
  }
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    return { ok: false, status: 410, error: "expired" };
  }
  return { ok: true, chatId: payload.c, messageId: payload.m, nonce: payload.n, expiresAtMs: payload.exp };
}

/**
 * Spent nonces, in memory. The `/whatsapp` component runs exactly one
 * instance (the renderer refuses more), so one process's memory is the whole
 * ledger; a restart forgets it, and a link that outlives a restart is still
 * bounded by its fifteen-minute expiry.
 */
export class NonceLedger {
  private readonly spent = new Map<string, number>();

  constructor(private readonly max = 10_000) {}

  /** True if this nonce had not been spent; marks it spent either way. */
  claim(nonce: string, expiresAtMs: number, now = Date.now()): boolean {
    for (const [n, exp] of this.spent) if (exp <= now) this.spent.delete(n);
    if (this.spent.has(nonce)) return false;
    if (this.spent.size >= this.max) {
      const oldest = this.spent.keys().next();
      if (!oldest.done) this.spent.delete(oldest.value);
    }
    this.spent.set(nonce, expiresAtMs);
    return true;
  }

  /** Hand a claim back: the work it was taken for produced no bytes. */
  release(nonce: string): void {
    this.spent.delete(nonce);
  }
}
