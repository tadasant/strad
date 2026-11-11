/**
 * One USDA FDC CSV release → compact records.
 *
 * Three quirks of the real files decide most of this, each observed in the
 * pinned releases:
 *
 *   - FOUNDATION'S food.csv IS MOSTLY NOT FOUNDATION FOODS. 469 of its 87,990
 *     rows are `foundation_food`; the rest are the lab samples they were
 *     derived from. Only the 469 are kept.
 *   - FNDDS'S food_nutrient.csv PUTS THE NUTRIENT NUMBER IN `nutrient_id`
 *     (203, 208, …) rather than the nutrient id (1003, 1008, …). Every value
 *     there is below 1000 and every real id is above it, so a value below 1000
 *     is mapped through nutrient.csv's `nutrient_nbr`.
 *   - FOUNDATION OFTEN LACKS THE CLASSIC NUTRIENT IDS. Energy may be only 2047
 *     (Atwater general) or 2048 (specific), carbs only 1050 (by summation),
 *     fat only 1085 (NLEA), sugar only 1063. Each nutrient takes the first id
 *     present in its list below; 91 foods have no energy at all and get 4/4/9
 *     from their macros, flagged.
 */

import {
  atwaterCalories,
  fromTuple,
  NUTRIENT_KEYS,
  type NutrientKey,
} from "../nutrients.js";
import { csvRecords } from "./csv.js";
import type { UsdaRecord } from "./format.js";

/** For each reported nutrient, the FDC nutrient ids to try, in order. */
const NUTRIENT_IDS: Record<NutrientKey, number[]> = {
  calories: [1008, 2047, 2048],
  protein_g: [1003],
  carbs_g: [1005, 1050],
  fat_g: [1004, 1085],
  fiber_g: [1079],
  sugar_g: [2000, 1063],
  saturated_fat_g: [1258],
  sodium_mg: [1093],
};

const WANTED_IDS = new Set(Object.values(NUTRIENT_IDS).flat());

const DATA_TYPE: Record<string, UsdaRecord["d"]> = {
  foundation_food: "F",
  sr_legacy_food: "S",
  survey_fndds_food: "N",
};

/** The SR Legacy release is 2018's; its rows carry a 2019 republication date. */
const FIXED_YEAR: Partial<Record<UsdaRecord["d"], number>> = { S: 2018 };

export type CsvFiles = Map<string, string>;

function need(files: CsvFiles, name: string): string {
  const text = files.get(name);
  if (text === undefined) throw new Error(`release is missing ${name}`);
  return text;
}

function year(date: string): number | null {
  const iso = /^(\d{4})-/.exec(date);
  if (iso) return Number(iso[1]);
  const us = /\/(\d{4})$/.exec(date);
  return us ? Number(us[1]) : null;
}

