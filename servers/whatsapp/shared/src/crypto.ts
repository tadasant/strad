/**
 * AES-256-GCM, for every object this server writes.
 *
 * Layout: `WAS1` (4 bytes) | IV (12) | tag (16) | ciphertext. The object's NAME
 * is the additional authenticated data, so a sealed blob only opens under the
 * name it was written to: swapping one chat's object for another's, or the
 * auth state for a buffer, fails authentication rather than decoding as the
 * wrong thing.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("WAS1");
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

export function seal(key: Buffer, name: string, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function open(key: Buffer, name: string, sealed: Buffer): Buffer {
  if (
    sealed.length < MAGIC.length + IV_BYTES + TAG_BYTES ||
    !sealed.subarray(0, MAGIC.length).equals(MAGIC)
  ) {
    throw new SealError(`${name} is not a sealed WhatsApp state object.`);
  }
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = sealed.subarray(
    MAGIC.length + IV_BYTES,
    MAGIC.length + IV_BYTES + TAG_BYTES,
  );
  const body = sealed.subarray(MAGIC.length + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new SealError(
      `${name} does not open with WHATSAPP_STATE_ENCRYPTION_KEY. The key was ` +
        `changed after this state was written, or the object was altered. ` +
        `Restore the previous key, or call whatsapp_logout to discard the ` +
        `stored state and pair again.`,
    );
  }
}
