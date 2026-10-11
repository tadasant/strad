import { createServer, type IncomingMessage } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { ProxyAgent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SourceUnavailable } from "../src/candidate.js";
import { fatsecretConfig } from "../src/config.js";
import { TtlCache } from "../src/remote/cache.js";
import { FatSecretClient } from "../src/remote/fatsecret.js";
import {
  FakeApis,
  FS_API,
  FS_CREDENTIALS,
  PROXY_PASSWORD,
  PROXY_URL,
  TOKEN_URL,
  type FakeOptions,
} from "./fake-apis.js";

function client(options: FakeOptions = {}, extra: { now?: () => number; dailyBudget?: number } = {}) {
  const fake = new FakeApis(options);
  const fs = new FatSecretClient({
    config: () => fatsecretConfig({ ...FS_CREDENTIALS }),
    fetch: fake.fatsecretFetch,
    tokenUrl: TOKEN_URL,
    apiBase: FS_API,
    ...extra,
  });
  return { fake, fs };
}

describe("FatSecretClient: every request goes through the proxy", () => {
  it("sends the token POST and every API call with ONE ProxyAgent dispatcher", async () => {
    const { fake, fs } = client();
    await fs.search("big mac");
    await fs.getFood("41963");
    // token, search, food.get
    expect(fake.calls).toEqual([TOKEN_URL, expect.stringContaining("/foods/search/v1"), expect.stringContaining("/food/v5")]);
    expect(fake.dispatchers).toHaveLength(3);
    expect(fake.dispatchers[0]).toBeInstanceOf(ProxyAgent);
    expect(new Set(fake.dispatchers).size).toBe(1);
  });

  it("makes no FatSecret network call at all without a proxy", async () => {
    const fake = new FakeApis();
    const { FATSECRET_PROXY_URL: _unset, ...noProxy } = FS_CREDENTIALS;
    const fs = new FatSecretClient({
      config: () => fatsecretConfig(noProxy),
      fetch: fake.fatsecretFetch,
      tokenUrl: TOKEN_URL,
      apiBase: FS_API,
    });
    expect(fs.configured()).toBe(false);
    expect(fs.unconfiguredReason()).toContain("FATSECRET_PROXY_URL is not set");
    await expect(fs.search("rice")).rejects.toThrow(/FATSECRET_PROXY_URL/);
    expect(fake.calls).toEqual([]);
  });

  it("refuses a proxy URL that is not http(s), without echoing it", () => {
    const c = fatsecretConfig({ ...FS_CREDENTIALS, FATSECRET_PROXY_URL: "socks5://u:hunter22@x:1" });
    expect(c.ok).toBe(false);
    expect(!c.ok && c.reason).not.toContain("hunter22");
  });

  it("reports a proxy failure as the proxy's, with its password scrubbed", async () => {
    const fs = new FatSecretClient({
      config: () => fatsecretConfig({ ...FS_CREDENTIALS }),
      fetch: async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error(`Proxy response (407) !== 200 when HTTP Tunneling via ${PROXY_URL}`), {
            code: "UND_ERR_ABORTED",
          }),
        });
      },
      tokenUrl: TOKEN_URL,
      apiBase: FS_API,
    });
    const err = await fs.search("rice").catch((e: Error) => e);
    expect(err).toBeInstanceOf(SourceUnavailable);
    expect(err.message).toContain("the FatSecret proxy (FATSECRET_PROXY_URL) failed");
    expect(err.message).toContain("407");
    expect(err.message).toContain("not a FatSecret API error");
    expect(err.message).not.toContain(PROXY_PASSWORD);
    expect(err.message).not.toContain(PROXY_URL);
  });
});

/**
 * The real transport — undici's fetch with a real ProxyAgent — against a real
 * local forward proxy that tunnels CONNECT, as BrightData's does. The targets'
 * hostnames do not resolve anywhere, so the only way a response comes back is
 * through the proxy, which pipes every tunnel to one local fake upstream.
 */
