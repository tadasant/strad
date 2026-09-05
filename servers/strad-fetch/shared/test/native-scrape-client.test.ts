import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import diagnosticsChannel from 'node:diagnostics_channel';
import type { AddressInfo } from 'node:net';
import type dns from 'node:dns';
import { fetch } from 'undici';
import { NativeScrapingClient } from '../src/scraping-client/native-scrape-client.js';
import { createGuardedDispatcher } from '../src/scraping-client/url-guard.js';

/**
 * The native strategy, over real sockets.
 *
 * `url-guard.test.ts` pins the rules; this suite pins that the strategy is
 * WIRED to them — that a blocked URL never reaches the listener, that a redirect
 * hop is checked as strictly as the URL the caller passed, and that a fetch the
 * guard permits still comes back with the page in it.
 */

const ORIGINAL_ALLOWLIST = process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS;
const servers: http.Server[] = [];
const subscriptions: Array<() => void> = [];

interface Listener {
  port: number;
  hits: string[];
}

async function listen(handler: http.RequestListener, host = '127.0.0.1'): Promise<Listener> {
  const hits: string[] = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url ?? '');
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return { port: (server.address() as AddressInfo).port, hits };
}

/**
 * The whole of `127.0.0.0/8` is local on Linux, which is what CI runs; macOS
 * binds `127.0.0.1` only. A test that needs a SECOND loopback address skips
 * rather than failing on a developer's laptop.
 */
async function listenOrSkip(
  handler: http.RequestListener,
  host: string
): Promise<Listener | null> {
  try {
    return await listen(handler, host);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL') return null;
    throw error;
  }
}

/** Counts every connection undici is about to open, refused or not. */
function countDispatches(): () => number {
  let dispatches = 0;
  const onConnect = () => {
    dispatches += 1;
  };
  diagnosticsChannel.channel('undici:client:beforeConnect').subscribe(onConnect);
  subscriptions.push(() =>
    diagnosticsChannel.channel('undici:client:beforeConnect').unsubscribe(onConnect)
  );
  return () => dispatches;
}

const page = (body: string): http.RequestListener => {
  return (_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(body);
  };
};

const redirectTo = (location: string): http.RequestListener => {
  return (_request, response) => {
    response.writeHead(302, { location });
    response.end();
  };
};

afterEach(async () => {
  if (ORIGINAL_ALLOWLIST === undefined) delete process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS;
  else process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS = ORIGINAL_ALLOWLIST;

  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
});

