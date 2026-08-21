import type { StradConfig } from "../config/schema.ts";

/**
 * Capability, enforced at the gateway.
 *
 * WHY THIS EXISTS. A server's capability (read-only vs read-write) used to be a
 * property of its CONTAINER: `GMAIL_ENABLED_TOOLGROUPS=readonly` built a process
 * that had no write tools in it. That is a lovely security property and a
 * terrible deployment property — a component's env is the union of its servers'
 * env maps, so `gmail-ro` (=readonly) and `gmail-rw` (=readwrite) wanted two
 * values of one variable and therefore could not share a container. Every
 * capability variant cost its own billed component: 12 bundles for the 26 server
 * slugs the config declared. The staging fleet is 28 supplementary-image entries:
 * 27 share ONE bundle and collapse onto 19 upstream mounts, while
 * `zimmer-secrets` runs the same image as its own bundle for a second parameter
 * store. The `echo` builtin and `deepwiki` remote-http add no billed component.
 *
 * Moving the decision here collapses that: ONE container runs each upstream at
 * FULL capability, and the gateway decides which tools a given SLUG may expose
 * and invoke. `gmail-ro` and `gmail-rw` become two config entries pointing at
 * the same container.
 *
 * THE TRADE. Read-only stops being physics (a process that lacks the code path)
 * and becomes policy (a gateway that declines). The blast radius of a gateway
 * bug grows accordingly, which is why enforcement lives on the ACTION —
 * `tools/call` — and not merely on the listing. Hiding a tool from `tools/list`
 * is cosmetic: nothing stops a client from calling a name it was never shown.
 * See `toolAllowed` callers in router.ts: list filters, call REJECTS.
 */

export interface ToolPolicy {
  /** If present, a tool must appear here. Absent = every tool is a candidate. */
  allow?: ReadonlySet<string>;
  /** If present, a tool named here is refused — even if `allow` listed it. */
  deny?: ReadonlySet<string>;
}

export type ToolPolicies = ReadonlyMap<string, ToolPolicy>;

/** Config -> one policy per server slug. Servers with no `tools:` get no entry. */
export function compileToolPolicies(config: StradConfig): ToolPolicies {
  const policies = new Map<string, ToolPolicy>();
  for (const server of config.servers) {
    if (!server.tools) continue;
    const { allow, deny } = server.tools;
    policies.set(server.slug, {
      allow: allow ? new Set(allow) : undefined,
      deny: deny ? new Set(deny) : undefined,
    });
  }
  return policies;
}

/**
 * May this (bare, un-namespaced) tool run on this server?
 *
 * Fail-closed in the only place it can be: an `allow` list is exhaustive, so an
 * upstream that grows a new write tool tomorrow does NOT silently gain it on a
 * read-only slug. `deny` overrides `allow`, so a deny entry is always the final
 * word regardless of how the allow list is maintained.
 */
export function toolAllowed(
  policy: ToolPolicy | undefined,
  tool: string,
): boolean {
  if (!policy) return true;
  if (policy.allow && !policy.allow.has(tool)) return false;
  if (policy.deny?.has(tool)) return false;
  return true;
}

/**
 * Allow-list entries that no upstream tool matches.
 *
 * A typo in an allow list is invisible — it just silently narrows the toolset by
 * one — so the gateway says so out loud when it filters a list. This is drift
 * detection, not enforcement: the policy still holds either way.
 */
export function unmatchedAllowEntries(
  policy: ToolPolicy | undefined,
  offered: readonly string[],
): string[] {
  if (!policy?.allow) return [];
  const have = new Set(offered);
  return [...policy.allow].filter((name) => !have.has(name));
}

/**
 * Deny entries that no upstream tool matches.
 *
 * The gateway does not emit this at runtime, and the asymmetry is deliberate: a
 * stale ALLOW entry silently narrows a live surface, while a stale DENY entry
 * subtracts nothing and changes no request. It is still drift — a deny list is
 * how a full-capability tier withholds one tool, so a name that matches nothing
 * means the tool was renamed and is being served — which is why the caller is
 * the pre-deploy check (src/deploy/tool-surface.ts) rather than the request path.
 *
 * A deny entry is not the place to pre-refuse a tool that does not exist yet:
 * `allow` is exhaustive and already fail-closed against an upstream growing one.
 */
export function unmatchedDenyEntries(
  policy: ToolPolicy | undefined,
  offered: readonly string[],
): string[] {
  if (!policy?.deny) return [];
  const have = new Set(offered);
  return [...policy.deny].filter((name) => !have.has(name));
}
