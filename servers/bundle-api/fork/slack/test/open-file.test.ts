// `openFile` — the hop that actually fetches an attachment from Slack.
//
// Everything here is a way to hand back something that is NOT the file while
// reporting success, which is the failure class this whole fork delta exists to
// remove:
//
//   1. A CONTENT-ENCODED body. `fetch` asks for gzip and decompresses, but
//      leaves `content-length` describing the COMPRESSED bytes. Declaring that
//      downstream truncates the file to a length the header agrees with — a
//      short file no caller can detect.
//   2. A CROSS-ORIGIN REDIRECT. undici drops the Authorization header on one, so
//      the target answers a sign-in page with a 200 that would stream as if it
//      were the attachment.
//   3. A SAME-ORIGIN redirect, which keeps the header and must still work.
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { openFile } from '../src/slack-client/lib/download-file.js';

const open: Server[] = [];

afterEach(() => {
  while (open.length) open.pop()?.close();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push(server);
  const addr = server.address();
  if (typeof addr === 'string' || !addr) throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

async function drain(body: ReadableStream<Uint8Array>): Promise<number> {
  const reader = body.getReader();
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.length;
  }
  return bytes;
}

const PAYLOAD = Buffer.alloc(100_000, 65);

describe('openFile', () => {
  it('reports no content-length for a gzipped body, because the header describes the compressed bytes', async () => {
    const gz = gzipSync(PAYLOAD);
    const base = await listen(
      createServer((_req, res) => {
        res.setHeader('content-type', 'text/plain');
        res.setHeader('content-encoding', 'gzip');
        res.setHeader('content-length', String(gz.length));
        res.end(gz);
      })
    );

    const stream = await openFile({}, base);

    // The wire said ~130 bytes; the body is 100,000. Declaring the former would
    // cut the caller's file to 130 under a 200 whose length header matched it.
    expect(gz.length).toBeLessThan(1000);
    expect(stream.contentLength).toBeUndefined();
    await expect(drain(stream.body)).resolves.toBe(PAYLOAD.length);
  });

  it('reports the content-length of an unencoded body, which is the real one', async () => {
    const base = await listen(
      createServer((_req, res) => {
        res.setHeader('content-type', 'application/zip');
        res.setHeader('content-length', String(PAYLOAD.length));
        res.end(PAYLOAD);
      })
    );

    const stream = await openFile({}, base);
    expect(stream.contentLength).toBe(PAYLOAD.length);
    expect(stream.contentType).toBe('application/zip');
    await expect(drain(stream.body)).resolves.toBe(PAYLOAD.length);
  });

  it('refuses a cross-origin redirect rather than fetching it without the token', async () => {
    const elsewhere = await listen(
      createServer((_req, res) => res.end('a sign-in page, served with a 200'))
    );
    const base = await listen(
      createServer((_req, res) => {
        res.statusCode = 302;
        res.setHeader('location', elsewhere);
        res.end();
      })
    );

    await expect(openFile({ Authorization: 'Bearer xoxb-t' }, base)).rejects.toThrow(
      /across origins/
    );
  });

  it('follows a same-origin redirect, which keeps the Authorization header', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization ?? '(none)');
      if (req.url === '/redirected') {
        res.setHeader('content-type', 'application/zip');
        res.setHeader('content-length', String(PAYLOAD.length));
        res.end(PAYLOAD);
        return;
      }
      res.statusCode = 302;
      res.setHeader('location', '/redirected');
      res.end();
    });
    const base = await listen(server);

    const stream = await openFile({ Authorization: 'Bearer xoxb-t' }, base);
    await expect(drain(stream.body)).resolves.toBe(PAYLOAD.length);
    // Both hops carried the credential — that is what makes following safe.
    expect(seen).toEqual(['Bearer xoxb-t', 'Bearer xoxb-t']);
  });

  it('gives up rather than following a redirect loop forever', async () => {
    const base = await listen(
      createServer((_req, res) => {
        res.statusCode = 302;
        res.setHeader('location', '/again');
        res.end();
      })
    );

    await expect(openFile({}, base)).rejects.toThrow(/more than/);
  });

  it('raises on a non-ok response instead of streaming the error body', async () => {
    const base = await listen(
      createServer((_req, res) => {
        res.statusCode = 404;
        res.end('not found');
      })
    );

    await expect(openFile({}, base)).rejects.toThrow(/Failed to download file: 404/);
  });
});
