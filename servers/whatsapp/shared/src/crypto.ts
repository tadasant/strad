/**
 * The WhatsApp bridge's seal: the shared AES-256-GCM in `state-store.ts`, with
 * this server's magic (`WAS1`), its key's name, and what to do when an object
 * does not open. The object's NAME is the associated data, so swapping one
 * chat's object for another's, or the auth state for a buffer, fails
 * authentication rather than decoding as the wrong thing.
 */
import {
  open as openSealed,
  seal as sealPlain,
  SealError,
  type SealFormat,
} from "./state-store.js";
import { ENV } from "./config.js";

export { SealError };

const FORMAT: SealFormat = {
  magic: "WAS1",
  what: "a sealed WhatsApp state object",
  keyVariable: ENV.encryptionKey,
  recovery:
    "Restore the previous key, or call whatsapp_logout to discard the " +
    "stored state and pair again.",
};

export function seal(key: Buffer, name: string, plain: Buffer): Buffer {
  return sealPlain(key, name, plain, FORMAT);
}

export function open(key: Buffer, name: string, sealed: Buffer): Buffer {
  return openSealed(key, name, sealed, FORMAT);
}