describe("FatSecretClient through a real forward proxy", () => {
  const tunnels: Array<{ target: string; auth: string }> = [];
  const requests: Array<{ method: string; host: string; path: string }> = [];
  const upstream = createServer((req: IncomingMessage, res) => {
    requests.push({ method: req.method ?? "", host: req.headers.host ?? "", path: (req.url ?? "").split("?")[0]! });
    res.setHeader("content-type", "application/json");
    if ((req.url ?? "").startsWith("/connect/token")) {
      res.end(JSON.stringify({ access_token: "t1", token_type: "Bearer", expires_in: 86400 }));
      return;
    }
    res.end(JSON.stringify({ foods: { food: { food_id: "1", food_name: "Rice", food_type: "Generic" } } }));
  });
  const proxy = createServer((_req, res) => {
    res.statusCode = 405;
    res.end();
  });
  proxy.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    tunnels.push({ target: req.url ?? "", auth: String(req.headers["proxy-authorization"] ?? "") });
    const up = connect((upstream.address() as AddressInfo).port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  let proxyUrl = "";

  beforeAll(async () => {
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyUrl = `http://brd-customer-x-zone-y:${PROXY_PASSWORD}@127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  it("tunnels the token POST and the API call through the proxy, with its credentials", async () => {
    const fs = new FatSecretClient({
      config: () => fatsecretConfig({ ...FS_CREDENTIALS, FATSECRET_PROXY_URL: proxyUrl }),
      tokenUrl: "http://oauth.fatsecret.invalid/connect/token",
      apiBase: "http://platform.fatsecret.invalid/rest",
    });
    const hits = await fs.search("rice");
    expect(hits[0]?.food_name).toBe("Rice");
    expect(requests).toEqual([
      { method: "POST", host: "oauth.fatsecret.invalid", path: "/connect/token" },
      { method: "GET", host: "platform.fatsecret.invalid", path: "/rest/foods/search/v1" },
    ]);
    expect(tunnels.map((t) => t.target)).toEqual(["oauth.fatsecret.invalid:80", "platform.fatsecret.invalid:80"]);
    const basic = `Basic ${Buffer.from(`brd-customer-x-zone-y:${PROXY_PASSWORD}`).toString("base64")}`;
    expect(tunnels.every((t) => t.auth === basic)).toBe(true);
  });

  it("names the proxy when the proxy is down", async () => {
    const fs = new FatSecretClient({
      config: () =>
        fatsecretConfig({ ...FS_CREDENTIALS, FATSECRET_PROXY_URL: `http://u:${PROXY_PASSWORD}@127.0.0.1:1` }),
      tokenUrl: "http://oauth.fatsecret.invalid/connect/token",
      apiBase: "http://platform.fatsecret.invalid/rest",
    });
    const err = await fs.search("rice").catch((e: Error) => e);
    expect(err.message).toContain("the FatSecret proxy (FATSECRET_PROXY_URL) failed");
    expect(err.message).not.toContain(PROXY_PASSWORD);
  });
});

describe("FatSecretClient", () => {
  it("mints one token with client credentials and reuses it", async () => {
    const { fake, fs } = client();
    await fs.search("big mac");
    await fs.getFood("41963");
    expect(fake.tokenRequests).toBe(1);
    expect(fake.apiCalls).toBe(2);
  });

  it("caches identical requests, so a repeat costs no call", async () => {
    const { fake, fs } = client();
    const a = await fs.search("big mac");
    const b = await fs.search("big mac");
    expect(b).toEqual(a);
    expect(fake.apiCalls).toBe(1);
    expect(fs.callsToday).toBe(1);
  });

  it("normalises a single result object into a list", async () => {
    const { fs } = client();
    const hits = await fs.search("big mac");
    expect(hits).toHaveLength(1);
    const food = await fs.getFood("41963");
    expect(food.servings).toHaveLength(1);
  });

  it("re-mints a rejected token once", async () => {
    const { fake, fs } = client({ expireTokenOnce: true });
    await fs.search("rice");
    expect(fake.tokenRequests).toBe(2);
  });

  it("explains the IP allowlist error (21)", async () => {
    const { fs } = client({ fsError: 21 });
    await expect(fs.search("rice")).rejects.toThrow(/IP address.*proxy.s exit IP.*allowlist/);
  });

  it("explains the daily quota error (11)", async () => {
    const { fs } = client({ fsError: 11 });
    await expect(fs.search("rice")).rejects.toThrow(/daily request limit/);
  });

  it("reports rejected credentials", async () => {
    const { fs } = client({ badClient: true });
    await expect(fs.search("rice")).rejects.toThrow(/invalid_client/);
  });

  it("stops at its daily budget and resets the next UTC day", async () => {
    let now = Date.parse("2026-10-11T12:00:00Z");
    const { fake, fs } = client({}, { now: () => now, dailyBudget: 2 });
    await fs.search("rice");
    await fs.search("big mac");
    await expect(fs.search("white")).rejects.toBeInstanceOf(SourceUnavailable);
    expect(fake.apiCalls).toBe(2);
    now = Date.parse("2026-10-12T00:00:01Z");
    await fs.search("white");
    expect(fake.apiCalls).toBe(3);
  });
});

describe("TtlCache", () => {
  it("expires entries and evicts the least recently used", () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, 2, () => now);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    now = 1000;
    expect(cache.get("a")).toBeUndefined();
  });
});
