import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import type { AuditLog } from "../audit.js";
import { CAPABILITIES, type CapabilityId } from "../capabilities.js";
import { displayName, type Config } from "../config.js";
import type { ConsentGate } from "../consent/gate.js";
import type { KillSwitch } from "../killswitch.js";
import { json, text, type Capability } from "./tool.js";

const GRANT_ID_DESCRIPTION =
  'The grant_id returned by request_control, e.g. "g_Zk3…". Every tool on this server needs one. ' +
  "If you have none, or yours stopped working, call request_control first.";

const PURPOSE_DESCRIPTION =
  "Why you need control of this machine, in AT MOST TWO SENTENCES (280 characters). It is shown verbatim, in a " +
  "dialog, to the person sitting at the machine, who has a few seconds to reject it — so say concretely what you " +
  'are about to do, e.g. "Find the Q3 invoice PDFs in ~/Documents and report their file names." ' +
  "A vague, missing or over-long purpose is refused.";

const MINUTES_DESCRIPTION =
  "How long the grant should last, in minutes. Defaults to the machine's setting (30 unless its owner changed it) " +
  "and is capped by it. Ask for what the task needs; a grant also ends early after 10 idle minutes.";

export interface ServerDeps {
  config: Config;
  gate: ConsentGate;
  killSwitch: KillSwitch;
  audit: AuditLog;
}

/**
 * The MCP server for ONE capability: three control tools, then the capability's
 * own, every one of which is refused without a live grant.
 *
 * WHY CONSENT IS A TOOL CALL and not a property of the connection. Tadas's words
 * were "initiating a connection … should always trigger the daemon to stall",
 * and over a gateway there is no such event to hang it on: strad keeps ONE
 * pooled upstream connection per slug, shared by every caller, and forwards a
 * tool's `name` and `arguments` and nothing else — no client identity, no
 * `_meta`, no per-caller session. So the only channel that reaches this machine
 * from the caller is tool arguments, and "a connection" is made an explicit
 * thing a caller asks for: `request_control(purpose)` returns a `grant_id`, and
 * the grant — not the socket — is what the dialog approves, the status page
 * shows, and the kill button ends. It also makes the purpose impossible to
 * omit: a caller that skips it has no grant_id and every tool says so.
 */
