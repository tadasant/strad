/**
 * The URL guard in front of the native strategy.
 *
 * FORK DELTA (FORK.md #11). Upstream calls `fetch(url)` on whatever string the
 * caller put in `scrape`'s `url`. As a per-session stdio subprocess that was a
 * fetch from the agent's own sandbox; behind strad it is a fetch from the
 * container that hosts twenty-one mounts, so an entitled caller could aim the
 * tool at `http://127.0.0.1:<port>`, at `http://169.254.169.254/…`, or at App
 * Platform's private component network, and read the response back as tool
 * output. The `scrape` tool is for the public web; this module is what makes
 * that sentence true.
 *
 * Three checks, because no one of them covers the others:
 *
 *  1. `assertFetchableUrl` — the scheme allowlist and the literal-address check,
 *     run before anything is dispatched, so the ordinary case fails fast with a
 *     message that says which rule it broke.
 *  2. `createGuardedLookup` — every DNS resolution the fetch performs, so a NAME
 *     that points into a private range is rejected. Forcing `all: true` means a
 *     record set with one public and one private address is rejected on the
 *     private one rather than raced against it.
 *  3. `createGuardedDispatcher` — the connector, which runs once per CONNECTION
 *     rather than once per call. This is the one that closes the two holes the
 *     first check cannot see: the resolve-then-connect race (the lookup that
 *     decides the socket is the guarded one, so there is no second, unchecked
 *     resolution), and REDIRECTS — a public page that 302s to `127.0.0.1` is a
 *     fresh dispatch through the same dispatcher, and an IP literal never
 *     reaches a resolver at all.
 *
 * `STRAD_FETCH_ALLOW_PRIVATE_HOSTS` is the operator's escape hatch: a
 * comma-separated list of hostnames or IP literals that may be reached anyway,
 * empty by default. It is for pointing a development gateway at a service on
 * the same box; it is deliberately a list rather than an off switch.
 */

import { isIP, type LookupFunction } from 'node:net';
import dns from 'node:dns';
import { Agent, buildConnector } from 'undici';

/** A URL the native strategy refuses to fetch, and why. */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Address blocks the native strategy will not reach.
 *
 * Wider than the loopback/link-local/RFC1918 set the defect was reported
 * against, on purpose: an over-strict guard is a failed scrape somebody reports
 * within the hour, and an incomplete one fails open in silence. Everything here
 * is either unroutable on the public internet or names infrastructure the
 * container sits inside.
 */
const IPV4_BLOCKS: Array<{ cidr: string; why: string }> = [
  { cidr: '0.0.0.0/8', why: 'in the "this network" block (0.0.0.0/8)' },
  { cidr: '10.0.0.0/8', why: 'a private address (10.0.0.0/8)' },
  { cidr: '100.64.0.0/10', why: 'a carrier-grade NAT address (100.64.0.0/10)' },
  { cidr: '127.0.0.0/8', why: 'a loopback address (127.0.0.0/8)' },
  { cidr: '169.254.0.0/16', why: 'a link-local address (169.254.0.0/16) — the cloud metadata range' },
  { cidr: '172.16.0.0/12', why: 'a private address (172.16.0.0/12)' },
  { cidr: '192.0.0.0/24', why: 'an IETF protocol-assignment address (192.0.0.0/24)' },
  { cidr: '192.168.0.0/16', why: 'a private address (192.168.0.0/16)' },
  { cidr: '198.18.0.0/15', why: 'a benchmarking address (198.18.0.0/15)' },
  { cidr: '224.0.0.0/4', why: 'a multicast address (224.0.0.0/4)' },
  { cidr: '240.0.0.0/4', why: 'a reserved address (240.0.0.0/4)' },
];

