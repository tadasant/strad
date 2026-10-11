import { describe, expect, it } from "vitest";

import { restaurantScore } from "../src/local/menustat.js";
import { fromTuple } from "../src/nutrients.js";
import { matchLabel, nameTokens, score, tokens } from "../src/text.js";
import { parsePortionLabel, parseUnit, portion, resolve } from "../src/units.js";

describe("text matching", () => {
  it("folds plurals, punctuation and stop words", () => {
    expect(tokens("Tomatoes, grape, raw")).toEqual(["tomato", "grape", "raw"]);
    expect(tokens("Chicken w/ Rice & Beans")).toEqual(["chicken", "rice", "bean"]);
  });

  it("does not treat a prefix as the word", () => {
    expect(score("apple", "APPLEBEE'S, chili").score).toBeLessThan(0.3);
    expect(score("cheeseburger", "Cheese, NFS").score).toBeLessThan(0.3);
  });

  it("ignores USDA's neutral qualifiers in names", () => {
    expect(nameTokens("Rice, white, cooked, no added fat")).toEqual(["rice", "white", "cooked"]);
    expect(nameTokens("Rice, white, cooked, NS as to fat added in cooking")).toEqual(["rice", "white", "cooked"]);
  });

  it("labels scores", () => {
    expect(matchLabel(1)).toBe("exact");
    expect(matchLabel(0.8)).toBe("strong");
    expect(matchLabel(0.6)).toBe("partial");
    expect(matchLabel(0.4)).toBe("weak");
  });
});

describe("restaurant matching", () => {
  it.each([
    ["mcd", "McDonald's"],
    ["mcdonalds", "McDonald's"],
    ["maccas", "McDonald's"],
    ["chick fil a", "Chick-Fil-A"],
    ["dominos pizza", "Dominos"],
    ["bk", "Burger King"],
    ["dunkin", "Dunkin' Donuts"],
  ])("%s names %s", (query, chain) => {
    expect(restaurantScore(query, chain)).toBeGreaterThanOrEqual(0.6);
  });

  it("does not match an unrelated restaurant", () => {
    expect(restaurantScore("Joe's Diner", "McDonald's")).toBeLessThan(0.6);
    expect(restaurantScore("Joe's Diner", "Jason's Deli")).toBeLessThan(0.6);
  });
});

describe("units and scaling", () => {
  const per100 = fromTuple([130, 2.7, 28, 0.3, 0.4, 0.1, 0.1, 1]);
  const cup = portion("1 cup", 158);

  it("parses units and portion labels", () => {
    expect(parseUnit("fl oz")).toMatchObject({ kind: "volume" });
    expect(parseUnit("OZ")).toMatchObject({ kind: "mass", grams: 28.3495 });
    expect(parseUnit("slices")).toMatchObject({ kind: "count", word: "slice" });
    expect(parseUnit(undefined)).toMatchObject({ kind: "count", word: "serving" });
    expect(parsePortionLabel("1 1/2 cup, chopped")).toMatchObject({ amount: 1.5, unit: { kind: "volume" } });
    expect(parsePortionLabel("Quantity not specified")).toMatchObject({ unit: { word: "serving" } });
  });

  it("converts mass directly", () => {
    const r = resolve(200, parseUnit("g"), per100, [cup]);
    expect(r.grams).toBe(200);
    expect(r.nutrients!.calories).toBeCloseTo(260);
  });

  it("converts a volume through the source's own volume portion", () => {
    const r = resolve(2, parseUnit("tbsp"), per100, [cup]);
    // 2 tbsp is 1/8 cup.
    expect(r.grams).toBeCloseTo(158 / 8, 1);
    expect(r.basis).toContain('"1 cup"');
  });

  it("converts a count word only through a portion with that word", () => {
    const banana = [portion("1 medium (7\" to 7-7/8\" long)", 118), portion("1 large", 136)];
    expect(resolve(2, parseUnit("medium"), per100, banana).grams).toBe(236);
    const none = resolve(1, parseUnit("slice"), per100, banana);
    expect(none).toMatchObject({ grams: null, nutrients: null });
  });

  it("maps serving to a serving portion, the default, or a package", () => {
    expect(resolve(1, parseUnit("serving"), per100, [portion("Quantity not specified", 330)]).grams).toBe(330);
    const item = portion("1 item", null, per100);
    expect(resolve(2, parseUnit("each"), null, [item], item).nutrients!.calories).toBe(260);
    expect(resolve(1, parseUnit("serving"), per100, [portion("1 container (6 oz)", 170)]).grams).toBe(170);
  });

  it("scales a per-portion source and derives per-gram values from it", () => {
    const burger = portion("1 burger", 219, fromTuple([590, 25, 46, 34]));
    expect(resolve(1, parseUnit("serving"), null, [burger], burger).nutrients!.calories).toBe(590);
    expect(resolve(110, parseUnit("g"), null, [burger], burger).nutrients!.calories).toBeCloseTo(296.3, 1);
  });

  it("maps whole to a fruit portion", () => {
    expect(resolve(0.5, parseUnit("whole"), per100, [portion("1 fruit", 150)]).grams).toBe(75);
  });
});
