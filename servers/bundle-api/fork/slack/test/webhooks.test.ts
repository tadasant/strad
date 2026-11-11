// MCP Events webhook delivery (draft SEP-3415 @ b08e4f9) for `message_posted`.
//
// The contract with a receiver — Zimmer's, tadasant/zimmer#1484 — pinned here:
//
//   1. Standard Webhooks signing, checked against the specification's own
//      test vector and against an independent verifier in this file.
//   2. Challenge-echo verification before any delivery; a receiver that
//      answers anything but `2xx {"challenge":"<nonce>"}` (a Cloudflare Access
//      login redirect, a login page) is `challenge_failed`.
//   3. Retry: five attempts over 14½ minutes, the same webhook-id each time.
//      `410` and `413` are not retried; `429` is.
//   4. Sustained failure suspends instead of discarding; a refresh reactivates
//      and delivery catches up from the buffer.
//   5. The watermark cursor, in the same cursor space as events/poll, persisted
//      so a restarted process resumes.
//   6. TTL: the grant's clamps, and an expired subscription is not delivered to.
//   7. SSRF: https only, no private or loopback address, at subscribe and at
//      delivery time, no redirects.
//   8. Edge credentials (a Cloudflare Access service token) go to configured
//      hosts only.
import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { EventBuffer, decodeCursor, encodeCursor, parseMessagePostedArgs } from '../src/events/buffer.js';
import { readWebhookAccess } from '../src/events/config.js';
import { SlackEventsIngest } from '../src/events/ingest.js';
import type { MessagePostedData } from '../src/events/normalize.js';
import { MemoryBlobStore } from '../src/events/state-store.js';
import { EventsStore } from '../src/events/store.js';
import {
  CallbackEndpointError,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  SubscriptionNotFound,
  WebhookDelivery,
  accessHeadersFor,
  type SubscribeInput,
} from '../src/events/webhook/delivery.js';
import { grantTtl, MAX_TTL_MS, MIN_TTL_MS, readRegistry } from '../src/events/webhook/registry.js';
import { parseWebhookSecret, signatureHeader } from '../src/events/webhook/signing.js';
import {
  DeliveryFailure,
  HttpsWebhookTransport,
  guardedLookup,
  isGloballyRoutable,
  validateCallbackUrl,
  type WebhookResponse,
  type WebhookTransport,
} from '../src/events/webhook/transport.js';
import { createMCPServer } from '../src/server.js';

const T0 = Date.parse('2026-11-11T12:00:00Z');
const PERSIST_MS_FOR_TEST = 5_000;
const URL_A = 'https://zimmer.tadasant.com/webhooks/mcp_events/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NAME = 'slack-zimmer__message_posted';
const PRINCIPAL = 'token:zimmer';
const newSecret = () => `whsec_${randomBytes(32).toString('base64')}`;

// --- an independent Standard Webhooks verifier --------------------------------

function verify(secret: string, headers: Record<string, string>, body: string): boolean {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const want = createHmac('sha256', key)
    .update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`)
    .digest('base64');
  return (headers['webhook-signature'] ?? '').split(' ').some((sig) => sig === `v1,${want}`);
}

// --- a receiver ---------------------------------------------------------------

interface Received {
  url: string;
  headers: Record<string, string>;
  body: string;
  json: Record<string, unknown>;
  at: number;
}

class FakeReceiver implements WebhookTransport {
  received: Received[] = [];
  /** Deliveries only (not the challenge). */
  get deliveries(): Received[] {
    return this.received.filter((r) => r.json.type !== 'verification');
  }
  secret = '';
  /** What a delivery is answered with. A DeliveryFailure is thrown as-is. */
  answer: (r: Received) => WebhookResponse | DeliveryFailure = () => ({ status: 200, body: '' });
  challengeAnswer: ((r: Received) => WebhookResponse | DeliveryFailure) | null = null;

  constructor(private readonly clock: () => number) {}

  async post(url: string, headers: Record<string, string>, body: string): Promise<WebhookResponse> {
    const r: Received = { url, headers, body, json: JSON.parse(body), at: this.clock() };
    this.received.push(r);
    const out =
      r.json.type === 'verification'
        ? (this.challengeAnswer ?? this.echo.bind(this))(r)
        : this.answer(r);
    if (out instanceof DeliveryFailure) throw out;
    return out;
  }

  /** A correct receiver: echo only when the signature verifies. */
  echo(r: Received): WebhookResponse {
    if (!verify(this.secret, r.headers, r.body)) return { status: 401, body: '' };
    return { status: 200, body: JSON.stringify({ challenge: r.json.challenge }) };
  }
}

// --- a world: buffer, store, delivery ------------------------------------------

function message(n: number, channel = 'C1'): { eventId: string; timestamp: string; data: MessagePostedData } {
  const ts = `${Math.floor(T0 / 1000) + n}.000100`;
  return {
    eventId: `slack:${channel}:${ts}`,
    timestamp: new Date(T0 + n * 1000).toISOString(),
    data: {
      channel_id: channel,
      channel_type: 'channel',
      ts,
      is_dm: false,
      mentions_bot: false,
      permalink: `https://tadasant.slack.com/archives/${channel}/p${ts.replace('.', '')}`,
      text: `message ${n}`,
    },
  };
}