/** IPv6 blocks checked against the address itself. */
const IPV6_BLOCKS: Array<{ cidr: string; why: string }> = [
  { cidr: '::/128', why: 'the unspecified address (::)' },
  { cidr: '::1/128', why: 'the loopback address (::1)' },
  { cidr: '64:ff9b:1::/48', why: 'a local-use NAT64 address (64:ff9b:1::/48)' },
  { cidr: '100::/64', why: 'a discard-only address (100::/64)' },
  { cidr: '2001:db8::/32', why: 'a documentation address (2001:db8::/32)' },
  { cidr: '2001::/32', why: 'a Teredo tunnel address (2001::/32)' },
  { cidr: 'fc00::/7', why: 'a unique-local address (fc00::/7)' },
  { cidr: 'fec0::/10', why: 'a deprecated site-local address (fec0::/10)' },
  { cidr: 'fe80::/10', why: 'a link-local address (fe80::/10)' },
  { cidr: 'ff00::/8', why: 'a multicast address (ff00::/8)' },
];

/**
 * IPv6 forms that CARRY an IPv4 address. Each is checked by pulling the four
 * bytes out and running the IPv4 rules over them, so `::ffff:127.0.0.1` and
 * `2002:7f00:1::` are blocked for the same reason `127.0.0.1` is — which is the
 * hole a flat list of IPv6 prefixes leaves open.
 */
const IPV6_EMBEDDED_IPV4: Array<{ cidr: string; offset: number; form: string }> = [
  { cidr: '::ffff:0:0/96', offset: 12, form: 'IPv4-mapped' },
  { cidr: '::ffff:0:0:0/96', offset: 12, form: 'IPv4-translated' },
  { cidr: '::/96', offset: 12, form: 'IPv4-compatible' },
  { cidr: '64:ff9b::/96', offset: 12, form: 'NAT64' },
  { cidr: '2002::/16', offset: 2, form: '6to4' },
];

/** Dotted-quad only: every other IPv4 spelling is normalised away by `new URL()`. */
function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Sixteen bytes, or null. Handles `::` compression and a trailing dotted quad. */
function parseIpv6(text: string): number[] | null {
  const zone = text.indexOf('%');
  const address = zone === -1 ? text : text.slice(0, zone);
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const expand = (chunk: string): number[] | null => {
    if (chunk === '') return [];
    const groups = chunk.split(':');
    const bytes: number[] = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      if (index === groups.length - 1 && group.includes('.')) {
        const embedded = parseIpv4(group);
        if (!embedded) return null;
        bytes.push(...embedded);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const value = parseInt(group, 16);
      bytes.push(value >> 8, value & 0xff);
    }
    return bytes;
  };

  const head = expand(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 16 ? head : null;

  const tail = expand(halves[1]);
  if (!tail) return null;
  const gap = 16 - head.length - tail.length;
  if (gap < 0) return null;
  return [...head, ...new Array<number>(gap).fill(0), ...tail];
}

function parseCidr(cidr: string): { prefix: number[]; bits: number } {
  const [address, length] = cidr.split('/');
  const prefix = address.includes(':') ? parseIpv6(address) : parseIpv4(address);
  if (!prefix) throw new Error(`unparseable CIDR constant: ${cidr}`);
  return { prefix, bits: Number(length) };
}

/** Byte-wise prefix match, so one implementation serves both address families. */
function inBlock(address: number[], prefix: number[], bits: number): boolean {
  const whole = bits >> 3;
  for (let index = 0; index < whole; index++) {
    if (address[index] !== prefix[index]) return false;
  }
  const remainder = bits & 7;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (address[whole] & mask) === (prefix[whole] & mask);
}

const IPV4_RULES = IPV4_BLOCKS.map((block) => ({ ...parseCidr(block.cidr), why: block.why }));
const IPV6_RULES = IPV6_BLOCKS.map((block) => ({ ...parseCidr(block.cidr), why: block.why }));
const IPV6_EMBEDDED_RULES = IPV6_EMBEDDED_IPV4.map((block) => ({
  ...parseCidr(block.cidr),
  offset: block.offset,
  form: block.form,
}));

function blockedIpv4Reason(octets: number[]): string | null {
  const rule = IPV4_RULES.find((candidate) => inBlock(octets, candidate.prefix, candidate.bits));
  return rule ? rule.why : null;
}

function blockedIpv6Reason(bytes: number[]): string | null {
  const direct = IPV6_RULES.find((candidate) => inBlock(bytes, candidate.prefix, candidate.bits));
  if (direct) return direct.why;

  for (const rule of IPV6_EMBEDDED_RULES) {
    if (!inBlock(bytes, rule.prefix, rule.bits)) continue;
    const embedded = bytes.slice(rule.offset, rule.offset + 4);
    const reason = blockedIpv4Reason(embedded);
    if (reason) return `${rule.form} for ${embedded.join('.')}, which is ${reason}`;
  }

  return null;
}

/**
 * Why this address may not be reached, or null if it may be.
 *
 * Fails CLOSED: something that is not an address, or an address neither parser
 * can read, is refused rather than allowed. This runs over resolved addresses,
 * where "I could not read it" is not a reason to connect.
 */
export function blockedAddressReason(address: string): string | null {
  const family = isIP(address);
  if (family === 4) {
    const octets = parseIpv4(address);
    if (!octets) return 'an address that could not be read';
    return blockedIpv4Reason(octets);
  }
  if (family === 6) {
    const bytes = parseIpv6(address);
    if (!bytes) return 'an address that could not be read';
    return blockedIpv6Reason(bytes);
  }
  return 'not an IP address';
}

/**
 * `[::1]` and `::1` are the same host, and one trailing dot is the same name.
 *
 * Matching against the allowlist is exact after this, so a punycode or unicode
 * spelling that does not normalise to a listed entry fails closed.
 */
function normalizeHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.') && host.length > 1) host = host.slice(0, -1);
  return host;
}

