import { describe, expect, it } from "vitest";

import { csvRows } from "../src/data/csv.js";
import { buildMenuStat } from "../src/data/menustat-build.js";
import { MENUSTAT_SOURCE, USDA_SOURCES } from "../src/data/sources.js";
import { exactPortions } from "../src/data/usda-build.js";
import { fromTuple } from "../src/nutrients.js";
import { buildFixtureData, MENUSTAT_CSV } from "./fixtures.js";

describe("csvRows", () => {
  it("reads quoted fields with commas, doubled quotes and newlines", () => {
    const rows = [...csvRows('"a","b, c","say ""hi""","two\nlines"\n"x",y,,z\r\n')];
    expect(rows).toEqual([
      ["a", "b, c", 'say "hi"', "two\nlines"],
      ["x", "y", "", "z"],
    ]);
  });

  it("drops a byte-order mark and handles a missing final newline", () => {
    expect([...csvRows("﻿id,name\n1,rice")]).toEqual([
      ["id", "name"],
      ["1", "rice"],
    ]);
  });
});

describe("buildUsda", () => {
  const { usda } = buildFixtureData();
  const byId = (id: number) => usda.foods.find((f) => f.i === id)!;

  it("keeps only foundation, SR Legacy and FNDDS foods", () => {
    expect(usda.foods.map((f) => f.i)).toEqual([1001, 1002, 1004, 2001, 2002, 2003, 2004, 3001, 3002, 3003, 3004, 3005, 3006, 3007]);
    expect(usda.foods.find((f) => f.i === 1003)).toBeUndefined();
  });

  it("falls back across nutrient ids: Atwater energy, sugars 1063", () => {
    const apple = fromTuple(byId(1001).k);
    expect(apple.calories).toBe(61);
    expect(apple.sugar_g).toBe(10.4);
    expect(byId(1001).e).toBeUndefined();
  });

  it("computes 4/4/9 energy when no energy id is present, and flags it", () => {
    const oil = byId(1002);
    expect(fromTuple(oil.k).fat_g).toBe(100);
    expect(fromTuple(oil.k).calories).toBe(900);
    expect(oil.e).toBe(1);
  });

  it("maps FNDDS nutrient numbers in the nutrient_id column", () => {
    const pad = fromTuple(byId(3001).k);
    expect(pad).toEqual({
      calories: 154,
      protein_g: 7.2,
      carbs_g: 21.4,
      fat_g: 4.6,
      fiber_g: 1.4,
      sugar_g: 4.3,
      saturated_fat_g: 0.8,
      sodium_mg: 400,
    });
  });

  it("writes each dataset's portions in one label form", () => {
    expect(byId(1001).p).toEqual([["1 medium", 200]]);
    expect(byId(1002).p).toEqual([["1 tablespoon", 13.5]]);
    expect(byId(2002).p).toEqual([["0.5 breast, bone and skin removed", 86]]);
    expect(byId(3001).p).toEqual([
      ["1 cup", 200],
      ["Quantity not specified", 330],
    ]);
  });

  it("restores a portion amount USDA truncated, by the food's own other portions", () => {
    // Foundation writes ricotta's quarter cup as "0.2 cup" = 64.6 g; its own
    // "1 cup" = 258 g makes that 0.25.
    expect(byId(1004).p).toEqual([
      ["1/4 cup", 64.6],
      ["0.5 cup", 129],
      ["1 cup", 258],
    ]);
  });

  it("uses the SR Legacy release year, categories, and a missing value as null", () => {
    expect(byId(2001).y).toBe(2018);
    expect(byId(2001).c).toBe("Cereal Grains and Pasta");
    expect(byId(3001).c).toBe("Asian mixed dishes");
    expect(fromTuple(byId(2002).k).fiber_g).toBeNull();
  });
});

describe("exactPortions", () => {
  it("reads a two-decimal third, sixth, eighth or twelfth as that fraction", () => {
    expect(exactPortions([["0.33 cup", 56], ["0.66 cup (#6 scoop)", 167], ["0.12 pie", 131], ["1.33 tbsp", 9], ["0.08 package", 34]])).toEqual([
      ["1/3 cup", 56],
      ["2/3 cup (#6 scoop)", 167],
      ["1/8 pie", 131],
      ["1 1/3 tbsp", 9],
      ["1/12 package", 34],
    ]);
  });

  it("leaves a decimal alone without a sibling that proves it truncated", () => {
    // Tofu's "0.2 block" is a fifth: its 1 block puts it at 0.28, no fraction.
    const tofu: Array<[string, number]> = [["0.2 block", 91], ["1 block", 320]];
    expect(exactPortions(tofu)).toEqual(tofu);
    expect(exactPortions([["0.2 package", 79], ["5.3 oz", 150], ["0.35 oz", 9.9], ["0.7 oz", 20]])).toEqual([
      ["0.2 package", 79],
      ["5.3 oz", 150],
      ["0.35 oz", 9.9],
      ["0.7 oz", 20],
    ]);
  });
});

describe("buildMenuStat", () => {
  const items = buildMenuStat(MENUSTAT_CSV);

  it("keeps each item at its latest year and drops rows without calories", () => {
    const bigMacs = items.filter((i) => i.n === "Big Mac");
    expect(bigMacs).toHaveLength(1);
    expect(bigMacs[0]).toMatchObject({ i: 180, y: 2018, k: [540, 25, 46, 28, 3, 9, 10, 950] });
    expect(items.find((i) => i.n === "McRib")?.y).toBe(2017);
    expect(items.find((i) => i.n === "Iced Coffee")).toBeUndefined();
  });

  it("records a weight serving in grams and a volume serving as text", () => {
    expect(items.find((i) => i.i === 181)).toMatchObject({ g: 150, s: "150 g" });
    expect(items.find((i) => i.i === 400)).toMatchObject({ g: null, s: "16 fl oz" });
  });
});

describe("pinned sources", () => {
  it("pins every download by a 64-hex SHA-256 over https", () => {
    for (const s of [...Object.values(USDA_SOURCES), MENUSTAT_SOURCE]) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
