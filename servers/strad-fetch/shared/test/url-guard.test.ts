import { afterEach, describe, expect, it } from 'vitest';
import type dns from 'node:dns';
import {
  BlockedUrlError,
  assertFetchableUrl,
  blockedAddressReason,
  blockedHostReason,
  blockedUrlCause,
  createGuardedLookup,
} from '../src/scraping-client/url-guard.js';

/**
 * The guard in front of the native strategy (FORK.md #11).
 *
 * The failure this suite exists for is the silent one: a range nobody listed, a
 * spelling of an address the parser did not recognise, a name that resolves
 * somewhere the literal check cannot see. An over-strict guard shows up as a
 * failed scrape within the hour; an incomplete one shows up as tool output
 * containing something from inside the container.
 */

const ORIGINAL_ALLOWLIST = process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS;

afterEach(() => {
  if (ORIGINAL_ALLOWLIST === undefined) delete process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS;
  else process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS = ORIGINAL_ALLOWLIST;
});

function refusal(url: string): string {
  try {
    assertFetchableUrl(url);
  } catch (error) {
    if (error instanceof BlockedUrlError) return error.message;
    throw error;
  }
  throw new Error(`expected ${url} to be refused, and it was not`);
}

describe('the scheme allowlist', () => {
  it.each(['http://example.com/', 'https://example.com/a?b=c'])('allows %s', (url) => {
    expect(assertFetchableUrl(url).protocol).toMatch(/^https?:$/);
  });

  it.each([
    'file:///etc/passwd',
    'data:text/plain;base64,aGk=',
    'ftp://example.com/x',
    'gopher://example.com:70/_x',
    'ws://example.com/',
    'blob:https://example.com/abc',
  ])('refuses %s', (url) => {
    expect(refusal(url)).toContain('http and https only');
  });
});

describe('IPv4 literals', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.99.1.2', 'loopback'],
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
  ])('refuses %s', (address, why) => {
    expect(refusal(`http://${address}/x`)).toContain(why);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '11.0.0.1'])(
    'allows the public address %s',
    (address) => {
      expect(blockedAddressReason(address)).toBeNull();
      expect(assertFetchableUrl(`http://${address}/x`).hostname).toBe(address);
    }
  );

  it.each(['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/'])(
    'refuses %s, the same address spelled to slip past a string match',
    (url) => {
      expect(refusal(url)).toContain('loopback');
    }
  );
});

describe('IPv6 literals', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['100::1', 'discard-only'],
    ['2001:db8::1', 'documentation'],
    ['2001::1', 'Teredo'],
    ['fec0::1', 'site-local'],
  ])('refuses [%s]', (address, why) => {
    expect(refusal(`http://[${address}]/x`)).toContain(why);
  });

  it.each([
    ['::ffff:127.0.0.1', 'IPv4-mapped', 'loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped', 'link-local'],
    ['::ffff:192.168.0.1', 'IPv4-mapped', 'private'],
    ['::127.0.0.1', 'IPv4-compatible', 'loopback'],
    ['::ffff:0:7f00:1', 'IPv4-translated', 'loopback'],
    ['64:ff9b::169.254.169.254', 'NAT64', 'link-local'],
    ['2002:7f00:1::', '6to4', 'loopback'],
  ])('refuses [%s], an %s form carrying a blocked IPv4 address', (address, form, why) => {
    const message = refusal(`http://[${address}]/x`);
    expect(message).toContain(form);
    expect(message).toContain(why);
  });

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'allows the public address %s',
    (address) => {
      expect(blockedAddressReason(address)).toBeNull();
      expect(() => assertFetchableUrl(`http://[${address}]/x`)).not.toThrow();
    }
  );

  // The IPv4-carrying forms carve the usable part out of a block that is
  // reserved in full, so a spelling none of them claims is a spelling nobody
  // assigned — and `::` is exactly where a novel one would appear.
  it.each(['::ffff:0:0:0:1', '::1:2:3:4:5'])(
    'refuses [%s], a ::/8 form no rule claims',
    (address) => {
      expect(refusal(`http://[${address}]/x`)).toContain('reserved ::/8');
    }
  );

  it('still allows an IPv4-mapped PUBLIC address, which also sits in ::/8', () => {
    expect(blockedAddressReason('::ffff:8.8.8.8')).toBeNull();
    expect(blockedAddressReason('64:ff9b::8.8.8.8')).toBeNull();
  });
});