/** Memoised on the raw variable: this is read twice per connection. */
let allowlist: { raw: string; hosts: Set<string> } | undefined;

function allowedHosts(): Set<string> {
  const raw = process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS || '';
  if (!allowlist || allowlist.raw !== raw) {
    allowlist = {
      raw,
      hosts: new Set(
        raw
          .split(',')
          .map((entry) => normalizeHost(entry))
          .filter((entry) => entry.length > 0)
      ),
    };
  }
  return allowlist.hosts;
}

/** Has the operator named this host in `STRAD_FETCH_ALLOW_PRIVATE_HOSTS`? */
export function isAllowedHost(hostname: string): boolean {
  return allowedHosts().has(normalizeHost(hostname));
}

/**
 * Why this HOST may not be reached, or null if nothing here objects.
 *
 * Null is not a promise that the host is public — a name is only known to be
 * public once it has been resolved, which is `createGuardedLookup`'s job.
 */
export function blockedHostReason(hostname: string): string | null {
  const host = normalizeHost(hostname);
  if (host === '') return 'the URL names no host';
  if (isAllowedHost(host)) return null;

  if (isIP(host) !== 0) {
    const reason = blockedAddressReason(host);
    return reason ? `${host} is ${reason}` : null;
  }

  // RFC 6761 reserves these for the loopback interface. The resolver would
  // catch them too; naming them here makes the common local-development
  // mistake say so plainly instead of surfacing as a connect failure.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return `${host} is a name reserved for the loopback interface`;
  }

  return null;
}

/**
 * Parse and check a URL the caller asked to scrape.
 *
 * Throws `BlockedUrlError` with a message written for whoever called the tool:
 * it is returned as the native strategy's failure, so it lands in the scrape
 * result rather than in a log nobody reads.
 */
