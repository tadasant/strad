import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { scrubSecret } from "./logging.js";
import { uploadAttachmentTool } from "./tools/attachments.js";
import { createCommentTool, listCommentsTool } from "./tools/comments.js";
import {
  createRecordTool,
  deleteRecordsTool,
  getRecordTool,
  listRecordsTool,
  searchRecordsTool,
  updateRecordsTool,
} from "./tools/records.js";
import {
  createFieldTool,
  createTableTool,
  describeTableTool,
  listBasesTool,
  listTablesTool,
  updateFieldTool,
  updateTableTool,
} from "./tools/schema.js";
import type { ClientFactory, ToolDefinition } from "./tools/shared.js";

/**
 * SIXTEEN TOOLS, named and argued exactly as `airtable-mcp-server@1.13.0`
 * named them, so a prompt written against the npx package works unchanged.
 *
 * TWO GROUPS. `readonly` is the seven reads; `readwrite` is all sixteen. In
 * strad these groups are not the enforcement — the gateway's per-slug `tools:`
 * policy is — but a read-only slug's allow list would be `toolNames(["readonly"])`,
 * so that set must be exactly the reads. The token is a second fence: a PAT
 * minted without the `:write` scopes cannot write whatever this server lists.
 */
export type ToolGroup = "readonly" | "readwrite";

const ALL_GROUPS: ToolGroup[] = ["readonly", "readwrite"];

/**
 * FAILS CLOSED. Unset means the full surface (the bundle's posture, where the
 * gateway decides capability); set-but-unrecognised means someone tried to
 * restrict this server and mistyped it, and the answer to that is the reads.
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
  factory: (client: ClientFactory) => ToolDefinition;
  groups: ToolGroup[];
}

const BOTH: ToolGroup[] = ["readonly", "readwrite"];
const WRITE: ToolGroup[] = ["readwrite"];

const ENTRIES: Entry[] = [
  { factory: listRecordsTool, groups: BOTH },
  { factory: searchRecordsTool, groups: BOTH },
  { factory: listBasesTool, groups: BOTH },
  { factory: listTablesTool, groups: BOTH },
  { factory: describeTableTool, groups: BOTH },
  { factory: getRecordTool, groups: BOTH },
  { factory: createRecordTool, groups: WRITE },
  { factory: updateRecordsTool, groups: WRITE },
  { factory: deleteRecordsTool, groups: WRITE },
  { factory: createTableTool, groups: WRITE },
  { factory: updateTableTool, groups: WRITE },
  { factory: createFieldTool, groups: WRITE },
  { factory: updateFieldTool, groups: WRITE },
  { factory: createCommentTool, groups: WRITE },
  { factory: listCommentsTool, groups: BOTH },
  { factory: uploadAttachmentTool, groups: WRITE },
];

export function toolDefinitions(
  client: ClientFactory,
  groups: ToolGroup[] = ALL_GROUPS,
): ToolDefinition[] {
  return ENTRIES.filter((e) => e.groups.some((g) => groups.includes(g))).map(
    (e) => e.factory(client),
  );
}

/** The names a deployment of `groups` serves — what a slug's allow list names. */
export function toolNames(groups: ToolGroup[] = ALL_GROUPS): string[] {
  return toolDefinitions(async () => {
    throw new Error("not used");
  }, groups).map((t) => t.name);
}

export function registerTools(
  server: Server,
  client: ClientFactory,
  groups: ToolGroup[],
  /** The token as it stands at call time, scrubbed from every result. */
  secret: () => string | undefined,
): void {
  const tools = toolDefinitions(client, groups);

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
    const result = await tool.handler(request.params.arguments);
    // The LAST line of defence, over successes as well as failures: a record
    // whose cell holds the token (pasted there by a human) is still the token.
    const token = secret();
    return {
      ...result,
      content: result.content.map((c) => ({
        ...c,
        text: scrubSecret(c.text, token),
      })),
    };
  });
}
