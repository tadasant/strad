import { describe, expect, it } from "vitest";

import { createClient, listPage } from "../src/client.js";
import { ConfigError, loadConfig, missingCredentials } from "../src/config.js";
import { TimeoutError } from "../src/errors.js";
import { BASE, FakeHetzner, TOKEN } from "./fake-hetzner.js";

describe("config", () => {
  it("names HCLOUD_TOKEN when it is missing or blank", () => {
    expect(missingCredentials({})).toEqual(["HCLOUD_TOKEN"]);
    expect(missingCredentials({ HCLOUD_TOKEN: " " })).toEqual(["HCLOUD_TOKEN"]);
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it("trims the token and the base URL", () => {
    expect(loadConfig({ HCLOUD_TOKEN: ` ${TOKEN}\n` }, `${BASE}/`)).toEqual({
      apiToken: TOKEN,
      baseUrl: BASE,
    });
  });
});

describe("client", () => {
  const config = { apiToken: TOKEN, baseUrl: BASE };

  it("sends repeated query keys for an array and drops undefined", async () => {
    const fake = new FakeHetzner();
    const client = createClient({ config, fetchImpl: fake.fetch });
    await client.request("/servers", {
      query: { status: ["off", "running"], name: undefined, page: 1 },
    });
    const url = fake.calls[0]!.url;
    expect(url.searchParams.getAll("status")).toEqual(["off", "running"]);
    expect(url.searchParams.has("name")).toBe(false);
    expect(url.searchParams.get("page")).toBe("1");
  });

  it("gives up after the timeout and says a write may have landed", async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    const client = createClient({ config, fetchImpl: hang, timeoutMs: 5 });
    await expect(client.request("/servers")).rejects.toThrow(TimeoutError);
    await expect(client.request("/servers")).rejects.toThrow(/WRITE/);
  });

  it("listPage infers a next page from the total when next_page is absent", async () => {
    const fake = new FakeHetzner();
    fake.on("GET /v1/servers", {
      body: { servers: [], meta: { pagination: { total_entries: 30 } } },
    });
    const client = createClient({ config, fetchImpl: fake.fetch });
    const page = await listPage(client, "/servers", "servers", 1, 25);
    expect(page).toMatchObject({
      has_next_page: true,
      next_page: 2,
      total: 30,
    });
  });

  it("listPage reports the last page", async () => {
    const fake = new FakeHetzner();
    const client = createClient({ config, fetchImpl: fake.fetch });
    const page = await listPage(client, "/servers", "servers", 1, 25);
    expect(page.has_next_page).toBe(false);
    expect(page.next_page).toBeUndefined();
    expect(page.items).toHaveLength(1);
  });
});
