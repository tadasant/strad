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
