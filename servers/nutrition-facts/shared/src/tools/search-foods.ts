import { z } from "zod";

import type { Candidate, SourceName, SourceResult } from "../candidate.js";
import { rounded } from "../nutrients.js";
import { ATTRIBUTION } from "../remote/fatsecret.js";
import { matchLabel } from "../text.js";
import {
  guard,
  KIND_DESCRIPTION,
  KINDS,
  ok,
  READ_ANNOTATIONS,
  SOURCE_NAMES,
  type ToolContext,
  type ToolDefinition,
} from "./shared.js";

const Schema = z
  .object({
    query: z.string().trim().min(1).max(200),
    sources: z.array(z.enum(SOURCE_NAMES)).min(1).max(3).optional(),
    restaurant: z.string().trim().min(1).max(100).optional(),
    brand: z.string().trim().min(1).max(100).optional(),
    kind: z.enum(KINDS).optional(),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();

/** A compact line per hit: calories and macros on the source's own basis. */
export function summarize(c: Candidate): Record<string, unknown> {
  const basis = c.per100g
    ? { per: "100 g", n: c.per100g }
    : c.defaultPortion?.nutrients
      ? { per: c.defaultPortion.label, n: c.defaultPortion.nutrients }
      : c.portions[0]?.nutrients
        ? { per: c.portions[0].label, n: c.portions[0].nutrients }
        : null;
  const n = basis ? rounded(basis.n) : null;
  return {
    id: c.id,
    name: c.name,
    ...(c.brand ? { brand: c.brand } : {}),
    ...(c.restaurant ? { restaurant: c.restaurant } : {}),
    ...(c.dataset ? { dataset: c.dataset } : {}),
    data_year: c.data_year,
    match: matchLabel(c.score),
    match_score: Math.round(c.score * 100) / 100,
    ...(basis && n
      ? {
          per: basis.per,
          calories: n.calories,
          protein_g: n.protein_g,
          carbs_g: n.carbs_g,
          fat_g: n.fat_g,
        }
      : {}),
    portions: c.portions.slice(0, 6).map((p) => p.label),
  };
}

function report(r: SourceResult) {
  return {
    status: r.unavailable ? "unavailable" : r.candidates.length ? "answered" : "no_match",
    ...(r.unavailable ? { detail: r.unavailable } : r.note ? { detail: r.note } : {}),
    results: r.candidates.map(summarize),
  };
}

export function searchFoodsTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "search_foods",
    description:
      "Search USDA FoodData Central, MenuStat and FatSecret for foods matching " +
      "a query, ranked per source, to find a better match than an estimate " +
      "picked. Pass a result's id to get_food for its full nutrients and " +
      "portions, or as food_id to estimate_components / " +
      "estimate_restaurant_item to pin it.\n\n" +
      "Sources: usda (local Foundation, SR Legacy and FNDDS; plus live USDA " +
      "Branded when `brand` or kind \"branded\" is given and a key is " +
      "configured), menustat (local chain menus, 2017–2018), fatsecret (live; " +
      "generic, branded and restaurant foods). Default: all three. Each " +
      "FatSecret search spends one call of a daily quota; results are cached.\n\n" +
      "Each result carries id, name, brand / restaurant, dataset, data_year, " +
      "match (exact / strong / partial / weak) and match_score, calories and " +
      "macros on the source's own basis (`per`: \"100 g\", \"1 item\", " +
      "\"1 cup\"), and up to six portion labels.\n\n" +
      'Example: {"results":{"usda":{"status":"answered","results":[{"id":' +
      '"usda:169756","name":"Rice, white, long-grain, regular, enriched, ' +
      'cooked","dataset":"sr_legacy","data_year":2018,"match":"strong",' +
      '"match_score":0.81,"per":"100 g","calories":130,"protein_g":2.7,' +
      '"carbs_g":28.2,"fat_g":0.3,"portions":["1 cup"]}]},"menustat":{...},' +
      '"fatsecret":{"status":"unavailable","detail":"FatSecret is not ' +
      'configured: ..."}}}\n\n' +
      "Use cases: browse a chain's menu (`restaurant` + query), compare raw " +
      "and cooked entries, find a brand's product, check what a source has " +
      "before estimating.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Food words: "greek yogurt", "big mac", "brown rice cooked".' },
        sources: {
          type: "array",
          items: { type: "string", enum: SOURCE_NAMES },
          description: 'Limit to some sources, e.g. ["usda"]. Default all three.',
        },
        restaurant: {
          type: "string",
          description: 'Search one chain\'s menu (MenuStat, FatSecret): "mcd", "Chipotle".',
        },
        brand: { type: "string", description: 'A brand name: "Chobani". Searches USDA Branded and FatSecret.' },
        kind: { type: "string", enum: KINDS, description: KIND_DESCRIPTION },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Results per source (default 5, max 20)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS },
    handler: (raw) =>
      guard(Schema, raw, async (input: z.infer<typeof Schema>) => {
        const wanted = new Set<SourceName>(input.sources ?? SOURCE_NAMES);
        const [usda, menustat, fatsecret] = await Promise.all([
          wanted.has("usda")
            ? ctx.lookups.usda(input.query, {
                limit: input.limit,
                ...(input.kind ? { kind: input.kind } : {}),
                ...(input.brand ? { brand: input.brand } : {}),
              })
            : undefined,
          wanted.has("menustat")
            ? ctx.lookups.menustat(input.restaurant, input.query, input.limit)
            : undefined,
          wanted.has("fatsecret")
            ? ctx.lookups.fatsecret(input.query, {
                limit: input.limit,
                ...(input.restaurant ? { restaurant: input.restaurant } : {}),
                ...(input.brand ? { brand: input.brand } : {}),
              })
            : undefined,
        ]);
        const results: Record<string, unknown> = {};
        const skipped = { status: "not_queried", detail: "not in `sources`", results: [] };
        results.usda = usda ? report(usda) : skipped;
        results.menustat = menustat
          ? {
              ...report(menustat),
              ...(menustat.chain ? { matched_restaurant: menustat.chain.restaurant } : {}),
            }
          : skipped;
        results.fatsecret = fatsecret ? report(fatsecret) : skipped;
        return ok({
          results,
          ...(fatsecret?.candidates.length ? { attribution: { ...ATTRIBUTION } } : {}),
        });
      }),
  };
}
