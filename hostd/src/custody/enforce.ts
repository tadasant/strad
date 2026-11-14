import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { CapabilityId } from "../capabilities.js";
import type { Vault } from "./vault.js";

/**
 * hostd ENFORCES custody; it is not a convention a skill asks agents to keep.
 *
 * Two rules, both applied in the one place every tool call on every server
 * passes (src/mcp/server.ts):
 *
 * 1. **The hold.** While the vault is live — a handle held, a tab tainted, a
 *    capture in flight — the servers that could read a secret back off this
 *    machine refuse:
 *      - `shell`, every tool: it runs as the owner and can read the Downloads
 *        folder, the clipboard, Chrome's profile and this daemon's own state.
 *      - `computer` and `computer-headless`, every tool: a screenshot or an
 *        Accessibility read of a window showing the token is the token.
 *      - `browser`: the reads (`read_page`, `evaluate_script`,
 *        `take_screenshot`) on EVERY tab, and anything but `list_tabs`,
 *        `navigate_tab` and `close_tab` on a tainted tab. Every tab, because a
 *        tab id from the DevTools backend and one from the extension are
 *        different strings for the same tab, so "is this the tainted one"
 *        cannot be answered across backends — refusing all reads can.
 *    `messages` reads the Messages database, not the screen, and is left
 *    alone. Navigating or closing a tainted tab through any server clears its
 *    taint: the page holding the secret is gone.
 *
 * 2. **The egress filter.** Every result any server returns, and every set of
 *    arguments any caller sends, is checked for the exact value of every live
 *    handle in every form it could travel in (`needlesFor`). A hit withholds
 *    the result and BURNS the handle: a value that reached the model is a
 *    leaked credential, and depositing it anyway would store one the owner
 *    has to rotate. This is the backstop for whatever the hold does not
 *    foresee; the hold is what makes it rare.
 *
 * The cost is deliberate and bounded: for the minutes between a capture and a
 * deposit, other sessions' shell and computer-use calls on this machine are
 * refused with a message saying why and how to end it.
 */

const HOLD_EVERYTHING: readonly CapabilityId[] = [
  "shell",
  "computer",
  "computer-headless",
];
const BROWSER_READS = new Set([
  "read_page",
  "evaluate_script",
  "take_screenshot",
]);
const SAFE_ON_TAINTED = new Set(["list_tabs", "navigate_tab", "close_tab"]);

function holdMessage(vault: Vault): string {
  const s = vault.status();
  return (
    `Refused: custody is holding a secret on this machine (${s.handles} handle(s), ` +
    `${s.tainted_tabs} tainted tab(s)${s.capturing ? `, ${s.capturing} capture(s) in flight` : ""}), ` +
    "and this call could read it back. On the custody server: deposit or discard_handle each handle, " +
    "and release_tab each tainted tab — or end_control there, which does both. Then retry. Nothing ran."
  );
}

/** Why `tool` on `capability` may not run right now, or undefined. */
export function custodyRefusal(
  vault: Vault,
  capability: CapabilityId,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (capability === "custody" || capability === "messages") return undefined;
  if (!vault.live()) return undefined;
  if (HOLD_EVERYTHING.includes(capability)) return holdMessage(vault);
  if (capability === "browser") {
    if (BROWSER_READS.has(tool)) return holdMessage(vault);
    const tab = args.tab_id;
    if (
      typeof tab === "string" &&
      vault.isTainted(tab) &&
      !SAFE_ON_TAINTED.has(tool)
    )
      return holdMessage(vault);
  }
  return undefined;
}

/** After a call that succeeded: a tab navigated away or closed shows no secret. */
export function custodyAfter(
  vault: Vault,
  capability: CapabilityId,
  tool: string,
  args: Record<string, unknown>,
  result: CallToolResult,
): void {
  if (result.isError) return;
  if (capability !== "browser" && capability !== "custody") return;
  if (tool !== "navigate_tab" && tool !== "close_tab") return;
  if (typeof args.tab_id === "string") vault.untaint(args.tab_id);
}

/** The strings a payload could carry a value in: each text, and the whole. */
function textsOf(payload: unknown): string[] {
  const out: string[] = [];
  try {
    out.push(JSON.stringify(payload) ?? "");
  } catch {
    // unserialisable: nothing a client could receive either
  }
  const content = (payload as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      const t = (c as { text?: unknown }).text;
      if (typeof t === "string") out.push(t);
    }
  }
  return out;
}

/**
 * Check a payload against every live handle. On a hit, burn the handles and
 * return them; the caller withholds what it was about to send.
 */
export function egressHits(vault: Vault, payload: unknown): string[] {
  const hits = vault.scan(textsOf(payload));
  for (const id of hits)
    vault.end(id, "burned", {
      reason: "its value appeared in a tool call or result",
    });
  return hits;
}

export function withheldResult(
  hits: string[],
  where: "result" | "arguments",
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          where === "result"
            ? `Withheld: this result contained the secret held by ${hits.join(", ")}. ` +
              "Those handles are now BURNED and cannot be deposited — treat the credential as leaked: " +
              "revoke it at its provider and capture a fresh one. Nothing of the result was returned."
            : `Refused: these arguments contain the secret held by ${hits.join(", ")}, so it has already ` +
              "been in your context. Those handles are now BURNED — revoke the credential at its provider " +
              "and capture a fresh one. Nothing ran.",
      },
    ],
    isError: true,
  };
}
