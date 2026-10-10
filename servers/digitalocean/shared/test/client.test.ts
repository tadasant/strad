import { describe, expect, it } from "vitest";

import { createClient, isLogHost, listPage, readTail } from "../src/client.js";
import {
  ConfigError,
  loadConfig,
  missingCredentials,
  ENV,
} from "../src/config.js";
import { DigitalOceanApiError, TimeoutError } from "../src/errors.js";
import { BASE, FakeDigitalOcean, LOGS_ORIGIN, TOKEN } from "./fake-do.js";

function build(fake = new FakeDigitalOcean(), timeoutMs?: number) {
  const client = createClient({
    config: { apiToken: TOKEN, baseUrl: BASE },
    fetchImpl: fake.fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { fake, client };
}

describe("config", () => {
  it("names the one missing variable, and treats blank as missing", () => {
    expect(missingCredentials({})).toEqual([ENV.apiToken]);
    expect(missingCredentials({ [ENV.apiToken]: "  " })).toEqual([
      ENV.apiToken,
    ]);
    expect(missingCredentials({ [ENV.apiToken]: TOKEN })).toEqual([]);
  });

  it("explains how a human gets the token", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(
      /cloud\.digitalocean\.com\/account\/api\/tokens/,
    );
  });

  it("trims the token and the base URL's trailing slash", () => {
    const config = loadConfig({ [ENV.apiToken]: ` ${TOKEN} ` }, `${BASE}/`);
    expect(config).toEqual({ apiToken: TOKEN, baseUrl: BASE });
  });
});

describe("request", () => {
  it("sends the bearer token, Accept, the query, and a JSON body", async () => {
    const { fake, client } = build();
    await client.request("/droplets", {
      method: "POST",
      query: { page: 2, skip: undefined, follow: false },
      body: { name: "web-2" },
    });
    const call = fake.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.href).toBe(`${BASE}/droplets?page=2&follow=false`);
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers.accept).toBe("application/json");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({ name: "web-2" });
  });

  it("sends no content-type and no body on a GET", async () => {
    const { fake, client } = build();
    await client.request("/account");
    expect(fake.calls[0]!.headers["content-type"]).toBeUndefined();
    expect(fake.calls[0]!.body).toBeUndefined();
  });

  it("returns undefined for a 204", async () => {
    const { client } = build();
    await expect(
      client.request("/droplets/3164444", { method: "DELETE" }),
    ).resolves.toBeUndefined();
  });

  it("classifies DigitalOcean's error envelope and keeps its id and request_id", async () => {
    const fake = new FakeDigitalOcean();
    fake.on("GET /v2/account", {
      status: 403,
      body: {
        id: "forbidden",
        message: "You are not authorized to perform this operation",
        request_id: "req-1",
      },
    });
    const { client } = build(fake);
    const err = (await client
      .request("/account")
      .catch((e) => e)) as DigitalOceanApiError;
    expect(err).toBeInstanceOf(DigitalOceanApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("forbidden");
    expect(err.requestId).toBe("req-1");
    expect(err.message).toMatch(/lacks the scope/);
  });

  it("scrubs the token when DigitalOcean echoes it in an error", async () => {
    const fake = new FakeDigitalOcean();
    fake.on("GET /v2/account", {
      status: 401,
      body: { id: "unauthorized", message: `bad token ${TOKEN}` },
    });
    const { client } = build(fake);
    const err = (await client.request("/account").catch((e) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("[redacted]");
    expect(err.message).toMatch(/Retrying will not help/);
  });

  it("caps a non-JSON error body instead of dumping it", async () => {
    const fake = new FakeDigitalOcean();
    fake.on("GET /v2/account", {
      status: 502,
      text: "<html>" + "x".repeat(5000) + "</html>",
    });
    const { client } = build(fake);
    const err = (await client.request("/account").catch((e) => e)) as Error;
    expect(err.message.length).toBeLessThan(500);
  });

  it("abandons a request that does not answer, with a timeout error", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    const client = createClient({
      config: { apiToken: TOKEN, baseUrl: BASE },
      fetchImpl: hanging,
      timeoutMs: 20,
    });
    const err = await client.request("/account").catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toMatch(/did not answer/);
  });
});

describe("fetchExternalText", () => {
  it("fetches a signed link with NO credential and no redirects", async () => {
    const { fake, client } = build();
    const out = await client.fetchExternalText(
      `${LOGS_ORIGIN}/logs/abc?X-Amz-Signature=sig`,
    );
    expect(out.text).toContain("line 1");
    expect(out.truncated).toBe(false);
    expect(out.bytes).toBe(Buffer.byteLength(out.text));
    const call = fake.calls[0]!;
    expect(call.url.origin).toBe(LOGS_ORIGIN);
    expect(call.headers.authorization).toBeUndefined();
    expect(JSON.stringify(call.headers)).not.toContain(TOKEN);
    expect(call.redirect).toBe("error");
  });

  it("refuses plain http, the API host, and any host that is not DigitalOcean's", async () => {
    const { fake, client } = build();
    for (const url of [
      "http://nyc3.digitaloceanspaces.com/x",
      `${BASE}/account`,
      "https://api.digitalocean.com/v2/account",
      "https://logs.example/x",
      "https://digitaloceanspaces.com.evil.example/x",
      "https://evil-digitaloceanspaces.com/x",
      "https://strad-abc.ondigitalocean.app/x",
      "https://nyc3.digitaloceanspaces.com:8443/x",
    ]) {
      await expect(client.fetchExternalText(url)).rejects.toThrow(
        /will not follow/,
      );
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("accepts a Spaces host and a digitalocean.com subdomain", () => {
    const api = "api.digitalocean.com";
    expect(isLogHost("nyc3.digitaloceanspaces.com", api)).toBe(true);
    expect(isLogHost("Logs.DigitalOcean.com", api)).toBe(true);
    expect(isLogHost("api.digitalocean.com", api)).toBe(false);
    expect(isLogHost("digitalocean.com.example", api)).toBe(false);
  });

  it("refuses a redirect instead of following it", async () => {
    const fake = new FakeDigitalOcean();
    fake.on(`GET ${new URL(LOGS_ORIGIN).host}/logs/abc`, {
      status: 302,
      headers: { location: "https://attacker.example/x" },
    });
    const { client } = build(fake);
    await expect(
      client.fetchExternalText(`${LOGS_ORIGIN}/logs/abc`),
    ).rejects.toThrow(/redirect/);
    expect(fake.calls.map((c) => c.url.host)).toEqual([
      new URL(LOGS_ORIGIN).host,
    ]);
  });

  it("refuses a 3xx even from a fetch that ignores redirect: error", async () => {
    const lax: typeof fetch = async () =>
      new Response(null, {
        status: 301,
        headers: { location: "https://attacker.example/x" },
      });
    const client = createClient({
      config: { apiToken: TOKEN, baseUrl: BASE },
      fetchImpl: lax,
    });
    await expect(
      client.fetchExternalText(`${LOGS_ORIGIN}/logs/abc`),
    ).rejects.toThrow(/redirect \(HTTP 301\)/);
  });

  it("streams a body larger than the cap and keeps only its tail", async () => {
    let pulled = 0;
    const big: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulled === 1000) return controller.close();
            pulled += 1;
            controller.enqueue(
              new TextEncoder().encode(`row ${pulled} ${"x".repeat(90)}\n`),
            );
          },
        }),
      );
    const client = createClient({
      config: { apiToken: TOKEN, baseUrl: BASE },
      fetchImpl: big,
      logCapBytes: 1024,
    });
    const out = await client.fetchExternalText(`${LOGS_ORIGIN}/logs/abc`);
    expect(pulled).toBe(1000);
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBeGreaterThan(90_000);
    expect(out.kept_bytes).toBeLessThanOrEqual(1024);
    expect(out.text.endsWith(`row 1000 ${"x".repeat(90)}\n`)).toBe(true);
    // The partial first line of the window is dropped, not returned cut.
    expect(out.text.startsWith("row ")).toBe(true);
  });
});

