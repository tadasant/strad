import { z } from "zod";

import {
  DEFAULT_ALTERNATIVES,
  DEFAULT_RESTAURANT_BUFFER_PCT,
  envelope,
  estimateRestaurant,
} from "../estimate.js";
import {
  guard,
  ok,
  READ_ANNOTATIONS,
  type ToolContext,
  type ToolDefinition,
} from "./shared.js";

const Schema = z
  .object({
    restaurant: z.string().trim().min(1).max(100),
    item: z.string().trim().min(1).max(200),
    size: z.string().trim().min(1).max(40).optional(),
    quantity: z.number().positive().max(100).default(1),
    food_id: z.string().trim().min(1).max(40).optional(),
    buffer_pct: z.number().min(0).max(100).default(DEFAULT_RESTAURANT_BUFFER_PCT),
    alternatives: z.number().int().min(0).max(5).default(DEFAULT_ALTERNATIVES),
  })
  .strict();

export function estimateRestaurantItemTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "estimate_restaurant_item",
    description:
      "Nutrition for one restaurant menu item, from MenuStat (the top ~100 " +
      "US chains, data years 2017–2018) and FatSecret (current chain menus), " +
      "with the closest USDA FNDDS generic dish as the fallback. The " +
      'restaurant is matched loosely ("mcd" finds McDonald\'s, "chick fil a" ' +
      "Chick-Fil-A), then the item on its menu.\n\n" +
      "When no chain item matches — an independent restaurant, or a chain " +
      "neither source has — the expected value is the USDA generic dish and " +
      "the component is flagged independent_restaurant_estimate.\n\n" +
      "Every restaurant estimate widens range.high by buffer_pct (default " +
      `${DEFAULT_RESTAURANT_BUFFER_PCT}%) on calories, fat and saturated fat, for extra cooking oil and butter; the ` +
      "`buffer` field says so. expected is never buffered.\n\n" +
      "Returns the same shape as estimate_components, with one component: " +
      "candidates (best per source: id, source, name, restaurant or brand, " +
      "data_year, match, grams_assumed, nutrients, in_range), alternatives, " +
      "range (low/expected/high per nutrient), flags (sources_disagree when " +
      "calories differ by >20%), notes (e.g. which chain was matched), " +
      "totals, sources (answered / no_match / unavailable, with reasons) and, " +
      "when FatSecret data is used, attribution to show with it.\n\n" +
      'Example: {"components":[{"expected_from":"fatsecret:41963",' +
      '"range":{"calories":{"low":540,"expected":550,"high":633}},' +
      '"buffer":{"applied_to":"high","pct":15},"candidates":[{"id":' +
      '"menustat:73418","source":"menustat","name":"Big Mac","restaurant":' +
      '"McDonald\'s","data_year":2018,"match":"exact","nutrients":' +
      '{"calories":540}}],"notes":["\\"mcd\\" was matched to MenuStat\'s ' +
      '\\"McDonald\'s\\"."]}],"sources":{"menustat":{"status":"answered"}}}\n\n' +
      "Use search_foods to browse a chain's menu, then pass a candidate's " +
      "id as food_id to pin it.",
    inputSchema: {
      type: "object",
      properties: {
        restaurant: { type: "string", description: 'The restaurant: "McDonald\'s", "mcd", "Joe\'s Diner".' },
        item: { type: "string", description: 'The menu item: "Big Mac", "chicken burrito bowl".' },
        size: { type: "string", description: 'Optional size word: "small", "medium", "large", "grande". It is matched against the menu item names.' },
        quantity: { type: "number", description: "How many of the item (default 1)." },
        food_id: {
          type: "string",
          description: 'Pin a candidate id from search_foods ("menustat:73418"); it becomes the expected value.',
        },
        buffer_pct: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: `Widening of range.high, in percent (default ${DEFAULT_RESTAURANT_BUFFER_PCT}; 0 turns it off).`,
        },
        alternatives: {
          type: "integer",
          minimum: 0,
          maximum: 5,
          description: `Runners-up kept per source (default ${DEFAULT_ALTERNATIVES}).`,
        },
      },
      required: ["restaurant", "item"],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS },
    handler: (raw) =>
      guard(Schema, raw, async (input: z.infer<typeof Schema>) => {
        const { alternatives, ...rest } = input;
        const outcome = await estimateRestaurant(
          ctx.lookups,
          {
            restaurant: rest.restaurant,
            item: rest.item,
            quantity: rest.quantity,
            buffer_pct: rest.buffer_pct,
            ...(rest.size ? { size: rest.size } : {}),
            ...(rest.food_id ? { food_id: rest.food_id } : {}),
          },
          alternatives,
        );
        return ok(envelope([outcome]));
      }),
  };
}
