/**
 * Links — the whole product.
 *
 * This server exists so an agent can hand a human a URL that opens. Two kinds
 * of link, and which one you get is decided by sensitivity, not by a flag:
 *
 *   SHARED (the default)  a SIGNED URL. Whoever holds the link can open it, with
 *                         no Google account, until it expires. This is the good
 *                         UX and it is what a screenshot should get.
 *
 *   RESTRICTED            a storage.cloud.google.com URL. It carries no
 *                         signature; access is decided by WHO is signed in, so
 *                         Google prompts for a login and then checks the
 *                         object's ACL. It does not expire, because nothing
 *                         about it is time-limited — the grant is.
 *
 * ── The seven-day problem, and what we do about it ─────────────────────────
 *
 * GCS's V4 signing process caps expiry at seven days (604800s), enforced both by
 * Google and by the Node SDK. A fourteen-day default is therefore impossible
 * with V4. It IS possible with V2, the older signing process, which has no such
 * cap — verified against a real bucket: a 14-day and a 365-day V2 URL both serve
 * 200 anonymously.
 *
 * So: V4 for links of seven days or less, V2 for longer. V4 is what Google
 * recommends and it stays the path for the common case; V2 is legacy and Google
 * could retire it, at which point links longer than seven days stop being
 * mintable. That is the tradeoff, and `refresh_link` is what makes it survivable
 * — a link that dies is one tool call away from being alive again.
 *
 * We do NOT silently downgrade a 14-day request to 7. If V2 signing ever fails,
 * the call fails and says why; handing back a link that expires in half the time
 * the caller asked for is the failure mode this whole design is trying to avoid.
 */

export type Sensitivity = "shared" | "restricted";

/** Which GCS signing process minted a URL. */
export type SigningVersion = "v2" | "v4";

/** The longest expiry GCS's V4 signing process accepts, in seconds. */
export const V4_MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The signing process to use for a link of the given life.
 *
 * Seven days exactly stays on V4 — the cap is inclusive, and the modern process
 * is preferred wherever it reaches.
 */
export function signingVersionFor(days: number): SigningVersion {
  return days * 24 * 60 * 60 <= V4_MAX_EXPIRY_SECONDS ? "v4" : "v2";
}

/**
 * The URL a signed-in human opens for a RESTRICTED artifact.
 *
 * `storage.cloud.google.com` is the cookie-authenticated browser front door for
 * GCS: anonymous requests are redirected to the Google sign-in page, and after
 * sign-in the object's ACL decides. `storage.googleapis.com` — the API host — is
 * NOT interchangeable here: it authenticates bearer tokens and signatures only,
 * so it answers an unauthenticated browser with a 403 and no way forward.
 */
export function authenticatedBrowserUrl(bucket: string, object: string): string {
  return `https://storage.cloud.google.com/${bucket}/${encodeObjectPath(object)}`;
}

/** Percent-encode an object path for a URL while leaving its slashes as slashes. */
export function encodeObjectPath(object: string): string {
  return object.split("/").map(encodeURIComponent).join("/");
}

/** The ACL entity that grants a whole Workspace domain read access to an object. */
export function domainReaderEntity(domain: string): string {
  return `domain-${domain}`;
}