function world(
  opts: { blobs?: MemoryBlobStore; access?: Parameters<typeof accessHeadersFor>[0]; retentionMs?: number } = {}
) {
  let now = T0;
  const clock = () => now;
  const blobs = opts.blobs ?? new MemoryBlobStore();
  const store = new EventsStore(blobs, Buffer.alloc(32, 9), 'slack-events', clock);
  const buffer = new EventBuffer(opts.retentionMs ?? 7 * 86_400_000, clock);
  const receiver = new FakeReceiver(clock);
  const delivery = new WebhookDelivery({
    store,
    source: {
      head: () => buffer.head,
      evictedThrough: () => buffer.evictedThroughSeq,
      eventsAfter: (after, args, limit) => buffer.eventsAfter(after, args, limit),
    },
    transport: receiver,
    parseArgs: parseMessagePostedArgs,
    access: opts.access ?? null,
    clock,
  });
  const secret = newSecret();
  receiver.secret = secret;
  const input = (over: Partial<SubscribeInput> = {}): SubscribeInput => ({
    principal: PRINCIPAL,
    name: NAME,
    eventType: 'message_posted',
    arguments: {},
    parsedArguments: parseMessagePostedArgs({}),
    url: URL_A,
    secret: parseWebhookSecret(secret),
    cursor: null,
    maxAgeMs: undefined,
    ttlMs: 6 * 3600_000,
    ...over,
  });
  /** One delivery pass, every POST finished. */
  const tick = async (owner = true) => {
    await delivery.tick(owner);
    await delivery.settle();
  };
  const advance = (ms: number) => {
    now += ms;
  };
  return { blobs, store, buffer, receiver, delivery, secret, input, tick, advance, clock };
}

// =============================================================================

describe('signing', () => {
  it("matches the Standard Webhooks specification's test vector", () => {
    const key = parseWebhookSecret('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');
    expect(signatureHeader([key], 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}')).toBe(
      'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='
    );
  });

  it('signs with every key in a rotation window, space-separated', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const header = signatureHeader([a, b], 'msg_x', 1, '{}');
    expect(header.split(' ')).toHaveLength(2);
    expect(header.split(' ').every((s) => s.startsWith('v1,'))).toBe(true);
  });

  it('accepts whsec_ + base64 of 24 to 64 bytes and nothing else, never quoting the value', () => {
    for (const n of [24, 32, 64]) {
      expect(parseWebhookSecret(`whsec_${randomBytes(n).toString('base64')}`)).toHaveLength(n);
    }
    for (const bad of [
      `whsec_${randomBytes(16).toString('base64')}`,
      `whsec_${randomBytes(65).toString('base64')}`,
      randomBytes(32).toString('base64'),
      'whsec_not base64!',
      undefined,
    ]) {
      expect(() => parseWebhookSecret(bad), String(bad)).toThrow(/whsec_/);
      try {
        parseWebhookSecret(bad);
      } catch (err) {
        if (typeof bad === 'string' && bad.length > 10) expect((err as Error).message).not.toContain(bad);
      }
    }
  });
});

