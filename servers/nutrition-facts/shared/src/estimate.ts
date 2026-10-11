/**
 * Evidence → an estimate: the best match per source, scaled; a low / expected
 * / high range across them; a disagreement flag; totals.
 *
 * THE RULES, each from the spec:
 *   - Each source contributes its best match, scaled to the requested amount,
 *     and keeps its runners-up as `alternatives`.
 *   - EXPECTED is the best match overall. LOW and HIGH are the smallest and
 *     largest values among the candidates in the range.
 *   - A candidate enters the range only if it is a real match (score ≥ 0.65,
 *     `RANGE_MIN_SCORE`, or pinned by the caller with `food_id`) and could be
 *     scaled. When none does, a partial match (≥ 0.5) may set the estimate,
 *     flagged `low_confidence_match`. A weak or unscalable candidate is still
 *     shown — it is what the source had — with `in_range: false`.
 *   - A NUTRIENT ROW IS WHOLE OR EMPTY: when the expected candidate does not
 *     carry a nutrient, that nutrient's low / expected / high are all null, so
 *     a row never claims a range around a value it does not have.
 *   - DISAGREEMENT: two or more sources in the range whose calories differ by
 *     more than 20% (the larger over the smaller).
 *   - RESTAURANT BUFFER: for restaurant estimates, chain or independent, HIGH
 *     is widened by 15% (configurable per call) for the extra oil and butter
 *     a kitchen adds — on calories, fat and saturated fat, the nutrients oil
 *     and butter carry. Always labelled, never folded into EXPECTED.
 *   - NO CONVERSION, NO GUESS: a quantity no source portion converts leaves the
 *     component without an estimate, flagged `needs_grams`, with each
 *     candidate's per-100 g values.
 */

import type { Candidate, SourceName, SourceResult } from "./candidate.js";
import { SOURCES } from "./candidate.js";
import type { Lookups } from "./lookup.js";
import type { FoodKind } from "./local/usda.js";
import {
  NUTRIENT_KEYS,
  round,
  rounded,
  type NutrientKey,
} from "./nutrients.js";
import { ATTRIBUTION } from "./remote/fatsecret.js";
import { matchLabel, MIN_SCORE, RANGE_MIN_SCORE } from "./text.js";
import { parseUnit, resolve, type Resolution, type Unit } from "./units.js";

/** A partial match (text.ts) may set the estimate when nothing better can. */
const PARTIAL_MIN_SCORE = 0.5;

/** The nutrients a kitchen's extra oil and butter raise; the buffer widens these. */
const BUFFERED: readonly NutrientKey[] = ["calories", "fat_g", "saturated_fat_g"];

export const DISAGREEMENT_THRESHOLD_PCT = 20;
export const DEFAULT_RESTAURANT_BUFFER_PCT = 15;
export const DEFAULT_ALTERNATIVES = 2;
export const MAX_COMPONENTS = 25;

export interface ComponentInput {
  name: string;
  quantity: number;
  unit?: string;
  brand?: string;
  kind?: FoodKind;
  food_id?: string;
}

export interface RestaurantInput {
  restaurant: string;
  item: string;
  size?: string;
  quantity: number;
  food_id?: string;
  buffer_pct: number;
}

type Range = { low: number | null; expected: number | null; high: number | null };
export type NutrientRanges = Record<NutrientKey, Range>;

export type StatusWord = "answered" | "no_match" | "unavailable" | "not_queried";

interface SourceSlot {
  source: SourceName;
  result: SourceResult | { notQueried: string };
  best?: Candidate;
  alternatives: Candidate[];
  /** Whether this source's best may enter the range at all (restaurant rule). */
  rangeEligible: boolean;
}

interface Scaled {
  slot: SourceSlot;
  cand: Candidate;
  res: Resolution;
  pinned: boolean;
  inRange: boolean;
}

export interface ComponentResult {
  input: Record<string, unknown>;
  expected_from: string | null;
  range: NutrientRanges | null;
  flags: string[];
  buffer?: {
    applied_to: "high";
    nutrients: readonly NutrientKey[];
    pct: number;
    reason: string;
  };
  disagreement: null | {
    threshold_pct: number;
    spread_pct: number;
    calories_by_source: Partial<Record<SourceName, number>>;
  };
  candidates: Array<Record<string, unknown>>;
  alternatives: Partial<Record<SourceName, Array<Record<string, unknown>>>>;
  source_status: Record<SourceName, StatusWord>;
  notes?: string[];
}

