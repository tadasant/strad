import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  NonceLedger,
  deriveKey,
  mintDownloadToken,
  verifyDownloadToken,
} from '../src/download-link.js';

const INTERNAL = 'internal-token-for-tests';
/** The Slack bot token a mount serves — folded into the key as a fingerprint. */
const BOT = 'xoxb-workspace-a';

describe('deriveKey', () => {
  it('gives a different key per public slug', () => {
    const a = deriveKey(INTERNAL, 'slack', BOT);
    const b = deriveKey(INTERNAL, 'slack-zimmer', BOT);
    expect(a.equals(b)).toBe(false);
  });

  it('gives a different key per internal token', () => {
    expect(deriveKey('one', 'slack', BOT).equals(deriveKey('two', 'slack', BOT))).toBe(false);
  });

  it('is deterministic, so a second process verifies what the first minted', () => {
    expect(deriveKey(INTERNAL, 'slack', BOT).equals(deriveKey(INTERNAL, 'slack', BOT))).toBe(true);
  });

  // The case the slug alone does not cover. prod runs this image twice against
  // two workspaces, both holding the SAME internal token; a deployment that
  // forgot SLACK_PUBLIC_SLUG has both mounts deriving from the default `slack`.
  // Without the credential in the key those two keys would be identical.
  it('gives a different key per workspace credential, even on the same slug', () => {
    const a = deriveKey(INTERNAL, 'slack', 'xoxb-workspace-a');
    const b = deriveKey(INTERNAL, 'slack', 'xoxb-workspace-b');
    expect(a.equals(b)).toBe(false);
  });

  it('never puts the credential itself anywhere in the key material', () => {
    const key = deriveKey(INTERNAL, 'slack', 'xoxb-super-secret-value');
    expect(key.toString('utf-8')).not.toContain('xoxb-super-secret-value');
    expect(key.toString('hex')).not.toContain(
      Buffer.from('xoxb-super-secret-value', 'utf-8').toString('hex')
    );
  });
});

describe('mint/verify round trip', () => {
  it('verifies a fresh token and reports the file it authorises', () => {
    const key = deriveKey(INTERNAL, 'slack-zimmer', BOT);
    const { token } = mintDownloadToken({ key, fileId: 'F123' });

    const result = verifyDownloadToken({ key, token });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fileId).toBe('F123');
  });

  it('reports an expiry the caller can show, and defaults to fifteen minutes', () => {
    const key = deriveKey(INTERNAL, 'slack', BOT);
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const { expiresAt } = mintDownloadToken({ key, fileId: 'F1', now });
    expect(Date.parse(expiresAt) - now).toBe(DEFAULT_TTL_SECONDS * 1000);
  });

  it('clamps a ttl above the ceiling rather than refusing it', () => {
    const key = deriveKey(INTERNAL, 'slack', BOT);
    const now = Date.UTC(2026, 0, 1);
    const { expiresAt } = mintDownloadToken({
      key,
      fileId: 'F1',
      ttlSeconds: MAX_TTL_SECONDS * 10,
      now,
    });
    expect(Date.parse(expiresAt) - now).toBe(MAX_TTL_SECONDS * 1000);
  });

  it('mints a distinct token each time, so one link is never another', () => {
    const key = deriveKey(INTERNAL, 'slack', BOT);
    const a = mintDownloadToken({ key, fileId: 'F1' });
    const b = mintDownloadToken({ key, fileId: 'F1' });
    expect(a.token).not.toBe(b.token);
  });
});

