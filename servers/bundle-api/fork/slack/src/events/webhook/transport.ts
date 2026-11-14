/**
 * The one way a webhook POST leaves this process, and the SSRF rules it obeys.
 *
 * A callback URL is chosen by whoever subscribes, so every request to one is a
 * request to an address an outsider picked. Draft SEP-3415 asks for, and this
 * does:
 *
 *   - `https://` only, refused at subscribe time;
 *   - the hostname resolved AT DELIVERY TIME, on every attempt, and refused if
 *     ANY address it resolves to is not globally routable (the IANA
 *     special-purpose registries: loopback, RFC 1918, link-local, CGNAT, ULA,
 *     documentation, multicast — and every IPv4-mapped or IPv4-compatible
 *     IPv6 address, whatever it carries, in any spelling);
 *   - the connection made to the address that was checked, with the original
 *     hostname as SNI and `Host`, so DNS cannot change between the check and
 *     the connect (rebinding);
 *   - no redirect followed: a 3xx is a failed attempt like any other non-2xx.
 *
 * Failures are reported as the draft's categories — `connection_refused`,
 * `timeout`, `tls_error`, `http_4xx`, `http_5xx` — and never as the far end's
 * own words, so a subscriber cannot use this server as an oracle for what an
 * internal URL answers. A refused address is `connection_refused`.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export type DeliveryErrorCategory =
  | 'connection_refused'
  | 'timeout'
  | 'tls_error'
  | 'http_4xx'
  | 'http_5xx'
  | 'challenge_failed';

export class DeliveryFailure extends Error {
  constructor(
    readonly category: DeliveryErrorCategory,
    readonly status?: number
  ) {
    super(`webhook delivery failed: ${category}${status ? ` (${status})` : ''}`);
    this.name = 'DeliveryFailure';
  }
}

export class InvalidCallbackUrl extends Error {
  constructor(reason: string) {
    super(`delivery.url ${reason}`);
    this.name = 'InvalidCallbackUrl';
  }
}

export interface WebhookResponse {
  status: number;
  /** At most {@link MAX_RESPONSE_BYTES}; only a verification answer is ever read. */
  body: string;
}

/** What delivery and verification need from the network. Tests substitute their own. */
export interface WebhookTransport {
  post(url: string, headers: Record<string, string>, body: string): Promise<WebhookResponse>;
}

export const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4096;
const MAX_URL_LENGTH = 2048;

/** Subscribe-time checks: what can be decided without resolving anything. */
export function validateCallbackUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length === 0) throw new InvalidCallbackUrl('is required');
  if (raw.length > MAX_URL_LENGTH) throw new InvalidCallbackUrl('is too long');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidCallbackUrl('is not a URL');
  }
  if (url.protocol !== 'https:') throw new InvalidCallbackUrl('must be https');
  if (url.username || url.password) throw new InvalidCallbackUrl('must not carry credentials');
  if (url.hash) throw new InvalidCallbackUrl('must not carry a fragment');
  const host = bareHost(url.hostname);
  if (isIP(host) && !isGloballyRoutable(host)) {
    throw new InvalidCallbackUrl('must not point at a private, loopback or reserved address');
  }
  if (!isIP(host) && (host === 'localhost' || host.endsWith('.localhost'))) {
    throw new InvalidCallbackUrl('must not point at localhost');
  }
  return url;
}

/** `[::1]` → `::1`. */
function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Not globally routable: the IANA IPv4 and IPv6 special-purpose registries,
 * less the few entries in them that ARE globally reachable (none of which a
 * webhook receiver would sit on, so they are refused too).
 */
const NOT_GLOBAL_V4 = new BlockList();
const NOT_GLOBAL_V6 = new BlockList();
/**
 * Two lists, one per family: a single `BlockList` matches an IPv4 address
 * against IPv4-mapped IPv6 rules too, so `::ffff:0:0/96` in one list would
 * refuse every IPv4 address there is.
 *
 * Every IPv4-mapped (`::ffff:0:0/96`) and IPv4-compatible (`::/96`) address is
 * refused outright rather than unwrapped and judged as the IPv4 address it
 * carries. Unwrapping by spelling is what a bypass looks like: Node's URL
 * parser rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, which no dotted
 * pattern matches. The BlockList compares bytes, so every spelling is caught,
 * and no real receiver is addressed by a mapped literal.
 */
