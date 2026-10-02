/**
 * RFC 6238 TOTP, so a server holding the seed can answer Monarch's 2FA prompt
 * itself. `MONARCH_TOTP` is a one-time CODE and is dead thirty seconds after a
 * human types it; `MONARCH_TOTP_SECRET` is the SEED an authenticator app holds,
 * which is what an unattended re-login needs.
 *
 * Accepts the bare base32 seed (spaces and lowercase tolerated) or the whole
 * `otpauth://totp/…?secret=…` URI a setup QR code encodes. SHA-1, six digits,
 * thirty seconds: the parameters every consumer authenticator assumes, and the
 * ones Monarch's setup issues.
 */
import { createHmac } from 'crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function seedFrom(raw: string): string {
  let value = raw.trim();
  if (/^otpauth:\/\//i.test(value)) {
    const secret = new URL(value).searchParams.get('secret');
    if (!secret) throw new Error('MONARCH_TOTP_SECRET is an otpauth:// URI with no secret= parameter');
    value = secret;
  }
  return value.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
}

function base32Decode(seed: string): Buffer {
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of seed) {
    const idx = BASE32.indexOf(ch);
    // Reported by shape, never by content: the content is the 2FA seed.
    if (idx < 0) throw new Error('MONARCH_TOTP_SECRET is not a base32 seed');
    acc = (acc << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (out.length === 0) throw new Error('MONARCH_TOTP_SECRET is empty');
  return Buffer.from(out);
}

export function totpCode(rawSeed: string, at: Date = new Date(), stepSeconds = 30, digits = 6): string {
  const key = base32Decode(seedFrom(rawSeed));
  const counter = Math.floor(at.getTime() / 1000 / stepSeconds);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, '0');
}