export interface SourceReport {
  status: StatusWord;
  detail?: string;
}

export interface EstimateResult {
  components: ComponentResult[];
  totals: NutrientRanges & {
    components_without_estimate?: number[];
    incomplete_nutrients?: NutrientKey[];
    buffer_included?: boolean;
  };
  sources: Record<SourceName, SourceReport>;
  attribution?: { text: string; url: string; html: string };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function candidateView(s: Scaled): Record<string, unknown> {
  const c = s.cand;
  const view: Record<string, unknown> = {
    id: c.id,
    source: c.source,
    ...(c.dataset ? { dataset: c.dataset } : {}),
    name: c.name,
    ...(c.brand ? { brand: c.brand } : {}),
    ...(c.restaurant ? { restaurant: c.restaurant } : {}),
    data_year: c.data_year,
    match: s.pinned ? "pinned" : matchLabel(c.score),
    match_score: round2(c.score),
    grams_assumed: s.res.grams === null ? null : Math.round(s.res.grams * 10) / 10,
    grams_basis: s.res.basis,
    nutrients: s.res.nutrients ? rounded(s.res.nutrients) : null,
    in_range: s.inRange,
  };
  if (!s.res.nutrients && c.per100g) view.per_100g = rounded(c.per100g);
  const flags = c.flags.filter((f) => f !== "summary_only");
  if (c.flags.includes("summary_only")) flags.push("calories_and_macros_only");
  if (flags.length) view.flags = flags;
  return view;
}

function altView(c: Candidate): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    ...(c.brand ? { brand: c.brand } : {}),
    ...(c.restaurant ? { restaurant: c.restaurant } : {}),
    ...(c.dataset ? { dataset: c.dataset } : {}),
    match_score: round2(c.score),
  };
}

function statusOf(slot: SourceSlot): StatusWord {
  if ("notQueried" in slot.result) return "not_queried";
  if (slot.best) return "answered";
  if (slot.result.unavailable) return "unavailable";
  return "no_match";
}

/**
 * How far below the top text score a candidate may be and still be picked as
 * a source's best because it can be SCALED and the top one cannot: "apple, 1
 * medium" should land on "Apples, raw, with skin" (which has a "1 medium"
 * portion), not on "Apple, dried" (which has none) by a hair of text score.
 */
export const SCALABLE_MARGIN = 0.1;

/** How many hits a local source is asked for, so the pick above has a choice. */
const POOL = 10;

/** Fill a slot from a source result, honouring a pinned candidate. */
function slotFrom(
  source: SourceName,
  result: SourceResult | { notQueried: string },
  pinned: Candidate | undefined,
  alternatives: number,
  rangeEligible = true,
  scalable?: (c: Candidate) => boolean,
): SourceSlot {
  const list =
    "notQueried" in result ? [] : result.candidates.filter((c) => c.score >= MIN_SCORE);
  if (pinned && pinned.source === source) {
    return {
      source,
      result,
      best: pinned,
      alternatives: list.filter((c) => c.id !== pinned.id).slice(0, alternatives),
      rangeEligible: true,
    };
  }
  const top = list[0];
  const best =
    top && scalable
      ? (list.find((c) => c.score >= top.score - SCALABLE_MARGIN && scalable(c)) ?? top)
      : top;
  return {
    source,
    result,
    ...(best ? { best } : {}),
    alternatives: list.filter((c) => c !== best).slice(0, alternatives),
    rangeEligible,
  };
}

function scalableFor(quantity: number, unit: Unit) {
  return (c: Candidate) =>
    resolve(quantity, unit, c.per100g, c.portions, c.defaultPortion).nutrients !== null;
}

interface AssembleOptions {
  input: Record<string, unknown>;
  quantity: number;
  unit: Unit;
  /** A per-source unit override (restaurant sizes for USDA). */
  unitFor?: (c: Candidate) => Unit;
  pinnedId?: string;
  bias: Partial<Record<SourceName, number>>;
  bufferPct?: number;
  flags?: string[];
  notes?: string[];
}

