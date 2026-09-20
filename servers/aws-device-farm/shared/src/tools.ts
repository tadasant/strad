import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { getAccountStatusTool } from "./tools/account.js";
import { listDevicePoolsTool, listDevicesTool } from "./tools/devices.js";
import {
  readScreenTool,
  runMobileCommandTool,
  swipeScreenTool,
  takeScreenshotTool,
  tapScreenTool,
  typeTextTool,
} from "./tools/driving.js";
import {
  getRunTool,
  listRunArtifactsTool,
  scheduleRunTool,
  stopRunTool,
} from "./tools/runs.js";
import {
  installAppTool,
  listDeviceSessionsTool,
  startDeviceSessionTool,
  stopDeviceSessionTool,
} from "./tools/sessions.js";
import { listUploadsTool, uploadAppTool } from "./tools/uploads.js";
import type { DepsFactory, ToolDefinition } from "./tools/shared.js";

/**
 * NINETEEN TOOLS IN THREE GROUPS, AND THE GROUPS ARE ABOUT MONEY.
 *
 * Every other server in this repo splits its surface on what a credential can
 * DAMAGE. Here the dangerous thing is spend: an access key scoped to Device
 * Farm cannot break anything in the AWS account, and a remote-access session
 * bills $0.17 a minute for as long as something keeps it alive — five minutes
 * of silence ends it, 150 minutes is the cap, and an agent polling it in a
 * loop is what reaches the cap. So:
 *
 *   readonly     costs nothing and changes nothing. Lists, statuses, artifacts.
 *   automation   uploads a build and schedules an unattended run. Spends.
 *   interactive  holds a physical phone and drives it. Spends continuously.
 *
 * THE TWO `stop_` TOOLS ARE IN EVERY GROUP, INCLUDING `readonly`. Stopping can
 * only ever reduce a bill, and a slug that can SEE a runaway session and cannot
 * end it is the worst arrangement available here. It is the one deliberate
 * exception to "readonly means no writes".
 *
 * IN STRAD, THESE GROUPS ARE NOT THE ENFORCEMENT. The bundle runs every server
 * at full capability and the gateway's per-slug `tools:` policy decides what a
 * slug may call. The groups exist because this server also runs outside strad,
 * and because a withheld-by-policy tool and an unbuilt tool should be the same
 * set — the tests assert against these, and the config's allow-lists are
 * derived from them.
 */
export type ToolGroup = "readonly" | "automation" | "interactive";

const ALL_GROUPS: ToolGroup[] = ["readonly", "automation", "interactive"];

/**
 * FAILS CLOSED. An unset variable means the full surface — that is the bundle's
 * posture, where the gateway decides capability — but a variable that is SET
 * and unrecognised means somebody tried to restrict this server and mistyped
 * it. Falling back to `readonly` costs that deployment some tools; falling back
 * to everything costs it the guarantee, and here that guarantee is a bill.
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
  factory: (deps: DepsFactory) => ToolDefinition;
  groups: ToolGroup[];
}

const ENTRIES: Entry[] = [
  // readonly — no device minutes, no state change.
  { factory: getAccountStatusTool, groups: ["readonly", "automation", "interactive"] },
  { factory: listDevicesTool, groups: ["readonly", "automation", "interactive"] },
  { factory: listDevicePoolsTool, groups: ["readonly", "automation"] },
  { factory: listUploadsTool, groups: ["readonly", "automation", "interactive"] },
  { factory: getRunTool, groups: ["readonly", "automation"] },
  { factory: listRunArtifactsTool, groups: ["readonly", "automation"] },
  { factory: listDeviceSessionsTool, groups: ["readonly", "automation", "interactive"] },
  // The two brakes, reachable from every group on purpose.
  { factory: stopRunTool, groups: ["readonly", "automation", "interactive"] },
  { factory: stopDeviceSessionTool, groups: ["readonly", "automation", "interactive"] },
  // automation — spends device minutes without holding a phone.
  { factory: uploadAppTool, groups: ["automation", "interactive"] },
  { factory: scheduleRunTool, groups: ["automation"] },
  // interactive — holds a phone and drives it.
  { factory: startDeviceSessionTool, groups: ["interactive"] },
  { factory: installAppTool, groups: ["interactive"] },
  { factory: readScreenTool, groups: ["interactive"] },
  { factory: takeScreenshotTool, groups: ["interactive"] },
  { factory: tapScreenTool, groups: ["interactive"] },
  { factory: typeTextTool, groups: ["interactive"] },
  { factory: swipeScreenTool, groups: ["interactive"] },
  { factory: runMobileCommandTool, groups: ["interactive"] },
];

export function toolDefinitions(
  deps: DepsFactory,
  groups: ToolGroup[] = ALL_GROUPS,
): ToolDefinition[] {
  return ENTRIES.filter((e) => e.groups.some((g) => groups.includes(g))).map((e) =>
    e.factory(deps),
  );
}

/** The names a deployment serves for a set of groups — what an allow-list is derived from. */
export function toolNames(groups: ToolGroup[] = ALL_GROUPS): string[] {
  return toolDefinitions(async () => {
    throw new Error("not used");
  }, groups).map((t) => t.name);
}

export function registerTools(
  server: Server,
  deps: DepsFactory,
  groups: ToolGroup[] = ALL_GROUPS,
): void {
  const tools = toolDefinitions(deps, groups);

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