describe('SSRF', () => {
  it('knows which addresses are globally routable', () => {
    for (const ip of ['8.8.8.8', '104.16.0.1', '2606:4700::1111']) expect(isGloballyRoutable(ip), ip).toBe(true);
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.5.4',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      // The spellings Node's URL parser produces, and the compatible form.
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '0:0:0:0:0:ffff:7f00:1',
      '::127.0.0.1',
      '::7f00:1',
      // A mapped PUBLIC address is refused too: no receiver is addressed so.
      '::ffff:8.8.8.8',
      '2001:db8::1',
    ]) {
      expect(isGloballyRoutable(ip), ip).toBe(false);
    }
  });

  it('refuses a callback URL that is not https, carries credentials, or names a private host', () => {
    expect(validateCallbackUrl(URL_A).hostname).toBe('zimmer.tadasant.com');
    for (const bad of [
      'http://zimmer.tadasant.com/x',
      'https://user:pw@zimmer.tadasant.com/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://[::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://[::ffff:169.254.169.254]/x',
      'https://[0:0:0:0:0:ffff:a00:1]/x',
      'https://[::127.0.0.1]/x',
      'https://169.254.169.254/latest',
      'ftp://zimmer.tadasant.com/x',
      'not a url',
      42,
    ]) {
      expect(() => validateCallbackUrl(bad), String(bad)).toThrow(/delivery\.url/);
    }
  });

  describe('the real transport', () => {
    let server: HttpServer;
    let base = '';
    const hits: string[] = [];
    beforeAll(async () => {
      server = createServer((req, res) => {
        hits.push(req.url ?? '');
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          if (req.url === '/redirect') {
            res.writeHead(302, { location: `${base}/elsewhere` });
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ got: JSON.parse(body), sig: req.headers['webhook-signature'] }));
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('posts the body and headers, and reads the answer', async () => {
      const t = new HttpsWebhookTransport({ insecureForTests: true });
      const res = await t.post(`${base}/hook`, { 'webhook-signature': 'v1,abc' }, '{"a":1}');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ got: { a: 1 }, sig: 'v1,abc' });
    });

    it('never follows a redirect', async () => {
      const t = new HttpsWebhookTransport({ insecureForTests: true });
      hits.length = 0;
      const res = await t.post(`${base}/redirect`, {}, '{}');
      expect(res.status).toBe(302);
      expect(hits).toEqual(['/redirect']);
    });

    it('refuses a loopback address in production mode, at delivery time, as connection_refused', async () => {
      // A listener that counts connections: the guard must refuse before one is made.
      let connections = 0;
      const sink = createNetServer((socket) => {
        connections++;
        socket.destroy();
      });
      await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
      const port = (sink.address() as { port: number }).port;
      try {
        const t = new HttpsWebhookTransport();
        // A NAME that resolves to loopback, with a live listener behind it.
        await expect(t.post(`https://localhost:${port}/x`, {}, '{}')).rejects.toMatchObject({
          category: 'connection_refused',
        });
        // Mapped literals, in the spelling the URL parser normalises them to.
        for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '127.0.0.1']) {
          await expect(t.post(`https://${host}:${port}/x`, {}, '{}'), host).rejects.toMatchObject({
            category: 'connection_refused',
          });
        }
        expect(connections).toBe(0);
      } finally {
        await new Promise<void>((r) => sink.close(() => r()));
      }
    });

    it('the lookup itself refuses a name resolving to loopback, whatever family is asked for', async () => {
      for (const options of [{}, { all: true }, { family: 4 }]) {
        const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
          guardedLookup(false)('localhost', options as never, (e) => resolve(e))
        );
        expect(err?.code, JSON.stringify(options)).toBe('ESTRADBLOCKED');
      }
    });
  });
});

