/**
 * The logical MCP servers one daemon exposes.
 *
 * ONE process, SEVERAL servers, because the two things that want separating are
 * not the same two things. The install, the tunnel, the consent gate and the
 * kill switch want to be one — a machine has one owner, and one place to say
 * no. The ENTITLEMENT wants to be several: strad grants a slug, not a tool, so
 * "may read my filesystem" and "may move my mouse" can only be different grants
 * if they are different servers. Each entry here is one path on the daemon's
 * listener, one bearer key, one line of consent text and one strad slug.
 *
 * The two computer-use servers share a native helper (`strad-hostd-ax`, under
 * `ax/`) and differ on the axis that matters most to the person at the
 * machine: `computer-headless` works through the Accessibility tree and never
 * touches the cursor, `computer` takes the real mouse and keyboard.
 *
 * `messages` has a helper of its own (`strad-hostd-messages`, under
 * `messages/`), the one process holding Full Disk Access, and it only reads:
 * it cannot send, type, click or run anything.
 *
 * `custody` drives the same Chrome as `browser`, for one job: capture a
 * credential the owner's browser is showing into an opaque handle, and deposit
 * it into strad, without the value ever reaching the caller. It is its own
 * server — its own slug, key and consent line — because "may mint and move my
 * credentials" is a different grant from "may browse as me", and because the
 * key strad holds for it is what its deposit bearer is derived from
 * (src/custody/deposit-wire.ts). While it holds a secret, the other servers
 * refuse whatever could read it back (src/custody/enforce.ts).
 */
export const CAPABILITY_IDS = [
  "shell",
  "browser",
  "computer-headless",
  "computer",
  "messages",
  "custody",
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export interface CapabilityInfo {
  id: CapabilityId;
  /** The path segment: `/shell/mcp`. */
  path: string;
  /** One line, shown to a caller in the MCP server's `instructions`. */
  summary: string;
  /**
   * `foreground` takes the one cursor and keyboard from the person at the
   * machine. Everything else runs behind their desktop. The banner is red for
   * one and orange for the other, and a foreground grant ends on their first
   * key or click.
   */
  mode: "background" | "foreground";
  /** An extra line in the consent dialog, for a server whose cost is not obvious. */
  consentNote?: string;
}

export const CAPABILITIES: Record<CapabilityId, CapabilityInfo> = {
  shell: {
    id: "shell",
    path: "/shell/mcp",
    mode: "background",
    summary:
      "Runs shell commands on this machine as its owner's user, in the background, with captured output.",
  },
  browser: {
    id: "browser",
    path: "/browser/mcp",
    mode: "background",
    summary:
      "Drives the owner's real, running Chrome over the DevTools protocol — their profile, their cookies, their open tabs — without taking focus.",
  },
  "computer-headless": {
    id: "computer-headless",
    path: "/computer-headless/mcp",
    mode: "background",
    summary:
      "Reads and operates the owner's running apps through macOS Accessibility — buttons, fields, menus, text — without moving their mouse or taking their focus.",
  },
  computer: {
    id: "computer",
    path: "/computer/mcp",
    mode: "foreground",
    summary:
      "Sees the owner's screen and drives their REAL mouse and keyboard. It takes the machine over while a grant lasts; the owner's first key or click ends it.",
    consentNote:
      "This server will move your mouse and type on your keyboard. Press any key or click to take the machine back.",
  },
  messages: {
    id: "messages",
    path: "/messages/mcp",
    mode: "background",
    summary:
      "Reads the owner's iMessage and SMS history from the Messages database on this Mac — chats, messages and attachments. Read-only: it cannot send, and reading marks nothing as read.",
  },
  custody: {
    id: "custody",
    path: "/custody/mcp",
    mode: "background",
    summary:
      "Captures a credential shown or downloaded in the owner's Chrome, or generates an SSH keypair, into an opaque handle, and deposits it into strad's secret store. The value is never returned to you: you work with the handle and its shape only, and for a generated keypair its public key.",
    consentNote:
      "This server can capture a credential your browser shows, or generate an SSH key, and send it to strad. While it holds one, shell and computer-use on this machine are refused.",
  },
};

/**
 * What `init` and `add` write into a server's config when they create it,
 * beyond the key and the name. Written into the FILE, not defaulted by the
 * schema, so the owner sees it in their config and a hand-written config never
 * acquires it silently.
 *
 * `messages` gets `onTimeout: "allow"`: its consumer is a nightly sweep that
 * runs when nobody is at the screen, and a dialog that fails closed would
 * refuse every one of them. The dialog is still shown for its window and is
 * still a veto; the grant still notifies, is audited, shows on the status page
 * and dies with the kill switch. The machine-wide default stays `deny`, so the
 * shell and the computer-use servers are not loosened with it.
 */
export const CAPABILITY_DEFAULTS: Partial<
  Record<CapabilityId, { onTimeout?: "deny" | "allow" }>
> = {
  messages: { onTimeout: "allow" },
};

/**
 * Servers `init` writes switched OFF and without a key, and the installer does
 * not add: each is enabled only by its owner running `strad-hostd add <id>`.
 * `custody` is one because enabling it mints the key its deposit bearer is
 * derived from, and a credential that can write into strad's store is put on a
 * machine by a decision, not by an upgrade.
 */
export const OPT_IN: readonly CapabilityId[] = ["custody"];

/**
 * The name a server goes by — its strad slug, and the name in the consent
 * dialog. "headless" is the owner's word for "does not take over the screen".
 */
export function slugFor(id: CapabilityId, suffix: string): string {
  switch (id) {
    case "browser":
      return `browser-use-${suffix}-headless`;
    case "computer-headless":
      return `computer-use-${suffix}-headless`;
    case "computer":
      return `computer-use-${suffix}`;
    case "messages":
      return `imessage-${suffix}`;
    case "custody":
      return `custody-${suffix}`;
    default:
      return `${id}-${suffix}`;
  }
}

export function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(value);
}

/** The native helper a server cannot run without, if any. */
export function helperFor(
  id: CapabilityId,
): "strad-hostd-ax" | "strad-hostd-messages" | undefined {
  if (id === "computer-headless" || id === "computer") return "strad-hostd-ax";
  if (id === "messages") return "strad-hostd-messages";
  return undefined;
}

/** The servers that need a macOS helper, and so are off by default elsewhere. */
export function needsHelper(id: CapabilityId): boolean {
  return helperFor(id) !== undefined;
}
