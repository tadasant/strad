import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { uploadFileTool } from "./tools/upload-file.js";
import { refreshLinkTool } from "./tools/refresh-link.js";
import { setSensitivityTool } from "./tools/set-sensitivity.js";
import { listFilesTool } from "./tools/list-files.js";
import { downloadFileTool } from "./tools/download-file.js";
import { deleteFileTool } from "./tools/delete-file.js";
import type { StoreFactory, ToolDefinition } from "./tools/shared.js";

/**
 * Tool groups, so a deployment can hand out a least-privileged surface.
 *
 * - `readonly`  browse, read, and mint a link for something that already exists
 * - `readwrite` everything above, plus storing, re-classifying and deleting
 *
 * `refresh_link` is readonly even though it mints a credential-bearing URL: it
 * changes nothing about the object, and withholding it from a read-only role
 * would leave that role able to LIST artifacts it can never open.
 */
export type ToolGroup = "readonly" | "readwrite";

const ALL_GROUPS: ToolGroup[] = ["readonly", "readwrite"];

export function parseToolGroups(raw?: string): ToolGroup[] {
  if (!raw) return ALL_GROUPS;
  const requested = raw.split(",").map((g) => g.trim().toLowerCase());
  const valid = requested.filter((g): g is ToolGroup =>
    ALL_GROUPS.includes(g as ToolGroup),
  );
  return valid.length > 0 ? valid : ALL_GROUPS;
}

interface Entry {
  factory: (storeFactory: StoreFactory) => ToolDefinition;
  groups: ToolGroup[];
}

const ENTRIES: Entry[] = [
  { factory: uploadFileTool, groups: ["readwrite"] },
  { factory: refreshLinkTool, groups: ["readonly", "readwrite"] },
  { factory: listFilesTool, groups: ["readonly", "readwrite"] },
  { factory: downloadFileTool, groups: ["readonly", "readwrite"] },
  { factory: setSensitivityTool, groups: ["readwrite"] },
  { factory: deleteFileTool, groups: ["readwrite"] },
];

export function toolDefinitions(
  storeFactory: StoreFactory,
  groups: ToolGroup[] = ALL_GROUPS,
): ToolDefinition[] {
  return ENTRIES.filter((e) => e.groups.some((g) => groups.includes(g))).map(
    (e) => e.factory(storeFactory),
  );
}

export function registerTools(
  server: Server,
  storeFactory: StoreFactory,
  groups: ToolGroup[] = ALL_GROUPS,
): void {
  const tools = toolDefinitions(storeFactory, groups);

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
