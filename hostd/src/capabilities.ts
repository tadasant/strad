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
 * `computer-headless` (Accessibility APIs) and `computer` (foreground pixel
 * control) are designed — see the design page under docs/ — and are not in this
 * table until they are implemented. A capability that is listed is one that
 * works.
 */
export const CAPABILITY_IDS = ["shell", "browser"] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export interface CapabilityInfo {
  id: CapabilityId;
  /** The path segment: `/shell/mcp`. */
  path: string;
  /** One line, shown to a caller in the MCP server's `instructions`. */
  summary: string;
}

export const CAPABILITIES: Record<CapabilityId, CapabilityInfo> = {
  shell: {
    id: "shell",
    path: "/shell/mcp",
    summary:
      "Runs shell commands on this machine as its owner's user, in the background, with captured output.",
  },
  browser: {
    id: "browser",
    path: "/browser/mcp",
    summary:
      "Drives the owner's real, running Chrome over the DevTools protocol — their profile, their cookies, their open tabs — without taking focus.",
  },
};

/**
 * The name a server goes by — its strad slug, and the name in the consent
 * dialog. "headless" is the owner's word for "does not take over the screen".
 */
export function slugFor(id: CapabilityId, suffix: string): string {
  return id === "browser"
    ? `browser-use-${suffix}-headless`
    : `${id}-${suffix}`;
}

export function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(value);
}
