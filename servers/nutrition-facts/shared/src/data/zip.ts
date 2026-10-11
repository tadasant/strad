import { basename } from "node:path";
import { unzipSync } from "fflate";

import type { CsvFiles } from "./usda-build.js";

/** The tables `buildUsda` reads. Everything else in a release zip is skipped. */
const USDA_TABLES = new Set([
  "food.csv",
  "food_nutrient.csv",
  "food_portion.csv",
  "measure_unit.csv",
  "nutrient.csv",
  "food_category.csv",
  "wweia_food_category.csv",
]);

/** A USDA release zip → its tables by file name (each zip nests one directory). */
export function unzipTables(zip: Uint8Array): CsvFiles {
  const entries = unzipSync(zip, {
    filter: (f) => USDA_TABLES.has(basename(f.name)),
  });
  const files: CsvFiles = new Map();
  const decoder = new TextDecoder("utf-8");
  for (const [name, data] of Object.entries(entries)) {
    files.set(basename(name), decoder.decode(data));
  }
  return files;
}