describe('NativeScrapingClient and the URL guard', () => {
  it('refuses a loopback URL, and the listener never hears about it', async () => {
    const target = await listen(page('<html><body>internal service</body></html>'));

    const result = await new NativeScrapingClient().scrape(`http://127.0.0.1:${target.port}/`);

    expect(result.success).toBe(false);
    expect(result.error).toContain('loopback');
    expect(result.data).toBeUndefined();
    expect(target.hits).toEqual([]);
  });

  it('refuses the same service reached by the name localhost', async () => {
    const target = await listen(page('<html><body>internal service</body></html>'));

    const result = await new NativeScrapingClient().scrape(`http://localhost:${target.port}/`);

    expect(result.success).toBe(false);
    expect(result.error).toContain('loopback interface');
    expect(target.hits).toEqual([]);
  });

  it('refuses the App Platform metadata address without opening a socket', async () => {
    // Counted rather than inferred. On a cloud runner this address is the LIVE
    // metadata endpoint, so a regression here would have CI make the request
    // the guard exists to prevent and then report it as a timeout.
    const dispatches = countDispatches();

    const result = await new NativeScrapingClient().scrape(
      'http://169.254.169.254/latest/meta-data/',
      { timeout: 5000 }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('link-local');
    expect(result.error).not.toContain('timeout');
    expect(dispatches()).toBe(0);
  });

  it('refuses a file: URL', async () => {
    const result = await new NativeScrapingClient().scrape('file:///etc/passwd');

    expect(result.success).toBe(false);
    expect(result.error).toContain('http and https only');
  });

  it('fetches and parses a page the guard permits', async () => {
    const target = await listen(page('<html><body><p>a public page</p></body></html>'));
    process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS = '127.0.0.1';

    const result = await new NativeScrapingClient().scrape(`http://127.0.0.1:${target.port}/x`);

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.data).toContain('a public page');
    expect(target.hits).toEqual(['/x']);
  });

  it('checks the REDIRECT TARGET, not only the URL the caller passed', async (ctx) => {
    // The allowlisted host answers; the hop it points at is a real listening
    // service on another loopback address, and it is refused at the connector.
    const internal = await listenOrSkip(
      page('<html><body>internal service</body></html>'),
      '127.0.0.2'
    );
    if (!internal) return ctx.skip();
    const hop = await listen(redirectTo(`http://127.0.0.2:${internal.port}/secret`));
    process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS = '127.0.0.1';

    const result = await new NativeScrapingClient().scrape(`http://127.0.0.1:${hop.port}/redirect`);

    expect(result.success).toBe(false);
    expect(result.error).toContain('127.0.0.2');
    expect(result.error).toContain('loopback');
    expect(hop.hits).toEqual(['/redirect']);
    expect(internal.hits).toEqual([]);
  });

  it('checks a redirect to the metadata address too', async () => {
    const hop = await listen(redirectTo('http://169.254.169.254/latest/meta-data/'));
    process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS = '127.0.0.1';

    const result = await new NativeScrapingClient().scrape(`http://127.0.0.1:${hop.port}/redirect`);

    expect(result.success).toBe(false);
    expect(result.error).toContain('link-local');
  });
});

/**
 * The resolve-then-connect half, end to end.
 *
 * The name here really is fetched and really would have connected — the guarded
 * lookup is the only thing between it and the listener — so this is the DNS
 * case the literal check cannot see, proven at the socket rather than in the
 * rule.
 */
describe('the guarded dispatcher on a name that points into a private range', () => {
  const resolveTo =
    (address: string) =>
    (hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
      if (hostname === 'rebind.example') {
        callback(null, [{ address, family: 4 }]);
        return;
      }
      callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    };

  it('refuses the connection, and the listener never hears about it', async () => {
    const target = await listen(page('<html><body>internal service</body></html>'));
    const dispatcher = createGuardedDispatcher({
      resolve: resolveTo('127.0.0.1') as unknown as typeof dns.lookup,
    });

    await expect(
      fetch(`http://rebind.example:${target.port}/`, { dispatcher })
    ).rejects.toMatchObject({
      cause: { name: 'BlockedUrlError', message: expect.stringContaining('127.0.0.1') },
    });
    expect(target.hits).toEqual([]);

    await dispatcher.close();
  });

  it('is on the TLS path too, which reaches net.connect through another branch', async () => {
    // undici spreads its build options into `tls.connect` for https and into
    // `net.connect` for http — two places the guarded `lookup` has to survive,
    // and https is the scheme that carries essentially all real traffic. A real
    // resolver would answer ENOTFOUND here, so the guard's own message is what
    // proves the lookup reached the TLS branch.
    const dispatcher = createGuardedDispatcher({
      resolve: resolveTo('127.0.0.1') as unknown as typeof dns.lookup,
    });

    await expect(fetch('https://rebind.example/', { dispatcher })).rejects.toMatchObject({
      cause: { name: 'BlockedUrlError', message: expect.stringContaining('127.0.0.1') },
    });

    await dispatcher.close();
  });

  it('connects when the operator has named the host, which is the escape hatch working', async () => {
    const target = await listen(page('<html><body>dev service</body></html>'));
    process.env.STRAD_FETCH_ALLOW_PRIVATE_HOSTS = 'rebind.example';
    const dispatcher = createGuardedDispatcher({
      resolve: resolveTo('127.0.0.1') as unknown as typeof dns.lookup,
    });

    const response = await fetch(`http://rebind.example:${target.port}/y`, { dispatcher });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('dev service');
    expect(target.hits).toEqual(['/y']);

    await dispatcher.close();
  });
});
