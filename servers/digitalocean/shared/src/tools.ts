import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  accountGetInformationTool,
  balanceGetTool,
  billingHistoryListTool,
  imageListTool,
  keyListTool,
  regionListTool,
  sizeListTool,
} from "./tools/account.js";
import {
  appsCreateAppFromSpecTool,
  appsCreateDeploymentTool,
  appsDeleteTool,
  appsGetDeploymentStatusTool,
  appsGetInfoTool,
  appsGetLogsTool,
  appsListTool,
  appsUpdateTool,
} from "./tools/apps.js";
import {
  dbClusterCreateTool,
  dbClusterDeleteTool,
  dbClusterGetFirewallRulesTool,
  dbClusterGetTool,
  dbClusterListBackupsTool,
  dbClusterListTool,
  dbClusterListUsersTool,
  dbClusterResizeTool,
} from "./tools/databases.js";
import {
  dropletActionGetTool,
  dropletActionTool,
  dropletCreateTool,
  dropletDeleteTool,
  dropletGetTool,
  dropletListTool,
} from "./tools/droplets.js";
import type { ClientFactory, ToolDefinition } from "./tools/shared.js";

/**
 * DROPLETS, APPS, DATABASES AND THE ACCOUNT — and deliberately not the rest.
 *
 * `@digitalocean/mcp` exposes about two hundred tools across eighteen services.
 * This server covers the four an operator of a small personal account actually
 * reaches for, under upstream's own hyphenated names so a prompt written
 * against one works on the other. Kubernetes, the registry, networking,
 * Spaces, Functions and the GenAI services are absent on purpose; the README
 * lists them and the hosted alternatives.
 *
 * TWO GROUPS, AND THE SPLIT IS DERIVED FROM THE ANNOTATIONS. A tool is in
 * `readonly` exactly when it declares `readOnlyHint: true`, so the group a slug
 * is allowed and the hint a client shows cannot disagree. `readwrite` is
 * everything.
 *
 * IN STRAD, THESE GROUPS ARE NOT THE ENFORCEMENT. The bundle runs every server
 * at full capability and the gateway's per-slug `tools:` policy decides what a
 * slug may call; `digitalocean-tadasant-ro`'s allow list is
 * `toolNames(["readonly"])`. That policy is the ONLY fence for `-ro`: both
 * slugs run in one container on one token, which holds the write scopes `-rw`
 * needs. A narrower token is a second fence only where `-ro` gets its own.
 */
export type ToolGroup = "readonly" | "readwrite";

const ALL_GROUPS: ToolGroup[] = ["readonly", "readwrite"];

/**
 * FAILS CLOSED. Unset means the full surface — the bundle's posture, where the
 * gateway decides capability. Set and unrecognised means someone tried to
 * restrict this server and mistyped it, and the write tools here delete
 * databases; falling back to `readonly` costs that deployment a tool, falling
 * back to everything costs it the guarantee.
 */
export function parseToolGroups(raw?: string): ToolGroup[] {
  if (!raw) return ALL_GROUPS;
  const requested = raw.split(",").map((g) => g.trim().toLowerCase());
  const valid = requested.filter((g): g is ToolGroup =>
    ALL_GROUPS.includes(g as ToolGroup),
  );
  return valid.length > 0 ? valid : ["readonly"];
}

const FACTORIES: Array<(factory: ClientFactory) => ToolDefinition> = [
  accountGetInformationTool,
  balanceGetTool,
  billingHistoryListTool,
  regionListTool,
  sizeListTool,
  imageListTool,
  keyListTool,
  dropletListTool,
  dropletGetTool,
  dropletActionGetTool,
  dropletCreateTool,
  dropletActionTool,
  dropletDeleteTool,
  appsListTool,
  appsGetInfoTool,
  appsGetDeploymentStatusTool,
  appsGetLogsTool,
  appsCreateAppFromSpecTool,
  appsUpdateTool,
  appsCreateDeploymentTool,
  appsDeleteTool,
  dbClusterListTool,
  dbClusterGetTool,
  dbClusterListBackupsTool,
  dbClusterGetFirewallRulesTool,
  dbClusterListUsersTool,
  dbClusterCreateTool,
  dbClusterResizeTool,
  dbClusterDeleteTool,
];

function groupsOf(tool: ToolDefinition): ToolGroup[] {
  return tool.annotations.readOnlyHint
    ? ["readonly", "readwrite"]
    : ["readwrite"];
}

export function toolDefinitions(
  factory: ClientFactory,
  groups: ToolGroup[] = ALL_GROUPS,
): ToolDefinition[] {
  return FACTORIES.map((f) => f(factory)).filter((t) =>
    groupsOf(t).some((g) => groups.includes(g)),
  );
}

/** The names a deployment of `groups` serves — what a slug's allow list is built from. */
export function toolNames(groups: ToolGroup[] = ALL_GROUPS): string[] {
  return toolDefinitions(() => {
    throw new Error("not used");
  }, groups).map((t) => t.name);
}

export function registerTools(
  server: Server,
  factory: ClientFactory,
  groups: ToolGroup[] = ALL_GROUPS,
): void {
  const tools = toolDefinitions(factory, groups);

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