describe('verify refuses', () => {
  const key = deriveKey(INTERNAL, 'slack-zimmer', BOT);

  it('a token minted for a different slug — the binding is in the key', () => {
    const { token } = mintDownloadToken({
      key: deriveKey(INTERNAL, 'slack', BOT),
      fileId: 'F123',
    });
    // The same image, the same internal token, a different workspace's mount.
    expect(verifyDownloadToken({ key, token }).ok).toBe(false);
  });

  it('a token minted by the same slug against a DIFFERENT workspace', () => {
    const { token } = mintDownloadToken({
      key: deriveKey(INTERNAL, 'slack-zimmer', 'xoxb-the-other-workspace'),
      fileId: 'F123',
    });
    expect(verifyDownloadToken({ key, token }).ok).toBe(false);
  });

  it('a token minted under a different internal token', () => {
    const { token } = mintDownloadToken({
      key: deriveKey('some-other-deployment', 'slack-zimmer', BOT),
      fileId: 'F123',
    });
    expect(verifyDownloadToken({ key, token }).ok).toBe(false);
  });

  it('an expired token', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const { token } = mintDownloadToken({ key, fileId: 'F1', ttlSeconds: 60, now });
    expect(verifyDownloadToken({ key, token, now: now + 59_000 }).ok).toBe(true);
    expect(verifyDownloadToken({ key, token, now: now + 61_000 }).ok).toBe(false);
  });

  it('a payload edited to name a different file', () => {
    const { token } = mintDownloadToken({ key, fileId: 'F111' });
    const [body, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf-8')) as {
      f: string;
    };
    payload.f = 'F999';
    const forged = `${Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')}.${sig}`;

    expect(verifyDownloadToken({ key, token: forged }).ok).toBe(false);
  });

  it('a payload edited to extend its own expiry', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const { token } = mintDownloadToken({ key, fileId: 'F1', ttlSeconds: 60, now });
    const [body, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf-8')) as {
      exp: number;
    };
    payload.exp = now + 86_400_000;
    const forged = `${Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')}.${sig}`;

    expect(verifyDownloadToken({ key, token: forged, now: now + 61_000 }).ok).toBe(false);
  });

  it('a tampered signature', () => {
    const { token } = mintDownloadToken({ key, fileId: 'F1' });
    const [body, sig] = token.split('.');
    expect(verifyDownloadToken({ key, token: `${body}.${sig!.slice(0, -1)}X` }).ok).toBe(false);
  });

  it('garbage, an empty string and a token with no signature at all', () => {
    for (const token of ['', '.', 'nonsense', 'body.', '.sig', 'a.b.c']) {
      expect(verifyDownloadToken({ key, token }).ok).toBe(false);
    }
  });

  it('says the same thing however it failed, and never echoes the token', () => {
    const expired = mintDownloadToken({ key, fileId: 'F1', ttlSeconds: 1, now: 0 });
    const a = verifyDownloadToken({ key, token: expired.token, now: 10_000 });
    const b = verifyDownloadToken({ key, token: 'nonsense' });

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok && !b.ok) {
      expect(a.error).toBe(b.error);
      expect(a.status).toBe(403);
      expect(a.error).not.toContain(expired.token);
    }
  });
});

describe('the token itself', () => {
  it('carries no filename — it travels in a URL and therefore into access logs', () => {
    const key = deriveKey(INTERNAL, 'slack', BOT);
    const { token } = mintDownloadToken({ key, fileId: 'F123' });
    const decoded = Buffer.from(token.split('.')[0]!, 'base64url').toString('utf-8');

    expect(decoded).toContain('F123');
    expect(decoded.toLowerCase()).not.toContain('tax');
    expect(Object.keys(JSON.parse(decoded) as object).sort()).toEqual(['exp', 'f', 'n', 'v']);
  });

  it('is URL-safe, so nothing is mangled by being put in a path', () => {
    const key = deriveKey(INTERNAL, 'slack', BOT);
    for (let i = 0; i < 50; i++) {
      const { token } = mintDownloadToken({ key, fileId: 'F1' });
      expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(encodeURIComponent(token)).toBe(token);
    }
  });
});

describe('NonceLedger', () => {
  it('lets a nonce through once and refuses it after', () => {
    const ledger = new NonceLedger();
    expect(ledger.claim('n1', Date.now() + 60_000)).toBe(true);
    expect(ledger.claim('n1', Date.now() + 60_000)).toBe(false);
  });

  it('releases a claim so a failed download does not burn the link', () => {
    const ledger = new NonceLedger();
    const exp = Date.now() + 60_000;
    expect(ledger.claim('n1', exp)).toBe(true);
    ledger.release('n1');
    expect(ledger.claim('n1', exp)).toBe(true);
  });

  it('forgets a nonce once it has expired, so the set cannot grow forever', () => {
    const ledger = new NonceLedger();
    const now = 1_000_000;
    ledger.claim('n1', now + 1_000, now);
    // Past its expiry the nonce is pruned — and a token bearing it is refused by
    // verifyDownloadToken anyway, which is what makes forgetting it safe.
    expect(ledger.claim('n1', now + 1_000, now + 2_000)).toBe(true);
  });

  it('keeps distinct nonces apart', () => {
    const ledger = new NonceLedger();
    const exp = Date.now() + 60_000;
    expect(ledger.claim('a', exp)).toBe(true);
    expect(ledger.claim('b', exp)).toBe(true);
    expect(ledger.claim('a', exp)).toBe(false);
  });

  it('bounds its own size, dropping the oldest entries first', () => {
    const ledger = new NonceLedger(3);
    const exp = Date.now() + 600_000;
    for (const n of ['a', 'b', 'c', 'd']) ledger.claim(n, exp);
    // 'a' was evicted to make room for 'd'; the three most recent still hold.
    expect(ledger.claim('b', exp)).toBe(false);
    expect(ledger.claim('d', exp)).toBe(false);
  });
});
