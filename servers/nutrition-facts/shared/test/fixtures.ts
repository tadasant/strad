/**
 * A tiny data directory, built through the SAME code path the image build
 * uses: CSV text shaped like each real release (quirks included) → a zip →
 * `unzipTables` → `buildUsda` / `buildMenuStat` → the gzipped files the
 * server loads. Only the download is skipped.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";

import {
  DATA_VERSION,
  MENUSTAT_FILE,
  USDA_FILE,
  type MenuStatFile,
  type UsdaFile,
} from "../src/data/format.js";
import { buildMenuStat } from "../src/data/menustat-build.js";
import { buildUsda } from "../src/data/usda-build.js";
import { unzipTables } from "../src/data/zip.js";

/** Every field double-quoted, as USDA writes them. */
export function csv(header: string[], rows: Array<Array<string | number>>): string {
  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  return [header, ...rows].map((r) => r.map(q).join(",")).join("\n") + "\n";
}

const NUTRIENT_CSV = csv(
  ["id", "name", "unit_name", "nutrient_nbr", "rank"],
  [
    [1003, "Protein", "G", "203", "600"],
    [1004, "Total lipid (fat)", "G", "204", "800"],
    [1005, "Carbohydrate, by difference", "G", "205", "1110"],
    [1008, "Energy", "KCAL", "208", "300"],
    [1079, "Fiber, total dietary", "G", "291", "1200"],
    [1085, "Total fat (NLEA)", "G", "298", "900"],
    [1093, "Sodium, Na", "MG", "307", "5800"],
    [1258, "Fatty acids, total saturated", "G", "606", "9700"],
    [2000, "Total Sugars", "G", "269", "1510"],
    [1063, "Sugars, Total", "G", "269.3", "1500"],
    [2047, "Energy (Atwater General Factors)", "KCAL", "957", "280"],
    [2048, "Energy (Atwater Specific Factors)", "KCAL", "958", "290"],
  ],
);

const UNITS_CSV = csv(
  ["id", "name"],
  [
    [1000, "cup"],
    [1001, "tablespoon"],
    [1043, "medium"],
    [9999, "undetermined"],
  ],
);

const FOOD_HEADER = ["fdc_id", "data_type", "description", "food_category_id", "publication_date"];
const FN_HEADER = ["id", "fdc_id", "nutrient_id", "amount", "data_points", "derivation_id", "min", "max", "median", "footnote", "min_year_acquired"];
const PORTION_HEADER = ["id", "fdc_id", "seq_num", "amount", "measure_unit_id", "portion_description", "modifier", "gram_weight", "data_points", "footnote", "min_year_acquired"];

function fn(fdc: number, rows: Array<[number, number]>): Array<Array<string | number>> {
  return rows.map(([id, amount], i) => [fdc * 100 + i, fdc, id, amount, "", "", "", "", "", "", ""]);
}

/** Foundation: real units, Atwater energy ids, lab-sample rows to exclude. */
function foundationZip(): Uint8Array {
  const files = {
    "FoodData_Central_foundation/food.csv": csv(FOOD_HEADER, [
      [1001, "foundation_food", "Apples, raw, with skin", 9, "2024-04-18"],
      [1002, "foundation_food", "Oil, olive, extra virgin", 4, "2023-10-26"],
      // A lab sample: excluded. Its description has a doubled quote and a newline.
      [1003, "sub_sample_food", 'Apples, "Gala" sample\n', 9, "8/16/2023"],
    ]),
    "FoodData_Central_foundation/food_nutrient.csv": csv(FN_HEADER, [
      // Energy only as 2047; sugar only as 1063.
      ...fn(1001, [[2047, 61], [1003, 0.17], [1005, 14.8], [1004, 0.15], [1079, 2.1], [1063, 10.4], [1093, 1]]),
      // No energy id at all, fat only as NLEA 1085: Atwater from the macros.
      ...fn(1002, [[1003, 0], [1005, 0], [1085, 100], [1258, 14]]),
      ...fn(1003, [[1008, 999]]),
    ]),
    "FoodData_Central_foundation/food_portion.csv": csv(PORTION_HEADER, [
      [1, 1001, 1, 1, 1043, "", "", 200, "", "", ""],
      [2, 1002, 1, 1, 1001, "", "", 13.5, "", "", ""],
      // Rows with no food and no unit exist in the real file.
      [3, "", 1, 1, "", "", "", 50, "", "", ""],
    ]),
    "FoodData_Central_foundation/measure_unit.csv": UNITS_CSV,
    "FoodData_Central_foundation/nutrient.csv": NUTRIENT_CSV,
    "FoodData_Central_foundation/food_category.csv": csv(
      ["id", "code", "description"],
      [
        [4, "0400", "Fats and Oils"],
        [9, "0900", "Fruits and Fruit Juices"],
      ],
    ),
  };
  return zip(files);
}

