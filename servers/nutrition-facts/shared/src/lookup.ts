/**
 * One place that knows how to ask each source, and how each one says no.
 *
 * Every method returns a `SourceResult` rather than throwing: a source that
 * cannot answer is EVIDENCE about the lookup (the spec's "say which source was
 * missing"), not a failure of it. Only a programming error escapes.
 */

import {
  SourceUnavailable,
  type Candidate,
  type SourceResult,
} from "./candidate.js";
import { FDC_NOT_CONFIGURED } from "./config.js";
import type { UsdaDataset } from "./data/format.js";
import { CHAIN_MIN_SCORE, restaurantScore, type ChainMatch } from "./local/menustat.js";
import type { LocalStore } from "./local/store.js";
import type { FoodKind } from "./local/usda.js";
import type { FatSecretClient } from "./remote/fatsecret.js";
import { fsFoodToCandidate, fsSearchToCandidate } from "./remote/fatsecret-map.js";
import { fdcToCandidate, type FdcClient } from "./remote/fdc.js";
import { MIN_SCORE, score } from "./text.js";

export interface LookupDeps {
  store: LocalStore;
  fatsecret: FatSecretClient;
  fdc: FdcClient;
  now?: () => number;
}

function reason(err: unknown): string {
  if (err instanceof SourceUnavailable) return err.message;
  return `unexpected error: ${err instanceof Error ? err.message : String(err)}`;
}

function byScore(a: Candidate, b: Candidate): number {
  return b.score - a.score;
}

