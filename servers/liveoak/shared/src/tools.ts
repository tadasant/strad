import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ApiError } from "./apiture.js";
import { LoginError } from "./cognito.js";
import { ConfigError } from "./config.js";
import { SealError } from "./crypto.js";
import { GcsError } from "./gcs.js";
import { redact } from "./logging.js";
import { LiveOakError, type LiveOakService } from "./service.js";
import { InputError, MAX_RANGE_MONTHS } from "./statements.js";

/**
 * Tool groups, so a deployment can hand out a least-privileged surface.
 *
 * - `readonly` status, and reading statements
 * - `admin`    + enrolling this server as a remembered device
 *
 * There is no write group because there is nothing to write: no tool here can
 * move money or change a setting (see apiture.ts). Enrolment is `admin`
 * because it texts a code to a person's phone.
 *
 * IN STRAD, THESE GROUPS ARE NOT THE ENFORCEMENT: the bundle runs every server
 * at full capability and the gateway's per-slug `tools:` policy decides what a
 * slug may call. They exist for running this server outside strad.
 */
export type ToolGroup = "readonly" | "admin";

const ALL_GROUPS: ToolGroup[] = ["readonly", "admin"];

/** FAILS CLOSED: set and naming no group means `readonly`, not everything. */
export function parseToolGroups(raw?: string): ToolGroup[] {
  if (!raw) return ALL_GROUPS;
  const valid = raw
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter((g): g is ToolGroup => ALL_GROUPS.includes(g as ToolGroup));
  return valid.length > 0 ? valid : ["readonly"];
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: Record<string, boolean>;
  handler: (args: unknown) => Promise<ToolResult>;
}

/** The service, built on first use; throws a ConfigError naming what is missing. */
export type ServiceFactory = () => Promise<LiveOakService>;

/** The result as JSON in `structuredContent` AND as the first text item. */
function ok(payload: object): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

/**
 * The one error path. Every message is redacted — shapes AND the configured
 * password's literal value — because much of it was written by Cognito,
 * Apiture or GCS, and none of it may carry a credential back to a model.
 */
async function guard(fn: () => Promise<object>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const known =
      err instanceof ConfigError ||
      err instanceof InputError ||
      err instanceof LiveOakError ||
      err instanceof LoginError ||
      err instanceof ApiError ||
      err instanceof GcsError ||
      err instanceof SealError;
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: redact(known ? message : `Unexpected error: ${message}`) }],
      isError: true,
    };
  }
}

function args(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new InputError("Arguments must be an object.");
  return raw as Record<string, unknown>;
}

function optionalString(input: Record<string, unknown>, name: string): string | undefined {
  const v = input[name];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new InputError(`\`${name}\` must be a string.`);
  return v.trim();
}

function requiredString(input: Record<string, unknown>, name: string): string {
  const v = optionalString(input, name);
  if (v === undefined) throw new InputError(`\`${name}\` is required.`);
  return v;
}

function rejectUnknown(input: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new InputError(
      `Unknown argument${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}. This tool takes ${
        allowed.length ? allowed.join(", ") : "no arguments"
      }.`,
    );
  }
}

const READ_ONLY = "Read-only: nothing here can move money or change a setting.";

function getStatusTool(service: ServiceFactory): ToolDefinition {
  return {
    name: "get_status",
    description:
      "Whether this LiveOak server is configured, whether a remembered device is " +
      "enrolled (without one, list_statements and get_statement refuse), and " +
      "whether an enrolment is waiting for its code. Does not log in to LiveOak. " +
      "It does read the device storage, so device_store_error reports GCS " +
      "settings that cannot work, before enrol_device is tried.\n\n" +
      'Example: {"configured":true,"device_enrolled":true,"enrolled_at":"2026-10-09T17:00:00.000Z",' +
      '"enrolment_pending":false,"download_links":true}',
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (raw) =>
      guard(async () => {
        rejectUnknown(args(raw), []);
        return (await service()).status();
      }),
  };
}

function listStatementsTool(service: ServiceFactory): ToolDefinition {
  return {
    name: "list_statements",
    description:
      "List the LiveOak Bank account statements whose end date falls in a date " +
      "range, newest first, across every account the login can see. Logs in as " +
      "the enrolled device (no code is sent). Use get_statement with a " +
      "statement_id to fetch one.\n\n" +
      "Default range: the first of the month a year ago through today. For " +
      '"last month\'s statement", pass that month\'s first and last day.\n\n' +
      "`statement_id` and `end_on` are always present. The other fields are " +
      "included when LiveOak returns them. `account` is masked to its last four " +
      `digits. ${READ_ONLY}\n\n` +
      'Example: {"from":"2026-09-01","to":"2026-09-30","count":1,"statements":' +
      '[{"statement_id":"d8f3a1","end_on":"2026-09-30","start_on":"2026-09-01",' +
      '"name":"Business Savings Statement","account":"*1234"}]}',
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: 'First day of the range, YYYY-MM-DD, e.g. "2026-09-01". Inclusive.',
        },
        to: {
          type: "string",
          description: `Last day of the range, YYYY-MM-DD, e.g. "2026-09-30". Inclusive. Default today. At most ${MAX_RANGE_MONTHS} months after \`from\`.`,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        rejectUnknown(input, ["from", "to"]);
        return (await service()).listStatements(optionalString(input, "from"), optionalString(input, "to"));
      }),
  };
}

