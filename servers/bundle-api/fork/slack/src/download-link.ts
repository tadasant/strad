/**
 * The signed, short-lived download link a Slack attachment is handed over as.
 *
 * WHY THIS EXISTS. The caller of `slack_download_file` runs on a different
 * machine from this mount, so a filesystem path names nothing it can open.
 * Slack offers no URL to pass through instead: `url_private` and
 * `url_private_download` both require `Authorization: Bearer <bot token>`, and
 * the only unauthenticated form, `permalink_public`, is minted by
 * `files.sharedPublicURL` — a USER-token method that makes the file public
 * indefinitely until `files.revokePublicURL`. Wrong on both counts. So strad
 * mints the link, and the SIGNATURE is the credential: the caller holds no strad
 * API key and sends no header. FORK.md carries the incident behind it.
 *
 * WHAT THE SIGNATURE COVERS, and why each field is in there:
 *
 *   - `file_id`  — the link authorises ONE attachment, not the workspace.
 *   - `exp`      — minutes, not days. The token rides in a URL path, so it lands
 *                  in App Platform's edge access log; a short life is what keeps
 *                  that from mattering.
 *   - `nonce`    — makes each mint unique, and is the handle {@link NonceLedger}
 *                  marks as spent so a link is single-use.
 *
 * The mount's identity is NOT in the payload either — it is folded into the KEY
 * by {@link deriveKey}, so a token from elsewhere fails to verify rather than
 * failing a field comparison, and a misrouted link cannot be read back for its
 * file id. Note what that does and does not check: the slug in the REQUEST URL
 * is never compared with anything. It is a routing address, and the container it
 * routes to either holds the key that signed the token or does not.
 *
 * THE FILENAME IS DELIBERATELY ABSENT. It would otherwise travel in the URL and
 * therefore into request logs and spans. strad's telemetry rule is that tool
 * arguments and results are never recorded, and a filename in a path is exactly
 * the leak that rule exists to prevent. The name is served in
 * `Content-Disposition` on the response instead, where no log keeps it.
 *
 * THE KEY IS DERIVED, NOT SEEDED. `STRAD_INTERNAL_TOKEN` is already on every
 * bundle component — the deploy refuses to render one without it — so there is
 * no new secret to place by hand and no operational step outside a deploy.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Default life of a download link. Matches remote-filesystem's upload lease. */
export const DEFAULT_TTL_SECONDS = 15 * 60;

/** Longest life this module will sign for. */
export const MAX_TTL_SECONDS = 60 * 60;

/**
 * Version tag, inside the signed payload AND inside the key's derivation string.
 *
 * A change to either the payload shape or what the signature means gets a new
 * tag, which invalidates every outstanding link rather than letting an old one
 * be reinterpreted under new rules.
 */
const VERSION = 1;
const KEY_DOMAIN = 'strad-slack-download-v1';

interface Payload {
  v: number;
  f: string;
  exp: number;
  n: string;
}

export interface MintedLink {
  token: string;
  /** Absolute expiry, ISO-8601, for the tool to show the caller. */
  expiresAt: string;
}

export type VerifyResult =
  | { ok: true; fileId: string; nonce: string; expiresAtMs: number }
  | { ok: false; status: number; error: string };

/**
 * The HMAC key for one mount, bound to BOTH the slug it is served as and the
 * workspace credential it serves.
 *
 * `publicSlug` is the slug the GATEWAY routes by — `slack-zimmer`, not the
 * `/slack` mount path this container serves it under.
 *
 * `workspaceToken` is the Slack bot token, folded in as a SHA-256 fingerprint
 * and never stored. It is what makes two workspaces two trust domains rather
 * than one: prod runs this image twice against two different Slack workspaces,
 * and both containers hold the SAME `STRAD_INTERNAL_TOKEN`. Slug alone would not
 * separate them — a deployment that forgot to set `SLACK_PUBLIC_SLUG` has both
 * mounts deriving from the default `slack`, so a link minted by one would verify
 * at the other and then fail obscurely against a file id that workspace has
 * never heard of. Binding the credential makes that a clean 403 instead.
 *
 * Rotating either the internal token or the bot token invalidates outstanding
 * links, which at a fifteen-minute life nobody notices.
 */
export function deriveKey(
  internalToken: string,
  publicSlug: string,
  workspaceToken: string
): Buffer {
  const workspace = createHash('sha256').update(workspaceToken).digest('base64url');
  return createHmac('sha256', internalToken)
    .update(`${KEY_DOMAIN}:${publicSlug}:${workspace}`)
    .digest();
}

function b64url(input: Buffer): string {
  return input.toString('base64url');
}

function sign(key: Buffer, body: string): string {
  return b64url(createHmac('sha256', key).update(body).digest());
}

/**
 * Mint a token authorising one GET of one file.
 *
 * `ttlSeconds` is clamped rather than rejected: a caller asking for a longer
 * link gets the longest one this module will sign, which is a better answer than
 * an error for something that is a policy ceiling rather than a mistake.
 */
