import { createHash, timingSafeEqual } from "node:crypto";

/** `Authorization: Bearer <token>` → the token. Anything else → undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer[ ]+([^\s]+)$/i.exec(header.trim());
  return m?.[1];
}

/**
 * Compare over digests, so the comparison is constant-time for inputs of any
 * length and `timingSafeEqual` never throws on a length mismatch.
 */
export function keysMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
