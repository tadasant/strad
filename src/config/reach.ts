import { toolAllowed, type ToolPolicy } from "../gateway/toolPolicy.ts";

/**
 * FLOW-THROUGH: one hosted server calling another slug, through core, with no
 * credential of its own.
 *
 * The config half lives in `ReachGrant` (src/config/schema.ts): a source's
 * `reaches:` names a target, the tools it may use there and the arguments
 * pinned on every call, and the target's `reachableFrom:` names the source
 * back. This module is the rules that make a grant legal and the one reading of
 * it the route (src/http/reach.ts) serves from.
 *
 * ## Which identity the nested call runs as
 *
 * The SOURCE SERVER's, and never the human's or the agent's that called the
 * source. A caller entitled to the source slug reaches the target only through
 * the source's own tools, which are the surface a reviewer approved; nothing
 * the caller sends is forwarded as authority, and the target's credential never
 * leaves the target's container. That is the same shape as a service account,
 * and it is why the grant has to be narrow: it is standing authority, held by
 * code, exercised on behalf of whoever the source serves.
 *
 * ## Why it cannot widen the gateway's entitlements
 *
 *   - The grant is CHECKED-IN CONFIG on both sides. A runtime roster write can
 *     neither declare nor change it (`assertNoReachChange` in
 *     src/config/overlay.ts).
 *   - It is EXHAUSTIVE AND BOUNDED BY THE TARGET: every tool must be named, and
 *     every named tool must pass the target's own `tools:` policy, so a grant on
 *     `gmail-ro` cannot reach a write tool `gmail-ro` withholds.
 *   - It is ONE HOP: a target that itself reaches something is refused, so the
 *     full reach of a source is readable off its own entry.
 *   - The caller is a COMPONENT, proven by its derived internal token
 *     (src/auth/internal-token.ts), and it may only speak for a slug that lives
 *     on that component. That is the boundary the route can actually enforce:
 *     every server on one component shares a process environment, so a grant
 *     is effectively held by the component, and the config says which slug
 *     asked for it.
 */

/** The slice of a server entry these rules read. Structural, to stay import-free of the schema. */
interface ReachServerView {
  slug: string;
  kind: string;
  enabled: boolean;
  tools?: { allow?: string[]; deny?: string[] };
  reachableFrom: string[];
  reaches?: ReachGrantView[];
}

interface ReachGrantView {
  slug: string;
  tools: string[];
  pin: Record<string, string | number | boolean>;
}

interface ReachConfigView {
  servers: ReachServerView[];
}

export interface ReachIssue {
  message: string;
  path: (string | number)[];
}

function policyOf(server: ReachServerView): ToolPolicy | undefined {
  if (!server.tools) return undefined;
  return {
    allow: server.tools.allow ? new Set(server.tools.allow) : undefined,
    deny: server.tools.deny ? new Set(server.tools.deny) : undefined,
  };
}

/**
 * Every way a config's grants are illegal. Called by `npm run config:check`
 * (scripts/check-config.ts), which CI runs over every config.
 *
 * NOT by the schema, and that is deliberate. The schema also judges the merged
 * roster on every runtime write, and a runtime REMOVAL of either half of a
 * grant has to stay possible — it is the kill switch — while it necessarily
 * leaves the other half dangling. What the gateway SERVES never depends on
 * these rules having run: `activeGrants` re-derives every one of them that
 * decides reach, on the config in hand.
 */
