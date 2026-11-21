import { SECRET_ENV_NAMES, type Env, value } from "./config.js";

/**
 * The one redaction every result and error goes through before it leaves.
 *
 * TWO LAYERS. The first removes the literal values this deployment holds:
 * each secret variable, and for the service-account key its private key, its
 * key id, and every line of the PEM body, so a key quoted re-wrapped or
 * JSON-escaped still does not survive. The second removes anything SHAPED like
 * a credential whatever its value: an `sk-…` key, a `Bearer` header, a Google
 * access token, a PEM block. An upstream error body is text this server did
 * not write, and the second layer is what covers a body that echoes a key
 * this deployment does not hold.
 *
 * Access tokens minted at call time are added with {@link Scrubber.add}.
 */

export interface Scrubber {
  (text: string): string;
  add(secret: string | undefined): void;
}

const REDACTED = "[redacted]";

/** Shorter than this, splitting on a value would shred ordinary text. */
const MIN_SECRET = 8;

const SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bya29\.[A-Za-z0-9._-]+/g,
  // A JWT: the signed service-account assertion is one.
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /"private_key"\s*:\s*"[^"]*"/g,
];

export function createScrubber(env: Env): Scrubber {
  const secrets = new Set<string>();
  const add = (secret: string | undefined) => {
    const s = secret?.trim();
    if (s && s.length >= MIN_SECRET) secrets.add(s);
  };

  for (const name of SECRET_ENV_NAMES) {
    const v = value(env, name);
    add(v);
    if (name === "GCP_BILLING_SA_KEY_JSON" && v) {
      try {
        const key = JSON.parse(v) as Record<string, unknown>;
        if (typeof key.private_key === "string") {
          add(key.private_key);
          for (const line of key.private_key.split(/\r?\n/)) {
            if (!line.startsWith("-----")) add(line);
          }
        }
        if (typeof key.private_key_id === "string") add(key.private_key_id);
      } catch {
        // Not JSON: the whole value is already in the set.
      }
    }
  }

  const scrub = ((text: string) => {
    let out = text;
    // Longest first, so a value that contains another is removed whole.
    for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(s).join(REDACTED);
    }
    for (const shape of SHAPES) out = out.replace(shape, REDACTED);
    return out;
  }) as Scrubber;
  scrub.add = add;
  return scrub;
}
