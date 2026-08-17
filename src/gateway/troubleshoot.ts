import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "./adapters/types.ts";

/**
 * The tool a `local-tunnel` server offers INSTEAD OF ITS OWN when the machine
 * behind it is not answering.
 *
 * ## The problem it solves
 *
 * A `local-tunnel` server is an MCP server on a machine a human owns, and that
 * machine is off much of the time by design. strad already handled that
 * gracefully in the sense that mattered least: the slug dropped out of listings
 * and took nothing down with it. What a caller got was a shorter list — with no
 * way to tell "Anki is off" from "Anki has no tools" — or, when it was the only
 * thing selected, an error. Neither says the one thing anybody actually needs,
 * which is WHAT TO GO AND RUN ON THAT MACHINE.
 *
 * So the slug stays present and offers exactly one tool. The listing is honest
 * (this server is not serving its tools), the failure is legible (there is a
 * named machine and a named remedy), and the fleet is unharmed (one tool, from
 * one slug, in a listing that otherwise proceeds normally).
 *
 * ## Why it is not a `_meta` field, or an empty list, or an error
 *
 * MCP has no in-band way to say "this part of your selection is unavailable" in
 * a successful `tools/list`. A `_meta` field would be the place and no client
 * reads one. An empty list is indistinguishable from a server with no tools. An
 * error takes the healthy servers named beside it down too. A TOOL is the one
 * channel every client already renders, every agent already reads, and nobody
 * has to be taught about.
 *
 * ## What it is not
 *
 * It is not a fallback implementation of the server's real tools, and it never
 * pretends the machine is up. It reports, and the report is strad's own words
 * plus operator-authored config — never an upstream's prose (see redact.ts).
 */

/**
 * Why a local-tunnel host is not serving.
 *
 * Two states, because they have different remedies and sending someone to the
 * wrong one wastes an afternoon. `offline` is a machine that is not there —
 * asleep, shut, tunnel stopped. `refused` is a machine that IS there and whose
 * door said no: an Access service token that expired, an app bearer that no
 * longer matches. Restarting a tunnel fixes the first and does nothing for the
 * second.
 */
export type HostState = "offline" | "refused";

/**
 * What strad knows about the machine behind a `local-tunnel` slug.
 *
 * Assembled at `Registry.build` from the server entry, so it is config and
 * nothing else: no upstream text, no resolved credential, no live state.
 */
export interface LocalHost {
  slug: string;
  /**
   * The tunnel's hostname, when the configured `url` is a plain one.
   *
   * Absent when `url` is a `${REF}` — the value may only exist inside the
   * secrets store, and this text goes to clients. A missing hostname costs a
   * sentence; a resolved one that turns out to be a credential costs rather
   * more.
   */
  hostname?: string;
  /** Whose machine it is, e.g. "Tadas's MacBook". From `recovery.machine`. */
  machine?: string;
  /** Exact commands to run ON THAT MACHINE. From `recovery.commands`. */
  commands: string[];
  /** Anything else that machine's owner needs to know. From `recovery.notes`. */
  notes?: string;
}

/**
 * The tool name.
 *
 * Verb-first and snake_case like every other tool, deliberately NOT prefixed
 * with the slug (the client already namespaces it as `anki__troubleshoot_host`),
 * and named for the machine rather than for the server — because the thing that
 * needs troubleshooting is somebody's laptop, and the person reading the list
 * should not go looking at strad.
 *
 * It SHADOWS an upstream tool of the same name on a local-tunnel slug, which is
 * the price of answering it here rather than forwarding it — and the reason for
 * a name specific enough that no MCP server on a laptop is likely to have
 * chosen it.
 */
export const TROUBLESHOOT_TOOL = "troubleshoot_host";

/**
 * The tool definition offered while the host is unavailable.
 *
 * The description does the work that a tool name cannot: it says, in the first
 * line, that this server's real tools are missing and why — so a client that
 * renders nothing but names and descriptions still communicates the outage.
 */