export function mintDownloadToken(opts: {
  key: Buffer;
  fileId: string;
  ttlSeconds?: number;
  now?: number;
}): MintedLink {
  const now = opts.now ?? Date.now();
  // `Number.isFinite` first: NaN survives Math.min/Math.max unchanged, and an
  // `exp: NaN` mints a token that every verify then refuses — total failure,
  // silently, from one bad argument.
  const requested = opts.ttlSeconds;
  const ttl = Math.min(
    Math.max(Number.isFinite(requested) ? (requested as number) : DEFAULT_TTL_SECONDS, 1),
    MAX_TTL_SECONDS
  );
  const expMs = now + ttl * 1000;

  const payload: Payload = {
    v: VERSION,
    f: opts.fileId,
    exp: expMs,
    n: b64url(randomBytes(12)),
  };

  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf-8'));
  return { token: `${body}.${sign(opts.key, body)}`, expiresAt: new Date(expMs).toISOString() };
}

/**
 * Check a token and report what it authorises.
 *
 * Every failure answers 403 with the same text. The distinctions this code can
 * see — bad signature, expired, malformed — are exactly the distinctions an
 * attacker would like reported back, and none of them is useful to a legitimate
 * caller, whose remedy is identical in all three cases: call the tool again.
 */
export function verifyDownloadToken(opts: {
  key: Buffer;
  token: string;
  now?: number;
}): VerifyResult {
  const now = opts.now ?? Date.now();
  const refuse: VerifyResult = {
    ok: false,
    status: 403,
    error: 'This download link is not valid. Links expire quickly and may be used once — call slack_download_file again for a fresh one.',
  };

  const dot = opts.token.indexOf('.');
  if (dot <= 0 || dot === opts.token.length - 1) return refuse;

  const body = opts.token.slice(0, dot);
  const presented = opts.token.slice(dot + 1);
  const expected = sign(opts.key, body);

  // Constant-time, and length-checked first because timingSafeEqual throws on a
  // length mismatch rather than returning false.
  const a = Buffer.from(presented, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return refuse;

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as Payload;
  } catch {
    return refuse;
  }

  if (payload?.v !== VERSION) return refuse;
  if (typeof payload.f !== 'string' || payload.f.length === 0) return refuse;
  if (typeof payload.n !== 'string' || payload.n.length === 0) return refuse;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return refuse;
  if (payload.exp <= now) return refuse;

  return { ok: true, fileId: payload.f, nonce: payload.n, expiresAtMs: payload.exp };
}

/**
 * The spent-nonce set that makes a link single-use.
 *
 * IN MEMORY, AND THAT IS A BOUND RATHER THAN A HOLE. A restart forgets which
 * nonces were spent, so a link could in principle be replayed across one — but
 * only within its own few-minute expiry, which is the outer limit on this whole
 * mechanism anyway. The artifact store's upload lease store makes the same trade
 * for the same reason. It is recorded in `HACKS.md`.
 *
 * A nonce is spent when the link is PRESENTED, not when the bytes land — see
 * `handleDownload` in `src/server.ts`. Claiming first is what makes two
 * simultaneous requests resolve to one winner; claiming after Slack answered
 * would let both through. The cost is that a transfer which dies after the
 * response began has still spent its link, and the caller re-calls the tool.
 *
 * {@link NonceLedger.release} narrows that to the cases worth narrowing: a
 * claim taken for work that never reached the caller at all — Slack refused, or
 * the file had gone — is handed back, so an ordinary retry still works.
 */
export class NonceLedger {
  private readonly spent = new Map<string, number>();

  /** Largest number of live nonces held before the oldest are dropped. */
  constructor(private readonly max = 10_000) {}

  /**
   * Give a claimed nonce back.
   *
   * Called when the work the claim was taken for did not happen — Slack refused,
   * or the file had gone. A link burned by a failure the caller did not cause
   * would make an ordinary retry impossible.
   */
  release(nonce: string): void {
    this.spent.delete(nonce);
  }

  /** True if this nonce had not been spent yet; marks it spent either way. */
  claim(nonce: string, expiresAtMs: number, now = Date.now()): boolean {
    this.prune(now);
    if (this.spent.has(nonce)) return false;
    // A Map iterates in insertion order, so the first key is the oldest write.
    // Dropping it early only ever shortens a nonce's protection to less than its
    // own expiry; it cannot extend one.
    if (this.spent.size >= this.max) {
      const oldest = this.spent.keys().next();
      if (!oldest.done) this.spent.delete(oldest.value);
    }
    this.spent.set(nonce, expiresAtMs);
    return true;
  }

  private prune(now: number): void {
    for (const [nonce, exp] of this.spent) {
      if (exp <= now) this.spent.delete(nonce);
    }
  }
}
