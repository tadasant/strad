/**
 * MenuStat's chain menu items, in memory: a loose restaurant match, then the
 * item.
 *
 * THE RESTAURANT MATCH IS LOOSE ON PURPOSE. The spec's example is "mcd" finding
 * McDonald's, and a caller will also write "chick fil a", "dominos pizza" or
 * "in n out". Names are compared with every non-letter removed ("McDonald's" →
 * "mcdonalds"), and a chain matches when it equals the query, starts with it
 * (three letters or more), is a prefix of it ("dominospizza" → "dominos"), has
 * the query as its initials ("bk", "dq"), or shares its words. 96 chains is a
 * small enough list that every one is scored.
 */

import type { Candidate } from "../candidate.js";
import type {
  MenuStatFile,
  MenuStatRecord,
  SourceProvenance,
} from "../data/format.js";
import { fromTuple, scale } from "../nutrients.js";
import { MIN_SCORE, normalize, scoreTokens, squash, tokens } from "../text.js";
import { parsePortionLabel, portion, type Portion } from "../units.js";

/** Nicknames no rule above can derive. Keys are squashed. */
const ALIASES: Record<string, string> = {
  maccas: "mcdonalds",
  mickeyds: "mcdonalds",
  mickeyd: "mcdonalds",
  dunkin: "dunkindonuts",
  bojangle: "bojangles",
  chickfilla: "chickfila",
  cfa: "chickfila",
};

export interface ChainMatch {
  restaurant: string;
  score: number;
}

/** How well a caller's restaurant text names a chain, 0..1. */
export function restaurantScore(query: string, chain: string): number {
  const q = ALIASES[squash(query)] ?? squash(query);
  const r = squash(chain);
  if (q === "" || r === "") return 0;
  if (q === r) return 1;
  if (q.length >= 3 && r.startsWith(q)) return 0.9;
  if (r.length >= 4 && q.startsWith(r)) return 0.85;
  const initials = normalize(chain)
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("");
  if (q.length >= 2 && initials.length >= 2 && q === initials) return 0.8;
  if (q.length >= 4 && r.includes(q)) return 0.7;
  const words = scoreTokens(tokens(query), tokens(chain));
  return words.coverage === 1 ? 0.75 * words.score + 0.1 : 0.6 * words.score;
}

/** At or above this a restaurant text is taken to name the chain. */
export const CHAIN_MIN_SCORE = 0.6;

interface Entry {
  rec: MenuStatRecord;
  nameTokens: string[];
  /** The chain's words, then the item's. */
  fullTokens: string[];
}

export class MenuStatIndex {
  private readonly entries: Entry[];
  private readonly byId = new Map<number, Entry>();
  private readonly byChain = new Map<string, Entry[]>();
  readonly sources: SourceProvenance[];

  constructor(file: MenuStatFile) {
    this.sources = file.sources;
    this.entries = file.items.map((rec) => {
      const nameTokens = tokens(rec.n);
      const entry: Entry = {
        rec,
        nameTokens,
        fullTokens: [...tokens(rec.r), ...nameTokens],
      };
      this.byId.set(rec.i, entry);
      const list = this.byChain.get(rec.r) ?? [];
      list.push(entry);
      this.byChain.set(rec.r, list);
      return entry;
    });
  }

  get size(): number {
    return this.entries.length;
  }

  get chains(): string[] {
    return [...this.byChain.keys()].sort();
  }

  /** Chains the text could name, best first; empty when none clears the bar. */
  matchRestaurant(query: string): ChainMatch[] {
    return this.chains
      .map((restaurant) => ({ restaurant, score: restaurantScore(query, restaurant) }))
      .filter((m) => m.score >= CHAIN_MIN_SCORE)
      .sort((a, b) => b.score - a.score || a.restaurant.localeCompare(b.restaurant));
  }

  /**
   * Items matching `query`. With `restaurant` (a chain name as MenuStat spells
   * it) only that chain's menu is searched; without it, every chain's, and the
   * item name is matched together with the restaurant name so "big mac" and
   * "mcdonalds big mac" both work.
   */
  search(
    query: string,
    options: { restaurant?: string; limit?: number } = {},
  ): Candidate[] {
    const q = tokens(query);
    if (q.length === 0) return [];
    const pool = options.restaurant
      ? (this.byChain.get(options.restaurant) ?? [])
      : this.entries;
    const scored: Array<{ entry: Entry; score: number }> = [];
    for (const entry of pool) {
      const own = scoreTokens(q, entry.nameTokens).score;
      const withChain = options.restaurant
        ? own
        : scoreTokens(q, entry.fullTokens).score;
      const score = Math.max(own, withChain);
      if (score >= MIN_SCORE) scored.push({ entry, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.rec.y - a.entry.rec.y ||
        a.entry.nameTokens.length - b.entry.nameTokens.length ||
        a.entry.rec.i - b.entry.rec.i,
    );
    return scored
      .slice(0, options.limit ?? 5)
      .map(({ entry, score }) => toCandidate(entry.rec, score));
  }

  get(id: number): Candidate | undefined {
    const entry = this.byId.get(id);
    return entry ? toCandidate(entry.rec, 1) : undefined;
  }
}

function toCandidate(rec: MenuStatRecord, score: number): Candidate {
  const perItem = fromTuple(rec.k);
  const item = portion(`1 item${rec.s ? ` (${rec.s})` : ""}`, rec.g, perItem);
  const portions: Portion[] = [item];
  // A serving given as a volume ("16 fl oz") lets "12 fl oz" of a drink scale.
  if (rec.s) {
    const parsed = parsePortionLabel(rec.s);
    if (parsed.unit.kind === "volume") portions.push(portion(rec.s, rec.g, perItem));
  }
  return {
    id: `menustat:${rec.i}`,
    source: "menustat",
    name: rec.n,
    restaurant: rec.r,
    ...(rec.c ? { category: rec.c } : {}),
    ...(rec.ds ? { description: rec.ds } : {}),
    data_year: rec.y || null,
    score,
    per100g: rec.g ? scale(perItem, 100 / rec.g) : null,
    portions,
    defaultPortion: item,
    flags: [],
  };
}