describe('hosts that are names', () => {
  it.each(['localhost', 'LOCALHOST', 'localhost.', 'api.localhost'])('refuses %s', (host) => {
    expect(refusal(`http://${host}:8080/x`)).toContain('loopback interface');
  });

  // `${bundle.PRIVATE_URL}` is `http://bundle-name:8080` (`src/deploy/appspec.ts`),
  // so the deployment's own private network is addressed by bare label. Nothing
  // in the range check can see that, which is what makes this rule the one that
  // covers the third destination the defect named.
  it.each(['strad-bundle', 'core', 'bundle-zimmer-secrets', 'metadata'])(
    'refuses the single-label name %s, which is how a private component is addressed',
    (host) => {
      expect(refusal(`http://${host}:8080/x`)).toContain('single-label');
    }
  );

  it.each([
    'metadata.google.internal',
    'printer.local',
    'db.localdomain',
    'thing.home.arpa',
    'x.alt',
  ])('refuses the special-use name %s', (host) => {
    expect(refusal(`http://${host}/x`)).toContain('reserved for private networks');
  });

  it('has nothing to say about an ordinary name — that is the resolver’s job', () => {
    expect(blockedHostReason('example.com')).toBeNull();
    expect(blockedHostReason('sub.example.co.uk')).toBeNull();
    expect(blockedHostReason('alt.example')).toBeNull();
  });

  it('does not mistake an IPv6 literal for a single-label name', () => {
    expect(blockedHostReason('2606:4700:4700::1111')).toBeNull();
    expect(refusal('http://[::1]/x')).toContain('loopback');
  });

  it('refuses a URL with no host at all', () => {
    expect(blockedHostReason('')).toContain('names no host');
  });
});

describe('blockedAddressReason fails closed', () => {
  it.each(['', 'not-an-address', '999.1.1.1', '::gggg'])('refuses %s', (value) => {
    expect(blockedAddressReason(value)).not.toBeNull();
  });
});

describe('STRAD_FETCH_ALLOW_PRIVATE_HOSTS', () => {
  it('lets an operator name a private host, and only the ones named', () => {
    process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS = '127.0.0.1, my-dev-box.internal';

    expect(() => assertFetchableUrl('http://127.0.0.1:8080/x')).not.toThrow();
    expect(blockedHostReason('my-dev-box.internal')).toBeNull();
    expect(refusal('http://127.0.0.2:8080/x')).toContain('loopback');
    expect(refusal('http://169.254.169.254/latest/meta-data/')).toContain('link-local');
  });

  it('is empty by default, so nothing private is reachable without a decision', () => {
    delete process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS;
    expect(refusal('http://127.0.0.1:8080/x')).toContain('loopback');
  });

  it('does not widen the scheme allowlist', () => {
    process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS = '127.0.0.1';
    expect(refusal('file:///etc/passwd')).toContain('http and https only');
  });
});

/**
 * The resolved-address half. A literal check cannot see a NAME that points into
 * a private range, and forcing `all: true` is what stops a record set with one
 * public and one private address from being a race.
 */