export class Lookups {
  constructor(private readonly deps: LookupDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * USDA: the local datasets always; Branded too when a brand is named (or
   * `kind` is `branded`) and a key is set.
   */
  async usda(
    query: string,
    options: {
      kind?: FoodKind;
      brand?: string;
      limit?: number;
      datasets?: readonly UsdaDataset[];
    } = {},
  ): Promise<SourceResult> {
    const limit = options.limit ?? 5;
    const local = await this.deps.store.usdaIndex();
    const out: Candidate[] = [];
    const notes: string[] = [];
    let localDown: string | undefined;
    if (local.ok) {
      out.push(
        ...local.value.search(query, {
          limit,
          ...(options.kind ? { kind: options.kind } : {}),
          ...(options.datasets ? { datasets: options.datasets } : {}),
        }),
      );
    } else {
      localDown = local.reason;
    }

    const wantsBranded =
      (options.brand !== undefined || options.kind === "branded") &&
      !options.datasets;
    let brandedDown: string | undefined;
    if (wantsBranded) {
      if (!this.deps.fdc.configured()) {
        brandedDown = FDC_NOT_CONFIGURED;
      } else {
        try {
          const full = options.brand ? `${options.brand} ${query}` : query;
          const hits = await this.deps.fdc.searchBranded(full, limit);
          for (const food of hits) {
            const named = `${food.brandName ?? food.brandOwner ?? ""} ${food.description}`;
            const s = score(full, named).score;
            // A named brand is part of the identity: the bonus keeps a branded
            // hit for that brand ahead of a generic food with the same words.
            if (s >= MIN_SCORE) out.push(fdcToCandidate(food, Math.min(1, s + 0.05)));
          }
        } catch (err) {
          brandedDown = `USDA Branded: ${reason(err)}`;
        }
      }
    }
    if (brandedDown) notes.push(brandedDown);
    out.sort(byScore);

    if (localDown) {
      if (out.length === 0) {
        return { candidates: [], unavailable: [localDown, ...notes].join(" ") };
      }
      notes.unshift(localDown);
    }
    return {
      candidates: out.slice(0, limit),
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  }

  /** MenuStat: a chain match, then items on that chain's menu. */
  async menustat(
    restaurant: string | undefined,
    item: string,
    limit = 5,
  ): Promise<SourceResult & { chain?: ChainMatch }> {
    const index = await this.deps.store.menustatIndex();
    if (!index.ok) return { candidates: [], unavailable: index.reason };
    if (restaurant === undefined) {
      return { candidates: index.value.search(item, { limit }) };
    }
    const chain = index.value.matchRestaurant(restaurant)[0];
    if (!chain) {
      return {
        candidates: [],
        note: `"${restaurant}" matches none of MenuStat's ${index.value.chains.length} chains.`,
      };
    }
    return {
      chain,
      candidates: index.value.search(item, { restaurant: chain.restaurant, limit }),
    };
  }

  /**
   * FatSecret search. With `restaurant`, only hits whose brand loosely names it
   * are kept — FatSecret files a chain's menu items under the chain as brand.
   */
  async fatsecret(
    query: string,
    options: { restaurant?: string; brand?: string; limit?: number } = {},
  ): Promise<SourceResult> {
    if (!this.deps.fatsecret.configured()) {
      return { candidates: [], unavailable: this.deps.fatsecret.unconfiguredReason()! };
    }
    const limit = options.limit ?? 5;
    const owner = options.restaurant ?? options.brand;
    const expression = owner ? `${owner} ${query}` : query;
    try {
      const hits = await this.deps.fatsecret.search(expression, Math.max(limit * 2, 10));
      const out: Candidate[] = [];
      for (const hit of hits) {
        if (options.restaurant) {
          if (!hit.brand_name) continue;
          if (restaurantScore(options.restaurant, hit.brand_name) < CHAIN_MIN_SCORE) {
            continue;
          }
        }
        const s = options.restaurant
          ? score(query, hit.food_name).score
          : score(expression, `${hit.brand_name ?? ""} ${hit.food_name}`).score;
        if (s >= MIN_SCORE) out.push(fsSearchToCandidate(hit, s, this.now()));
      }
      out.sort(byScore);
      return { candidates: out.slice(0, limit) };
    } catch (err) {
      return { candidates: [], unavailable: reason(err) };
    }
  }

  /**
   * Replace a FatSecret search hit with its full record (all eight nutrients,
   * every serving). One call; the hit is kept if it fails.
   */
  async fatsecretDetail(hit: Candidate): Promise<Candidate> {
    if (hit.source !== "fatsecret" || !hit.flags.includes("summary_only")) return hit;
    try {
      const food = await this.deps.fatsecret.getFood(hit.id.slice("fatsecret:".length));
      return fsFoodToCandidate(food, hit.score, this.now());
    } catch {
      return hit;
    }
  }

  /** One candidate by id, from its own source. */
  async byId(id: string): Promise<{ candidate?: Candidate; error?: string }> {
    const m = /^(usda|menustat|fatsecret):(\d+)$/.exec(id.trim());
    if (!m) {
      return {
        error:
          `"${id}" is not a candidate id. Ids look like "usda:171287", ` +
          `"menustat:35005" or "fatsecret:41963"; get them from search_foods or an estimate.`,
      };
    }
    const [, source, raw] = m;
    const n = Number(raw);
    if (source === "usda") {
      const local = await this.deps.store.usdaIndex();
      const hit = local.ok ? local.value.get(n) : undefined;
      if (hit) return { candidate: hit };
      if (!this.deps.fdc.configured()) {
        return {
          error: local.ok
            ? `usda:${n} is not in the local USDA datasets, and USDA Branded cannot be read: ${FDC_NOT_CONFIGURED}`
            : local.reason,
        };
      }
      try {
        return { candidate: fdcToCandidate(await this.deps.fdc.food(n), 1) };
      } catch (err) {
        return { error: reason(err) };
      }
    }
    if (source === "menustat") {
      const index = await this.deps.store.menustatIndex();
      if (!index.ok) return { error: index.reason };
      const hit = index.value.get(n);
      return hit ? { candidate: hit } : { error: `MenuStat has no item ${n}.` };
    }
    if (!this.deps.fatsecret.configured()) {
      return { error: this.deps.fatsecret.unconfiguredReason()! };
    }
    try {
      const food = await this.deps.fatsecret.getFood(String(n));
      return { candidate: fsFoodToCandidate(food, 1, this.now()) };
    } catch (err) {
      return { error: reason(err) };
    }
  }
}
