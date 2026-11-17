/**
 * The tools, and the two groups they fall in.
 *
 * - `readonly`  is it healthy, which threads, what was said, what was attached
 * - `admin`     + log in, cancel a login, log out
 *
 * There is NO send tool, and no group that has one: this server reads.
 *
 * IN STRAD, THESE GROUPS ARE NOT THE ENFORCEMENT: the bundle runs every server
 * at full capability and the gateway's per-slug `tools:` policy decides what a
 * slug may call (`messenger-tadas` allows the four readonly names;
 * `messenger-tadas-admin` has no policy). They exist for running this server
 * outside strad, and so the policy's allow-list can be derived from something.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { SupersededError, type MessengerBridge } from "./bridge.js";
import { ConfigError } from "./config.js";
import { redact } from "./logging.js";
import { BridgeError } from "./sidecar.js";
import { GcsHttpError, SealError, TokenFetchFailed, TransientStoreError } from "./state-store.js";

export type ToolGroup = "readonly" | "admin";
const ALL_GROUPS: ToolGroup[] = ["readonly", "admin"];

/** Unset means everything; a value that names no group fails closed to readonly. */
export function parseToolGroups(raw?: string): ToolGroup[] {
  if (!raw) return ALL_GROUPS;
  const valid = raw
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter((g): g is ToolGroup => ALL_GROUPS.includes(g as ToolGroup));
  return valid.length > 0 ? valid : ["readonly"];
}

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

export interface ToolResult {
  [key: string]: unknown;
  content: Content[];
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
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export type BridgeFactory = () => Promise<MessengerBridge>;

const UNOFFICIAL =
  "This is an UNOFFICIAL Messenger client: Meta offers no API to a personal " +
  "inbox, so it runs mautrix-meta's implementation of the Messenger apps' own " +
  "protocol. Automated access is against Facebook's Terms, and Meta can " +
  "checkpoint or disable the account for it.";

const BOUNDED_IMAGE_BYTES = 5 * 1024 * 1024;

function ok(payload: object, extra: Content[] = []): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }, ...extra],
    structuredContent: payload as Record<string, unknown>,
  };
}

function fail(err: unknown): ToolResult {
  const message = redact(err instanceof Error ? err.message : String(err));
  return { content: [{ type: "text", text: message }], isError: true };
}

async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (
      err instanceof ConfigError ||
      err instanceof BridgeError ||
      err instanceof SealError ||
      err instanceof SupersededError ||
      err instanceof TransientStoreError ||
      err instanceof GcsHttpError ||
      err instanceof TokenFetchFailed
    ) {
      return fail(err);
    }
    return fail(new Error(`Unexpected failure: ${err instanceof Error ? err.message : String(err)}`));
  }
}

class ArgError extends BridgeError {}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ArgError(`\`${key}\` must be a string.`);
  return v;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const v = optionalString(args, key);
  if (v === undefined) throw new ArgError(`\`${key}\` is required.`);
  return v;
}

function boundedInt(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) {
    throw new ArgError(`\`${key}\` must be a whole number from 1 to ${max}.`);
  }
  return v;
}

function optionalCursor(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new ArgError(`\`${key}\` must be a cursor returned by an earlier call (a whole number).`);
  }
  return n;
}

/** ISO 8601 → epoch ms. */
function optionalTime(args: Record<string, unknown>, key: string): number | undefined {
  const v = optionalString(args, key);
  if (v === undefined) return undefined;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new ArgError(`\`${key}\` must be an ISO 8601 time, e.g. "2026-11-17T00:00:00Z".`);
  return ms;
}

const iso = (ms: unknown): string | undefined =>
  typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : undefined;

// ---- readonly ---------------------------------------------------------------

interface StatusPayload {
  accounts: Array<{ id: string; name: string; state: string; state_error?: string; state_message?: string }> | null;
  login_in_progress: { flow: string; step_id: string } | null;
  cursor: number;
  uptime_seconds: number;
}

function statusTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "messenger_status",
    description:
      "Is the Messenger bridge logged in and connected? Returns the account (id, name), its " +
      "connection state (`CONNECTED` is the only healthy one; `BAD_CREDENTIALS` means Meta ended " +
      "the session and a human must log in again with messenger_login_start), any login in " +
      "progress, the newest message cursor, and when state last reached durable storage.\n\n" +
      UNOFFICIAL,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: () =>
      guard(async () => {
        const b = await bridge();
        const status = await (await b.client()).request<StatusPayload>("GET", "/status");
        const accounts = status.accounts ?? [];
        return ok({
          logged_in: accounts.length > 0,
          connected: accounts.some((a) => a.state === "CONNECTED"),
          accounts,
          login_in_progress: status.login_in_progress
            ? { flow: status.login_in_progress.flow, step_id: status.login_in_progress.step_id }
            : null,
          cursor: status.cursor,
          last_saved_at: iso(b.lastSavedAt) ?? null,
          ...(accounts.length === 0
            ? { next_step: "Not logged in. A human logs in with messenger_login_start (admin slug)." }
            : {}),
        });
      }),
  };
}

function listThreadsTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "messenger_list_threads",
    description:
      "List the Messenger chats (\"threads\") the bridge knows, most recently active first: " +
      "id (pass to messenger_get_messages), name, type (`dm` or `group`), whether it is " +
      "end-to-end encrypted, the newest buffered message's time, and how many messages are " +
      "buffered. A thread appears once the bridge has seen it — at login (the most recent " +
      "chats) or when a message arrives.\n\n" +
      'Example: {"updated_after":"2026-11-16T00:00:00Z"} → the threads with a message since then.\n\n' +
      UNOFFICIAL,
    inputSchema: {
      type: "object",
      properties: {
        updated_after: {
          type: "string",
          description: "ISO 8601. Only threads whose newest buffered message is at or after this time.",
        },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 100." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (args) =>
      guard(async () => {
        const params = new URLSearchParams({ limit: String(boundedInt(args, "limit", 100, 500)) });
        const after = optionalTime(args, "updated_after");
        if (after !== undefined) params.set("updated_after_ms", String(after));
        const res = await (await (await bridge()).client()).request<{
          threads: Array<Record<string, unknown>> | null;
          has_more: boolean;
        }>("GET", `/threads?${params}`);
        const threads = (res.threads ?? []).map((t) => {
          const { last_message_at_ms, last_cursor: _drop, ...rest } = t;
          return { ...rest, last_message_at: iso(last_message_at_ms) ?? null };
        });
        return ok({ threads, has_more: res.has_more });
      }),
  };
}

function getMessagesTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "messenger_get_messages",
    description:
      "Read buffered Messenger messages, across every thread or one, oldest-first in the order " +
      "the bridge received them. For a periodic sweep: keep `next_cursor` and pass it back as " +
      "`cursor` next time to get only what is new — including an earlier message that was " +
      "edited or unsent since (it comes back with `edited_at` or `deleted: true`), and history " +
      "the bridge backfilled late, whose `timestamp` is older than the sweep. Loop while " +
      "`has_more` is true. The buffer keeps the last MESSENGER_BUFFER_MAX_AGE_DAYS days (30 by " +
      "default). `from_me` marks the account's own messages. A message with an `attachment` " +
      "can be fetched with messenger_get_attachment.\n\n" +
      'Example: {"cursor":1234,"limit":200}\n\n' +
      UNOFFICIAL,
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "One thread's id, from messenger_list_threads. Omit for every thread." },
        cursor: {
          type: "integer",
          minimum: 0,
          description: "Exclusive: `next_cursor` from the previous call. Omit or 0 for the oldest buffered message.",
        },
        since: { type: "string", description: "ISO 8601. Only messages sent at or after this time." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 100." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (args) =>
      guard(async () => {
        const params = new URLSearchParams({ limit: String(boundedInt(args, "limit", 100, 500)) });
        const thread = optionalString(args, "thread_id");
        if (thread) params.set("thread_id", thread);
        const cursor = optionalCursor(args, "cursor");
        if (cursor !== undefined) params.set("cursor", String(cursor));
        const since = optionalTime(args, "since");
        if (since !== undefined) params.set("since_ms", String(since));
        const res = await (await (await bridge()).client()).request<{
          messages: Array<Record<string, unknown>>;
          next_cursor: number;
          has_more: boolean;
        }>("GET", `/messages?${params}`);
        const messages = res.messages.map((m) => {
          const { timestamp_ms, edited_at_ms, seq: _seq, ...rest } = m;
          return {
            ...rest,
            timestamp: iso(timestamp_ms),
            ...(iso(edited_at_ms) ? { edited_at: iso(edited_at_ms) } : {}),
          };
        });
        return ok({ messages, next_cursor: res.next_cursor, has_more: res.has_more });
      }),
  };
}

function getAttachmentTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "messenger_get_attachment",
    description:
      "Fetch one message's attachment from Meta, by the message `id` messenger_get_messages " +
      "returned. An image comes back as an image (up to 5 MB); text as text; anything else as " +
      "an embedded file (up to 25 MB). Media is fetched on demand, never stored, so an old " +
      "attachment Meta has expired can fail.\n\n" +
      UNOFFICIAL,
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "string", description: "The message's `id`." } },
      required: ["message_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (args) =>
      guard(async () => {
        const id = requiredString(args, "message_id");
        const file = await (await (await bridge()).client()).fetchBytes(
          `/attachment?${new URLSearchParams({ id })}`,
        );
        const mimeType = file.mimeType.split(";")[0]!.trim();
        const meta = { message_id: id, name: file.fileName, mime_type: mimeType, size_bytes: file.data.length };
        if (mimeType.startsWith("image/") && file.data.length <= BOUNDED_IMAGE_BYTES) {
          return ok(meta, [{ type: "image", data: file.data.toString("base64"), mimeType }]);
        }
        if (mimeType.startsWith("text/")) {
          return ok(meta, [{ type: "text", text: file.data.toString("utf8") }]);
        }
        return ok(meta, [
          {
            type: "resource",
            resource: {
              uri: `messenger://attachment/${encodeURIComponent(id)}`,
              mimeType,
              blob: file.data.toString("base64"),
            },
          },
        ]);
      }),
  };
}

// ---- admin ------------------------------------------------------------------

interface StepPayload {
  flow: string;
  type: string;
  step_id: string;
  instructions: string;
  fields?: unknown[];
  cookies?: string[];
  cookies_url?: string;
  display?: { type: string; data?: string };
  images?: Array<{ mime_type: string; base64: string }>;
  account?: { id: string; name: string };
  unsupported?: string;
}

const NEXT: Record<string, string> = {
  user_input: "Call messenger_login_submit with `input` holding each field's value by its `id`.",
  cookies:
    "Sign in at `cookies_url` in a browser, copy each named cookie's value, and call " +
    "messenger_login_submit with `input` mapping cookie name to value.",
  display_and_wait:
    "Do what `instructions` says (usually: approve the login on a phone already signed in to " +
    "Facebook), then call messenger_login_submit with no input; it waits up to two minutes.",
  complete: "Logged in. The bridge is connecting and backfilling recent chats.",
};

async function stepResult(b: MessengerBridge, step: StepPayload): Promise<ToolResult> {
  const { images, ...rest } = step;
  let saved: boolean | undefined;
  if (step.type === "complete") {
    try {
      await b.snapshot();
      saved = true;
    } catch {
      saved = false;
    }
  }
  const payload = {
    ...rest,
    next: step.unsupported ?? NEXT[step.type] ?? "Unknown step type.",
    ...(saved === undefined ? {} : { saved }),
  };
  return ok(
    payload,
    (images ?? []).map((img) => ({ type: "image" as const, data: img.base64, mimeType: img.mime_type })),
  );
}

const CREDENTIAL_WARNING =
  "WHO RUNS THIS: a human, from strad's console playground on the admin slug. The " +
  "values typed into a step — a password, a code, a PIN, cookies — are the account; " +
  "an agent must never ask a person to paste them into a chat, and none is ever " +
  "logged or returned.";

function loginStartTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "messenger_login_start",
    description:
      "Begin logging this bridge in to a Facebook account, and return the first step. Flows: " +
      '"android" (default) and "ios" sign in the way the Messenger phone apps do — email or ' +
      "phone and password, then whatever Meta asks (a code, an approval on another device) — " +
      "and register as a device of their own; \"cookies\" adopts a browser's facebook.com " +
      "session instead. After the account step, Meta may ask for the 6-digit secure-storage " +
      "PIN that restores end-to-end encrypted history; leave it empty to skip. Continue each " +
      "step with messenger_login_submit. Refused while an account is already connected " +
      "(messenger_logout first). Starting again abandons a login in progress.\n\n" +
      CREDENTIAL_WARNING +
      "\n\n" +
      UNOFFICIAL,
    inputSchema: {
      type: "object",
      properties: {
        flow: { type: "string", enum: ["android", "ios", "cookies"], description: 'Default "android".' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (args) =>
      guard(async () => {
        const flow = optionalString(args, "flow") ?? "android";
        const b = await bridge();
        const step = await (await b.client()).request<StepPayload>("POST", "/login/start", { flow });
        return stepResult(b, step);
      }),
  };
}

function loginSubmitTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "messenger_login_submit",
    description:
      "Answer the current login step and return the next one. `input` maps each field's `id` " +
      "(or, for a cookies step, each cookie's name) to its value; omit it for a step of type " +
      '`display_and_wait`. A step of type "complete" means logged in, and `saved: true` that ' +
      "the login is already in durable storage. A failed step ends the login: start again.\n\n" +
      CREDENTIAL_WARNING,
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Field id → value.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (args) =>
      guard(async () => {
        const raw = args.input;
        if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
          throw new ArgError("`input` must be an object of field id → string value.");
        }
        const input: Record<string, string> = {};
        for (const [k, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
          if (typeof v !== "string") throw new ArgError(`\`input.${k}\` must be a string.`);
          input[k] = v;
        }
        const b = await bridge();
        const step = await (await b.client()).request<StepPayload>("POST", "/login/submit", { input });
        return stepResult(b, step);
      }),
  };
}

function loginCancelTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "messenger_login_cancel",
    description: "Abandon a login in progress. A connected account is unaffected.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: () =>
      guard(async () => ok(await (await (await bridge()).client()).request("POST", "/login/cancel"))),
  };
}

function logoutTool(bridge: BridgeFactory): ToolDefinition {
  return {
    name: "messenger_logout",
    description:
      "Log the bridge out at Meta (this device disappears from the account's logged-in " +
      "devices) and delete everything it holds: the session, the encryption keys, every " +
      "buffered message, and the saved copy in strad's state bucket. Irreversible; the next " +
      'login starts from nothing. Requires {"confirm": true}.',
    inputSchema: {
      type: "object",
      properties: { confirm: { type: "boolean", description: "Must be true." } },
      required: ["confirm"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: (args) =>
      guard(async () => {
        if (args.confirm !== true) throw new ArgError('Logging out deletes everything: pass {"confirm": true}.');
        const result = await (await bridge()).logout();
        return ok({ ...result, deleted: true });
      }),
  };
}

const ENTRIES: Array<{ factory: (b: BridgeFactory) => ToolDefinition; groups: ToolGroup[] }> = [
  { factory: statusTool, groups: ["readonly", "admin"] },
  { factory: listThreadsTool, groups: ["readonly", "admin"] },
  { factory: getMessagesTool, groups: ["readonly", "admin"] },
  { factory: getAttachmentTool, groups: ["readonly", "admin"] },
  { factory: loginStartTool, groups: ["admin"] },
  { factory: loginSubmitTool, groups: ["admin"] },
  { factory: loginCancelTool, groups: ["admin"] },
  { factory: logoutTool, groups: ["admin"] },
];

export function toolDefinitions(bridge: BridgeFactory, groups: ToolGroup[] = ALL_GROUPS): ToolDefinition[] {
  return ENTRIES.filter((e) => e.groups.some((g) => groups.includes(g))).map((e) => e.factory(bridge));
}

export function toolNames(groups: ToolGroup[] = ALL_GROUPS): string[] {
  return toolDefinitions(async () => {
    throw new Error("not used");
  }, groups).map((t) => t.name);
}

export function registerTools(server: Server, bridge: BridgeFactory, groups: ToolGroup[] = ALL_GROUPS): void {
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
      throw new Error(`Unknown tool: ${request.params.name}. This server offers: ${tools.map((t) => t.name).join(", ")}.`);
    }
    const raw = request.params.arguments;
    return tool.handler(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
  });
}
