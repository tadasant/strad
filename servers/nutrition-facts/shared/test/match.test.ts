import { describe, expect, it } from "vitest";

import type { UsdaRecord } from "../src/data/format.js";
import { restaurantScore } from "../src/local/menustat.js";
import { UsdaIndex } from "../src/local/usda.js";
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

  it('does not read a word with "-ed" on it as the word', () => {
    expect(score("butter", "Pretzels, soft, buttered").coverage).toBe(0);
    expect(score("salt", "Butter, salted").coverage).toBe(0);
    expect(score("bread", "Chicken, breaded").coverage).toBe(0);
    // A cooking method's "-ed" form is the same food.
    expect(score("roast chicken", "Chicken, roasted").coverage).toBe(1);
    expect(score("smoke salmon", "Salmon, smoked").coverage).toBe(1);
    // A spelling the plural fold missed still matches.
    expect(score("tomatoe", "Tomato, raw").coverage).toBe(1);
  });

  it('folds "without salt" into "unsalted", and keeps a negated word from matching the word', () => {
    expect(tokens("Butter, without salt")).toEqual(["butter", "unsalted"]);
    expect(tokens("Beans, canned, no salt added")).toEqual(["bean", "canned", "unsalted"]);
    expect(tokens("Butter, whipped, with salt")).toEqual(["butter", "whipped", "salted"]);
    expect(score("butter, unsalted", "Butter, without salt").score).toBe(1);
    expect(score("butter", "Pretzels, soft, unsalted, no butter").coverage).toBe(0);
    expect(score("peanuts", "Mixed nuts, without peanuts").coverage).toBe(0);
    expect(tokens("Peanuts, with salt added")).toEqual(["peanut", "salted"]);
    expect(tokens("Applesauce, no sugar added")).toEqual(["applesauce", "nosugar"]);
    expect(tokens("Applesauce, no added sugar")).toEqual(["applesauce", "nosugar"]);
    expect(score("chicken skin", "Chicken, without the skin").coverage).toBe(0.5);
  });

  it("scores the real butter above a buttered pretzel, and the pretzel weak", () => {
    const butter = score("butter, unsalted", "Butter, without salt").score;
    const pretzel = score("butter, unsalted", "Pretzels, soft, ready-to-eat, unsalted, buttered").score;
    expect(butter).toBeGreaterThan(pretzel);
    expect(matchLabel(pretzel)).toBe("weak");
    // Good matches stay what they were.
    expect(matchLabel(score("salted butter", "Butter, salted").score)).toBe("exact");
    expect(matchLabel(score("unsalted peanuts", "Peanuts, roasted, unsalted").score)).toBe("strong");
    expect(matchLabel(score("chicken breast", "Chicken, broilers or fryers, breast, meat only, cooked, roasted").score)).toBe("strong");
  });

  it("labels scores", () => {
    expect(matchLabel(1)).toBe("exact");
    expect(matchLabel(0.8)).toBe("strong");
    expect(matchLabel(0.6)).toBe("partial");
    expect(matchLabel(0.4)).toBe("weak");
  });
});

describe("USDA ranking", () => {
  const food = (i: number, n: string, d: UsdaRecord["d"] = "S"): UsdaRecord => ({
    i,
    d,
    n,
    c: "",
    y: 2018,
    k: [100, 1, 1, 1, null, null, null, null],
    p: [],
  });
  const index = new UsdaIndex({
    version: 1,
    built_at: "",
    sources: [],
    foods: [
      food(1, "Peanut butter, chunk style, without salt"),
      food(2, "Peanuts, roasted, unsalted", "N"),
      food(3, "Rice flour, brown"),
      food(4, "Rice, brown, long-grain, cooked"),
      food(5, "Big Mac (McDonalds)", "N"),
    ],
  });

  it("ranks a compound the query only half names below the food itself", () => {
    expect(index.search("unsalted peanuts", { kind: "ingredient" })[0]!.id).toBe("usda:2");
    expect(index.search("brown rice")[0]!.id).toBe("usda:4");
  });

  it("does not count a parenthetical as part of the name's head", () => {
    expect(index.search("big mac")[0]!.id).toBe("usda:5");
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

  it("scales through the whole-unit portion when a source lists several in one unit", () => {
    // USDA's ricotta: "0.2 cup" = 64.6 g is a truncated quarter cup.
    const ricotta = [portion("0.2 cup", 64.6), portion("0.5 cup", 129), portion("1 cup", 258)];
    const r = resolve(0.75, parseUnit("cup"), per100, ricotta);
    expect(r.grams).toBeCloseTo(193.5, 5);
    expect(r.basis).toBe('0.75 cup via source portion "1 cup" = 258 g');
    expect(resolve(0.75, parseUnit("cup"), per100, [portion("1/4 cup", 64.6)]).grams).toBeCloseTo(193.8, 5);
  });

  it("maps whole to a fruit portion", () => {
    expect(resolve(0.5, parseUnit("whole"), per100, [portion("1 fruit", 150)]).grams).toBe(75);
  });
});
