/**
 * MenuStat's CSV → one record per menu item, at its LATEST year.
 *
 * The NYC Open Data export has a row per item per year (2017 and 2018). The
 * spec says to use the latest year available, so an item that appears in both
 * keeps 2018's numbers, and an item MenuStat only has for 2017 (dropped from
 * the menu, or not re-collected) keeps 2017's and says so in its year. Rows
 * with no calories — 9,904 of them, mostly beverages MenuStat listed without
 * values — carry no evidence and are dropped.
 */

import type { NutrientTuple } from "../nutrients.js";
import { squash } from "../text.js";
import { csvRecords } from "./csv.js";
import type { MenuStatRecord } from "./format.js";

/** MenuStat columns in `NUTRIENT_KEYS` order. */
const COLUMNS = [
  "Calories",
  "Protein",
  "Carbohydrates",
  "Total_Fat",
  "Dietary_Fiber",
  "Sugar",
  "Saturated_Fat",
  "Sodium",
];

function num(text: string | undefined): number | null {
  if (text === undefined || text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function buildMenuStat(csv: string): MenuStatRecord[] {
  const groups = new Map<string, MenuStatRecord[]>();
  for (const r of csvRecords(csv)) {
    const k: NutrientTuple = COLUMNS.map((c) => num(r[c]));
    if (k[0] === null) continue;
    const name = (r.Item_Name ?? "").trim();
    const restaurant = (r.restaurant ?? "").trim();
    if (name === "" || restaurant === "") continue;

    const size = num(r.Serving_Size);
    const unit = (r.Serving_Size_Unit ?? "").trim().toLowerCase();
    const grams =
      size === null ? null : unit === "g" ? size : unit === "oz" ? size * 28.3495 : null;
    const household = (r.Serving_Size_household ?? "").trim();
    const servingText =
      household !== ""
        ? household
        : size !== null && unit !== ""
          ? `${size} ${unit}`
          : null;

    const rec: MenuStatRecord = {
      i: Number(r.Menu_Item_ID),
      r: restaurant,
      n: name,
      ds: (r.Item_Description ?? "").trim(),
      c: (r.Food_Category ?? "").trim(),
      y: Number(r.Year) || 0,
      g: grams === null ? null : Math.round(grams * 10) / 10,
      s: servingText,
      k,
    };
    // Grouped by restaurant and item name; the group keeps every row of its
    // latest year. Two rows in one year are two items (a lunch and a dinner
    // portion of the same entrée), not a duplicate.
    const key = `${squash(restaurant)}|${squash(name)}`;
    const group = groups.get(key);
    if (!group || rec.y > group[0]!.y) groups.set(key, [rec]);
    else if (rec.y === group[0]!.y && !group.some((g) => g.ds === rec.ds)) {
      group.push(rec);
    }
  }
  return [...groups.values()].flat().sort((a, b) => a.i - b.i);
}
