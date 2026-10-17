/**
 * Turning "2 cups" or "1 medium" into grams, using each source's OWN portions.
 *
 * The spec's rule: quantities convert to grams through the source's portion
 * data, and when no conversion exists the result is per-100 g with a flag that
 * grams are needed. So nothing here guesses a density or a typical size. A
 * mass unit converts itself; a volume converts through a volume portion the
 * source published (its "1 cup = 158 g" fixes that food's density, so "3 tbsp"
 * follows); a count word ("medium", "slice", "serving") converts only through
 * a portion with that word in it.
 */

import { scale, type Nutrients } from "./nutrients.js";
import { stem } from "./text.js";

export type Unit =
  | { kind: "mass"; name: string; grams: number }
  | { kind: "volume"; name: string; ml: number }
  | { kind: "count"; name: string; word: string };

const MASS: Record<string, number> = {
  g: 1,
  gm: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kilogram: 1000,
  kilograms: 1000,
  mg: 0.001,
  oz: 28.3495,
  ounce: 28.3495,
  ounces: 28.3495,
  lb: 453.592,
  lbs: 453.592,
  pound: 453.592,
  pounds: 453.592,
};

const VOLUME: Record<string, number> = {
  ml: 1,
  milliliter: 1,
  milliliters: 1,
  millilitre: 1,
  l: 1000,
  liter: 1000,
  liters: 1000,
  litre: 1000,
  cup: 236.588,
  cups: 236.588,
  c: 236.588,
  tbsp: 14.7868,
  tbs: 14.7868,
  tablespoon: 14.7868,
  tablespoons: 14.7868,
  tsp: 4.92892,
  teaspoon: 4.92892,
  teaspoons: 4.92892,
  "fl oz": 29.5735,
  floz: 29.5735,
  "fluid ounce": 29.5735,
  "fluid ounces": 29.5735,
  pint: 473.176,
  pints: 473.176,
  pt: 473.176,
  quart: 946.353,
  quarts: 946.353,
  qt: 946.353,
  gallon: 3785.41,
  gal: 3785.41,
};

/**
 * Words that all mean "one of whatever the source calls a serving". A caller
 * that says "1 serving" of a menu item means the item; of a branded food, the
 * label's serving; of an FNDDS dish, USDA's "Quantity not specified" portion,
 * which is FNDDS's typical amount eaten.
 */
export const SERVING_WORDS = new Set([
  "serving",
  "each",
  "item",
  "portion",
  "order",
  "unit",
  "sandwich",
  "burger",
  "meal",
]);

/**
 * Count words a source spells differently. "1 whole" avocado is USDA's
 * "1 fruit"; when a source has neither, its "medium" is the typical whole one.
 */
const COUNT_ALIASES: Record<string, string[]> = {
  whole: ["whole", "fruit", "medium"],
  fruit: ["fruit", "whole", "medium"],
  piece: ["piece", "pc"],
};