export function assertFetchableUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BlockedUrlError(`Not a URL the native strategy can fetch: ${input}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedUrlError(
      `Refusing to fetch ${input}: ${url.protocol} is not a scheme the native strategy fetches — http and https only.`
    );
  }

  const reason = blockedHostReason(url.hostname);
  if (reason) {
    throw new BlockedUrlError(
      `Refusing to fetch ${input}: ${reason}. The native strategy reaches the public internet only.`
    );
  }

  return url;
}

/** How a resolution failure is reported. `net` ignores the rest when it errors. */
type ErrorOnly = (error: Error) => void;

/** The resolver this wraps, flattened out of `dns.lookup`'s overloads. */
type Resolver = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: string | dns.LookupAddress[],
    family?: number
  ) => void
) => void;

/**
 * A `dns.lookup` that refuses to hand back a private address.
 *
 * Typed as node's own `LookupFunction`, so it cannot drift from what
 * `net.connect` calls. `resolve` is injectable so the resolved-address rule can
 * be tested without a name that really points at 127.0.0.1.
 */
export function createGuardedLookup(resolve: typeof dns.lookup = dns.lookup): LookupFunction {
  const lookup = resolve as unknown as Resolver;

  return (hostname, options, callback) => {
    // node's type demands an address alongside the error it will not read.
    const refuse = callback as unknown as ErrorOnly;

    if (isAllowedHost(hostname)) {
      // The operator named this host; hand it to the resolver unguarded.
      lookup(hostname, options, callback);
      return;
    }

    // `all: true` whatever was asked for: checking one address out of a record
    // set and connecting to another is the race this guard exists to lose.
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        refuse(error);
        return;
      }

      const entries = (Array.isArray(addresses) ? addresses : []) as dns.LookupAddress[];
      if (entries.length === 0) {
        refuse(new BlockedUrlError(`${hostname} resolved to no addresses`));
        return;
      }

      for (const entry of entries) {
        const reason = blockedAddressReason(entry.address);
        if (reason) {
          refuse(
            new BlockedUrlError(
              `Refusing to connect to ${hostname}: it resolves to ${entry.address}, which is ${reason}.`
            )
          );
          return;
        }
      }

      if (options.all) {
        callback(null, entries);
        return;
      }
      callback(null, entries[0].address, entries[0].family);
    });
  };
}

export interface GuardedDispatcherOptions {
  /** Resolver the guard wraps. Defaults to `dns.lookup`. */
  resolve?: typeof dns.lookup;
}

/**
 * An undici `Agent` that checks every connection it opens.
 *
 * Per CONNECTION rather than per call, which is what makes it cover redirects:
 * `fetch` dispatches each hop through the same dispatcher, so a public page
 * that 302s to `http://127.0.0.1:8080/` is refused at the connector — where an
 * IP literal, which never reaches a resolver, is also caught.
 */
export function createGuardedDispatcher(options: GuardedDispatcherOptions = {}): Agent {
  // `lookup` goes to buildConnector, not to the connector call: undici passes
  // its leftover build options through to `net.connect`, and destructures the
  // per-connection ones down to a fixed set that does not include this.
  const connect = buildConnector({ lookup: createGuardedLookup(options.resolve) });

  return new Agent({
    connect(connectOptions, callback) {
      const hostname = connectOptions.hostname ?? '';
      const reason = blockedHostReason(hostname);
      if (reason) {
        callback(
          new BlockedUrlError(
            `Refusing to connect to ${normalizeHost(hostname)}: ${reason}. The native strategy reaches the public internet only.`
          ),
          null
        );
        return;
      }
      connect(connectOptions, callback);
    },
  });
}

let sharedDispatcher: Agent | undefined;

/**
 * The process-wide guarded dispatcher.
 *
 * One per process, not one per scrape: the tool builds a fresh client on every
 * call, and an `Agent` owns a connection pool that a per-call instance would
 * leak.
 */
export function guardedDispatcher(): Agent {
  if (!sharedDispatcher) sharedDispatcher = createGuardedDispatcher();
  return sharedDispatcher;
}

/**
 * The `BlockedUrlError` behind a failure, wherever in the cause chain it is.
 *
 * A refusal raised inside the connector reaches the caller as undici's
 * `TypeError: fetch failed` with the real error as `cause`, and "fetch failed"
 * is exactly the message this guard exists to replace.
 */
export function blockedUrlCause(error: unknown, depth = 0): BlockedUrlError | null {
  if (error == null || depth > 8) return null;
  if (error instanceof BlockedUrlError) return error;

  // Happy-eyeballs collects one error per address it tried, so a refusal can
  // arrive as a member of an AggregateError rather than as a `cause`.
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const blocked = blockedUrlCause(inner, depth + 1);
      if (blocked) return blocked;
    }
  }

  return blockedUrlCause((error as { cause?: unknown }).cause, depth + 1);
}