describe('createGuardedLookup', () => {
  const resolver =
    (table: Record<string, dns.LookupAddress[]>) =>
    (hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
      const entries = table[hostname];
      if (!entries) {
        callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
        return;
      }
      // Honour `all` the way `dns.lookup` does, so the bypass case below is
      // asserting the shape the caller ASKED for rather than the only shape
      // this fake can produce.
      if (options.all) callback(null, entries);
      else callback(null, entries[0].address, entries[0].family);
    };

  const lookup = (
    table: Record<string, dns.LookupAddress[]>,
    hostname: string,
    options: dns.LookupOptions = {}
  ) =>
    new Promise<{ error: unknown; address: unknown; family: unknown }>((resolve) => {
      createGuardedLookup(resolver(table) as unknown as typeof dns.lookup)(
        hostname,
        options,
        (error, address, family) => resolve({ error, address, family })
      );
    });

  it('refuses a name that resolves into a private range', async () => {
    const { error } = await lookup(
      { 'rebind.example': [{ address: '127.0.0.1', family: 4 }] },
      'rebind.example'
    );
    expect(error).toBeInstanceOf(BlockedUrlError);
    expect((error as Error).message).toContain('resolves to 127.0.0.1');
    expect((error as Error).message).toContain('loopback');
  });

  it('refuses a name that resolves into a private IPv6 range', async () => {
    const { error } = await lookup(
      { 'rebind6.example': [{ address: 'fe80::1', family: 6 }] },
      'rebind6.example'
    );
    expect((error as Error).message).toContain('link-local');
  });

  it('refuses a record set where only ONE address is private', async () => {
    const { error } = await lookup(
      {
        'mixed.example': [
          { address: '93.184.216.34', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ],
      },
      'mixed.example'
    );
    expect(error).toBeInstanceOf(BlockedUrlError);
    expect((error as Error).message).toContain('169.254.169.254');
  });

  it('passes a public name through, in the single-address shape', async () => {
    const { error, address, family } = await lookup(
      { 'ok.example': [{ address: '93.184.216.34', family: 4 }] },
      'ok.example'
    );
    expect(error).toBeNull();
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('passes a public name through, in the all: true shape net.connect asks for', async () => {
    const entries = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    const { error, address } = await lookup({ 'ok.example': entries }, 'ok.example', { all: true });
    expect(error).toBeNull();
    expect(address).toEqual(entries);
  });

  it('refuses a name that resolves to nothing', async () => {
    const { error } = await lookup({ 'empty.example': [] }, 'empty.example');
    expect(error).toBeInstanceOf(BlockedUrlError);
  });

  it('reports a resolver failure as itself, not as a refusal', async () => {
    const { error } = await lookup({}, 'missing.example');
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BlockedUrlError);
  });

  it('hands an allowlisted host to the resolver unguarded', async () => {
    process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS = 'dev.example';
    const { error, address } = await lookup(
      { 'dev.example': [{ address: '127.0.0.1', family: 4 }] },
      'dev.example'
    );
    expect(error).toBeNull();
    expect(address).toBe('127.0.0.1');
  });

  it('hands an allowlisted host through in the all: true shape as well', async () => {
    process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS = 'dev.example';
    const entries = [{ address: '127.0.0.1', family: 4 }];
    const { error, address } = await lookup({ 'dev.example': entries }, 'dev.example', {
      all: true,
    });
    expect(error).toBeNull();
    expect(address).toEqual(entries);
  });
});

describe('blockedUrlCause', () => {
  it('finds the refusal under undici’s "fetch failed"', () => {
    const blocked = new BlockedUrlError('nope');
    expect(blockedUrlCause(new TypeError('fetch failed', { cause: blocked }))).toBe(blocked);
  });

  it('finds it inside an AggregateError, which is how happy-eyeballs reports', () => {
    const blocked = new BlockedUrlError('nope');
    const aggregate = new AggregateError([new Error('ECONNREFUSED'), blocked]);
    expect(blockedUrlCause(new TypeError('fetch failed', { cause: aggregate }))).toBe(blocked);
  });

  it('does not run away on a cause that points at itself', () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(blockedUrlCause(looped)).toBeNull();
  });

  it('returns null for an unrelated failure', () => {
    expect(blockedUrlCause(new Error('ECONNRESET'))).toBeNull();
  });
});
