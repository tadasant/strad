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

  it("nulls a whole nutrient row the expected source lacks, and says the total is partial", async () => {
    const { call } = await connect();
    const { json } = await call("estimate_components", {
      components: [
        { name: "chicken breast", quantity: 100, unit: "g", food_id: "usda:2002" },
        { name: "white rice, cooked", quantity: 1, unit: "cup" },
      ],
    });
    expect(json.components[0].range.fiber_g).toEqual({ low: null, expected: null, high: null });
    expect(json.totals.incomplete_nutrients).toContain("fiber_g");
    expect(json.totals.fiber_g.low).toBe(json.totals.fiber_g.expected);
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

describe("estimate_components accuracy (issue #436)", () => {
  it("scales a volume through the whole-cup portion, not USDA's truncated quarter cup", async () => {
    const { call } = await connect();
    const { json } = await call("estimate_components", {
      components: [
        { name: "ricotta", quantity: 0.75, unit: "cup", food_id: "usda:1004" },
        { name: "ricotta", quantity: 0.25, unit: "cup", food_id: "usda:1004" },
      ],
    });
    const [three, one] = json.components;
    // 0.75 × 258 g, not 0.75 / 0.2 × 64.6 g = 242 g.
    expect(three.candidates[0].grams_assumed).toBe(193.5);
    expect(three.candidates[0].grams_basis).toBe('0.75 cup via source portion "1 cup" = 258 g');
    expect(three.range.calories.expected).toBe(306);
    expect(one.candidates[0].grams_assumed).toBe(64.5);
  });

  it("shows a caller's amount as given", async () => {
    const { call } = await connect();
    const { json } = await call("estimate_components", {
      components: [{ name: "rice", quantity: 0.75, unit: "lb", food_id: "usda:3004" }],
    });
    expect(json.components[0].candidates[0].grams_basis).toBe("0.75 lb = 340.2 g");
  });

  it('matches "butter, unsalted" to butter, not a buttered pretzel', async () => {
    const { call } = await connect();
    const { json } = await call("estimate_components", {
      components: [
        { name: "butter, unsalted", quantity: 21, unit: "g" },
        { name: "unsalted butter", quantity: 1.5, unit: "tbsp" },
      ],
    });
    for (const c of json.components) {
      expect(c.expected_from).toBe("usda:2004");
      expect(c.candidates[0]).toMatchObject({ name: "Butter, without salt", match: "exact" });
      expect(c.flags).not.toContain("low_confidence_match");
      // The pretzel may still be shown as a runner-up, but only as a weak one.
      const pretzel = (c.alternatives.usda ?? []).find((a: Json) => a.id === "usda:3006");
      if (pretzel) expect(pretzel.match_score).toBeLessThan(0.5);
    }
    // 717 kcal/100 g × 21 g.
    expect(json.components[0].range.calories.expected).toBe(151);
  });

  it("never calls a buttered pretzel a strong match for butter when butter is not there", async () => {
    const { call } = await connect();
    const { json } = await call("search_foods", { query: "butter, unsalted", sources: ["usda"], kind: "dish" });
    const pretzel = json.results.usda.results.find((r: Json) => r.id === "usda:3006");
    expect(pretzel === undefined || pretzel.match === "weak").toBe(true);
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
    // FNDDS's "Big Mac (McDonalds)" is the chain's own item, so it is in the
    // range: 257 kcal/100 g × 205 g = 527, beside MenuStat's 540.
    expect(c.range.calories).toEqual({ low: 527, expected: 540, high: 621 });
    expect(c.buffer).toMatchObject({ applied_to: "high", pct: 15 });
    expect(c.flags).not.toContain("independent_restaurant_estimate");
    expect(c.flags).not.toContain("sources_disagree");
    const usda = c.candidates.find((x: Json) => x.source === "usda");
    expect(usda).toMatchObject({ id: "usda:3003", in_range: true });
    expect(usda.not_in_range_because).toBeUndefined();
    expect(c.notes.join(" ")).toContain("McDonald's");
    expect(json.totals.buffer_included).toBe(true);
  });

  it("keeps a generic USDA dish out of a chain item's range, and says why", async () => {
    const { call } = await connect();
    const { json } = await call("estimate_restaurant_item", { restaurant: "McDonald's", item: "cheeseburger" });
    const c = json.components[0];
    expect(c.expected_from).toBe("menustat:184");
    expect(c.range.calories).toEqual({ low: 300, expected: 300, high: 345 });
    const usda = c.candidates.find((x: Json) => x.source === "usda");
    expect(usda).toMatchObject({ id: "usda:3002", in_range: false });
    expect(usda.not_in_range_because).toContain("chain menu item matched");
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

  it("never lets a weak chain item set the estimate when no chain item matches", async () => {
    const { call } = await connect();
    const { json } = await call("estimate_restaurant_item", { restaurant: "chipotle", item: "chicken burrito" });
    const c = json.components[0];
    expect(c.flags).toContain("independent_restaurant_estimate");
    expect(c.expected_from).toBe("usda:3005");
    const ms = c.candidates.find((x: Json) => x.source === "menustat");
    expect(ms).toMatchObject({ id: "menustat:500", in_range: false });
    // 244 kcal/100 g × 220 g; the 180 kcal "Chicken" is not the low end.
    expect(c.range.calories).toEqual({ low: 537, expected: 537, high: 617 });
    expect(c.notes.join(" ")).toContain("Chipotle is in MenuStat");
  });

  it("buffers only calories, fat and saturated fat", async () => {
    const { call } = await connect();
    const { json } = await call("estimate_restaurant_item", { restaurant: "mcd", item: "big mac" });
    const c = json.components[0];
    expect(c.buffer.nutrients).toEqual(["calories", "fat_g", "saturated_fat_g"]);
    // FNDDS's Big Mac: 14.6 g/100 g × 205 g = 29.9 g, × 1.15.
    expect(c.range.fat_g.high).toBe(34.4);
    // Protein is not buffered: FNDDS's 24.2 g is the low end, MenuStat's 25 the high.
    expect(c.range.protein_g).toEqual({ low: 24.2, expected: 25, high: 25 });
  });

  it("keeps a numeric size in the query instead of treating it as a unit", async () => {
    const { call } = await connect();
    const { json } = await call("estimate_restaurant_item", { restaurant: "Joe's Diner", item: "cheeseburger", size: "16 oz" });
    const c = json.components[0];
    expect(c.expected_from).toBe("usda:3002");
    expect(c.range.calories.expected).toBe(421);
    expect(c.notes.join(" ")).toContain('size "16 oz" was not used');
  });

  it("adds FatSecret's current menu item and its attribution", async () => {
    const { call } = await connect(WITH_FS);
    const { json } = await call("estimate_restaurant_item", { restaurant: "mcd", item: "big mac" });
    const c = json.components[0];
    const fs = c.candidates.find((x: Json) => x.source === "fatsecret");
    expect(fs).toMatchObject({ id: "fatsecret:41963", brand: "McDonald's", in_range: true });
    expect(c.range.calories.low).toBe(527);
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
    expect(json.results.usda).toMatchObject({ status: "not_queried", results: [] });
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