function assemble(slots: SourceSlot[], o: AssembleOptions): ComponentResult {
  const scaled: Scaled[] = [];
  for (const slot of slots) {
    if (!slot.best) continue;
    const c = slot.best;
    const unit = o.unitFor ? o.unitFor(c) : o.unit;
    let res = resolve(o.quantity, unit, c.per100g, c.portions, c.defaultPortion);
    if (!res.nutrients && unit !== o.unit) {
      res = resolve(o.quantity, o.unit, c.per100g, c.portions, c.defaultPortion);
    }
    const pinned = c.id === o.pinnedId;
    const inRange =
      slot.rangeEligible && res.nutrients !== null && (pinned || c.score >= RANGE_MIN_SCORE);
    scaled.push({ slot, cand: c, res, pinned, inRange });
  }

  let inRange = scaled.filter((s) => s.inRange);
  const flags = [...(o.flags ?? [])];
  // Nothing clears the range bar, but a partial match could be scaled: it is
  // the best evidence there is, so it sets the estimate — and says so.
  if (inRange.length === 0) {
    const partial = scaled.filter(
      (s) => s.slot.rangeEligible && s.res.nutrients !== null && s.cand.score >= PARTIAL_MIN_SCORE,
    );
    if (partial.length) {
      for (const s of partial) s.inRange = true;
      inRange = partial;
      flags.push("low_confidence_match");
    }
  }
  const expected =
    inRange.find((s) => s.pinned) ??
    [...inRange].sort(
      (a, b) =>
        b.cand.score + (o.bias[b.cand.source] ?? 0) -
        (a.cand.score + (o.bias[a.cand.source] ?? 0)),
    )[0];

  let range: NutrientRanges | null = null;
  if (expected?.res.nutrients) {
    range = {} as NutrientRanges;
    for (const k of NUTRIENT_KEYS) {
      const e = expected.res.nutrients[k];
      if (e === null) {
        range[k] = { low: null, expected: null, high: null };
        continue;
      }
      const values = inRange
        .map((s) => s.res.nutrients![k])
        .filter((v): v is number => v !== null);
      let high = Math.max(...values);
      if (o.bufferPct && BUFFERED.includes(k)) high *= 1 + o.bufferPct / 100;
      range[k] = {
        low: round(k, Math.min(...values)),
        expected: round(k, e),
        high: round(k, high),
      };
    }
  } else if (scaled.length === 0) {
    flags.push("no_match");
  } else if (scaled.every((s) => s.res.nutrients === null)) {
    flags.push("needs_grams");
  } else {
    flags.push("no_usable_match");
  }

  let disagreement: ComponentResult["disagreement"] = null;
  const cal = inRange
    .map((s) => ({ source: s.cand.source, kcal: s.res.nutrients!.calories }))
    .filter((x): x is { source: SourceName; kcal: number } => x.kcal !== null && x.kcal > 0);
  if (cal.length >= 2) {
    const min = Math.min(...cal.map((x) => x.kcal));
    const max = Math.max(...cal.map((x) => x.kcal));
    if (max > min * (1 + DISAGREEMENT_THRESHOLD_PCT / 100)) {
      disagreement = {
        threshold_pct: DISAGREEMENT_THRESHOLD_PCT,
        spread_pct: Math.round(((max - min) / min) * 100),
        calories_by_source: Object.fromEntries(cal.map((x) => [x.source, Math.round(x.kcal)])),
      };
      flags.push("sources_disagree");
    }
  }

  const alternatives: ComponentResult["alternatives"] = {};
  for (const slot of slots) {
    if (slot.alternatives.length) alternatives[slot.source] = slot.alternatives.map(altView);
  }
  const source_status = Object.fromEntries(
    SOURCES.map((s) => {
      const slot = slots.find((x) => x.source === s);
      return [s, slot ? statusOf(slot) : "not_queried"];
    }),
  ) as Record<SourceName, StatusWord>;

  const notes = [...(o.notes ?? [])];
  for (const slot of slots) {
    if (!("notQueried" in slot.result) && slot.result.note) notes.push(slot.result.note);
  }

  return {
    input: o.input,
    expected_from: expected?.cand.id ?? null,
    range,
    flags,
    ...(o.bufferPct && range
      ? {
          buffer: {
            applied_to: "high" as const,
            nutrients: BUFFERED,
            pct: o.bufferPct,
            reason: "restaurant estimate: kitchens add oil and butter a menu or recipe does not show",
          },
        }
      : {}),
    disagreement,
    candidates: scaled.map(candidateView),
    alternatives,
    source_status,
    ...(notes.length ? { notes } : {}),
  };
}