describe("readTail", () => {
  const stream = (...parts: string[]) =>
    new Response(parts.join("")).body as ReadableStream<Uint8Array>;

  it("returns a body within the cap whole", async () => {
    const out = await readTail(stream("a\nb\n"), 100);
    expect(out).toEqual({
      text: "a\nb\n",
      bytes: 4,
      kept_bytes: 4,
      truncated: false,
    });
  });

  it("drops a UTF-8 character the cut lands inside", async () => {
    const out = await readTail(stream("ééééé"), 5);
    expect(out.truncated).toBe(true);
    expect(out.text).toBe("éé");
  });

  it("treats a null body as empty", async () => {
    expect((await readTail(null, 10)).text).toBe("");
  });
});

describe("listPage", () => {
  it("returns one page, meta.total, and the next page when links say there is one", async () => {
    const { fake, client } = build();
    const page = await listPage(
      client,
      "/customers/my/billing_history",
      "billing_history",
      1,
      20,
    );
    expect(page).toMatchObject({
      page: 1,
      per_page: 20,
      total: 45,
      has_next_page: true,
      next_page: 2,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url.searchParams.get("per_page")).toBe("20");
  });

  it("says there is no next page on the last one", async () => {
    const { client } = build();
    const page = await listPage(client, "/droplets", "droplets", 1, 20);
    expect(page.has_next_page).toBe(false);
    expect(page.next_page).toBeUndefined();
  });
});
