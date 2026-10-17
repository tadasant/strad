/**
 * USDA Foundation, SR Legacy and FNDDS, in memory, searchable.
 *
 * ~13,600 foods. A query scores every one of them (text.ts) — a linear scan
 * over precomputed tokens takes a few milliseconds and needs no index to keep
 * consistent.
 *
 * WHICH DATASET WINS is the spec's rule, applied as a small bonus on top of
 * the text score rather than a filter, so a clearly better match in another
 * dataset still surfaces:
 *   - `ingredient` favours Foundation and SR Legacy (measured single foods);
 *   - `dish` favours FNDDS (USDA's mixed dishes "as eaten");
 *   - `auto` leans slightly to Foundation / SR on a tie.
 */

import type { Candidate } from "../candidate.js";
import {
  DATASET_CODES,
  type SourceProvenance,
  type UsdaDataset,
  type UsdaFile,
  type UsdaRecord,
} from "../data/format.js";
import { fromTuple } from "../nutrients.js";
import { MIN_SCORE, nameTokens, scoreTokens, tokenMatches, tokens } from "../text.js";
import { portion } from "../units.js";

export type FoodKind = "auto" | "ingredient" | "dish" | "branded";

const BONUS: Record<FoodKind, Record<UsdaDataset, number>> = {
  auto: { foundation: 0.02, sr_legacy: 0.02, fndds: 0 },
  ingredient: { foundation: 0.06, sr_legacy: 0.05, fndds: 0 },
  dish: { foundation: 0, sr_legacy: 0, fndds: 0.08 },
  branded: { foundation: 0, sr_legacy: 0, fndds: 0 },
};

const HEAD_BONUS = 0.08;

/**
 * A name whose leading food is a COMPOUND the query only half names is about
 * something else: "unsalted peanuts" is not "Peanut butter, …, without salt",
 * and "brown rice" is not "Rice flour, brown". The head is the name up to its
 * first comma, parentheticals aside ("Big Mac (McDonalds)" is headed "big
 * mac").
 */
const PARTIAL_HEAD_PENALTY = 0.08;

function headTokens(name: string): string[] {
  return nameTokens(name.split(",")[0]!.replace(/\([^)]*\)/g, " "));
}

function halfNamesHead(query: readonly string[], head: readonly string[]): boolean {
  const named = head.filter((h) => query.some((q) => tokenMatches(q, h))).length;
  return named > 0 && named < head.length;
}

interface Entry {
  rec: UsdaRecord;
  dataset: UsdaDataset;
  nameTokens: string[];
  headTokens: string[];
}

export interface UsdaSearchOptions {
  kind?: FoodKind;
  limit?: number;
  datasets?: readonly UsdaDataset[];
}

export class UsdaIndex {
  private readonly entries: Entry[];
  private readonly byId = new Map<number, Entry>();
  readonly sources: SourceProvenance[];

  constructor(file: UsdaFile) {
    this.sources = file.sources;
    this.entries = file.foods.map((rec) => {
      const entry: Entry = {
        rec,
        dataset: DATASET_CODES[rec.d]!,
        nameTokens: nameTokens(rec.n),
        headTokens: headTokens(rec.n),
      };
      this.byId.set(rec.i, entry);
      return entry;
    });
  }

  get size(): number {
    return this.entries.length;
  }

  search(query: string, options: UsdaSearchOptions = {}): Candidate[] {
    const q = tokens(query);
    if (q.length === 0) return [];
    const kind = options.kind ?? "auto";
    const allowed = options.datasets ? new Set(options.datasets) : null;
    const scored: Array<{ entry: Entry; score: number; rank: number }> = [];
    for (const entry of this.entries) {
      if (allowed && !allowed.has(entry.dataset)) continue;
      const { score } = scoreTokens(q, entry.nameTokens);
      if (score < MIN_SCORE) continue;
      // USDA names lead with the food ("Egg, whole, raw"); a name that leads
      // with the query's first word is about it, not merely mentioning it
      // ("Bread, egg").
      const head =
        (entry.nameTokens[0] === q[0] ? HEAD_BONUS : 0) -
        (halfNamesHead(q, entry.headTokens) ? PARTIAL_HEAD_PENALTY : 0);
      scored.push({ entry, score, rank: score + head + BONUS[kind][entry.dataset] });
    }
    scored.sort(
      (a, b) =>
        b.rank - a.rank ||
        a.entry.nameTokens.length - b.entry.nameTokens.length ||
        a.entry.rec.i - b.entry.rec.i,
    );
    return scored
      .slice(0, options.limit ?? 5)
      .map(({ entry, score }) => toCandidate(entry, score));
  }

  get(fdcId: number): Candidate | undefined {
    const entry = this.byId.get(fdcId);
    return entry ? toCandidate(entry, 1) : undefined;
  }
}

function toCandidate(entry: Entry, score: number): Candidate {
  const { rec } = entry;
  return {
    id: `usda:${rec.i}`,
    source: "usda",
    dataset: entry.dataset,
    name: rec.n,
    ...(rec.c ? { category: rec.c } : {}),
    data_year: rec.y || null,
    score,
    per100g: fromTuple(rec.k),
    portions: rec.p.map(([label, grams]) => portion(label, grams)),
    flags: rec.e ? ["calories_computed_from_macros"] : [],
    url: `https://fdc.nal.usda.gov/food-details/${rec.i}/nutrients`,
  };
}