/** SR Legacy: amount + modifier portions, unit always 9999, 2019 dates. */
function srZip(): Uint8Array {
  return zip({
    "sr/food.csv": csv(FOOD_HEADER, [
      [2001, "sr_legacy_food", "Rice, white, long-grain, regular, enriched, cooked", 20, "2019-04-01"],
      [2002, "sr_legacy_food", "Chicken, broilers or fryers, breast, meat only, cooked, roasted", 5, "2019-04-01"],
      [2003, "sr_legacy_food", "Yogurt, Greek, plain, nonfat", 1, "2019-04-01"],
    ]),
    "sr/food_nutrient.csv": csv(FN_HEADER, [
      ...fn(2001, [[1008, 130], [1003, 2.69], [1005, 28.17], [1004, 0.28], [1079, 0.4], [2000, 0.05], [1258, 0.077], [1093, 1]]),
      ...fn(2002, [[1008, 165], [1003, 31.02], [1005, 0], [1004, 3.57], [1258, 1.01], [1093, 74]]),
      ...fn(2003, [[1008, 59], [1003, 10.19], [1005, 3.6], [1004, 0.39], [2000, 3.24], [1093, 36]]),
    ]),
    "sr/food_portion.csv": csv(PORTION_HEADER, [
      [10, 2001, 1, 1, 9999, "", "cup", 158, "", "", ""],
      [11, 2002, 1, 0.5, 9999, "", "breast, bone and skin removed", 86, "", "", ""],
      [12, 2003, 1, 1, 9999, "", "container (6 oz)", 170, "", "", ""],
    ]),
    "sr/measure_unit.csv": UNITS_CSV,
    "sr/nutrient.csv": NUTRIENT_CSV,
    "sr/food_category.csv": csv(["id", "code", "description"], [[20, "2000", "Cereal Grains and Pasta"]]),
  });
}

/** FNDDS: nutrient NUMBERS in the nutrient_id column; text portions. */
function fnddsZip(): Uint8Array {
  return zip({
    "survey/food.csv": csv(FOOD_HEADER, [
      [3001, "survey_fndds_food", "Pad Thai, NFS", 3202, "2022-10-28"],
      [3002, "survey_fndds_food", "Cheeseburger, NFS", 3702, "2022-10-28"],
      [3003, "survey_fndds_food", "Big Mac (McDonalds)", 3702, "2022-10-28"],
      [3004, "survey_fndds_food", "Rice, white, cooked, no added fat", 4802, "2022-10-28"],
      [3005, "survey_fndds_food", "Burrito, chicken, cheese", 3502, "2022-10-28"],
    ]),
    "survey/food_nutrient.csv": csv(FN_HEADER, [
      ...fn(3001, [[208, 154], [203, 7.2], [205, 21.4], [204, 4.6], [291, 1.4], [269, 4.3], [606, 0.8], [307, 400]]),
      ...fn(3002, [[208, 263], [203, 13.6], [205, 24.3], [204, 12.2], [291, 1.1], [269, 5.3], [606, 5.4], [307, 552]]),
      ...fn(3003, [[208, 257], [203, 11.8], [205, 20.1], [204, 14.6], [291, 1.6], [269, 3.9], [606, 4.2], [307, 455]]),
      ...fn(3004, [[208, 130], [203, 2.7], [205, 28.6], [204, 0.3], [291, 0.4], [269, 0.1], [606, 0.1], [307, 1]]),
      ...fn(3005, [[208, 244], [203, 13.1], [205, 24.1], [204, 10.3], [291, 2.1], [269, 1.4], [606, 4.4], [307, 545]]),
    ]),
    "survey/food_portion.csv": csv(PORTION_HEADER, [
      [20, 3001, 1, "", 9999, "1 cup", "10205", 200, "", "", ""],
      [21, 3001, 2, "", 9999, "Quantity not specified", "90000", 330, "", "", ""],
      [22, 3002, 1, "", 9999, "1 sandwich, any size", "60000", 160, "", "", ""],
      [23, 3002, 2, "", 9999, "Quantity not specified", "90000", 185, "", "", ""],
      [24, 3003, 1, "", 9999, "Quantity not specified", "90000", 205, "", "", ""],
      [25, 3004, 1, "", 9999, "1 cup", "10205", 158, "", "", ""],
      [26, 3005, 1, "", 9999, "Quantity not specified", "90000", 220, "", "", ""],
    ]),
    "survey/measure_unit.csv": UNITS_CSV,
    "survey/nutrient.csv": NUTRIENT_CSV,
    "survey/wweia_food_category.csv": csv(
      ["wweia_food_category", "wweia_food_category_description"],
      [
        [3202, "Asian mixed dishes"],
        [3702, "Burgers"],
        [4802, "Rice"],
        [3502, "Burritos and tacos"],
      ],
    ),
  });
}

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

