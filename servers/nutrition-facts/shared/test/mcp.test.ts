import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createMCPServer, missingCredentials, toolNames } from "../src/index.js";
import { DESCRIPTION_BUDGET } from "../src/tools/shared.js";
import { buildFixtureData } from "./fixtures.js";
import { FakeApis, FDC_API, FS_API, FS_CREDENTIALS, TOKEN_URL, type FakeOptions } from "./fake-apis.js";

/**
 * The server as an agent meets it: a real MCP `Client` over an in-memory
 * transport, against fixture data built by the real data builders and a fake
 * FatSecret / FDC. No network.
 */

const { dir: DATA_DIR } = buildFixtureData();
const ALL = ["estimate_components", "estimate_restaurant_item", "search_foods", "get_food"];

type Json = Record<string, any>;

async function connect(
  options: { env?: NodeJS.ProcessEnv; fake?: FakeOptions; dataDir?: string } = {},
) {
  const fake = new FakeApis(options.fake);
  const { server, registerHandlers } = createMCPServer({
    version: "0.0.0-test",
    env: options.env ?? {},
    dataDir: options.dataDir ?? DATA_DIR,
    fetch: fake.fetch,
    fatsecretFetch: fake.fatsecretFetch,
    urls: { fatsecretToken: TOKEN_URL, fatsecretApi: FS_API, fdc: FDC_API },
  });
  await registerHandlers(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    const text = result.content[0]!.text;
    let json: Json | undefined;
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = undefined;
    }
    return { isError: result.isError === true, text, json: json as Json };
  };
  return { fake, client, call };
}

const WITH_FS = { env: { ...FS_CREDENTIALS } };

