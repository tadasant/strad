/**
 * The eight nutrients this server reports, and nothing else.
 *
 * The spec's core set: calories, protein, carbs, fat, fiber, sugar, saturated
 * fat, sodium. Every source is mapped onto exactly these keys, and a value a
 * source does not carry is `null` — never 0, because "this food has no fiber"
 * and "this source did not measure fiber" are different claims and a total
 * that silently adds a missing value as zero is a total that lies.
 *
 * Units are in the key: grams, except calories (kcal) and sodium (mg).
 */

export const NUTRIENT_KEYS = [
  "calories",
  "protein_g",
  "carbs_g",
  "fat_g",
  "fiber_g",
  "sugar_g",
  "saturated_fat_g",
  "sodium_mg",
] as const;

export type NutrientKey = (typeof NUTRIENT_KEYS)[number];

export type Nutrients = Record<NutrientKey, number | null>;

/**
 * The compact on-disk form: the eight values in `NUTRIENT_KEYS` order. The
 * data files carry thirty thousand of these, so the keys are not repeated.
 */
export type NutrientTuple = Array<number | null>;

export function fromTuple(tuple: NutrientTuple): Nutrients {
  const out = {} as Nutrients;
  NUTRIENT_KEYS.forEach((key, i) => {
    const v = tuple[i];
    out[key] = typeof v === "number" && Number.isFinite(v) ? v : null;
  });
  return out;
}

export function toTuple(n: Nutrients): NutrientTuple {
  return NUTRIENT_KEYS.map((k) => n[k]);
}

export function emptyNutrients(): Nutrients {
  return fromTuple([]);
}

export function scale(n: Nutrients, factor: number): Nutrients {
  const out = {} as Nutrients;
  for (const k of NUTRIENT_KEYS) {
    const v = n[k];
    out[k] = v === null ? null : v * factor;
  }
  return out;
}

/** Calories and sodium as whole numbers, grams to one decimal. */
export function rounded(n: Nutrients): Nutrients {
  const out = {} as Nutrients;
  for (const k of NUTRIENT_KEYS) {
    out[k] = round(k, n[k]);
  }
  return out;
}

export function round(key: NutrientKey, v: number | null): number | null {
  if (v === null) return null;
  if (key === "calories" || key === "sodium_mg") return Math.round(v);
  return Math.round(v * 10) / 10;
}

/**
 * Atwater 4/4/9 from protein, carbs and fat, for a record that carries the
 * macros but no energy value — 91 of USDA Foundation's 469 foods. The record
 * says it was computed; see `flags` on a candidate.
 */
export function atwaterCalories(n: Nutrients): number | null {
  if (n.protein_g === null || n.carbs_g === null || n.fat_g === null) {
    return null;
  }
  return 4 * n.protein_g + 4 * n.carbs_g + 9 * n.fat_g;
}
