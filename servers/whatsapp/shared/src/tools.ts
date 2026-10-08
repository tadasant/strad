import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getAttachmentTool } from "./tools/get-attachment.js";
import { getMessagesTool } from "./tools/get-messages.js";
import { listChatsTool } from "./tools/list-chats.js";
import { logoutTool } from "./tools/logout.js";
import { pairTool } from "./tools/pair.js";
import { sendMessageTool } from "./tools/send-message.js";
import type { BridgeFactory, ToolDefinition } from "./tools/shared.js";
import { statusTool } from "./tools/status.js";

/**
 * Tool groups, so a deployment can hand out a least-privileged surface.
 *
 * - `readonly`  is it healthy, which chats, what was said, what was attached
 * - `readwrite` + posting as the account
 * - `admin`     + pairing and unlinking the account
 *
 * IN STRAD, THESE GROUPS ARE NOT THE ENFORCEMENT: the bundle runs every server
 * at full capability and the gateway's per-slug `tools:` policy decides what a
 * slug may call. They exist for running this server outside strad, and so the
 * policy's allow-lists can be derived from something.
 */
export type ToolGroup = "readonly" | "readwrite" | "admin";

const ALL_GROUPS: ToolGroup[] = ["readonly", "readwrite", "admin"];

/**
 * FAILS CLOSED: unset means everything (the bundle's posture), but a value that
 * is set and names no group means someone tried to restrict this server and
 * mistyped it — so it gets `readonly`, not everything.
 */
export function parseToolGroups(raw?: string): ToolGroup[] {
  if (!raw) return ALL_GROUPS;
  const valid = raw
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter((g): g is ToolGroup => ALL_GROUPS.includes(g as ToolGroup));
  return valid.length > 0 ? valid : ["readonly"];
}

interface Entry {
  factory: (bridge: BridgeFactory) => ToolDefinition;
  groups: ToolGroup[];
}

const ENTRIES: Entry[] = [
  { factory: statusTool, groups: ["readonly", "readwrite", "admin"] },
  { factory: listChatsTool, groups: ["readonly", "readwrite", "admin"] },
  { factory: getMessagesTool, groups: ["readonly", "readwrite", "admin"] },
  { factory: getAttachmentTool, groups: ["readonly", "readwrite", "admin"] },
  { factory: sendMessageTool, groups: ["readwrite", "admin"] },
  { factory: pairTool, groups: ["admin"] },
  { factory: logoutTool, groups: ["admin"] },
];

export function toolDefinitions(
  bridge: BridgeFactory,
  groups: ToolGroup[] = ALL_GROUPS,
): ToolDefinition[] {
  return ENTRIES.filter((e) => e.groups.some((g) => groups.includes(g))).map((e) =>
    e.factory(bridge),
  );
}

export function toolNames(groups: ToolGroup[] = ALL_GROUPS): string[] {
  return toolDefinitions(async () => {
    throw new Error("not used");
  }, groups).map((t) => t.name);
}

export function registerTools(
  server: Server,
  bridge: BridgeFactory,
  groups: ToolGroup[] = ALL_GROUPS,
): void {
  const tools = toolDefinitions(bridge, groups);

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
