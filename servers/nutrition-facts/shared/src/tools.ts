import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { estimateComponentsTool } from "./tools/estimate-components.js";
import { estimateRestaurantItemTool } from "./tools/estimate-restaurant-item.js";
import { getFoodTool } from "./tools/get-food.js";
import { searchFoodsTool } from "./tools/search-foods.js";
import type { ToolContext, ToolDefinition } from "./tools/shared.js";

/**
 * FOUR TOOLS, ALL READS: two estimates that do the work, two lookups that let
 * the caller swap in a better match. Nothing here writes anywhere — no food
 * diary, no account (spec non-goals) — so `readwrite` is the `readonly` set. It
 * is still exported, so this server's groups read like every other tree's.
 *
 * IN STRAD, THESE GROUPS ARE NOT THE ENFORCEMENT. The gateway's per-slug
 * `tools:` policy is; the groups exist because this server also runs outside
 * strad, and the tests assert against them.
 */
export type ToolGroup = "readonly" | "readwrite";

const ALL_GROUPS: ToolGroup[] = ["readonly", "readwrite"];

/**
 * FAILS CLOSED. Unset means the full surface (the bundle's posture, where the
 * gateway decides capability); set and unrecognised means someone tried to
 * restrict this server and mistyped it, so it falls back to `readonly`.
 */
export function parseToolGroups(raw?: string): ToolGroup[] {
  if (!raw) return ALL_GROUPS;
  const requested = raw.split(",").map((g) => g.trim().toLowerCase());
  const valid = requested.filter((g): g is ToolGroup =>
    ALL_GROUPS.includes(g as ToolGroup),
  );
  return valid.length > 0 ? valid : ["readonly"];
}

interface Entry {
  factory: (ctx: ToolContext) => ToolDefinition;
  groups: ToolGroup[];
}

const ENTRIES: Entry[] = [
  { factory: estimateComponentsTool, groups: ["readonly", "readwrite"] },
  { factory: estimateRestaurantItemTool, groups: ["readonly", "readwrite"] },
  { factory: searchFoodsTool, groups: ["readonly", "readwrite"] },
  { factory: getFoodTool, groups: ["readonly", "readwrite"] },
];

export function toolDefinitions(
  ctx: ToolContext,
  groups: ToolGroup[] = ALL_GROUPS,
): ToolDefinition[] {
  return ENTRIES.filter((e) => e.groups.some((g) => groups.includes(g))).map(
    (e) => e.factory(ctx),
  );
}

const UNUSED_CONTEXT = { lookups: undefined } as unknown as ToolContext;

/** The names a deployment of these groups serves. */
export function toolNames(groups: ToolGroup[] = ALL_GROUPS): string[] {
  return toolDefinitions(UNUSED_CONTEXT, groups).map((t) => t.name);
}

export function registerTools(
  server: Server,
  ctx: ToolContext,
  groups: ToolGroup[] = ALL_GROUPS,
): void {
  const tools = toolDefinitions(ctx, groups);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      throw new Error(
        `Unknown tool: ${request.params.name}. This server offers: ${tools
          .map((t) => t.name)
          .join(", ")}.`,
      );
    }
    return tool.handler(request.params.arguments);
  });
}
