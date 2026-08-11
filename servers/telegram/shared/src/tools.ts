import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getMeTool } from "./tools/get-me.js";
import { listChatsTool } from "./tools/list-chats.js";
import { getChatTool } from "./tools/get-chat.js";
import { getChatHistoryTool } from "./tools/get-chat-history.js";
import { searchMessagesTool } from "./tools/search-messages.js";
import { sendMessageTool } from "./tools/send-message.js";
import type { GatewayFactory, ToolDefinition } from "./tools/shared.js";

/**
 * Tool groups, so a deployment can hand out a least-privileged surface.
 *
 * - `readonly`  who am I, which chats, what was said
 * - `readwrite` everything above, plus posting as the account
 *
 * IN STRAD, THESE GROUPS ARE NOT THE ENFORCEMENT. The bundle runs every server
 * at full capability and the gateway's per-slug `tools:` policy decides what a
 * slug may call (`telegram-ro` withholds send_message; `telegram-rw` does not).
 * The groups exist because this server also runs outside strad, and because a
 * withheld-by-policy tool and an unbuilt tool should be the same set — the tests
 * assert against these, and the staging allow-list is derived from them.
 */
export type ToolGroup = "readonly" | "readwrite";

const ALL_GROUPS: ToolGroup[] = ["readonly", "readwrite"];

/**
 * FAILS CLOSED. An unset variable means the full surface — that is the bundle's
 * posture, where the gateway decides capability — but a variable that is SET and
 * unrecognised means someone tried to restrict this server and mistyped it, and
 * the write tool here posts as a named human. Falling back to `readonly` costs
 * that deployment a tool; falling back to everything costs it the guarantee.
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
  factory: (gateway: GatewayFactory) => ToolDefinition;
  groups: ToolGroup[];
}

const ENTRIES: Entry[] = [
  { factory: getMeTool, groups: ["readonly", "readwrite"] },
  { factory: listChatsTool, groups: ["readonly", "readwrite"] },
  { factory: getChatTool, groups: ["readonly", "readwrite"] },
  { factory: getChatHistoryTool, groups: ["readonly", "readwrite"] },
  { factory: searchMessagesTool, groups: ["readonly", "readwrite"] },
  { factory: sendMessageTool, groups: ["readwrite"] },
];

export function toolDefinitions(
  gateway: GatewayFactory,
  groups: ToolGroup[] = ALL_GROUPS,
): ToolDefinition[] {
  return ENTRIES.filter((e) => e.groups.some((g) => groups.includes(g))).map(
    (e) => e.factory(gateway),
  );
}

/** The names a `readonly` deployment serves — what `telegram-ro` allows. */
export function toolNames(groups: ToolGroup[] = ALL_GROUPS): string[] {
  return toolDefinitions(async () => {
    throw new Error("not used");
  }, groups).map((t) => t.name);
}

export function registerTools(
  server: Server,
  gateway: GatewayFactory,
  groups: ToolGroup[] = ALL_GROUPS,
): void {
  const tools = toolDefinitions(gateway, groups);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
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