(() => {
  const b = NOT_GLOBAL_V4;
  const v4: [string, number][] = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.31.196.0', 24],
    ['192.52.193.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['192.175.48.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  for (const [net, prefix] of v4) b.addSubnet(net, prefix, 'ipv4');
  const v6: [string, number][] = [
    ['::', 96],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
    ['5f00::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ];
  for (const [net, prefix] of v6) NOT_GLOBAL_V6.addSubnet(net, prefix, 'ipv6');
})();

export function isGloballyRoutable(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    return !NOT_GLOBAL_V6.check(address, 'ipv6');
  }
  return !NOT_GLOBAL_V4.check(address, 'ipv4');
}

/**
 * A `lookup` for `https.request` that resolves every address, refuses the
 * lot if any is not global, and hands the socket the first one — which is
 * therefore the address that was checked.
 */
export function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as LookupAddress[];
      const blocked = !allowPrivate && list.some((a) => !isGloballyRoutable(a.address));
      if (list.length === 0 || blocked) {
        const refused = Object.assign(new Error('callback address is not globally routable'), {
          code: 'ESTRADBLOCKED',
        });
        return callback(refused, '', 0);
      }
      const chosen = list[0]!;
      if ((options as { all?: boolean }).all) {
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, [chosen]);
      }
      return callback(null, chosen.address, chosen.family);
    });
  };
}

const TLS_CODES = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_OSSL)/;

function categorize(err: unknown): DeliveryErrorCategory {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (code === 'ETIMEDOUT' || code === 'ESTRADTIMEOUT') return 'timeout';
    if (TLS_CODES.test(code)) return 'tls_error';
  }
  return 'connection_refused';
}

export interface HttpsTransportOptions {
  timeoutMs?: number;
  /**
   * Tests only: allow `http:` and private addresses, so a suite can stand a
   * receiver up on loopback. Never set in production code paths.
   */
  insecureForTests?: boolean;
}

/** The production transport: Node's own `https`, behind {@link guardedLookup}. */
export class HttpsWebhookTransport implements WebhookTransport {
  private readonly timeoutMs: number;
  private readonly insecure: boolean;

  constructor(opts: HttpsTransportOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DELIVERY_TIMEOUT_MS;
    this.insecure = opts.insecureForTests === true;
  }

  post(url: string, headers: Record<string, string>, body: string): Promise<WebhookResponse> {
    const target = new URL(url);
    if (target.protocol !== 'https:' && !(this.insecure && target.protocol === 'http:')) {
      return Promise.reject(new DeliveryFailure('connection_refused'));
    }
    const literal = bareHost(target.hostname);
    if (isIP(literal) && !this.insecure && !isGloballyRoutable(literal)) {
      return Promise.reject(new DeliveryFailure('connection_refused'));
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const payload = Buffer.from(body, 'utf8');
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const req = send(
        target,
        {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/json',
            'content-length': String(payload.length),
          },
          lookup: guardedLookup(this.insecure),
          // A fresh connection per request: a pooled socket would skip the
          // lookup, and with it the delivery-time address check.
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            if (size < MAX_RESPONSE_BYTES) chunks.push(chunk);
            size += chunk.length;
          });
          res.on('end', () =>
            done(() =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString('utf8'),
              })
            )
          );
          res.on('error', (err) => done(() => reject(new DeliveryFailure(categorize(err)))));
        }
      );
      const timer = setTimeout(() => {
        req.destroy(Object.assign(new Error('timeout'), { code: 'ESTRADTIMEOUT' }));
      }, this.timeoutMs);
      timer.unref?.();
      req.on('error', (err) => done(() => reject(new DeliveryFailure(categorize(err)))));
      req.end(payload);
    });
  }
}

/** A response's status as a failure category, or null for a 2xx. */
export function statusCategory(status: number): DeliveryErrorCategory | null {
  if (status >= 200 && status < 300) return null;
  return status >= 500 ? 'http_5xx' : 'http_4xx';
}