export function reachIssues(cfg: ReachConfigView): ReachIssue[] {
  const issues: ReachIssue[] = [];
  const bySlug = new Map(cfg.servers.map((s) => [s.slug, s]));

  cfg.servers.forEach((source, i) => {
    const grants = source.reaches ?? [];
    const seen = new Set<string>();
    grants.forEach((grant, j) => {
      const at = ["servers", i, "reaches", j];
      if (seen.has(grant.slug)) {
        issues.push({
          message: `${source.slug} reaches ${grant.slug} twice; one grant per target`,
          path: [...at, "slug"],
        });
      }
      seen.add(grant.slug);

      if (grant.slug === source.slug) {
        issues.push({
          message: `${source.slug} reaches itself; a server calls its own tools directly`,
          path: [...at, "slug"],
        });
        return;
      }
      const target = bySlug.get(grant.slug);
      if (!target) {
        issues.push({
          message: `${source.slug} reaches ${grant.slug}, which is not a configured server`,
          path: [...at, "slug"],
        });
        return;
      }
      // BOTH SIDES CONSENT. The source's grant alone is not enough.
      if (!target.reachableFrom.includes(source.slug)) {
        issues.push({
          message:
            `${source.slug} reaches ${grant.slug}, but ${grant.slug} does not ` +
            `list it under reachableFrom:. A flow-through grant needs both sides.`,
          path: [...at, "slug"],
        });
      }
      // ONE HOP. A target that reaches onward would make the source's reach the
      // closure of a graph instead of the list on its own entry.
      if ((target.reaches ?? []).length > 0) {
        issues.push({
          message:
            `${source.slug} reaches ${grant.slug}, which itself reaches other ` +
            `servers. Flow-through is one hop; chains are refused.`,
          path: [...at, "slug"],
        });
      }
      // NOT A LOCAL-TUNNEL. Its degraded surface carries strad's own
      // troubleshooting tool outside any policy, so a grant onto one would not
      // be exhaustive.
      if (target.kind === "local-tunnel") {
        issues.push({
          message:
            `${source.slug} reaches ${grant.slug}, a local-tunnel; flow-through ` +
            `targets must be hosted, remote or builtin servers`,
          path: [...at, "slug"],
        });
      }
      // BOUNDED BY THE TARGET'S OWN POLICY, checked here rather than only at
      // call time so the grant as written is the grant that works.
      const policy = policyOf(target);
      grant.tools.forEach((tool, k) => {
        if (!toolAllowed(policy, tool)) {
          issues.push({
            message:
              `${source.slug} reaches ${grant.slug} tool "${tool}", which ` +
              `${grant.slug}'s own tools: policy withholds`,
            path: [...at, "tools", k],
          });
        }
      });
    });
  });

  // THE OTHER DIRECTION: a `reachableFrom:` entry nobody's `reaches:` matches is
  // consent to nothing, most likely a typo in one of the two halves.
  cfg.servers.forEach((target, i) => {
    target.reachableFrom.forEach((sourceSlug, j) => {
      const source = bySlug.get(sourceSlug);
      const matched = (source?.reaches ?? []).some(
        (g) => g.slug === target.slug,
      );
      if (!matched) {
        issues.push({
          message:
            `${target.slug} lists ${sourceSlug} under reachableFrom:, but ` +
            `${sourceSlug} declares no reaches: grant for it`,
          path: ["servers", i, "reachableFrom", j],
        });
      }
    });
  });

  return issues;
}

/**
 * The grants a source may exercise right now, on the config in hand.
 *
 * Every rule that decides REACH is re-derived here rather than trusted to
 * `reachIssues`, which only CI runs: the target exists, is enabled, is not a
 * local-tunnel, consents by name, and reaches nothing itself. A grant failing
 * any of them is simply inactive — which is also what a runtime removal of
 * either half produces.
 */
export function activeGrants(
  cfg: ReachConfigView,
  sourceSlug: string,
): ReachGrantView[] {
  const source = cfg.servers.find((s) => s.slug === sourceSlug);
  if (!source?.enabled) return [];
  return (source.reaches ?? []).filter((g) => {
    const target = cfg.servers.find((s) => s.slug === g.slug);
    return (
      target !== undefined &&
      target.slug !== sourceSlug &&
      target.enabled &&
      target.kind !== "local-tunnel" &&
      target.reachableFrom.includes(sourceSlug) &&
      (target.reaches ?? []).length === 0
    );
  });
}

/**
 * The tool policy a reach session runs under, per target: the grant's own list,
 * intersected with the target's `tools:` policy. The intersection is repeated
 * here, not only trusted to the schema, because the route builds from whatever
 * config it was handed.
 */
export function reachPolicies(
  cfg: ReachConfigView,
  grants: readonly ReachGrantView[],
): Map<string, ToolPolicy> {
  const out = new Map<string, ToolPolicy>();
  for (const grant of grants) {
    const target = cfg.servers.find((s) => s.slug === grant.slug);
    const policy = target ? policyOf(target) : undefined;
    out.set(grant.slug, {
      allow: new Set(grant.tools.filter((t) => toolAllowed(policy, t))),
    });
  }
  return out;
}

export type ArgumentPins = ReadonlyMap<
  string,
  Readonly<Record<string, string | number | boolean>>
>;

/** Pins per target slug, for `buildGatewayServer`. Targets with none get no entry. */
export function reachPins(grants: readonly ReachGrantView[]): ArgumentPins {
  const out = new Map<string, Record<string, string | number | boolean>>();
  for (const grant of grants) {
    if (Object.keys(grant.pin).length > 0) out.set(grant.slug, grant.pin);
  }
  return out;
}

/**
 * The first pinned argument this call does not honour, or null.
 *
 * Exact and strict: a missing argument is a violation, and `"1"` is not `1`.
 * Nothing is normalised, because every normalisation is a second spelling of
 * the pinned value that the target might read differently — the Sheets tools
 * take a bare id OR a URL, and only the spelling the grant names is the one it
 * was reviewed for.
 */
export function pinViolation(
  pin: Readonly<Record<string, string | number | boolean>> | undefined,
  args: Record<string, unknown>,
): string | null {
  if (!pin) return null;
  for (const [name, value] of Object.entries(pin)) {
    if (!Object.hasOwn(args, name) || args[name] !== value) return name;
  }
  return null;
}