function num(text: string | undefined): number | null {
  if (text === undefined || text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function compactNumber(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function buildUsda(files: CsvFiles): UsdaRecord[] {
  // nutrient_nbr → id, for FNDDS's nbr-in-the-id-column.
  const nbrToId = new Map<string, number>();
  for (const r of csvRecords(need(files, "nutrient.csv"))) {
    const id = Number(r.id);
    if (r.nutrient_nbr) nbrToId.set(String(Number(r.nutrient_nbr)), id);
  }

  const categories = new Map<string, string>();
  const catText = files.get("food_category.csv");
  if (catText) {
    for (const r of csvRecords(catText)) categories.set(r.id!, r.description!);
  }
  const wweiaText = files.get("wweia_food_category.csv");
  if (wweiaText) {
    for (const r of csvRecords(wweiaText)) {
      categories.set(r.wweia_food_category!, r.wweia_food_category_description!);
    }
  }

  const units = new Map<string, string>();
  for (const r of csvRecords(need(files, "measure_unit.csv"))) {
    units.set(r.id!, r.name!);
  }

  interface Building {
    rec: UsdaRecord;
    raw: Map<number, number>;
  }
  const foods = new Map<string, Building>();
  for (const r of csvRecords(need(files, "food.csv"))) {
    const d = DATA_TYPE[r.data_type ?? ""];
    if (!d) continue;
    foods.set(r.fdc_id!, {
      rec: {
        i: Number(r.fdc_id),
        d,
        n: (r.description ?? "").trim(),
        c: categories.get(r.food_category_id ?? "") ?? "",
        y: FIXED_YEAR[d] ?? year(r.publication_date ?? "") ?? 0,
        k: [],
        p: [],
      },
      raw: new Map(),
    });
  }

  for (const r of csvRecords(need(files, "food_nutrient.csv"))) {
    const food = foods.get(r.fdc_id ?? "");
    if (!food) continue;
    let id = Number(r.nutrient_id);
    if (id < 1000) id = nbrToId.get(String(id)) ?? id;
    if (!WANTED_IDS.has(id)) continue;
    const amount = num(r.amount);
    if (amount !== null) food.raw.set(id, amount);
  }

  for (const r of csvRecords(need(files, "food_portion.csv"))) {
    const food = foods.get(r.fdc_id ?? "");
    if (!food) continue;
    const grams = num(r.gram_weight);
    if (grams === null || grams <= 0) continue;
    const label = portionLabel(food.rec.d, r, units);
    if (label) food.rec.p.push([label, compactNumber(grams)]);
  }

  const out: UsdaRecord[] = [];
  for (const { rec, raw } of foods.values()) {
    rec.p = exactPortions(rec.p);
    const tuple = NUTRIENT_KEYS.map((key) => {
      for (const id of NUTRIENT_IDS[key]) {
        const v = raw.get(id);
        if (v !== undefined) return compactNumber(v);
      }
      return null;
    });
    if (tuple[0] === null) {
      const computed = atwaterCalories(fromTuple(tuple));
      if (computed === null) continue;
      tuple[0] = compactNumber(computed);
      rec.e = 1;
    }
    rec.k = tuple;
    out.push(rec);
  }
  out.sort((a, b) => a.i - b.i);
  return out;
}

/**
 * Each dataset writes a portion differently:
 *   SR Legacy   amount + modifier            "1" + "cup, chopped"
 *   Foundation  amount + unit + modifier     "1" + "cup" + "drained"
 *   FNDDS       portion_description          "1 cup", "Quantity not specified"
 */
function portionLabel(
  d: UsdaRecord["d"],
  r: Record<string, string>,
  units: Map<string, string>,
): string | null {
  const amount = (r.amount ?? "").trim();
  const modifier = (r.modifier ?? "").trim();
  if (d === "N") {
    const text = (r.portion_description ?? "").trim();
    return text === "" ? null : text;
  }
  if (d === "S") {
    if (modifier === "") return null;
    return `${amount === "" ? "1" : trimNumber(amount)} ${modifier}`;
  }
  const unit = units.get(r.measure_unit_id ?? "");
  if (!unit || unit === "undetermined") {
    const text = (r.portion_description ?? "").trim() || modifier;
    return text === "" ? null : `${amount === "" ? "1" : trimNumber(amount)} ${text}`;
  }
  const base = `${amount === "" ? "1" : trimNumber(amount)} ${unit}`;
  return modifier === "" ? base : `${base}, ${modifier}`;
}

function trimNumber(text: string): string {
  const n = Number(text);
  return Number.isFinite(n) ? String(n) : text;
}

const DECIMAL_LABEL = /^(\d+\.\d+) (.+)$/;

/** Household fractions a portion amount is written in. */
const DENOMINATORS = [2, 3, 4, 6, 8, 12];

/** Fractions a two-decimal amount cannot write exactly. */
const REPEATING = [3, 6, 8, 12];

/** The nearest k/n to `v` over `denominators`, reduced, as [k, n]. */
function nearestFraction(v: number, denominators: readonly number[]): [number, number] {
  let best: [number, number] = [Math.round(v), 1];
  for (const n of denominators) {
    const k = Math.round(v * n);
    if (k > 0 && Math.abs(k / n - v) < Math.abs(best[0] / best[1] - v)) best = [k, n];
  }
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  const g = gcd(best[0], best[1]);
  return [best[0] / g, best[1] / g];
}

/** 5/4 → "1 1/4", 1/3 → "1/3". */
function fractionText([k, n]: [number, number]): string {
  const whole = Math.floor(k / n);
  const rest = k - whole * n;
  if (rest === 0) return String(whole);
  return whole === 0 ? `${rest}/${n}` : `${whole} ${rest}/${n}`;
}

/**
 * Whether `v` could have been written as `decimal`, cut short or rounded to
 * its places: 0.25 as "0.2", 1/3 as "0.33" or "0.3", 2/3 as "0.66" or "0.67".
 */
function writesAs(v: number, decimal: string): boolean {
  const step = 10 ** -decimal.split(".")[1]!.length;
  const a = Number(decimal);
  return v >= a - step / 2 - 1e-9 && v < a + step - 1e-9;
}

/**
 * USDA writes a fractional portion amount as a TRUNCATED DECIMAL: SR Legacy's
 * "0.33 cup" is a third of a cup, and Foundation's whole-milk ricotta lists
 * "0.2 cup" = 64.6 g beside "1 cup" = 258 g — a quarter cup, by its own
 * numbers. Scaling divides by the amount, so 0.75 cup through "0.2 cup" came
 * out 25% heavy. The amount is restored to the fraction it stands for, when
 * the decimal is that fraction cut short or rounded and is not already exact
 * (a half or a quarter never is rewritten):
 *
 *   - a two-decimal third, sixth, eighth or twelfth (0.33, 0.66, 0.67, 0.16,
 *     0.12, 0.08) always: no measured amount is written that way;
 *   - any other decimal only when a whole-number portion of the same food in
 *     the same unit puts the grams within 2% of such a fraction. Tofu's "0.2
 *     block" has no such sibling and stays a fifth.
 *
 * The label is rewritten ("1/4 cup"), so the amount the server divides by and
 * the label the caller reads are the same number.
 */
export function exactPortions(portions: Array<[string, number]>): Array<[string, number]> {
  const parsed = portions.map(([label, grams]) => {
    const m = DECIMAL_LABEL.exec(label);
    const lead = /^(\d+(?:\.\d+)?) (.+)$/.exec(label);
    return {
      label,
      grams,
      decimal: m ? m[1]! : null,
      amount: lead ? Number(lead[1]) : null,
      tail: lead ? lead[2]! : null,
    };
  });
  return parsed.map((p) => {
    const { decimal, amount: a } = p;
    if (decimal === null || a === null || Number.isInteger(a * 4)) return [p.label, p.grams];
    const fits = (f: [number, number]) => f[1] !== 1 && writesAs(f[0] / f[1], decimal);
    let exact: [number, number] | null = null;
    if (decimal.split(".")[1]!.length === 2) {
      const f = nearestFraction(a, REPEATING);
      if (fits(f)) exact = f;
    }
    if (!exact) {
      // A whole-number sibling is the reference: it is the one USDA did not cut.
      const ref = parsed.find(
        (s) => s !== p && s.tail === p.tail && s.amount !== null && Number.isInteger(s.amount),
      );
      if (ref) {
        const implied = p.grams / (ref.grams / ref.amount!);
        const f = nearestFraction(implied, DENOMINATORS);
        const v = f[0] / f[1];
        if (Math.abs(implied - a) / a > 0.02 && Math.abs(v - implied) / v <= 0.02 && fits(f)) {
          exact = f;
        }
      }
    }
    return exact ? [`${fractionText(exact)} ${p.tail}`, p.grams] : [p.label, p.grams];
  });
}