export function buildServer(
  id: CapabilityId,
  capability: Capability,
  deps: ServerDeps,
): Server {
  const { config, gate, killSwitch, audit } = deps;
  const name = displayName(config, id);

  const controlTools: Tool[] = [
    {
      name: "request_control",
      description: `Ask the owner of ${config.machine} for permission to use this server. START HERE: every other tool needs the grant_id this returns.

Calling it puts a dialog on the machine's screen — "Remote control requested by ${name} MCP server for purpose: <your purpose>" — and BLOCKS for up to ${config.consent.windowSeconds} seconds while the person there may allow or reject it. ${
        config.consent.onTimeout === "allow"
          ? "If nobody answers, the request is allowed."
          : "If nobody answers, the request is DENIED: this machine fails closed, so its owner has to be at the screen."
      }

**Returns** on success:
{"grant_id":"g_Zk3…","expires_at":"2026-01-01T12:30:00.000Z","minutes":30,"idle_minutes":10,"approved_by":"owner"}
approved_by is "owner" (they clicked Allow), "timeout" (nobody objected, and this machine allows that) or "local" (a local stdio run with the dialog turned off).

**On refusal** the result is an error naming one of: rejected (the owner said no — do not retry; tell your user), timeout, no_display (nobody is logged in to the desktop), cooldown (a recent rejection; wait), dialog_busy (another request is on screen; ask again in a few seconds), disabled (the owner switched remote control off), bad_purpose, too_many_grants.

**Use cases:**
- First call of any task on this server
- Re-establishing control after a grant expired, went idle, or was killed by the owner
- Asking for a longer grant up front for a long job (minutes)

The owner can see your grant and kill it at any moment; a killed grant stops whatever it started. Call end_control when you are done.`,
      inputSchema: {
        type: "object",
        properties: {
          purpose: { type: "string", description: PURPOSE_DESCRIPTION },
          minutes: {
            type: "integer",
            description: MINUTES_DESCRIPTION,
            minimum: 1,
          },
        },
        required: ["purpose"],
      },
      annotations: {
        title: "Request control of this machine",
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "end_control",
      description: `Give the grant back. Stops anything it started that is still running and removes it from the owner's status page.

**Returns:** {"ended":true}

**Use cases:**
- The task is finished
- You are about to hand off and will not use this server again
- You asked for control by mistake

Idempotent: ending a grant that is already gone returns {"ended":false}.`,
      inputSchema: {
        type: "object",
        properties: {
          grant_id: { type: "string", description: GRANT_ID_DESCRIPTION },
        },
        required: ["grant_id"],
      },
      annotations: {
        title: "End control",
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    {
      name: "get_control_status",
      description: `Report whether this server is usable right now, without asking for anything and without showing a dialog.

**Returns:** {"machine":"…","server":"${name}","enabled":true,"consent":{"mode":"modal","window_seconds":5,"on_timeout":"deny"},"grant":{"active":true,"expires_at":"…","calls":4}}
"enabled": false means the owner has switched remote control off. "grant" appears only when you pass a grant_id.

**Use cases:**
- Check whether a grant_id you hold is still live before a long step
- Find out whether the owner needs to be at the screen (on_timeout "deny") before asking
- Tell "switched off by the owner" apart from "grant expired"`,
      inputSchema: {
        type: "object",
        properties: {
          grant_id: { type: "string", description: GRANT_ID_DESCRIPTION },
        },
      },
      annotations: { title: "Get control status", readOnlyHint: true },
    },
  ];

  const capabilityTools: Tool[] = capability.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: "object",
      properties: {
        grant_id: { type: "string", description: GRANT_ID_DESCRIPTION },
        ...t.inputSchema.properties,
      },
      required: ["grant_id", ...(t.inputSchema.required ?? [])],
    },
    annotations: t.annotations,
  }));

  const server = new Server(
    { name, version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        `${CAPABILITIES[id].summary} The machine is ${config.machine}, a personal computer with a person who may be ` +
        `using it. Call request_control with a one-or-two-sentence purpose first; pass the grant_id it returns to ` +
        `every other tool; call end_control when done.`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...controlTools, ...capabilityTools],
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (req, extra): Promise<CallToolResult> => {
      const tool = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;

      if (tool === "request_control") {
        const decision = await gate.request({
          capability: id,
          server: name,
          purpose: args.purpose,
          minutes: typeof args.minutes === "number" ? args.minutes : undefined,
          signal: extra.signal,
        });
        if (!decision.ok)
          return text(
            `Control was not granted (${decision.code}): ${decision.reason}.`,
            true,
          );
        const g = decision.grant;
        return json({
          grant_id: g.id,
          expires_at: new Date(g.expiresAt).toISOString(),
          minutes: Math.round((g.expiresAt - g.createdAt) / 60_000),
          idle_minutes: config.consent.idleMinutes,
          approved_by:
            decision.how === "allowed"
              ? "owner"
              : decision.how === "timeout-allow"
                ? "timeout"
                : "local",
        });
      }

      if (tool === "get_control_status") {
        const mine =
          typeof args.grant_id === "string"
            ? gate.grants.active(id).find((g) => g.id === args.grant_id)
            : undefined;
        return json({
          machine: config.machine,
          server: name,
          enabled: !killSwitch.isDisabled(),
          consent: {
            mode: config.consent.mode,
            window_seconds: config.consent.windowSeconds,
            on_timeout: config.consent.onTimeout,
          },
          ...(typeof args.grant_id === "string"
            ? {
                grant: mine
                  ? {
                      active: true,
                      expires_at: new Date(mine.expiresAt).toISOString(),
                      calls: mine.calls,
                    }
                  : { active: false },
              }
            : {}),
        });
      }

      if (tool === "end_control") {
        const mine = gate.grants.active(id).some((g) => g.id === args.grant_id);
        return json({
          ended: mine ? gate.grants.end(String(args.grant_id), "ended") : false,
        });
      }

      const def = capability.tools.find((t) => t.name === tool);
      if (!def) return text(`Unknown tool "${tool}".`, true);

      // The switch outranks a grant: thrown, it has already ended every grant, and
      // this is the check that holds if a grant were ever minted around it.
      if (killSwitch.isDisabled()) {
        return text(
          `Remote control of ${config.machine} is switched off by its owner. Nothing ran.`,
          true,
        );
      }
      const used = gate.grants.use(args.grant_id, id, tool);
      if (!used.ok) {
        return text(
          `Not permitted: ${used.reason}. Call request_control with a purpose (two sentences at most) to get a grant_id, then retry with it. Nothing ran.`,
          true,
        );
      }

      const { grant_id: _grantId, ...rest } = args;
      const parsed = def.schema.safeParse(rest);
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`,
        );
        return text(
          `Invalid arguments for ${tool}:\n${issues.join("\n")}`,
          true,
        );
      }
      audit.record({
        kind: "tool",
        capability: id,
        grantId: used.grant.id,
        detail: def.summarize ? def.summarize(parsed.data) : tool,
      });
      try {
        return await def.handler(parsed.data, { grant: used.grant });
      } catch (err) {
        return text(`${tool} failed: ${(err as Error).message}`, true);
      }
    },
  );

  return server;
}
