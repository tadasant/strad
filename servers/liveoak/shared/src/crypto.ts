/**
 * AES-256-GCM, for the one object this server writes and for every download
 * token it mints.
 *
 * Layout: `LOS1` (4 bytes) | IV (12) | tag (16) | ciphertext. The object's NAME
 * is the additional authenticated data, so a sealed blob only opens under the
 * name it was written to: a device state copied to another prefix, or a
 * download token presented as state, fails authentication rather than decoding
 * as the wrong thing. The same construction as the WhatsApp server's
 * `crypto.ts`, with its own magic so neither opens the other's objects.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("LOS1");
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
    throw new SealError(`${name} is not a sealed LiveOak object.`);
  }
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = sealed.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(MAGIC.length + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new SealError(
      `${name} does not open with LIVEOAK_STATE_ENCRYPTION_KEY. The key was ` +
        `changed after this device was enrolled, or the object was altered. ` +
        `Restore the previous key, or call enrol_device with force: true to ` +
        `enrol again.`,
    );
  }
}
