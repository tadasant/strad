import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getAirportDelaysTool } from "./tools/get-airport-delays.js";
import { getAirportFlightsTool } from "./tools/get-airport-flights.js";
import { getAirportTool } from "./tools/get-airport.js";
import { getFlightPositionTool } from "./tools/get-flight-position.js";
import { getFlightTrackTool } from "./tools/get-flight-track.js";
import { getFlightTool } from "./tools/get-flight.js";
import { getOperatorTool } from "./tools/get-operator.js";
import { searchFlightsTool } from "./tools/search-flights.js";
import type { ToolContext, ToolDefinition } from "./tools/shared.js";

/**
 * EIGHT TOOLS, ALL READS. AeroAPI's flight data has no write side, so the
 * `readwrite` group is the `readonly` group. It is still exported, so this
 * server's groups read like every other tree's and a staging allow list derived
 * from `toolNames(["readonly"])` means the same thing here as anywhere.
 *
 * What is deliberately NOT offered, because each is a different bill:
 *   - AeroAPI alerts (`/alerts`) — a write: it registers a webhook that keeps
 *     charging after the call returns.
 *   - historical flights (`/history/...`) — priced well above live data.
 *   - Foresight predictions — a separate, more expensive product tier.
 * Adding any of them is a decision about what an agent may spend, not a
 * feature.
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
  { factory: getFlightTool, groups: ["readonly", "readwrite"] },
  { factory: searchFlightsTool, groups: ["readonly", "readwrite"] },
  { factory: getFlightPositionTool, groups: ["readonly", "readwrite"] },
  { factory: getFlightTrackTool, groups: ["readonly", "readwrite"] },
  { factory: getAirportTool, groups: ["readonly", "readwrite"] },
  { factory: getAirportFlightsTool, groups: ["readonly", "readwrite"] },
  { factory: getAirportDelaysTool, groups: ["readonly", "readwrite"] },
  { factory: getOperatorTool, groups: ["readonly", "readwrite"] },
];

export function toolDefinitions(
  ctx: ToolContext,
  groups: ToolGroup[] = ALL_GROUPS,
): ToolDefinition[] {
  return ENTRIES.filter((e) => e.groups.some((g) => groups.includes(g))).map(
    (e) => e.factory(ctx),
  );
}

const UNUSED_CONTEXT: ToolContext = {
  client: () => {
    throw new Error("not used");
  },
  scrub: (text) => text,
};

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