describe("tools/list", () => {
  it("serves four read-only tools whose descriptions fit the client budget", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(ALL);
    expect(toolNames(["readonly"])).toEqual(ALL);
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeLessThanOrEqual(DESCRIPTION_BUDGET);
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("requires no credential", () => {
    expect(missingCredentials()).toEqual([]);
  });
});

describe("estimate_components without FatSecret", () => {
  it("answers from local USDA, scaled through USDA's own portion, and says FatSecret is unavailable", async () => {
    const { call, fake } = await connect();
    const { isError, json } = await call("estimate_components", {
      components: [{ name: "white rice, cooked", quantity: 1, unit: "cup" }],
    });
    expect(isError).toBe(false);
    const c = json.components[0];
    expect(c.expected_from).toMatch(/^usda:/);
    expect(c.candidates[0]).toMatchObject({ source: "usda", grams_assumed: 158, in_range: true });
    expect(c.candidates[0].grams_basis).toContain("1 cup");
    expect(c.range.calories.expected).toBeGreaterThan(200);
    expect(c.source_status).toEqual({ usda: "answered", menustat: "not_queried", fatsecret: "unavailable" });
    expect(json.sources.fatsecret).toMatchObject({ status: "unavailable" });
    expect(json.sources.fatsecret.detail).toContain("FATSECRET_CLIENT_ID");
    expect(json.attribution).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  it("sums totals across components", async () => {
    const { call } = await connect();
    const { json } = await call("estimate_components", {
      components: [
        { name: "pad thai", quantity: 2, unit: "cup", kind: "dish" },
        { name: "apples, raw", quantity: 1, unit: "medium" },
      ],
    });
    const [pad, apple] = json.components;
    // Pad Thai, NFS: 154 kcal/100 g, 1 cup = 200 g. Apple: 61 kcal/100 g, 1 medium = 200 g.
    expect(pad.range.calories.expected).toBe(616);
    expect(apple.range.calories.expected).toBe(122);
    expect(json.totals.calories).toEqual({ low: 738, expected: 738, high: 738 });
  });

  it("flags needs_grams with per-100 g values when no portion converts the unit", async () => {
    const { call } = await connect();
    const { json } = await call("estimate_components", {
      components: [{ name: "olive oil", quantity: 1, unit: "drizzle" }],
    });
    const c = json.components[0];
    expect(c.flags).toContain("needs_grams");
    expect(c.range).toBeNull();
    expect(c.candidates[0].per_100g.calories).toBe(900);
    expect(c.candidates[0].flags).toContain("calories_computed_from_macros");
    expect(json.totals.components_without_estimate).toEqual([0]);
  });

  it("pins a candidate with food_id", async () => {
    const { call } = await connect();
    const { json } = await call("estimate_components", {
      components: [{ name: "rice", quantity: 100, unit: "g", food_id: "usda:3004" }],
    });
    expect(json.components[0].expected_from).toBe("usda:3004");
    expect(json.components[0].candidates[0].match).toBe("pinned");
  });

  it("reports a missing data directory as unavailable, not as a crash", async () => {
    const { call } = await connect({ dataDir: mkdtempSync(join(tmpdir(), "nf-empty-")) });
    const { isError, json } = await call("estimate_components", {
      components: [{ name: "rice", quantity: 1, unit: "cup" }],
    });
    expect(isError).toBe(false);
    expect(json.sources.usda.status).toBe("unavailable");
    expect(json.sources.usda.detail).toContain("usda.json.gz");
    expect(json.components[0].flags).toContain("no_match");
  });

  it("refuses unknown and malformed arguments", async () => {
    const { call } = await connect();
    const bad = await call("estimate_components", { components: [{ name: "rice", quantity: -1 }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("components.0.quantity");
    const extra = await call("estimate_components", { components: [{ name: "rice", quantity: 1, grams: 5 }] });
    expect(extra.isError).toBe(true);
  });
});

describe("estimate_components with FatSecret", () => {
  it("puts both sources side by side, flags a >20% disagreement, and attributes FatSecret", async () => {
    const { call, fake } = await connect(WITH_FS);
    const { json } = await call("estimate_components", {
      components: [{ name: "white rice, cooked", quantity: 1, unit: "cup" }],
    });
    const c = json.components[0];
    const fs = c.candidates.find((x: Json) => x.source === "fatsecret");
    expect(fs).toMatchObject({ id: "fatsecret:4501", grams_assumed: 158 });
    expect(fs.nutrients.calories).toBe(260);
    expect(c.disagreement).toMatchObject({ threshold_pct: 20 });
    expect(c.flags).toContain("sources_disagree");
    expect(c.range.calories.low).toBeLessThan(c.range.calories.high);
    expect(c.range.calories.high).toBe(260);
    expect(json.sources.fatsecret.status).toBe("answered");
    expect(json.attribution).toEqual({
      text: "Powered by fatsecret Platform API",
      url: "https://platform.fatsecret.com",
      html: '<a href="https://platform.fatsecret.com">Powered by fatsecret Platform API</a>',
    });
    // One search, one food.get for the best match.
    expect(fake.fsCalls).toHaveLength(2);
  });

  it("treats FatSecret as unconfigured without the proxy, and never calls it", async () => {
    const { FATSECRET_PROXY_URL: _unset, ...noProxy } = FS_CREDENTIALS;
    const { call, fake } = await connect({ env: noProxy });
    const { json } = await call("estimate_components", {
      components: [{ name: "white rice, cooked", quantity: 1, unit: "cup" }],
    });
    expect(json.components[0].expected_from).toMatch(/^usda:/);
    expect(json.sources.fatsecret.status).toBe("unavailable");
    expect(json.sources.fatsecret.detail).toContain("FATSECRET_PROXY_URL is not set");
    expect(fake.calls).toEqual([]);
  });

  it("serves a repeat from cache", async () => {
    const { call, fake } = await connect(WITH_FS);
    const args = { components: [{ name: "white rice", quantity: 1, unit: "cup" }] };
    await call("estimate_components", args);
    await call("estimate_components", args);
    expect(fake.fsCalls).toHaveLength(2);
  });

  it("still answers locally when FatSecret refuses the caller's IP", async () => {
    const { call } = await connect({ ...WITH_FS, fake: { fsError: 21 } });
    const { json } = await call("estimate_components", {
      components: [{ name: "white rice, cooked", quantity: 1, unit: "cup" }],
    });
    expect(json.components[0].expected_from).toMatch(/^usda:/);
    expect(json.sources.fatsecret.status).toBe("unavailable");
    expect(json.sources.fatsecret.detail).toContain("error 21");
  });

  it("searches USDA Branded for a brand when a key is set, and says so when not", async () => {
    const without = await connect();
    const a = await without.call("estimate_components", {
      components: [{ name: "greek yogurt", quantity: 1, unit: "serving", brand: "Chobani" }],
    });
    expect(a.json.components[0].notes.join(" ")).toContain("USDA_FDC_API_KEY");

    const withKey = await connect({ env: { USDA_FDC_API_KEY: "fdc-key" } });
    const b = await withKey.call("estimate_components", {
      components: [{ name: "greek yogurt", quantity: 1, unit: "serving", brand: "Chobani" }],
    });
    const c = b.json.components[0];
    expect(c.expected_from).toBe("usda:9001");
    expect(c.candidates[0]).toMatchObject({ dataset: "branded", brand: "CHOBANI", grams_assumed: 170 });
    expect(c.candidates[0].nutrients.calories).toBe(90);
  });
});

describe("estimate_restaurant_item", () => {
  it('matches "mcd" to McDonald\'s, uses the latest MenuStat year, and buffers the high end 15%', async () => {
    const { call } = await connect();
    const { json } = await call("estimate_restaurant_item", { restaurant: "mcd", item: "big mac" });
    const c = json.components[0];
    expect(c.expected_from).toBe("menustat:180");
    const ms = c.candidates.find((x: Json) => x.source === "menustat");
    expect(ms).toMatchObject({ restaurant: "McDonald's", data_year: 2018, in_range: true });
    expect(c.range.calories).toEqual({ low: 540, expected: 540, high: 621 });
    expect(c.buffer).toMatchObject({ applied_to: "high", pct: 15 });
    expect(c.flags).not.toContain("independent_restaurant_estimate");
    // The USDA generic dish is evidence, but a chain match keeps it out of the range.
    expect(c.candidates.find((x: Json) => x.source === "usda").in_range).toBe(false);
    expect(c.notes.join(" ")).toContain("McDonald's");
    expect(json.totals.buffer_included).toBe(true);
  });

  it("takes the buffer as configured", async () => {
    const { call } = await connect();
    const { json } = await call("estimate_restaurant_item", { restaurant: "McDonald's", item: "Big Mac", buffer_pct: 0 });
    expect(json.components[0].range.calories.high).toBe(540);
    expect(json.components[0].buffer).toBeUndefined();
  });

  it("picks a size from the item name", async () => {
    const { call } = await connect();
    const { json } = await call("estimate_restaurant_item", { restaurant: "mcdonalds", item: "french fries", size: "large" });
    expect(json.components[0].expected_from).toBe("menustat:181");
  });

  it("falls back to a USDA FNDDS dish for an independent restaurant, flagged", async () => {
    const { call } = await connect();
    const { json } = await call("estimate_restaurant_item", { restaurant: "Joe's Diner", item: "cheeseburger" });
    const c = json.components[0];
    expect(c.flags).toContain("independent_restaurant_estimate");
    expect(c.expected_from).toBe("usda:3002");
    // Cheeseburger, NFS: 263 kcal/100 g × FNDDS's "1 sandwich, any size" = 160 g.
    expect(c.range.calories.expected).toBe(421);
    expect(c.range.calories.high).toBe(484);
    expect(json.sources.menustat.status).toBe("no_match");
  });

  it("adds FatSecret's current menu item and its attribution", async () => {
    const { call } = await connect(WITH_FS);
    const { json } = await call("estimate_restaurant_item", { restaurant: "mcd", item: "big mac" });
    const c = json.components[0];
    const fs = c.candidates.find((x: Json) => x.source === "fatsecret");
    expect(fs).toMatchObject({ id: "fatsecret:41963", brand: "McDonald's", in_range: true });
    expect(c.range.calories.low).toBe(540);
    // 590 × 1.15
    expect(c.range.calories.high).toBe(679);
    expect(json.attribution.text).toBe("Powered by fatsecret Platform API");
  });
});

describe("search_foods and get_food", () => {
  it("searches each requested source and reports the rest of the shape", async () => {
    const { call } = await connect();
    const { json } = await call("search_foods", { query: "big mac" });
    expect(json.results.usda.results[0].id).toBe("usda:3003");
    expect(json.results.menustat.results[0]).toMatchObject({ id: "menustat:180", restaurant: "McDonald's", per: "1 item" });
    expect(json.results.fatsecret.status).toBe("unavailable");
  });

  it("browses one chain's menu", async () => {
    const { call } = await connect();
    const { json } = await call("search_foods", { query: "fries", restaurant: "mcd", sources: ["menustat"] });
    expect(json.results.menustat.matched_restaurant).toBe("McDonald's");
    expect(json.results.menustat.results.map((r: Json) => r.id).sort()).toEqual(["menustat:181", "menustat:182"]);
    expect(json.results.usda).toBeUndefined();
  });

  it("gets a USDA food with portions and per-100 g values", async () => {
    const { call } = await connect();
    const { json } = await call("get_food", { id: "usda:2001" });
    expect(json).toMatchObject({ dataset: "sr_legacy", data_year: 2018, category: "Cereal Grains and Pasta" });
    expect(json.per_100g.calories).toBe(130);
    expect(json.portions).toEqual([{ label: "1 cup", grams: 158 }]);
  });

  it("gets a FatSecret food with every serving, attributed", async () => {
    const { call } = await connect(WITH_FS);
    const { json } = await call("get_food", { id: "fatsecret:4501" });
    expect(json.portions).toHaveLength(2);
    expect(json.per_100g.calories).toBe(165);
    expect(json.attribution).toBeDefined();
  });

  it("refuses an id it cannot parse, and one it cannot reach", async () => {
    const { call } = await connect();
    expect((await call("get_food", { id: "rice" })).text).toContain("not a candidate id");
    const fs = await call("get_food", { id: "fatsecret:4501" });
    expect(fs.isError).toBe(true);
    expect(fs.text).toContain("FATSECRET_CLIENT_ID");
    const usda = await call("get_food", { id: "usda:123456789" });
    expect(usda.text).toContain("USDA_FDC_API_KEY");
  });
});

describe("missingDataFiles", () => {
  it("names the files a data directory lacks", async () => {
    const { missingDataFiles } = await import("../src/index.js");
    expect(missingDataFiles(DATA_DIR)).toEqual([]);
    expect(missingDataFiles(mkdtempSync(join(tmpdir(), "nf-none-")))).toEqual(["usda.json.gz", "menustat.json.gz"]);
  });
});
