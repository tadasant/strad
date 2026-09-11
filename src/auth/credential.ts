import { timingSafeEqual } from "node:crypto";
import { bearerToken, constantTimeEquals } from "../secrets/presence.ts";

/**
 * How a door of the gateway reads a credential, and how it compares one.
 *
 * Two primitives, and every door uses both: the public `/mcp` and the
 * readiness route (`authenticateMcp`), the console's `/ui` gate and `/console`
 * (the bootstrap token, from a header), a bundle's `/mcp` in the strad image
 * (`authenticateInternal`), and the internal-token routes under `/_strad/`.
 * One of each because every copy is another place to get the scheme or a
 * length guard wrong, and the copy written from memory is the one that does.
 * `test/auth-header.doors.test.ts` walks every door in this image with the same
 * five headers, and fails on a source file that parses or compares by hand.
 *
 * Both are IMPLEMENTED in `src/secrets/presence.ts`, not here. That module is
 * vendored into the bundle host tree and carries `authorizePresence`, the
 * internal-token gate, which cannot import a sibling across the vendoring — so
 * the host's mounts and its presence route run these same bytes. This module is
 * the core binding: the parse as it is, and the comparator with `node:crypto`'s
 * `timingSafeEqual` in place of the vendored module's JS fallback.
 */

export { bearerToken };

/**
 * Constant-time string compare for a presented credential. A length mismatch is
 * `false`, never a throw.
 */
export function secretEquals(a: string, b: string): boolean {
  return constantTimeEquals(a, b, timingSafeEqual);
}
