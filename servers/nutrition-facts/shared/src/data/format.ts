/**
 * The two files the image carries, and what is in them.
 *
 * Both are gzipped JSON written at image build time by `data/cli.ts` from the
 * pinned public downloads in `data/sources.ts`, and read once, lazily, on the
 * first call that needs them. Short keys because USDA's file holds ~13,700
 * foods and MenuStat's ~30,000 items; every nutrient array is in
 * `NUTRIENT_KEYS` order (nutrients.ts).
 */

import type { NutrientTuple } from "../nutrients.js";

export const DATA_VERSION = 1;

export const USDA_FILE = "usda.json.gz";
export const MENUSTAT_FILE = "menustat.json.gz";

/** Which USDA dataset a record came from. */
export type UsdaDataset = "foundation" | "sr_legacy" | "fndds";

export const DATASET_CODES: Record<string, UsdaDataset> = {
  F: "foundation",
  S: "sr_legacy",
  N: "fndds",
};

export interface UsdaRecord {
  /** FDC id. */
  i: number;
  /** Dataset code: F, S or N. */
  d: "F" | "S" | "N";
  /** USDA's description, e.g. "Rice, white, long-grain, regular, cooked". */
  n: string;
  /** Food category (Foundation / SR) or WWEIA category (FNDDS). */
  c: string;
  /** Data year. */
  y: number;
  /** Nutrients per 100 g. */
  k: NutrientTuple;
  /** Portions: [label, grams]. */
  p: Array<[string, number]>;
  /** 1 when calories were computed from macros (Atwater 4/4/9). */
  e?: 1;
}

export interface MenuStatRecord {
  /** MenuStat's Menu_Item_ID. */
  i: number;
  /** Restaurant, as MenuStat spells it: "McDonald's". */
  r: string;
  /** Item name: "Big Mac". */
  n: string;
  /** MenuStat's item description, which often names the menu section. */
  ds: string;
  /** Food category: "Burgers", "Beverages". */
  c: string;
  /** Data year — the latest year MenuStat has this item for. */
  y: number;
  /** Serving weight in grams, when MenuStat gives one by weight. */
  g: number | null;
  /** Serving size as text ("16 fl oz", "1 slice"), when given. */
  s: string | null;
  /** Nutrients per item, as served. */
  k: NutrientTuple;
}

export interface SourceProvenance {
  name: string;
  url: string;
  sha256: string;
  release: string;
}

export interface UsdaFile {
  version: number;
  built_at: string;
  sources: SourceProvenance[];
  foods: UsdaRecord[];
}

export interface MenuStatFile {
  version: number;
  built_at: string;
  sources: SourceProvenance[];
  items: MenuStatRecord[];
}
