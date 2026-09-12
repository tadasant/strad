// `GET /mcp-download/:slug/:token` — the gateway's whole part in getting a file
// OUT of a mount.
//
// It is the mirror of `/mcp-upload`, and the asymmetry between them is the
// point: an upload is bounded (the store caps it at 100MB) and may be buffered,
// while a download is unbounded — a Slack attachment can be hundreds of
// megabytes — and must therefore stream. So what is pinned here is not just
// "the bytes arrive" but that NOTHING ON THIS PATH ACCUMULATES THEM, and that a
// failure partway through a body cannot be mistaken for a complete file.
//
// The route is deliberately unauthenticated: the caller is an agent session
// that holds no strad API key, so the signature inside `:token` is the whole
// credential and the upstream that signed it is the only thing that checks it.
// The gateway's job is to resolve a slug and pipe.
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

const CONFIG = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle-slack-zimmer
servers:
  - slug: slack-zimmer
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-slack-zimmer
    path: /slack
    entitlements: [admin]
`;

const open: Server[] = [];

afterEach(() => {
  while (open.length) open.pop()?.close();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  open.push(server);
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return addr.port;
}

/** The gateway, pointed at an upstream standing in for the bundle component. */
async function gatewayFor(upstreamPort: number): Promise<string> {
  const cfg = parseConfig(CONFIG);
  const env = {
    STRAD_TOKENS: "[]",
    STRAD_BUNDLE_URL_BUNDLE_SLACK_ZIMMER: `http://127.0.0.1:${upstreamPort}`,
  };
  const registry = await Registry.build({
    config: cfg,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env,
  });
  const app = createApp({
    config: cfg,
    registry,
    tokenStore: tokenStoreFromConfig(cfg, env),
    mode: "core",
    env,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s as unknown as Server));
  });
  open.push(server);
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no gateway port");
  return `http://127.0.0.1:${addr.port}`;
}

describe("/mcp-download", () => {
  it("proxies a GET to the mount's download route, with no caller credential", async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | undefined;
    const upstream = createServer((req, res) => {
      seenUrl = req.url;
      seenAuth = req.headers.authorization;
      res.setHeader("content-type", "application/zip");
      res.setHeader(
        "content-disposition",
        "attachment; filename*=UTF-8''a.zip",
      );
      res.end("PKpayload");
    });
    const base = await gatewayFor(await listen(upstream));

    // No Authorization header: the signature in the path is the credential.
    const res = await fetch(`${base}/mcp-download/slack-zimmer/sometoken`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    // The filename rides in a header, never in the URL — see download-link.ts.
    expect(res.headers.get("content-disposition")).toContain("a.zip");
    await expect(res.text()).resolves.toBe("PKpayload");
    expect(seenUrl).toBe("/slack/download/sometoken");
    expect(seenAuth).toBeUndefined();
  });

  it("relays the upstream's refusal, so a spent link says so", async () => {
    const upstream = createServer((_req, res) => {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ error: "This download link has already been used." }),
      );
    });
    const base = await gatewayFor(await listen(upstream));

    const res = await fetch(`${base}/mcp-download/slack-zimmer/spent`);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("already been used"),
    });
  });

  it("404s a slug this deployment does not serve", async () => {
    const upstream = createServer((_req, res) => res.end("never reached"));
    const base = await gatewayFor(await listen(upstream));

    const res = await fetch(`${base}/mcp-download/no-such-slug/tok`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not_found" });
  });

  it("streams rather than buffers: bytes arrive before the upstream finishes", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const upstream = createServer((_req, res) => {
      res.setHeader("content-type", "application/octet-stream");
      res.write("first-chunk");
      // The rest is withheld until the test has already read the first chunk.
      void held.then(() => res.end("second-chunk"));
    });
    const base = await gatewayFor(await listen(upstream));

    const res = await fetch(`${base}/mcp-download/slack-zimmer/tok`);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const first = await reader.read();
    // If ANY hop buffered the whole response, this read could not have resolved
    // while the upstream is still holding the rest of the body open.
    expect(new TextDecoder().decode(first.value)).toContain("first-chunk");

    release!();
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    expect(rest).toContain("second-chunk");
  });

  it("holds memory flat across a body far larger than any buffer would be", async () => {
    // 64MB, in chunks, from an upstream that never holds it all either. The
    // assertion is the heap: buffering this anywhere would show up as tens of
    // megabytes retained, which is exactly the failure mode `postRaw` has and
    // this route must not.
    const CHUNK = Buffer.alloc(1024 * 1024, 7);
    const CHUNKS = 64;
    const upstream = createServer((_req, res) => {
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-length", String(CHUNK.length * CHUNKS));
      let sent = 0;
      const pump = (): void => {
        while (sent < CHUNKS) {
          sent += 1;
          if (!res.write(CHUNK)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    const base = await gatewayFor(await listen(upstream));

    global.gc?.();
    const before = process.memoryUsage().heapUsed;

    const res = await fetch(`${base}/mcp-download/slack-zimmer/tok`);
    const reader = res.body!.getReader();
    let bytes = 0;
    let peak = before;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      const now = process.memoryUsage().heapUsed;
      if (now > peak) peak = now;
    }

    expect(bytes).toBe(CHUNK.length * CHUNKS);
    // Generous, because a GC may not have run: the point is that growth is not
    // proportional to the 64MB that went through.
    expect(peak - before).toBeLessThan(32 * 1024 * 1024);
  });

  // Core fetches the bundle with `fetch`, which DECOMPRESSES an encoded body and
  // leaves `content-length` describing the compressed bytes. Relaying that pair
  // would declare a length the caller never reaches — Node stops writing at it,
  // and the truncation agrees with the header, so nothing can detect it.
  it("drops content-length and content-encoding when the upstream body was encoded", async () => {
    const payload = Buffer.alloc(100_000, 65);
    const gz = gzipSync(payload);
    const upstream = createServer((_req, res) => {
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-encoding", "gzip");
      res.setHeader("content-length", String(gz.length));
      res.end(gz);
    });
    const base = await gatewayFor(await listen(upstream));

    const res = await fetch(`${base}/mcp-download/slack-zimmer/tok`);
    expect(res.status).toBe(200);

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(payload.length);
    expect(body.equals(payload)).toBe(true);
  });

  it("destroys the connection when a body fails partway, rather than ending it cleanly", async () => {
    // The dangerous case: a chunked response ended tidily after a failure is
    // indistinguishable from a complete file, and a half-written zip that looks
    // whole is the worst outcome this route has.
    const upstream = createServer((_req, res) => {
      res.setHeader("content-type", "application/octet-stream");
      res.write("half-a-file");
      // Rip the socket out from under the gateway mid-body.
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const base = await gatewayFor(await listen(upstream));

    const res = await fetch(`${base}/mcp-download/slack-zimmer/tok`);
    expect(res.status).toBe(200);

    // The caller must see a failed transfer, not a short but successful one.
    await expect(res.arrayBuffer()).rejects.toThrow();
  });
});
