import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createSshKeyTool,
  deleteImageTool,
  deleteSshKeyTool,
  listDatacentersTool,
  listImagesTool,
  listLocationsTool,
  listServerTypesTool,
  listSshKeysTool,
} from "./tools/catalog.js";
import {
  applyFirewallTool,
  attachVolumeTool,
  detachVolumeTool,
  listFirewallsTool,
  listNetworksTool,
  listPrimaryIpsTool,
  listVolumesTool,
  removeFirewallTool,
  setFirewallRulesTool,
} from "./tools/networking.js";
import {
  changeServerTypeTool,
  createServerImageTool,
  createServerTool,
  deleteServerTool,
  getActionTool,
  getServerMetricsTool,
  getServerTool,
  listServerActionsTool,
  listServersTool,
  powerServerTool,
  rebuildServerTool,
} from "./tools/servers.js";
import type { ClientFactory, ToolDefinition } from "./tools/shared.js";

/**
 * WHAT OPERATING A BOX NEEDS — and deliberately not the rest.
 *
 * Hetzner publishes no MCP server of its own, so this is strad's, over the
 * Cloud API. It covers servers (power, rebuild, resize, snapshot, metrics,
 * actions), what they are made of (images, types, locations, datacenters, SSH
 * keys) and what surrounds them (firewalls, networks, primary IPs, volumes).
 * Load balancers, floating IPs, placement groups, certificates, DNS, Storage
 * Boxes and the Robot (dedicated server) API are absent; the README lists them.
 *
 * ABSENT ON PURPOSE, because each hands a credential to the caller or removes
 * a human's fence: `reset_password` and `enable_rescue` (a root password),
 * `request_console` (a VNC URL and password), and every `change_protection`
 * (the switch a human sets so a box cannot be deleted or rebuilt by mistake).
 *
 * TWO GROUPS, AND THE SPLIT IS DERIVED FROM THE ANNOTATIONS. A tool is in
 * `readonly` exactly when it declares `readOnlyHint: true`, so the group a slug
 * is allowed and the hint a client shows cannot disagree. `readwrite` is
 * everything.
 *
 * IN STRAD, THESE GROUPS ARE NOT THE ENFORCEMENT. The bundle runs every server
 * at full capability and the gateway's per-slug `tools:` policy decides what a
 * slug may call; `hetzner-pulse-ro`'s allow list is `toolNames(["readonly"])`.
 * That policy is the ONLY fence for `-ro`: both slugs run in one container on
 * one token, which is Read & Write because `-rw` needs it to be.
 */
export type ToolGroup = "readonly" | "readwrite";

const ALL_GROUPS: ToolGroup[] = ["readonly", "readwrite"];

/**
 * FAILS CLOSED. Unset means the full surface — the bundle's posture, where the
 * gateway decides capability. Set and unrecognised means someone tried to
 * restrict this server and mistyped it, and the write tools here power off and
 * wipe machines; falling back to `readonly` costs that deployment a tool,
 * falling back to everything costs it the guarantee.
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
  listServersTool,
  getServerTool,
  getServerMetricsTool,
  listServerActionsTool,
  getActionTool,
  listImagesTool,
  listServerTypesTool,
  listLocationsTool,
  listDatacentersTool,
  listSshKeysTool,
  listFirewallsTool,
  listNetworksTool,
  listPrimaryIpsTool,
  listVolumesTool,
  createServerTool,
  powerServerTool,
  rebuildServerTool,
  changeServerTypeTool,
  createServerImageTool,
  deleteServerTool,
  deleteImageTool,
  createSshKeyTool,
  deleteSshKeyTool,
  setFirewallRulesTool,
  applyFirewallTool,
  removeFirewallTool,
  attachVolumeTool,
  detachVolumeTool,
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
