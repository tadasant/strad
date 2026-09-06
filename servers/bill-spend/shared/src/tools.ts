import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getTransactionCodingTool } from "./tools/get-transaction-coding.js";
import { listCodingFieldsTool } from "./tools/list-coding-fields.js";
import { listCodingOptionsTool } from "./tools/list-coding-options.js";
import { listTransactionsTool } from "./tools/list-transactions.js";
import { setTransactionCodingTool } from "./tools/set-transaction-coding.js";
import type { GatewayFactory, ToolDefinition } from "./tools/shared.js";

/**
 * FIVE TOOLS, AND THE SHORTNESS IS THE SECURITY MODEL.
 *
 * A BILL Spend & Expense apiToken is unscoped ADMIN on the whole company. The
 * same secret that re-codes a transaction can issue a virtual card, freeze one,
 * create and move budgets, and manage users — BILL offers no read-only token and
 * no way to narrow one. So the tool surface is the only boundary that exists
 * between an agent and a new virtual card, and everything the API can do that
 * this server does not implement is unreachable through it. That is why this is
 * a first-party server rather than an adopted community one: the two that exist
 * expose `create_virtual_card` and `freeze_card`.
 *
 * Nothing here issues, freezes, or reorders a card. Nothing creates or moves a
 * budget. Nothing touches users, reimbursements or bank accounts. Adding any of
 * those is a decision about that boundary, not a feature.
 *
 * TWO GROUPS, and the split is the one that matters: four tools read, one
 * writes. `bill-spend-ro` is the tier to hand out — a sweep can be planned,
 * costed and reviewed on it, and cannot change a ledger.
 *
 * IN STRAD, THESE GROUPS ARE NOT THE ENFORCEMENT. The bundle runs every server
 * at full capability and the gateway's per-slug `tools:` policy decides what a
 * slug may call. The groups exist because this server also runs outside strad,
 * and because a withheld-by-policy tool and an unbuilt tool should be the same
 * set — the tests assert against these, and the staging allow-list is derived
 * from them.
 */
export type ToolGroup = "readonly" | "readwrite";

const ALL_GROUPS: ToolGroup[] = ["readonly", "readwrite"];

/**
 * FAILS CLOSED. An unset variable means the full surface — that is the bundle's
 * posture, where the gateway decides capability — but a variable that is SET and
 * unrecognised means someone tried to restrict this server and mistyped it, and
 * the write tool here edits a financial record. Falling back to `readonly` costs
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
  { factory: listCodingFieldsTool, groups: ["readonly", "readwrite"] },
  { factory: listCodingOptionsTool, groups: ["readonly", "readwrite"] },
  { factory: listTransactionsTool, groups: ["readonly", "readwrite"] },
  { factory: getTransactionCodingTool, groups: ["readonly", "readwrite"] },
  { factory: setTransactionCodingTool, groups: ["readwrite"] },
];

export function toolDefinitions(
  gateway: GatewayFactory,
  groups: ToolGroup[] = ALL_GROUPS,
): ToolDefinition[] {
  return ENTRIES.filter((e) => e.groups.some((g) => groups.includes(g))).map(
    (e) => e.factory(gateway),
  );
}

/** The names a `readonly` deployment serves — what `bill-spend-ro` allows. */
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
