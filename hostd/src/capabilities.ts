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
 */
export const CAPABILITY_IDS = [
  "shell",
  "browser",
  "computer-headless",
  "computer",
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
};

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
    default:
      return `${id}-${suffix}`;
  }
}

export function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(value);
}

/** The servers that cannot run without `strad-hostd-ax`. */
export function needsHelper(id: CapabilityId): boolean {
  return id === "computer-headless" || id === "computer";
}