export function troubleshootTool(host: LocalHost, state: HostState): Tool {
  const machine = host.machine ?? "the machine that hosts it";
  return {
    name: TROUBLESHOOT_TOOL,
    title: `${host.slug}: host machine is not answering`,
    description:
      `THIS SERVER'S OWN TOOLS ARE NOT AVAILABLE RIGHT NOW. "${host.slug}" runs on a ` +
      `machine somebody owns (${machine}), and it serves tools only while that machine ` +
      `is awake, running the server, and holding its tunnel open. ` +
      (state === "refused"
        ? `That machine IS answering but refused strad's credentials, so its tools cannot be listed. `
        : `That machine is not answering, so its tools cannot be listed. `) +
      `Nothing is broken in strad and there is nothing here to retry — the real tools come ` +
      `back on their own once the machine does.\n\n` +
      `Call this tool (it takes no arguments) to get the diagnosis and the exact commands to ` +
      `run ON THAT MACHINE to bring it back. It re-checks the machine when you call it, so it ` +
      `also tells you if the machine has recovered since this list was built.\n\n` +
      `Example response:\n` +
      `  "anki" is not serving tools: the machine hosting it is offline.\n` +
      `  Machine: Tadas's MacBook (anki.example.com).\n` +
      `  Run this on that machine:\n` +
      `    launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      title: `${host.slug}: host machine is not answering`,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      // It reaches out to the machine to re-check it, which is as open-world as
      // this gateway gets.
      openWorldHint: true,
    },
  };
}

/**
 * The remedy, as prose.
 *
 * Shared by the tool result AND by the error message a real tool call gets when
 * the machine is down (see `LocalHostUnavailableError`), because the two answer
 * the same question and there is no version of this where one of them should be
 * less useful than the other.
 *
 * Every part is ours: the slug and hostname come from the config, the commands
 * and notes were written by whoever operates the deployment, and the sentences
 * are strad's. Nothing an upstream said appears here.
 */
export function remedyText(host: LocalHost, state: HostState): string {
  const lines: string[] = [];

  const where = [host.machine, host.hostname].filter(Boolean).join(" — ");
  if (where) lines.push(`Machine: ${where}.`);

  lines.push(
    state === "refused"
      ? `Diagnosis: the machine answered and REFUSED strad's credentials. It is not off. ` +
          `Restarting the tunnel will not help — the credential is what to look at: an ` +
          `expired access-service token, or an app-level bearer that no longer matches ` +
          `what the server on that machine expects.`
      : `Diagnosis: the machine is not answering. It is asleep, shut down, not running ` +
          `the server, or not running its tunnel.`,
  );

  if (host.commands.length > 0) {
    lines.push(
      `Run ${host.commands.length === 1 ? "this" : "these"} on that machine:`,
    );
    for (const command of host.commands) lines.push(`  ${command}`);
  } else {
    // No `recovery.commands` on the entry. Say what strad genuinely knows
    // rather than guessing a tunnel name out of a hostname — a confidently
    // wrong command is worse than an honest generic one.
    lines.push(
      `No recovery commands are configured for this server. On that machine: wake it, ` +
        `start the application that serves${host.hostname ? ` ${host.hostname}` : ""}, and ` +
        `make sure its tunnel is running. See ` +
        `https://docs.strad.tadasant.com/servers/local-tunnel-host/ — and add a ` +
        `\`recovery:\` block to this server's config so this answer is exact next time.`,
    );
  }

  if (host.notes) lines.push(host.notes);

  return lines.join("\n");
}

/** The tool result: what is wrong, and what to run. */
export function troubleshootResult(
  host: LocalHost,
  state: HostState,
): CallToolResult {
  return text(
    `"${host.slug}" is not serving its tools.\n\n${remedyText(host, state)}`,
  );
}

/**
 * The result when the machine turns out to be answering after all.
 *
 * Worth its own sentence rather than a shrug: the tool only appears when a
 * listing found the host down, so reaching this means it recovered in between —
 * which is exactly what somebody who just ran the commands wants to be told.
 * `isError` stays unset: the tool did its job, and the news is good.
 */
export function recoveredResult(
  host: LocalHost,
  tools: number,
): CallToolResult {
  return text(
    `"${host.slug}" is answering again — its machine is up and serving ${tools} ` +
      `${tools === 1 ? "tool" : "tools"}. List tools again to see them; the ` +
      `troubleshooting tool disappears once they are back.`,
  );
}

/**
 * The result when the machine answered and strad still could not list its tools.
 *
 * Neither "offline" nor "refused" — something is wrong that no command on that
 * machine is known to fix, and saying otherwise would send its owner chasing a
 * tunnel that is working. The upstream's own message is NOT quoted: it is
 * arbitrary text strad did not author (see telemetry/redact.ts), and the one
 * that motivated the rule was a whole HTML error page.
 */
export function undiagnosedResult(host: LocalHost): CallToolResult {
  return text(
    `"${host.slug}" is not serving its tools, and this is NOT the usual case of a machine ` +
      `being off. Its machine answered, and strad still could not list its tools — so the ` +
      `server on that machine is reachable but not behaving as an MCP server: a wrong path ` +
      `in this slug's \`url\`, or a server that is running and erroring. Check strad's logs ` +
      `for this slug; the commands below are unlikely to be the fix.\n\n` +
      remedyText(host, "offline"),
  );
}

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}