/** Parse a caller's or a source's unit text. Never fails: unknown is a count word. */
export function parseUnit(raw: string | undefined): Unit {
  const text = (raw ?? "")
    .toLowerCase()
    .replace(/[().,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return { kind: "count", name: "serving", word: "serving" };
  for (const candidate of [text, text.split(" ").slice(0, 2).join(" ")]) {
    if (candidate in VOLUME) {
      return { kind: "volume", name: candidate, ml: VOLUME[candidate]! };
    }
  }
  const first = text.split(" ")[0]!;
  if (first in MASS) return { kind: "mass", name: first, grams: MASS[first]! };
  if (first in VOLUME) return { kind: "volume", name: first, ml: VOLUME[first]! };
  if (text.startsWith("quantity not specified")) {
    return { kind: "count", name: "serving", word: "serving" };
  }
  return { kind: "count", name: first, word: stem(first) };
}

/** "1 1/2" → 1.5, "1/2" → 0.5, "0.75" → 0.75. */
function parseAmount(text: string): number | null {
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(text);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(text);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A portion a source published: "1 cup, chopped" = 91 g, or FatSecret's
 * "1 medium" serving with its own nutrient values.
 */
export interface Portion {
  /** The source's own words, for the caller to read. */
  label: string;
  amount: number;
  unit: Unit;
  /** Grams in `amount` of `unit`, when the source says. */
  grams: number | null;
  /**
   * Nutrients for `amount` of `unit`, when the source reports per portion
   * rather than per 100 g (FatSecret servings, MenuStat items).
   */
  nutrients?: Nutrients;
}

/** Parse a portion label: "1 cup, chopped", "0.5 fillet", "Quantity not specified". */
export function parsePortionLabel(label: string): { amount: number; unit: Unit } {
  const text = label.trim();
  if (/^quantity not specified/i.test(text)) {
    return { amount: 1, unit: parseUnit("serving") };
  }
  const m = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*(.*)$/.exec(text);
  if (!m) return { amount: 1, unit: parseUnit(text) };
  return { amount: parseAmount(m[1]!) ?? 1, unit: parseUnit(m[2]) };
}

export function portion(
  label: string,
  grams: number | null,
  nutrients?: Nutrients,
): Portion {
  const { amount, unit } = parsePortionLabel(label);
  return {
    label,
    amount,
    unit,
    grams,
    ...(nutrients ? { nutrients } : {}),
  };
}

export interface Resolution {
  grams: number | null;
  nutrients: Nutrients | null;
  /** How the amount was arrived at, in words a human can audit. */
  basis: string;
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** A caller's or a source's amount, as given: 0.75 stays 0.75. */
function fmtAmount(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/**
 * The portion to scale through, among several in the same unit: the first
 * with a whole amount ("1 cup" over "0.5 cup"), else the largest. A source's
 * fractional amount is the one it may have rounded — USDA writes a quarter cup
 * as "0.2 cup" — and the larger the amount, the less a rounding moves the
 * grams per unit. Among whole amounts the source's order stands, so its first
 * preparation ("1 cup, chopped") keeps deciding the density.
 */
function preferWhole<P extends Portion>(portions: readonly P[]): P | undefined {
  const whole = portions.find((p) => Number.isInteger(p.amount));
  if (whole) return whole;
  let best: P | undefined;
  for (const p of portions) if (!best || p.amount > best.amount) best = p;
  return best;
}

function labelWords(p: Portion): string[] {
  return p.label
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .map(stem);
}

/**
 * A packaged food's whole package is its serving when the source names no
 * serving: SR Legacy lists "1 container (5.3 oz)" for a single-serve yogurt.
 */
const PACKAGE_WORDS = new Set([
  "container",
  "package",
  "packet",
  "pouch",
  "bar",
  "can",
  "bottle",
  "cup",
]);

function isPackagePortion(p: Portion): boolean {
  return p.unit.kind === "count" && PACKAGE_WORDS.has(p.unit.word);
}

function isServingPortion(p: Portion): boolean {
  return (
    p.unit.kind === "count" &&
    (SERVING_WORDS.has(p.unit.word) ||
      /serving|quantity not specified/i.test(p.label))
  );
}

/**
 * Scale one candidate to the requested quantity.
 *
 * `per100g` is the candidate's nutrients per 100 g when the source has them;
 * `portions` are its published portions; `defaultPortion` is the one "1
 * serving" means when no portion says "serving" (a branded label's serving, a
 * menu item).
 */
export function resolve(
  quantity: number,
  unit: Unit,
  per100g: Nutrients | null,
  portions: readonly Portion[],
  defaultPortion?: Portion,
): Resolution {
  const fromGrams = (grams: number, basis: string): Resolution => {
    if (per100g) {
      return { grams, nutrients: scale(per100g, grams / 100), basis };
    }
    // No per-100 g table: derive one from a portion that carries both.
    const anchor = portions.find((p) => p.nutrients && p.grams);
    if (anchor?.nutrients && anchor.grams) {
      return {
        grams,
        nutrients: scale(anchor.nutrients, grams / anchor.grams),
        basis: `${basis}; scaled from "${anchor.label}" = ${fmt(anchor.grams)} g`,
      };
    }
    return { grams, nutrients: null, basis };
  };

  const fromPortion = (p: Portion, factor: number, how: string): Resolution => {
    const grams = p.grams === null ? null : p.grams * factor;
    if (p.nutrients) {
      return { grams, nutrients: scale(p.nutrients, factor), basis: how };
    }
    if (grams !== null) return fromGrams(grams, how);
    return { grams: null, nutrients: null, basis: how };
  };

  if (unit.kind === "mass") {
    const grams = quantity * unit.grams;
    return fromGrams(
      grams,
      unit.name === "g" || unit.name === "gram" || unit.name === "grams"
        ? `${fmt(grams)} g as given`
        : `${fmtAmount(quantity)} ${unit.name} = ${fmt(grams)} g`,
    );
  }

  if (unit.kind === "volume") {
    const volumes = portions.filter(
      (p): p is Portion & { unit: { kind: "volume"; ml: number } } =>
        p.unit.kind === "volume" && (p.grams !== null || !!p.nutrients),
    );
    const same = preferWhole(volumes.filter((p) => p.unit.ml === unit.ml));
    const p = same ?? volumes[0];
    if (p) {
      const factor = (quantity * unit.ml) / (p.amount * p.unit.ml);
      const grams = p.grams === null ? "" : ` = ${fmt(p.grams)} g`;
      return fromPortion(
        p,
        factor,
        `${fmtAmount(quantity)} ${unit.name} via source portion "${p.label}"${grams}`,
      );
    }
    return { grams: null, nutrients: null, basis: "no volume portion" };
  }

  // A count word.
  let p: Portion | undefined;
  if (SERVING_WORDS.has(unit.word)) {
    p = portions.find(isServingPortion) ?? defaultPortion ?? portions.find(isPackagePortion);
  }
  for (const word of COUNT_ALIASES[unit.word] ?? [unit.word]) {
    p ??= portions.find((x) => x.unit.kind === "count" && x.unit.word === word);
    p ??= portions.find((x) => x.unit.kind === "count" && labelWords(x).includes(word));
  }
  if (p) {
    const factor = quantity / p.amount;
    const grams = p.grams === null ? "" : ` = ${fmt(p.grams)} g`;
    return fromPortion(
      p,
      factor,
      `${fmtAmount(quantity)} ${unit.name} via source portion "${p.label}"${grams}`,
    );
  }
  return {
    grams: null,
    nutrients: null,
    basis: `no source portion matches "${unit.name}"`,
  };
}
