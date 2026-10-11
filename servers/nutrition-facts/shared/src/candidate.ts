/**
 * One source's answer for one food, before it is scaled.
 *
 * Every source — two local files and two live APIs — reduces to this, so the
 * matching, scaling and range logic in estimate.ts never asks which source it
 * is holding.
 */

import type { Nutrients } from "./nutrients.js";
import type { Portion } from "./units.js";

export type SourceName = "usda" | "menustat" | "fatsecret";

export const SOURCES: readonly SourceName[] = ["usda", "menustat", "fatsecret"];

export interface Candidate {
  /** `usda:171287`, `menustat:35005`, `fatsecret:41963` — what get_food takes. */
  id: string;
  source: SourceName;
  /** USDA's dataset (`foundation`, `sr_legacy`, `fndds`, `branded`). */
  dataset?: string;
  name: string;
  brand?: string;
  restaurant?: string;
  category?: string;
  description?: string;
  data_year: number | null;
  /** Match score, 0..1 (text.ts). */
  score: number;
  per100g: Nutrients | null;
  portions: Portion[];
  /** What "1 serving" means when no portion says so. */
  defaultPortion?: Portion;
  /** Caveats about this record itself, e.g. `calories_computed_from_macros`. */
  flags: string[];
  /** The source's own page for this food, when it has one. */
  url?: string;
}

/** Why a source has nothing to say about a lookup. */
export type SourceStatus =
  | { status: "answered" }
  | { status: "no_match" }
  | { status: "unavailable"; reason: string }
  | { status: "not_queried"; reason: string };

export class SourceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceUnavailable";
  }
}

/** What a source returns for one query. */
export interface SourceResult {
  candidates: Candidate[];
  /** Set when the source could not be asked at all. */
  unavailable?: string;
  /** A partial answer: e.g. USDA local answered but Branded was not searched. */
  note?: string;
}
