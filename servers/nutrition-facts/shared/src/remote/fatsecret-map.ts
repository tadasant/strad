/**
 * FatSecret's shapes → candidates.
 *
 * Every FatSecret number arrives as a string ("29.55"), any nutrient but the
 * four macros may be absent, and sodium is in milligrams already.
 */

import type { Candidate } from "../candidate.js";
import { emptyNutrients, scale, type Nutrients } from "../nutrients.js";
import { portion, type Portion } from "../units.js";
import type { FsFood, FsSearchFood, FsServing } from "./fatsecret.js";

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function servingNutrients(s: FsServing): Nutrients {
  return {
    calories: num(s.calories),
    protein_g: num(s.protein),
    carbs_g: num(s.carbohydrate),
    fat_g: num(s.fat),
    fiber_g: num(s.fiber),
    sugar_g: num(s.sugar),
    saturated_fat_g: num(s.saturated_fat),
    sodium_mg: num(s.sodium),
  };
}

function servingGrams(s: FsServing): number | null {
  const amount = num(s.metric_serving_amount);
  if (amount === null) return null;
  const unit = (s.metric_serving_unit ?? "").toLowerCase();
  if (unit === "g") return amount;
  if (unit === "oz") return amount * 28.3495;
  return null;
}

/** The year a live answer is "from": today, since FatSecret's data is current. */
function thisYear(now: number): number {
  return new Date(now).getUTCFullYear();
}

export function fsFoodToCandidate(
  food: FsFood,
  score: number,
  now: number = Date.now(),
): Candidate {
  const portions: Portion[] = food.servings.map((s) =>
    portion(
      s.serving_description || `${s.number_of_units ?? "1"} ${s.measurement_description ?? "serving"}`,
      servingGrams(s),
      servingNutrients(s),
    ),
  );
  // Per 100 g: the "100 g" serving when there is one, else any serving in grams.
  const exact = portions.find((p) => p.unit.kind === "mass" && p.grams === 100);
  const anchor = exact ?? portions.find((p) => p.grams && p.nutrients);
  const per100g =
    anchor?.grams && anchor.nutrients ? scale(anchor.nutrients, 100 / anchor.grams) : null;
  // The first non-metric serving is the label's / the menu's serving.
  const first = portions.find((p) => p.unit.kind === "count") ?? portions[0];
  return {
    id: `fatsecret:${food.food_id}`,
    source: "fatsecret",
    name: food.food_name,
    ...(food.brand_name ? { brand: food.brand_name } : {}),
    data_year: thisYear(now),
    score,
    per100g,
    portions,
    ...(first ? { defaultPortion: first } : {}),
    flags: [],
    ...(food.food_url ? { url: food.food_url } : {}),
  };
}

/**
 * A search hit, from its summary line alone — no extra call:
 * "Per 1 serving - Calories: 300kcal | Fat: 13.00g | Carbs: 32.00g | Protein: 15.00g".
 * Only those four nutrients are in it; the rest stay null until get_food.
 */
export function fsSearchToCandidate(
  hit: FsSearchFood,
  score: number,
  now: number = Date.now(),
): Candidate {
  const portions: Portion[] = [];
  let per100g: Nutrients | null = null;
  const m = /^Per\s+(.+?)\s+-\s+(.*)$/i.exec(hit.food_description ?? "");
  if (m) {
    const n = emptyNutrients();
    for (const part of m[2]!.split("|")) {
      const kv = /^\s*(\w+):\s*([\d.]+)/.exec(part);
      if (!kv) continue;
      const v = Number(kv[2]);
      const key = kv[1]!.toLowerCase();
      if (key === "calories") n.calories = v;
      else if (key === "fat") n.fat_g = v;
      else if (key === "carbs") n.carbs_g = v;
      else if (key === "protein") n.protein_g = v;
    }
    const label = m[1]!.trim();
    const p = portion(label, null, n);
    if (p.unit.kind === "mass") {
      const grams = p.amount * p.unit.grams;
      p.grams = grams;
      per100g = scale(n, 100 / grams);
    }
    portions.push(p);
  }
  return {
    id: `fatsecret:${hit.food_id}`,
    source: "fatsecret",
    name: hit.food_name,
    ...(hit.brand_name ? { brand: hit.brand_name } : {}),
    data_year: thisYear(now),
    score,
    per100g,
    portions,
    ...(portions[0] && portions[0].unit.kind !== "mass"
      ? { defaultPortion: portions[0] }
      : {}),
    flags: ["summary_only"],
    ...(hit.food_url ? { url: hit.food_url } : {}),
  };
}