async function pinnedCandidate(
  lookups: Lookups,
  id: string | undefined,
): Promise<{ pinned?: Candidate; note?: string }> {
  if (!id) return {};
  const { candidate, error } = await lookups.byId(id);
  if (candidate) return { pinned: { ...candidate, score: 1 } };
  return { note: `food_id ${id} was not used: ${error}` };
}

export async function estimateComponent(
  lookups: Lookups,
  input: ComponentInput,
  alternatives = DEFAULT_ALTERNATIVES,
): Promise<{ result: ComponentResult; slots: SourceSlot[] }> {
  const { pinned, note } = await pinnedCandidate(lookups, input.food_id);
  const limit = alternatives + 1;
  const unit = parseUnit(input.unit);
  const scalable = scalableFor(input.quantity, unit);
  const [usda, fatsecret] = await Promise.all([
    lookups.usda(input.name, {
      limit: Math.max(limit, POOL),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.brand ? { brand: input.brand } : {}),
    }),
    lookups.fatsecret(input.name, {
      limit,
      ...(input.brand ? { brand: input.brand } : {}),
    }),
  ]);
  const slots = [
    slotFrom("usda", usda, pinned, alternatives, true, scalable),
    slotFrom(
      "menustat",
      pinned?.source === "menustat"
        ? { candidates: [] }
        : { notQueried: "MenuStat is restaurant menus; use estimate_restaurant_item." },
      pinned,
      alternatives,
    ),
    slotFrom("fatsecret", fatsecret, pinned, alternatives),
  ];
  const fs = slots[2]!;
  if (fs.best) fs.best = await lookups.fatsecretDetail(fs.best);

  const branded = input.kind === "branded" || input.brand !== undefined;
  const result = assemble(slots, {
    input: { ...input },
    quantity: input.quantity,
    unit,
    ...(pinned ? { pinnedId: pinned.id } : {}),
    // Local USDA is curated and versioned; it wins a near-tie for a generic
    // food. For a named brand, the brand's own record should win instead.
    bias: branded ? { fatsecret: 0.02 } : { usda: 0.05 },
    ...(note ? { notes: [note] } : {}),
  });
  return { result, slots };
}

export async function estimateRestaurant(
  lookups: Lookups,
  input: RestaurantInput,
  alternatives = DEFAULT_ALTERNATIVES,
): Promise<{ result: ComponentResult; slots: SourceSlot[] }> {
  const { pinned, note } = await pinnedCandidate(lookups, input.food_id);
  const limit = alternatives + 1;
  // Only a size WORD ("large", "grande") is matched: menus spell sizes into
  // item names. A size with a number in it ("16 oz") names no item and would
  // only drag the text score down, so it is left out and the note says so.
  const sizeWord = input.size && !/\d/.test(input.size) ? input.size : undefined;
  const itemQuery = sizeWord ? `${sizeWord} ${input.item}` : input.item;
  const menustat = await lookups.menustat(input.restaurant, itemQuery, Math.max(limit, POOL));
  const owner = menustat.chain?.restaurant ?? input.restaurant;
  const [fatsecret, usda] = await Promise.all([
    lookups.fatsecret(itemQuery, { restaurant: owner, limit }),
    lookups.usda(itemQuery, { limit: Math.max(limit, POOL), kind: "dish", datasets: ["fndds"] }),
  ]);

  const strong = (r: SourceResult) =>
    r.candidates.some((c) => c.score >= RANGE_MIN_SCORE);
  const chainMatched =
    (pinned !== undefined && pinned.source !== "usda") ||
    strong(menustat) ||
    strong(fatsecret);

  const serving = parseUnit("serving");
  const sizeParsed = sizeWord ? parseUnit(sizeWord) : undefined;
  const sizeUnit = sizeParsed?.kind === "count" ? sizeParsed : undefined;
  const servingScalable = scalableFor(input.quantity, serving);
  const slots = [
    slotFrom("usda", usda, pinned, alternatives, !chainMatched, servingScalable),
    // With no chain match, only the USDA dish may set the estimate: a weak
    // chain item ("Chicken" for "chicken burrito") is shown, never used.
    slotFrom("menustat", menustat, pinned, alternatives, chainMatched, servingScalable),
    slotFrom("fatsecret", fatsecret, pinned, alternatives, chainMatched),
  ];
  const fs = slots[2]!;
  if (fs.best) fs.best = await lookups.fatsecretDetail(fs.best);

  const flags = chainMatched ? [] : ["independent_restaurant_estimate"];
  const notes = note ? [note] : [];
  if (input.size && !sizeWord) {
    notes.push(
      `size "${input.size}" was not used: only a size word ("small", "large", "grande") is matched against menu items. ` +
        "Pass a measured amount to estimate_components instead.",
    );
  }
  if (menustat.chain && menustat.chain.restaurant !== input.restaurant) {
    notes.push(`"${input.restaurant}" was matched to MenuStat's "${menustat.chain.restaurant}".`);
  }
  if (!chainMatched) {
    notes.push(
      menustat.chain
        ? `${menustat.chain.restaurant} is in MenuStat, but no menu item there or on FatSecret ` +
            `matched "${itemQuery}" closely, so the expected value is the closest USDA FNDDS generic dish.`
        : "No chain menu item matched, so the expected value is the closest USDA FNDDS generic dish.",
    );
  }
  const result = assemble(slots, {
    input: { ...input },
    quantity: input.quantity,
    unit: serving,
    // A size word ("large") picks a USDA portion of that size when FNDDS has one.
    ...(sizeUnit ? { unitFor: (c: Candidate) => (c.source === "usda" ? sizeUnit : serving) } : {}),
    ...(pinned ? { pinnedId: pinned.id } : {}),
    // MenuStat's newest data is 2018; FatSecret is current. A near-tie goes
    // to the current menu.
    bias: { fatsecret: 0.03 },
    bufferPct: input.buffer_pct,
    flags,
    notes,
  });
  // The fallback note claims the USDA dish; drop it if no USDA dish was usable.
  if (!chainMatched && !result.expected_from?.startsWith("usda:") && result.notes) {
    result.notes = result.notes.filter((n) => !n.includes("closest USDA FNDDS generic dish"));
  }
  return { result, slots };
}