const MENUSTAT_HEADER = [
  "Menu_Item_ID", "Year", "restaurant", "Item_Name", "Item_Description", "Food_Category",
  "Serving_Size", "Serving_Size_Unit", "Serving_Size_household",
  "Calories", "Total_Fat", "Saturated_Fat", "Sodium", "Carbohydrates", "Protein", "Sugar", "Dietary_Fiber",
];

/** MenuStat's export: quoted only where needed, a row per item per year. */
export const MENUSTAT_CSV = [
  MENUSTAT_HEADER.join(","),
  `101,2017,McDonald's,Big Mac,"Big Mac, Burgers",Burgers,,,,530,27,10,960,46,24,9,3`,
  `180,2018,McDonald's,Big Mac,"Big Mac, Burgers",Burgers,,,,540,28,10,950,46,25,9,3`,
  `181,2018,McDonald's,"French Fries, Large","French Fries, Large, Sides",Appetizers & Sides,150,g,,510,24,3.5,400,66,7,0,6`,
  `182,2018,McDonald's,"French Fries, Small","French Fries, Small, Sides",Appetizers & Sides,71,g,,230,11,1.5,180,29,2,0,3`,
  `183,2017,McDonald's,McRib,"McRib, Burgers",Burgers,,,,480,22,8,840,44,22,11,3`,
  `300,2018,Chick-Fil-A,Chick Fil a Chicken Sandwich,"Chicken Sandwich, Entrees",Sandwiches,183,g,,440,19,4,1350,41,28,6,1`,
  `400,2018,Starbucks,"Caffe Latte w/ 2% Milk, Grande","Caffe Latte, Espresso",Beverages,16,fl oz,,190,7,4.5,170,19,13,17,0`,
  `500,2018,Chipotle,Chicken,"Chicken, Proteins",Entrees,4,oz,,180,7,3,310,0,32,0,0`,
  `401,2018,Starbucks,Iced Coffee,"Iced Coffee, Drinks",Beverages,,,,,,,,,,,`,
].join("\n") + "\n";

export function buildFixtureData(): { dir: string; usda: UsdaFile; menustat: MenuStatFile } {
  const dir = mkdtempSync(join(tmpdir(), "nutrition-facts-"));
  const foods = [foundationZip(), srZip(), fnddsZip()].flatMap((z) => buildUsda(unzipTables(z)));
  const usda: UsdaFile = { version: DATA_VERSION, built_at: "2026-10-11T00:00:00Z", sources: [], foods };
  const menustat: MenuStatFile = {
    version: DATA_VERSION,
    built_at: "2026-10-11T00:00:00Z",
    sources: [],
    items: buildMenuStat(MENUSTAT_CSV),
  };
  writeFileSync(join(dir, USDA_FILE), gzipSync(JSON.stringify(usda)));
  writeFileSync(join(dir, MENUSTAT_FILE), gzipSync(JSON.stringify(menustat)));
  return { dir, usda, menustat };
}