describe('subscribe and verify', () => {
  it('verifies with a signed challenge, then grants a subscription with a stable id', async () => {
    const w = world();
    const res = await w.delivery.subscribe(w.input());
    expect(res.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(res.truncated).toBe(false);
    expect(decodeCursor(res.cursor)).toBe(w.buffer.head);
    expect(Date.parse(res.refreshBefore)).toBe(T0 + 6 * 3600_000);

    const [challenge] = w.receiver.received;
    expect(challenge!.json).toMatchObject({ type: 'verification' });
    expect(typeof challenge!.json.challenge).toBe('string');
    expect(challenge!.headers['webhook-id']).toMatch(/^msg_verification_[A-Za-z0-9_-]+$/);
    expect(challenge!.headers['x-mcp-subscription-id']).toBe(res.id);
    expect(verify(w.secret, challenge!.headers, challenge!.body)).toBe(true);

    // A refresh does not challenge again, and the id does not move.
    const again = await w.delivery.subscribe(w.input());
    expect(again.id).toBe(res.id);
    expect(again.deliveryStatus).toEqual({ active: true, lastDeliveryAt: null, lastError: null });
    expect(w.receiver.received).toHaveLength(1);

    // Another principal at the same URL is challenged on its own.
    const other = await w.delivery.subscribe(w.input({ principal: 'token:other' }));
    expect(other.id).not.toBe(res.id);
    expect(w.receiver.received).toHaveLength(2);
  });

  it('refuses an endpoint that does not echo: wrong nonce, a login redirect, a login page, no answer', async () => {
    const cases: [string, (r: Received) => WebhookResponse | DeliveryFailure, string][] = [
      ['wrong echo', () => ({ status: 200, body: '{"challenge":"nope"}' }), 'challenge_failed'],
      ['Access redirect', () => ({ status: 302, body: '' }), 'challenge_failed'],
      ['Access login page', () => ({ status: 200, body: '<html>Sign in</html>' }), 'challenge_failed'],
      ['401', () => ({ status: 401, body: '' }), 'challenge_failed'],
      ['refused', () => new DeliveryFailure('connection_refused'), 'connection_refused'],
      ['timeout', () => new DeliveryFailure('timeout'), 'timeout'],
    ];
    for (const [label, answer, reason] of cases) {
      const w = world();
      w.receiver.challengeAnswer = answer;
      await expect(w.delivery.subscribe(w.input()), label).rejects.toMatchObject({ reason });
      await expect(w.delivery.subscribe(w.input()), label).rejects.toBeInstanceOf(CallbackEndpointError);
      expect((await readRegistry(w.store)).subscriptions, label).toEqual([]);
    }
  });

  it('grants a TTL inside its clamps, and never no-expiry', () => {
    expect(grantTtl(undefined)).toBe(3600_000);
    expect(grantTtl(null)).toBe(MAX_TTL_MS);
    expect(grantTtl(1000)).toBe(MIN_TTL_MS);
    expect(grantTtl(6 * 3600_000)).toBe(6 * 3600_000);
    expect(grantTtl(30 * 86_400_000)).toBe(MAX_TTL_MS);
  });

  it('takes a poll cursor as the start, and says truncated when it is older than the buffer', async () => {
    const w = world();
    for (let i = 1; i <= 3; i++) w.buffer.add(message(i));
    const pollCursor = w.buffer.poll({ cursor: 0, args: parseMessagePostedArgs({}), maxEvents: 1 }).cursor;
    const res = await w.delivery.subscribe(w.input({ cursor: pollCursor }));
    expect(res.truncated).toBe(false);
    expect(res.cursor).toBe(encodeCursor(pollCursor));
    await w.tick();
    // Events 2 and 3, the ones after the poll cursor, and only those.
    expect(w.receiver.deliveries.map((d) => (d.json.data as MessagePostedData).text)).toEqual([
      'message 2',
      'message 3',
    ]);
  });

  it('clamps a cursor ahead of the head, so nothing that arrives next is skipped', async () => {
    const w = world();
    const res = await w.delivery.subscribe(w.input({ cursor: w.buffer.head + 10_000_000_000 }));
    expect(decodeCursor(res.cursor)).toBe(w.buffer.head);
    w.buffer.add(message(1));
    await w.tick();
    expect(w.receiver.deliveries).toHaveLength(1);
  });

  it('unsubscribes by the same key, and NotFound after', async () => {
    const w = world();
    await w.delivery.subscribe(w.input());
    await w.delivery.unsubscribe({ principal: PRINCIPAL, name: NAME, url: URL_A, arguments: {} });
    await expect(
      w.delivery.unsubscribe({ principal: PRINCIPAL, name: NAME, url: URL_A, arguments: {} })
    ).rejects.toBeInstanceOf(SubscriptionNotFound);
    w.buffer.add(message(1));
    await w.tick();
    expect(w.receiver.deliveries).toEqual([]);
  });
});

describe('delivery', () => {
  it('POSTs each event signed, with the namespaced name, the eventId and a watermark cursor', async () => {
    const w = world();
    const sub = await w.delivery.subscribe(w.input());
    w.buffer.add(message(1));
    w.buffer.add(message(2));
    await w.tick();
    const [a, b] = w.receiver.deliveries;
    for (const d of [a!, b!]) {
      expect(verify(w.secret, d.headers, d.body)).toBe(true);
      expect(d.headers['x-mcp-subscription-id']).toBe(sub.id);
      expect(d.headers['webhook-id']).toMatch(/^msg_[A-Za-z0-9_-]{1,251}$/);
      expect(Number(d.headers['webhook-timestamp'])).toBe(Math.floor(T0 / 1000));
      expect(d.json.name).toBe(NAME);
    }
    expect(a!.json).toMatchObject({
      eventId: message(1).eventId,
      timestamp: message(1).timestamp,
      data: { text: 'message 1', channel_id: 'C1' },
    });
    // A payload's cursor is never ahead of an unacknowledged event.
    expect(decodeCursor(a!.json.cursor)).toBeLessThan(w.buffer.eventsAfter(0, parseMessagePostedArgs({}), 1)[0]!.seq);
    await w.tick();
    const status = await w.delivery.subscribe(w.input());
    expect(decodeCursor(status.cursor)).toBe(w.buffer.head);
    expect(status.deliveryStatus).toMatchObject({ active: true, lastError: null });
  });

  it('filters by the subscription arguments', async () => {
    const w = world();
    await w.delivery.subscribe(
      w.input({ arguments: { channel_ids: ['C2'] }, parsedArguments: parseMessagePostedArgs({ channel_ids: ['C2'] }) })
    );
    w.buffer.add(message(1, 'C1'));
    w.buffer.add(message(2, 'C2'));
    await w.tick();
    expect(w.receiver.deliveries.map((d) => (d.json.data as MessagePostedData).channel_id)).toEqual(['C2']);
  });

  it('retries on its schedule with the same webhook-id and a fresh timestamp; 429 is retried', async () => {
    const w = world();
    await w.delivery.subscribe(w.input());
    let fails = 2;
    w.receiver.answer = () => (fails-- > 0 ? { status: 429, body: '' } : { status: 200, body: '' });
    w.buffer.add(message(1));
    await w.tick();
    w.advance(RETRY_DELAYS_MS[0] - 1);
    await w.tick();
    expect(w.receiver.deliveries).toHaveLength(1);
    w.advance(1);
    await w.tick();
    w.advance(RETRY_DELAYS_MS[1]);
    await w.tick();
    const tries = w.receiver.deliveries;
    expect(tries).toHaveLength(3);
    expect(new Set(tries.map((t) => t.headers['webhook-id'])).size).toBe(1);
    expect(new Set(tries.map((t) => t.headers['webhook-timestamp'])).size).toBe(3);
    for (const t of tries) expect(verify(w.secret, t.headers, t.body)).toBe(true);
    w.advance(RETRY_DELAYS_MS[2]);
    await w.tick();
    expect(w.receiver.deliveries).toHaveLength(3);
  });

  it('reports an ongoing failure while still active, and clears it once a delivery is accepted', async () => {
    const w = world();
    await w.delivery.subscribe(w.input());
    w.receiver.answer = () => ({ status: 503, body: '' });
    w.buffer.add(message(1));
    await w.tick();
    const failing = await w.delivery.subscribe(w.input());
    expect(failing.deliveryStatus).toEqual({
      active: true,
      lastDeliveryAt: null,
      lastError: 'http_5xx',
      failedSince: new Date(T0).toISOString(),
    });
    w.receiver.answer = () => ({ status: 200, body: '' });
    w.advance(RETRY_DELAYS_MS[0]);
    await w.tick();
    const healthy = await w.delivery.subscribe(w.input());
    expect(healthy.deliveryStatus).toEqual({
      active: true,
      lastDeliveryAt: new Date(T0 + RETRY_DELAYS_MS[0]).toISOString(),
      lastError: null,
    });
  });

  it('does not retry 410 or 413', async () => {
    for (const status of [410, 413]) {
      const w = world();
      await w.delivery.subscribe(w.input());
      w.receiver.answer = () => ({ status, body: '' });
      w.buffer.add(message(1));
      await w.tick();
      for (const d of RETRY_DELAYS_MS) {
        w.advance(d);
        await w.tick();
      }
      expect(w.receiver.deliveries, String(status)).toHaveLength(1);
      const refresh = await w.delivery.subscribe(w.input());
      expect(refresh.deliveryStatus, String(status)).toEqual({ active: true, lastDeliveryAt: null, lastError: null });
    }
  });

  it('a 410 after an error clears it: the receiver answered, and Zimmer reads lastError as unhealthy', async () => {
    const w = world();
    await w.delivery.subscribe(w.input());
    let first = true;
    w.receiver.answer = () => {
      if (first) {
        first = false;
        return { status: 503, body: '' };
      }
      return { status: 410, body: '' };
    };
    w.buffer.add(message(1));
    await w.tick();
    w.advance(RETRY_DELAYS_MS[0]);
    await w.tick();
    const res = await w.delivery.subscribe(w.input());
    expect(res.deliveryStatus).toEqual({ active: true, lastDeliveryAt: null, lastError: null });
    expect(decodeCursor(res.cursor)).toBe(w.buffer.head);
  });

  it('gives up one event the endpoint keeps refusing while it accepts the rest', async () => {
    const w = world();
    await w.delivery.subscribe(w.input());
    w.receiver.answer = (r) =>
      (r.json.data as MessagePostedData).text === 'message 1' ? { status: 400, body: '' } : { status: 200, body: '' };
    w.buffer.add(message(1));
    w.buffer.add(message(2));
    await w.tick();
    for (const d of RETRY_DELAYS_MS) {
      w.advance(d);
      await w.tick();
    }
    const ones = w.receiver.deliveries.filter((d) => (d.json.data as MessagePostedData).text === 'message 1');
    expect(ones).toHaveLength(MAX_ATTEMPTS);
    await w.tick();
    const res = await w.delivery.subscribe(w.input());
    expect(res.deliveryStatus!.active).toBe(true);
    expect(decodeCursor(res.cursor)).toBe(w.buffer.head);
  });

  it('suspends after sustained failure, keeps every event, and catches up after a refresh', async () => {
    const w = world();
    await w.delivery.subscribe(w.input());
    w.receiver.answer = () => new DeliveryFailure('connection_refused');
    for (let i = 1; i <= 3; i++) w.buffer.add(message(i));
    await w.tick();
    for (const d of RETRY_DELAYS_MS) {
      w.advance(d);
      await w.tick();
    }
    expect(w.receiver.deliveries).toHaveLength(3 * MAX_ATTEMPTS);
    // Suspended: nothing more is attempted, and the watermark has not moved.
    w.advance(3600_000);
    w.buffer.add(message(4));
    await w.tick();
    expect(w.receiver.deliveries).toHaveLength(3 * MAX_ATTEMPTS);

    w.receiver.answer = () => ({ status: 200, body: '' });
    const refresh = await w.delivery.subscribe(w.input());
    expect(refresh.deliveryStatus).toMatchObject({ active: false, lastError: 'connection_refused' });
    expect(refresh.deliveryStatus!.failedSince).toBeDefined();
    w.receiver.received = [];
    await w.tick(); // re-reads the registry: reactivated
    await w.tick();
    expect(w.receiver.deliveries.map((d) => (d.json.data as MessagePostedData).text).sort()).toEqual([
      'message 1',
      'message 2',
      'message 3',
      'message 4',
    ]);
    const after = await w.delivery.subscribe(w.input());
    expect(after.deliveryStatus).toMatchObject({ active: true, lastError: null });
    expect(decodeCursor(after.cursor)).toBe(w.buffer.head);
  });

  it('a restarted process resumes from the persisted watermark', async () => {
    const blobs = new MemoryBlobStore();
    const first = world({ blobs });
    await first.delivery.subscribe(first.input());
    first.buffer.add(message(1));
    await first.tick();
    first.advance(10_000);
    await first.delivery.flush();
    const watermark = (await readRegistry(first.store)).subscriptions[0]!.watermark;
    expect(watermark).toBe(first.buffer.head);

    // A new process: same store, the buffer as persisted plus one event that
    // arrived while nothing was delivering.
    const second = world({ blobs });
    second.buffer.merge(first.buffer.toDoc(), { resequence: false });
    second.buffer.add(message(2));
    await second.tick();
    expect(second.receiver.deliveries.map((d) => (d.json.data as MessagePostedData).text)).toEqual(['message 2']);
    expect(second.receiver.received.filter((r) => r.json.type === 'verification')).toEqual([]);
  });

  it('only the lease holder delivers', async () => {
    const w = world();
    await w.delivery.subscribe(w.input());
    w.buffer.add(message(1));
    await w.tick(false);
    expect(w.receiver.deliveries).toEqual([]);
    await w.tick(true);
    expect(w.receiver.deliveries).toHaveLength(1);
  });

  it('stops delivering at refreshBefore and collects the subscription', async () => {
    const w = world();
    await w.delivery.subscribe(w.input({ ttlMs: MIN_TTL_MS }));
    w.advance(MIN_TTL_MS + 1);
    w.buffer.add(message(1));
    await w.tick();
    expect(w.receiver.deliveries).toEqual([]);
    w.advance(10_000);
    await w.delivery.flush();
    expect((await readRegistry(w.store)).subscriptions).toEqual([]);
  });

  it('announces a gap with a signed envelope when the buffer evicted past the watermark', async () => {
    const blobs = new MemoryBlobStore();
    const HOUR = 3600_000;
    const first = world({ blobs, retentionMs: HOUR });
    await first.delivery.subscribe(first.input());
    first.buffer.add(message(1));
    // The process dies before delivering it. Two hours later a new one starts
    // from the persisted buffer, whose one-hour retention evicts message 1.
    const second = world({ blobs, retentionMs: HOUR });
    second.advance(2 * HOUR);
    second.buffer.merge(first.buffer.toDoc(), { resequence: false });
    second.buffer.add({ ...message(2), timestamp: new Date(second.clock()).toISOString() });
    expect(second.buffer.evictedThroughSeq).toBeGreaterThan(0);
    await second.tick();
    const [gap, event] = second.receiver.deliveries;
    expect(gap!.json).toEqual({ type: 'gap', cursor: encodeCursor(second.buffer.evictedThroughSeq) });
    expect(gap!.headers['webhook-id']).toMatch(/^msg_gap_/);
    expect(verify(first.secret, gap!.headers, gap!.body)).toBe(true);
    expect((event!.json.data as MessagePostedData).text).toBe('message 2');
  });

  it("a gap's cursor never passes an event still queued for retry", async () => {
    const HOUR = 3600_000;
    const w = world({ retentionMs: HOUR });
    await w.delivery.subscribe(w.input());
    w.receiver.answer = () => new DeliveryFailure('connection_refused');
    w.buffer.add({ ...message(1), timestamp: new Date(w.clock()).toISOString() });
    await w.tick();
    for (const d of RETRY_DELAYS_MS) {
      w.advance(d);
      await w.tick();
    }
    // Suspended with message 1 still queued. Message 2 arrives and is evicted
    // before the subscriber comes back.
    w.buffer.add({ ...message(2), timestamp: new Date(w.clock()).toISOString() });
    w.advance(2 * HOUR);
    w.buffer.prune();
    w.buffer.add({ ...message(3), timestamp: new Date(w.clock()).toISOString() });
    const queuedSeq = w.buffer.evictedThroughSeq - 1;
    w.receiver.answer = () => ({ status: 200, body: '' });
    await w.delivery.subscribe(w.input());
    w.receiver.received = [];
    await w.tick();
    await w.tick();
    const gap = w.receiver.deliveries.find((d) => d.json.type === 'gap')!;
    const first = w.receiver.deliveries.find((d) => (d.json.data as MessagePostedData | undefined)?.text === 'message 1')!;
    expect(first).toBeDefined();
    expect(decodeCursor(gap.json.cursor)).toBeLessThan(w.buffer.evictedThroughSeq);
    expect(decodeCursor(gap.json.cursor)).toBeLessThanOrEqual(queuedSeq);
  });

  it('a lapsed subscription comes back from the client cursor, truncated if the buffer moved past it', async () => {
    const w = world({ retentionMs: 3600_000 });
    const sub = await w.delivery.subscribe(w.input({ ttlMs: MIN_TTL_MS }));
    w.buffer.add(message(1));
    w.advance(2 * 3600_000);
    w.buffer.prune();
    w.buffer.add({ ...message(2), timestamp: new Date(w.clock()).toISOString() });
    const back = await w.delivery.subscribe(w.input({ cursor: decodeCursor(sub.cursor) }));
    expect(back.truncated).toBe(true);
    expect(decodeCursor(back.cursor)).toBe(w.buffer.evictedThroughSeq);
    await w.tick();
    expect(w.receiver.deliveries.map((d) => (d.json.data as MessagePostedData).text)).toEqual(['message 2']);
  });
});

describe('two processes', () => {
  /** The lease holder and a second process (a deploy overlap) over one store and one buffer. */
  function pair() {
    const owner = world();
    const other = new WebhookDelivery({
      store: owner.store,
      source: {
        head: () => owner.buffer.head,
        evictedThrough: () => owner.buffer.evictedThroughSeq,
        eventsAfter: (after, args, limit) => owner.buffer.eventsAfter(after, args, limit),
      },
      transport: owner.receiver,
      parseArgs: parseMessagePostedArgs,
      clock: owner.clock,
    });
    return { ...owner, other };
  }

  it('a resubscribe made elsewhere, after an unsubscribe, starts from its own cursor', async () => {
    const w = pair();
    for (let i = 1; i <= 3; i++) w.buffer.add(message(i));
    await w.delivery.subscribe(w.input());
    await w.tick();
    // All three were before the subscription: nothing to send.
    expect(w.receiver.deliveries).toEqual([]);
    await w.other.unsubscribe({ principal: PRINCIPAL, name: NAME, url: URL_A, arguments: {} });
    w.advance(1000);
    await w.other.subscribe(w.input({ cursor: 0 }));
    w.advance(20_000);
    await w.tick();
    await w.tick();
    expect(w.receiver.deliveries.map((d) => (d.json.data as MessagePostedData).text)).toEqual([
      'message 1',
      'message 2',
      'message 3',
    ]);
  });

  it('a refresh elsewhere reactivates a suspension the lease holder has not written yet', async () => {
    const w = pair();
    await w.delivery.subscribe(w.input());
    w.receiver.answer = () => new DeliveryFailure('connection_refused');
    w.buffer.add(message(1));
    await w.tick();
    for (const d of RETRY_DELAYS_MS.slice(0, -1)) {
      w.advance(d);
      await w.tick();
    }
    // The last attempt suspends, inside the persist interval: not yet written.
    w.advance(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!);
    await w.delivery.tick(true);
    await w.delivery.settle();
    expect((await readRegistry(w.store)).subscriptions[0]!.active).toBe(true);
    // The refresh lands on the other process, which sees `active: true`.
    w.advance(1000);
    await w.other.subscribe(w.input());
    w.receiver.answer = () => ({ status: 200, body: '' });
    w.receiver.received = [];
    // The lease holder writes its suspension, then re-reads: the refresh wins.
    w.advance(PERSIST_MS_FOR_TEST);
    await w.delivery.flush();
    expect((await readRegistry(w.store)).subscriptions[0]!.active).toBe(true);
    w.advance(20_000);
    await w.tick();
    await w.tick();
    expect(w.receiver.deliveries.map((d) => (d.json.data as MessagePostedData).text)).toEqual(['message 1']);
  });
});

describe('edge credentials', () => {
  const access = { hosts: ['zimmer.tadasant.com'], headers: { 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 's3cret' } };

  it('go to a configured host, on the challenge and on deliveries, and to no other host', async () => {
    const w = world({ access });
    await w.delivery.subscribe(w.input());
    w.buffer.add(message(1));
    await w.tick();
    for (const r of w.receiver.received) {
      expect(r.headers['CF-Access-Client-Id']).toBe('id.access');
      expect(r.headers['CF-Access-Client-Secret']).toBe('s3cret');
    }
    const other = world({ access });
    await other.delivery.subscribe(other.input({ url: 'https://attacker.example.com/hook' }));
    other.buffer.add(message(1));
    await other.tick();
    expect(other.receiver.received.length).toBeGreaterThan(1);
    for (const r of other.receiver.received) {
      expect(JSON.stringify(r.headers)).not.toContain('s3cret');
    }
    expect(accessHeadersFor(access, 'https://zimmer.tadasant.com.attacker.example/x')).toEqual({});
    expect(accessHeadersFor(access, 'https://sub.zimmer.tadasant.com/x')).toEqual({});
    expect(accessHeadersFor(access, 'http://zimmer.tadasant.com/x')).toEqual({});
    expect(accessHeadersFor(access, 'https://zimmer.tadasant.com:8443/x')).toEqual({});
    expect(accessHeadersFor(access, 'https://zimmer.tadasant.com:443/x')).toMatchObject({ 'CF-Access-Client-Id': 'id.access' });
    expect(accessHeadersFor(access, 'https://ZIMMER.tadasant.com/x')).toMatchObject({ 'CF-Access-Client-Id': 'id.access' });
  });

  it('come from strad configuration, all three variables or none', () => {
    expect(readWebhookAccess({})).toBeNull();
    expect(
      readWebhookAccess({
        SLACK_EVENTS_WEBHOOK_ACCESS_HOSTS: 'Zimmer.Tadasant.com, other.example.com',
        SLACK_EVENTS_WEBHOOK_CF_ACCESS_CLIENT_ID: 'id',
        SLACK_EVENTS_WEBHOOK_CF_ACCESS_CLIENT_SECRET: 'sec',
      })
    ).toEqual({
      hosts: ['zimmer.tadasant.com', 'other.example.com'],
      headers: { 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'sec' },
    });
    expect(() => readWebhookAccess({ SLACK_EVENTS_WEBHOOK_ACCESS_HOSTS: 'zimmer.tadasant.com' })).toThrow(
      /SLACK_EVENTS_WEBHOOK_CF_ACCESS_CLIENT_ID, SLACK_EVENTS_WEBHOOK_CF_ACCESS_CLIENT_SECRET/
    );
    expect(() =>
      readWebhookAccess({
        SLACK_EVENTS_WEBHOOK_ACCESS_HOSTS: 'https://zimmer.tadasant.com/',
        SLACK_EVENTS_WEBHOOK_CF_ACCESS_CLIENT_ID: 'id',
        SLACK_EVENTS_WEBHOOK_CF_ACCESS_CLIENT_SECRET: 'sec',
      })
    ).toThrow(/bare hostnames/);
  });
});

// =============================================================================
// over MCP
// =============================================================================

const ENV = {
  SLACK_APP_TOKEN: 'xapp-1-test',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_EVENTS_STATE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  STRAD_STATE_GCS_BUCKET: 'bucket',
  STRAD_STATE_GCS_CLIENT_EMAIL: 'sa@example.iam.gserviceaccount.com',
  STRAD_STATE_GCS_PRIVATE_KEY: 'unused-by-the-memory-store',
};

const Loose = ResultSchema.passthrough();

async function mcp(transport: WebhookTransport) {
  const ingest = new SlackEventsIngest({
    env: ENV,
    blobs: new MemoryBlobStore(),
    fetch: (async () => new Response('{"ok":true}')) as typeof fetch,
    manualTimers: true,
    webSocket: () => {
      throw new Error('no socket in this test');
    },
    webhookTransport: transport,
  });
  const created = createMCPServer({ version: '0', events: ingest });
  const server = new Server({ name: 'slack', version: '0' }, { capabilities: { tools: {} } });
  await created.registerHandlers(server, () => {
    throw new Error('no Slack client in this test');
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(b);
  return client;
}

describe('events/subscribe and events/unsubscribe over MCP', () => {
  const params = (secret: string, over: Record<string, unknown> = {}) => ({
    name: 'message_posted',
    arguments: {},
    delivery: { mode: 'webhook', url: URL_A, secret },
    cursor: null,
    ttlMs: 21_600_000,
    _meta: { 'strad/principal': PRINCIPAL, 'strad/name': NAME },
    ...over,
  });

  it('lists webhook delivery, subscribes, and unsubscribes', async () => {
    const receiver = new FakeReceiver(Date.now);
    receiver.secret = newSecret();
    const client = await mcp(receiver);
    const list = await client.request({ method: 'events/list', params: {} }, Loose);
    expect((list.events as { delivery: string[] }[])[0]!.delivery).toEqual(['poll', 'webhook']);

    const sub = await client.request({ method: 'events/subscribe', params: params(receiver.secret) }, Loose);
    expect(sub).toMatchObject({ id: expect.stringMatching(/^sub_/), truncated: false });
    expect(typeof sub.refreshBefore).toBe('string');
    expect(typeof sub.cursor).toBe('string');

    const gone = await client.request(
      {
        method: 'events/unsubscribe',
        params: { name: 'message_posted', arguments: {}, delivery: { url: URL_A }, _meta: params('')._meta },
      },
      Loose
    );
    expect(gone).toEqual({});
    await expect(
      client.request(
        {
          method: 'events/unsubscribe',
          params: { name: 'message_posted', arguments: {}, delivery: { url: URL_A }, _meta: params('')._meta },
        },
        Loose
      )
    ).rejects.toMatchObject({ code: -32023, data: { kind: 'subscription' } });
  });

  it('refuses with the draft codes', async () => {
    const receiver = new FakeReceiver(Date.now);
    receiver.secret = newSecret();
    const client = await mcp(receiver);
    const call = (p: Record<string, unknown>) => client.request({ method: 'events/subscribe', params: p }, Loose);
    await expect(call(params(receiver.secret, { _meta: {} }))).rejects.toMatchObject({ code: -32024 });
    await expect(call(params('whsec_short'))).rejects.toMatchObject({ code: -32602 });
    await expect(
      call(params(receiver.secret, { delivery: { mode: 'webhook', url: 'http://zimmer.tadasant.com/x', secret: receiver.secret } }))
    ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('https') });
    await expect(
      call(params(receiver.secret, { delivery: { mode: 'push', url: URL_A, secret: receiver.secret } }))
    ).rejects.toMatchObject({ code: -32026, data: { feature: 'deliveryMode', value: 'push' } });
    await expect(call(params(receiver.secret, { arguments: { nope: true } }))).rejects.toMatchObject({ code: -32602 });
    await expect(call(params(receiver.secret, { name: 'other' }))).rejects.toMatchObject({ code: -32023 });
    await expect(call(params(receiver.secret, { cursor: 'garbage' }))).rejects.toMatchObject({ code: -32602 });
    receiver.challengeAnswer = () => ({ status: 302, body: '' });
    await expect(call(params(receiver.secret))).rejects.toMatchObject({
      code: -32027,
      data: { reason: 'challenge_failed' },
    });
  });
});