function sumRanges(results: ComponentResult[]): EstimateResult["totals"] {
  const totals = {} as EstimateResult["totals"];
  for (const k of NUTRIENT_KEYS) {
    const acc: Range = { low: null, expected: null, high: null };
    for (const r of results) {
      if (!r.range) continue;
      for (const part of ["low", "expected", "high"] as const) {
        const v = r.range[k][part];
        if (v !== null) acc[part] = (acc[part] ?? 0) + v;
      }
    }
    totals[k] = {
      low: round(k, acc.low),
      expected: round(k, acc.expected),
      high: round(k, acc.high),
    };
  }
  const missing = results.flatMap((r, i) => (r.range ? [] : [i]));
  if (missing.length) totals.components_without_estimate = missing;
  // A nutrient some estimated component could not report is a partial sum.
  const partial = NUTRIENT_KEYS.filter((k) =>
    results.some((r) => r.range && r.range[k].expected === null),
  );
  if (partial.length) totals.incomplete_nutrients = partial;
  if (results.some((r) => r.buffer)) totals.buffer_included = true;
  return totals;
}

function sourceReports(all: SourceSlot[][]): Record<SourceName, SourceReport> {
  const out = {} as Record<SourceName, SourceReport>;
  for (const s of SOURCES) {
    const slots = all.flatMap((list) => list.filter((x) => x.source === s));
    const words = slots.map(statusOf);
    let status: StatusWord;
    if (words.includes("answered")) status = "answered";
    else if (words.includes("unavailable")) status = "unavailable";
    else if (words.length > 0 && words.every((w) => w === "not_queried")) status = "not_queried";
    else status = "no_match";
    const details = new Set<string>();
    for (const slot of slots) {
      const r = slot.result;
      if ("notQueried" in r) {
        if (status === "not_queried") details.add(r.notQueried);
      } else if (r.unavailable) {
        details.add(r.unavailable);
      }
    }
    out[s] = { status, ...(details.size ? { detail: [...details].join(" ") } : {}) };
  }
  return out;
}

/** True when any FatSecret record is shown anywhere in the result. */
function usedFatSecret(all: SourceSlot[][]): boolean {
  return all.some((list) =>
    list.some((s) => s.source === "fatsecret" && (s.best || s.alternatives.length)),
  );
}

export function envelope(
  outcomes: Array<{ result: ComponentResult; slots: SourceSlot[] }>,
): EstimateResult {
  const slots = outcomes.map((o) => o.slots);
  const results = outcomes.map((o) => o.result);
  return {
    components: results,
    totals: sumRanges(results),
    sources: sourceReports(slots),
    ...(usedFatSecret(slots) ? { attribution: { ...ATTRIBUTION } } : {}),
  };
}
