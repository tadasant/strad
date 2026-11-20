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
 *        `take_screenshot`, and `list_tabs`, which carries every page's own
 *        title) on EVERY tab, and anything but `navigate_tab` and `close_tab`
 *        on a tainted tab. Every tab, because a
 *        tab id from the DevTools backend and one from the extension are
 *        different strings for the same tab, so "is this the tainted one"
 *        cannot be answered across backends — refusing all reads can.
 *    `messages` reads the Messages database, not the screen, and is left
 *    alone. Closing a tainted tab clears its taint, and so does custody's
 *    `release_tab`, which blanks it. A navigation does not: a `#fragment`
 *    navigation leaves the page, and the secret, where they were.
 *
 *    A capture also refuses to START while a shell command is running. The
 *    hold is checked when a call begins, so a command started before the
 *    capture — `sleep 20; pbpaste` — would otherwise run straight through it.
 *
 * 2. **The egress filter.** Every result any server returns, and every set of
 *    arguments any caller sends, is checked for the exact value of every live
 *    handle in every form it could travel in (`needlesFor`) — and of every
 *    handle deposited or discarded under a custody grant that is still
 *    running, since that value is still live at its provider. A hit withholds
 *    the result and BURNS a handle still held: a value readable outside
 *    custody is a leaked credential, and depositing it anyway would store one
 *    the owner has to rotate. A deposited or discarded hit burns nothing, and
 *    the refusal says which each handle was (`withheldResult`). This is the backstop for whatever the hold does not
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
  "list_tabs",
]);
const SAFE_ON_TAINTED = new Set(["navigate_tab", "close_tab"]);

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

/** After a call that succeeded: a closed tab shows no secret. */
export function custodyAfter(
  vault: Vault,
  capability: CapabilityId,
  tool: string,
  args: Record<string, unknown>,
  result: CallToolResult,
): void {
  if (result.isError) return;
  // CLOSE only. A navigation can leave the page where it is — a `#fragment`
  // is a same-document navigation — so it lifts nothing; `release_tab`,
  // which blanks the tab, is the way to keep a tab and lose the taint.
  if (capability !== "browser" || tool !== "close_tab") return;
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

/** A handle whose value a payload carried, and what it was when it did. */
export interface EgressHit {
  handle: string;
  /**
   * `held` — burned by this hit. `deposited` / `discarded` — it had already
   * left custody and is filtered as a tripwire; nothing burned.
   */
  was: "held" | "deposited" | "discarded";
}

/**
 * Check a payload against every live handle. On a hit, burn the HELD handles
 * and return every hit with what it was; the caller withholds what it was
 * about to send.
 */
export function egressHits(vault: Vault, payload: unknown): EgressHit[] {
  const hits: EgressHit[] = vault.scan(textsOf(payload)).map((handle) => ({
    handle,
    was: vault.filterState(handle) ?? "discarded",
  }));
  for (const h of hits)
    if (h.was === "held")
      vault.end(h.handle, "burned", {
        reason: "its value appeared in a tool call or result",
      });
  return hits;
}

const ids = (hits: EgressHit[], was: EgressHit["was"]) =>
  hits
    .filter((h) => h.was === was)
    .map((h) => h.handle)
    .join(", ");

/**
 * What the caller is told, per handle and per what it WAS: a burn is only
 * claimed of a handle that was held. A discarded handle is filtered because a
 * credential discarded unused is still live at its provider — but it may as
 * well have been the wrong capture (a label, a public preview), and the page
 * showing it again is not a leak of anything in custody.
 */
export function withheldResult(
  hits: EgressHit[],
  where: "result" | "arguments",
): CallToolResult {
  const parts: string[] = [];
  const held = ids(hits, "held");
  const deposited = ids(hits, "deposited");
  const discarded = ids(hits, "discarded");
  if (where === "result") {
    parts.push(
      `Withheld: this result contained the value behind ${hits.map((h) => h.handle).join(", ")}. Nothing of the result was returned.`,
    );
    if (held)
      parts.push(
        `${held} was held and is now BURNED: it cannot be deposited. Its value is readable outside custody — revoke the credential at its provider and capture a fresh one.`,
      );
    if (deposited)
      parts.push(
        `${deposited} is already deposited in strad, and its value is readable outside custody: rotate it.`,
      );
    if (discarded)
      parts.push(
        `${discarded} was already DISCARDED, so nothing was burned and nothing is in strad. Its value stays filtered until the custody grant ends, because a discarded credential can still be live at its provider: if it was a real credential, revoke it there. If you discarded it as the wrong capture — a partial or display copy the page shows to anyone — this is that same text again, not a leak.`,
      );
  } else {
    parts.push(
      `Refused: these arguments contain the secret behind ${hits.map((h) => h.handle).join(", ")}, so it has already been in your context. Nothing ran.`,
    );
    if (held)
      parts.push(
        `${held} is now BURNED — revoke the credential at its provider and capture a fresh one.`,
      );
    if (deposited)
      parts.push(`${deposited} is already deposited in strad: rotate it.`);
    if (discarded)
      parts.push(
        `${discarded} was already discarded; nothing was burned. If it was a real credential, revoke it at its provider.`,
      );
  }
  return {
    content: [{ type: "text", text: parts.join(" ") }],
    isError: true,
  };
}
