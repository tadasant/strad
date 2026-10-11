import { z } from "zod";

import { rounded } from "../nutrients.js";
import { ATTRIBUTION } from "../remote/fatsecret.js";
import {
  fail,
  guard,
  ok,
  READ_ANNOTATIONS,
  type ToolContext,
  type ToolDefinition,
} from "./shared.js";

const Schema = z.object({ id: z.string().trim().min(1).max(40) }).strict();

export function getFoodTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "get_food",
    description:
      "Everything one source has on one food: nutrients per 100 g, every " +
      "published portion with its grams (and its own nutrients when the " +
      "source reports per serving), and provenance. Takes an id from " +
      'search_foods or an estimate ("usda:171287", "menustat:73418", ' +
      '"fatsecret:41963") and reads only that id\'s source — a FatSecret id ' +
      "spends one call of the daily quota (cached).\n\n" +
      "Use it to check which portion an estimate's grams_basis used, see a " +
      "food's full nutrient set, or record a food precisely in the user's own " +
      "list. To use the food in an estimate, pass its id as food_id.\n\n" +
      'Example: {"id":"usda:169756","source":"usda","dataset":"sr_legacy",' +
      '"name":"Rice, white, long-grain, regular, enriched, cooked",' +
      '"category":"Cereal Grains and Pasta","data_year":2018,"per_100g":' +
      '{"calories":130,"protein_g":2.7,"carbs_g":28.2,"fat_g":0.3,"fiber_g":' +
      '0.4,"sugar_g":0.1,"saturated_fat_g":0.1,"sodium_mg":1},"portions":' +
      '[{"label":"1 cup","grams":158}],"url":"https://fdc.nal.usda.gov/' +
      'food-details/169756/nutrients"}\n\n' +
      "Fields: per_100g is null when the source does not publish weights " +
      "(many MenuStat items); default_serving is what \"1 serving\" means; " +
      "flags note record caveats (calories_computed_from_macros: USDA " +
      "Foundation carried no energy value, so 4/4/9 was applied). A FatSecret " +
      "record comes with attribution to show alongside it.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: 'A candidate id: "usda:171287", "menustat:73418", "fatsecret:41963".',
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS },
    handler: (raw) =>
      guard(Schema, raw, async (input: z.infer<typeof Schema>) => {
        const { candidate: c, error } = await ctx.lookups.byId(input.id);
        if (!c) return fail(error ?? `No food ${input.id}.`);
        return ok({
          id: c.id,
          source: c.source,
          ...(c.dataset ? { dataset: c.dataset } : {}),
          name: c.name,
          ...(c.brand ? { brand: c.brand } : {}),
          ...(c.restaurant ? { restaurant: c.restaurant } : {}),
          ...(c.category ? { category: c.category } : {}),
          ...(c.description ? { description: c.description } : {}),
          data_year: c.data_year,
          per_100g: c.per100g ? rounded(c.per100g) : null,
          portions: c.portions.map((p) => ({
            label: p.label,
            grams: p.grams === null ? null : Math.round(p.grams * 10) / 10,
            ...(p.nutrients ? { nutrients: rounded(p.nutrients) } : {}),
          })),
          ...(c.defaultPortion ? { default_serving: c.defaultPortion.label } : {}),
          ...(c.flags.length ? { flags: c.flags } : {}),
          ...(c.url ? { url: c.url } : {}),
          ...(c.source === "fatsecret" ? { attribution: { ...ATTRIBUTION } } : {}),
        });
      }),
  };
}