function getStatementTool(service: ServiceFactory): ToolDefinition {
  return {
    name: "get_statement",
    description:
      "Fetch one statement's PDF from LiveOak and return a download link for it, " +
      "with its size and SHA-256. The link is single-use and expires in 15 " +
      "minutes. It needs no credential, so pass it straight to whatever attaches " +
      "or stores the file, and do not paste it anywhere public. The PDF itself " +
      "is not returned inline.\n\n" +
      "Without a link (download_unavailable says why), the statement is still " +
      `fetched and checksummed. ${READ_ONLY}\n\n` +
      'Example: {"statement_id":"d8f3a1","end_on":"2026-09-30","filename":' +
      '"liveoak-statement-2026-09-30-1234.pdf","content_type":"application/pdf",' +
      '"size_bytes":184213,"sha256":"9f2c…","download_url":"https://strad.example.com/mcp-download/liveoak/…",' +
      '"expires_at":"2026-10-09T17:15:00.000Z"}',
    inputSchema: {
      type: "object",
      properties: {
        statement_id: {
          type: "string",
          description: "The statement_id from list_statements.",
        },
      },
      required: ["statement_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        rejectUnknown(input, ["statement_id"]);
        return (await service()).getStatement(requiredString(input, "statement_id"));
      }),
  };
}

function enrolDeviceTool(service: ServiceFactory): ToolDefinition {
  return {
    name: "enrol_device",
    description:
      "Step 1 of 2 in making this server a remembered device on the LiveOak " +
      "account, so later logins skip the MFA code. It logs in with the stored " +
      "credentials, and LiveOak texts a code to the account holder's phone. Ask " +
      "them for it, then call confirm_device within about 3 minutes.\n\n" +
      "It checks that the device storage takes a write BEFORE logging in, and " +
      "sends no code if it does not. If confirm_device could not store a device " +
      "LiveOak confirmed (status says device_unsaved), call this without force " +
      "to store it; no code is sent.\n\n" +
      "Run it once, when status says device_enrolled is false. If the enrolled " +
      'device still works it answers "already_enrolled" and sends nothing. ' +
      "force: true discards the stored device first. Each call that sends a " +
      "code invalidates the previous one. The password is never returned.\n\n" +
      'Example: {"status":"code_sent","delivery_medium":"SMS","destination":"+*******1234",' +
      '"expires_in_seconds":180,"message":"LiveOak sent a code to +*******1234 by SMS. …"}\n' +
      'Example: {"status":"already_enrolled","enrolled_at":"2026-10-09T17:00:00.000Z","message":"…"}',
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Discard the stored device and enrol from scratch. Default false.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        rejectUnknown(input, ["force"]);
        if (input.force !== undefined && typeof input.force !== "boolean") {
          throw new InputError("`force` must be true or false.");
        }
        return (await service()).enrol(input.force === true);
      }),
  };
}

function confirmDeviceTool(service: ServiceFactory): ToolDefinition {
  return {
    name: "confirm_device",
    description:
      "Step 2 of 2: answer the MFA code from enrol_device. On success this " +
      "server is a remembered device and its keys are sealed into storage. " +
      "From then on list_statements and get_statement need no code. A wrong " +
      "code can be retried against the same challenge. An expired one needs a " +
      "new enrol_device.\n\n" +
      'Example: {"status":"enrolled","enrolled_at":"2026-10-09T17:02:11.000Z","message":"…"}',
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: 'The numeric code LiveOak sent, e.g. "123456".',
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        rejectUnknown(input, ["code"]);
        return (await service()).confirm(requiredString(input, "code").replace(/\s+/g, ""));
      }),
  };
}

interface Entry {
  factory: (service: ServiceFactory) => ToolDefinition;
  groups: ToolGroup[];
}

const ENTRIES: Entry[] = [
  { factory: getStatusTool, groups: ["readonly", "admin"] },
  { factory: listStatementsTool, groups: ["readonly", "admin"] },
  { factory: getStatementTool, groups: ["readonly", "admin"] },
  { factory: enrolDeviceTool, groups: ["admin"] },
  { factory: confirmDeviceTool, groups: ["admin"] },
];

export function toolDefinitions(service: ServiceFactory, groups: ToolGroup[] = ALL_GROUPS): ToolDefinition[] {
  return ENTRIES.filter((e) => e.groups.some((g) => groups.includes(g))).map((e) => e.factory(service));
}

export function toolNames(groups: ToolGroup[] = ALL_GROUPS): string[] {
  return toolDefinitions(async () => {
    throw new Error("not used");
  }, groups).map((t) => t.name);
}

export function registerTools(server: Server, service: ServiceFactory, groups: ToolGroup[] = ALL_GROUPS): void {
  const tools = toolDefinitions(service, groups);

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
        `Unknown tool: ${request.params.name}. This server offers: ${tools.map((t) => t.name).join(", ")}.`,
      );
    }
    return tool.handler(request.params.arguments);
  });
}
