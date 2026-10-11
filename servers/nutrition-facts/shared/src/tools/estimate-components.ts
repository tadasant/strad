import { z } from "zod";

import {
  DEFAULT_ALTERNATIVES,
  envelope,
  estimateComponent,
  MAX_COMPONENTS,
} from "../estimate.js";
import {
  guard,
  KIND_DESCRIPTION,
  KINDS,
  ok,
  READ_ANNOTATIONS,
  type ToolContext,
  type ToolDefinition,
} from "./shared.js";

const Component = z
  .object({
    name: z.string().trim().min(1).max(200),
    quantity: z.number().positive().max(100_000),
    unit: z.string().trim().max(40).optional(),
    brand: z.string().trim().min(1).max(100).optional(),
    kind: z.enum(KINDS).optional(),
    food_id: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

const Schema = z
  .object({
    components: z.array(Component).min(1).max(MAX_COMPONENTS),
    alternatives: z.number().int().min(0).max(5).default(DEFAULT_ALTERNATIVES),
  })
  .strict();

const COMPONENT_PROPERTIES = {
  name: {
    type: "string",
    description: 'What the food is: "white rice, cooked", "chicken breast", "pad thai".',
  },
  quantity: { type: "number", description: "How much, in `unit`: 1.5, 200." },
  unit: {
    type: "string",
    description:
      'g, kg, oz, lb, cup, tbsp, tsp, fl oz, ml, or a count word ("medium", ' +
      '"slice", "serving"). Default "serving".',
  },
  brand: { type: "string", description: 'A brand, when the food is a packaged product: "Chobani".' },
  kind: { type: "string", enum: KINDS, description: KIND_DESCRIPTION },
  food_id: {
    type: "string",
    description:
      'Pin a candidate from search_foods or an earlier estimate ("usda:171287"). ' +
      "It becomes the expected value; other sources still report.",
  },
};

export function estimateComponentsTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "estimate_components",
    description:
      "Nutrition for foods given as components with quantities, from USDA " +
      "FoodData Central and FatSecret side by side, each scaled to the amount " +
      "using that source's own portion data. Break a free-form meal into " +
      'components first; one dish ("pad thai", 2 cup) is a valid single ' +
      "component. For a chain restaurant item use estimate_restaurant_item.\n\n" +
      "Per component: each source's best match (candidates[]: id, source, " +
      "dataset, name, brand, data_year, match, grams_assumed, grams_basis, " +
      "nutrients, in_range), runners-up (alternatives), and range — " +
      "low/expected/high for calories, protein_g, carbs_g, fat_g, fiber_g, " +
      "sugar_g, saturated_fat_g, sodium_mg. expected is the best match " +
      "(expected_from); low/high span the in-range candidates. Then totals " +
      "across components and sources: answered / no_match / unavailable / " +
      "not_queried, with the reason.\n\n" +
      "Flags: sources_disagree (calories differ by >20%), needs_grams (no " +
      "portion converts this unit — per_100g values are given; call again in " +
      "g). A weak match is shown with in_range: false.\n\n" +
      'Example: {"components":[{"expected_from":"usda:2512381","range":' +
      '{"calories":{"low":205,"expected":205,"high":242}},"flags":[],' +
      '"candidates":[{"id":"usda:2512381","source":"usda","dataset":"fndds",' +
      '"name":"Rice, white, cooked, no added fat","match":"strong",' +
      '"grams_assumed":158,"grams_basis":"1 cup via source portion \\"1 cup\\" = 158 g",' +
      '"nutrients":{"calories":205}}],"source_status":{"usda":"answered",' +
      '"menustat":"not_queried","fatsecret":"answered"}}],"totals":{...},' +
      '"sources":{...},"attribution":{"text":"Powered by fatsecret Platform API"}}\n\n' +
      "When FatSecret data is used, show `attribution` with it.",
    inputSchema: {
      type: "object",
      properties: {
        components: {
          type: "array",
          minItems: 1,
          maxItems: MAX_COMPONENTS,
          items: {
            type: "object",
            properties: COMPONENT_PROPERTIES,
            required: ["name", "quantity"],
            additionalProperties: false,
          },
          description: `1 to ${MAX_COMPONENTS} components.`,
        },
        alternatives: {
          type: "integer",
          minimum: 0,
          maximum: 5,
          description: `Runners-up kept per source (default ${DEFAULT_ALTERNATIVES}).`,
        },
      },
      required: ["components"],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS },
    handler: (raw) =>
      guard(Schema, raw, async (input: z.infer<typeof Schema>) => {
        const outcomes = [];
        // In order, not in parallel: a 25-component call would otherwise spend
        // up to 50 FatSecret calls at once against a per-second limit.
        for (const c of input.components) {
          outcomes.push(await estimateComponent(ctx.lookups, c, input.alternatives));
        }
        return ok(envelope(outcomes));
      }),
  };
}
