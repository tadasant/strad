/**
 * USDA Branded foods, from the live FoodData Central API — the one USDA
 * dataset that is not local (see data/sources.ts for why).
 *
 * Optional: it needs `USDA_FDC_API_KEY`, a free api.data.gov key. Without one
 * the USDA source still answers from its local datasets and says Branded was
 * not searched. It is only asked when a component names a brand (or
 * `kind: "branded"`), so ordinary ingredient lookups spend nothing here.
 *
 * Branded nutrient values in FDC are per 100 g (or per 100 ml for a liquid),
 * converted by USDA from the label; the label serving rides along as the
 * candidate's default portion. Responses are cached for 23 hours, like
 * FatSecret's, so a repeated lookup costs no request against the key's
 * 1,000-per-hour limit.
 */

import { SourceUnavailable, type Candidate } from "../candidate.js";
import { emptyNutrients, type NutrientKey, type Nutrients } from "../nutrients.js";
import { portion, type Portion } from "../units.js";
import { TtlCache } from "./cache.js";

export const FDC_BASE = "https://api.nal.usda.gov/fdc/v1";
const REQUEST_TIMEOUT_MS = 10_000;

/** FDC nutrient numbers (`nutrientNumber` / `nutrient.number`). */
const NUMBERS: Record<string, NutrientKey> = {
  "208": "calories",
  "203": "protein_g",
  "205": "carbs_g",
  "204": "fat_g",
  "291": "fiber_g",
  "269": "sugar_g",
  "606": "saturated_fat_g",
  "307": "sodium_mg",
};

interface FdcNutrient {
  nutrientNumber?: string;
  value?: number;
  amount?: number;
  nutrient?: { number?: string };
}

export interface FdcFood {
  fdcId: number;
  description: string;
  dataType?: string;
  brandOwner?: string;
  brandName?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  publishedDate?: string;
  publicationDate?: string;
  foodNutrients?: FdcNutrient[];
}

export interface FdcOptions {
  apiKey: () => string | undefined;
  fetch?: typeof fetch;
  base?: string;
}

export class FdcClient {
  private readonly cache = new TtlCache<unknown>();

  constructor(private readonly options: FdcOptions) {}

  configured(): boolean {
    return this.options.apiKey() !== undefined;
  }

  async searchBranded(query: string, limit: number): Promise<FdcFood[]> {
    const body = await this.get<{ foods?: FdcFood[] }>("/foods/search", {
      query,
      dataType: "Branded",
      pageSize: String(Math.min(Math.max(limit, 1), 25)),
    });
    return body.foods ?? [];
  }

  async food(fdcId: number): Promise<FdcFood> {
    return this.get<FdcFood>(`/food/${fdcId}`, {});
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const key = this.options.apiKey();
    if (!key) throw new SourceUnavailable("USDA_FDC_API_KEY is not set.");
    const cacheKey = `${path}?${new URLSearchParams(params).toString()}`;
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined) return hit as T;

    const url = `${this.options.base ?? FDC_BASE}${path}?${new URLSearchParams({
      ...params,
      api_key: key,
    }).toString()}`;
    let res: Response;
    try {
      res = await (this.options.fetch ?? fetch)(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new SourceUnavailable("USDA FoodData Central could not be reached.");
    }
    if (res.status === 403 || res.status === 401) {
      throw new SourceUnavailable("api.data.gov rejected USDA_FDC_API_KEY.");
    }
    if (res.status === 429) {
      throw new SourceUnavailable("api.data.gov rate limit reached for USDA_FDC_API_KEY.");
    }
    if (res.status === 404) {
      throw new SourceUnavailable(`USDA FoodData Central has no food at ${path}.`);
    }
    if (!res.ok) {
      throw new SourceUnavailable(`USDA FoodData Central answered HTTP ${res.status}.`);
    }
    const body = (await res.json().catch(() => null)) as T | null;
    if (!body || typeof body !== "object") {
      throw new SourceUnavailable("USDA FoodData Central answered with a body that is not JSON.");
    }
    this.cache.set(cacheKey, body);
    return body;
  }
}

function nutrients(list: FdcNutrient[] | undefined): Nutrients {
  const n = emptyNutrients();
  for (const item of list ?? []) {
    const number = item.nutrientNumber ?? item.nutrient?.number;
    const key = number ? NUMBERS[number] : undefined;
    const value = item.value ?? item.amount;
    if (key && typeof value === "number" && Number.isFinite(value)) n[key] = value;
  }
  return n;
}

export function fdcToCandidate(food: FdcFood, score: number): Candidate {
  const per100 = nutrients(food.foodNutrients);
  const unit = (food.servingSizeUnit ?? "").toLowerCase();
  const isGrams = unit === "g" || unit === "grm";
  const isMl = unit === "ml" || unit === "mlt";
  const portions: Portion[] = [];
  let defaultPortion: Portion | undefined;
  if (food.servingSize && (isGrams || isMl)) {
    const amount = `${food.servingSize} ${isGrams ? "g" : "ml"}`;
    const label = food.householdServingFullText
      ? `1 serving: ${food.householdServingFullText} (${amount})`
      : `1 serving (${amount})`;
    // A liquid's values are per 100 ml; treating its ml as grams is the only
    // conversion FDC offers, and the candidate says so.
    defaultPortion = portion(label, food.servingSize);
    portions.push(defaultPortion);
  }
  const date = food.publishedDate ?? food.publicationDate ?? "";
  const year = /(\d{4})/.exec(date);
  return {
    id: `usda:${food.fdcId}`,
    source: "usda",
    dataset: "branded",
    name: food.description,
    ...(food.brandName || food.brandOwner
      ? { brand: food.brandName || food.brandOwner }
      : {}),
    data_year: year ? Number(year[1]) : null,
    score,
    per100g: per100,
    portions,
    ...(defaultPortion ? { defaultPortion } : {}),
    flags: isMl ? ["values_per_100ml_treated_as_100g"] : [],
    url: `https://fdc.nal.usda.gov/food-details/${food.fdcId}/nutrients`,
  };
}
