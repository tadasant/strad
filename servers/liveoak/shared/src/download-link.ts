/**
 * The signed, single-use download link a statement is handed over as.
 *
 * The same shape as the WhatsApp server's (`servers/whatsapp/shared/src/
 * download-link.ts`) and the Slack fork's before it: the caller of
 * `get_statement` is on another machine and holds no strad key, so the URL
 * itself is the credential, served through core's `/mcp-download/:slug/:token`
 * and this mount's `/download/:token`.
 *
 * SEALED, NOT MERELY SIGNED. The token rides in a URL path that reaches the
 * edge access log, and a statement id is an identifier inside someone's bank.
 * So the payload is AES-256-GCM sealed and the token is opaque.
 *
 * THE KEY IS DERIVED, NOT SEEDED: an HMAC of the component's own
 * `STRAD_INTERNAL_TOKEN` over the gateway slug and a fingerprint of the
 * account's username. A link presented to another deployment, or minted for
 * another LiveOak login, fails to open. Rotating either input voids every
 * outstanding link, which at fifteen minutes nobody notices.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { open, seal } from "./crypto.js";

export const DOWNLOAD_TTL_SECONDS = 15 * 60;

const KEY_DOMAIN = "strad-liveoak-download-v1";
/** The AAD every token is sealed under. A new payload shape gets a new one. */
const AAD = "liveoak-download-v1";

export interface DownloadLinkConfig {
  /** The GATEWAY slug this mount is served as, e.g. `liveoak-tadas`. */
  publicSlug: string;
  /** Origin of the public gateway, no trailing slash. */
  publicBaseUrl: string;
  internalToken: string;
}

interface Payload {
  d: string;
  exp: number;
  n: string;
}

export type VerifiedLink =
  | { ok: true; statementId: string; nonce: string; expiresAtMs: number }
  | { ok: false; status: number; error: string };

export function deriveDownloadKey(internalToken: string, publicSlug: string, username: string): Buffer {
  const account = createHash("sha256").update(username.toLowerCase().trim()).digest("base64url");
  return createHmac("sha256", internalToken).update(`${KEY_DOMAIN}:${publicSlug}:${account}`).digest();
}

export function mintDownloadToken(
  key: Buffer,
  statementId: string,
  now = Date.now(),
  ttlSeconds = DOWNLOAD_TTL_SECONDS,
): { token: string; nonce: string; expiresAt: string; expiresAtMs: number } {
  const exp = now + ttlSeconds * 1000;
  const nonce = randomBytes(12).toString("base64url");
  const payload: Payload = { d: statementId, exp, n: nonce };
  const token = seal(key, AAD, Buffer.from(JSON.stringify(payload))).toString("base64url");
  return { token, nonce, expiresAt: new Date(exp).toISOString(), expiresAtMs: exp };
}

export function verifyDownloadToken(key: Buffer, token: string, now = Date.now()): VerifiedLink {
  let payload: Payload;
  try {
    payload = JSON.parse(open(key, AAD, Buffer.from(token, "base64url")).toString("utf8")) as Payload;
  } catch {
    // Forged, truncated, or minted by another deployment: all the same answer.
    return { ok: false, status: 403, error: "invalid_token" };
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.d !== "string" ||
    typeof payload.n !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, status: 403, error: "invalid_token" };
  }
  if (payload.exp <= now) return { ok: false, status: 410, error: "expired" };
  return { ok: true, statementId: payload.d, nonce: payload.n, expiresAtMs: payload.exp };
}

/**
 * Spent nonces, in memory. A restart forgets them, and a link that outlives a
 * restart is still bounded by its fifteen-minute expiry. Two instances of the
 * bundle would each keep their own ledger, so a link could be spent once per
 * instance — the same bound, stated in docs/servers/liveoak.
 */
export class NonceLedger {
  private readonly spent = new Map<string, number>();

  constructor(private readonly max = 10_000) {}

  /** `full` refuses rather than evicting an unexpired entry, which would make that link usable twice. */
  claim(nonce: string, expiresAtMs: number, now = Date.now()): "ok" | "spent" | "full" {
    for (const [n, exp] of this.spent) if (exp <= now) this.spent.delete(n);
    if (this.spent.has(nonce)) return "spent";
    if (this.spent.size >= this.max) return "full";
    this.spent.set(nonce, expiresAtMs);
    return "ok";
  }

  /** Hand a claim back: the work it was taken for produced no bytes. */
  release(nonce: string): void {
    this.spent.delete(nonce);
  }
}
