import type { StradConfig } from "../config/schema.ts";
import {
  compileToolPolicies,
  unmatchedAllowEntries,
  unmatchedDenyEntries,
} from "../gateway/toolPolicy.ts";
import { parseImage, sameRepository } from "./appspec.ts";

/**
 * Does every `tools:` entry in a config name a tool the mount really serves?
 *
 * ## The failure this catches
 *
 * An `allow` list is exhaustive and fail-closed, which is what makes it a
 * capability boundary and what makes a typo in it invisible: `list_email_conversation`
 * for `list_email_conversations` does not error, it silently narrows that slug's
 * surface by one. So does a rename upstream — every `remote-filesystem-tmp-public`
 * tool but `list_files` was renamed in one PR, and a config naming the old names
 * would have filtered the surface down to almost nothing, quietly, in prod.
 *
 * The gateway already says so, at runtime: `unmatchedAllowEntries()` runs on
 * every `tools/list` and emits `mcp.policy_unmatched_tools`. That is detection
 * AFTER a deploy. This is the same predicate, joined to a booted container's real
 * tool names before one.
 *
 * ## Why both halves already exist, and only the join is new
 *
 * CI builds the bundle image, boots it and lists every mount's tools (the smoke
 * test), and CI parses every config in the repo (the config check). They run in
 * separate jobs that never meet. `checkToolSurface` is the meeting: the observed
 * names on one side, `config.servers[].tools` on the other, matched per mount.
 *
 * ## What it must NOT do
 *
 * Fail on a slug whose tools it could not enumerate. A check that reddens a good
 * PR because a mount is behind a credential CI does not hold, or lives on a
 * server CI cannot reach, is a check somebody disables. Every such slug is
 * SKIPPED with a reason, and the reason is reported as loudly as a finding —
 * "not covered" and "covered and clean" must never look alike.
 */

/** One mount of the booted image, as observed. */
export interface ObservedMount {
  /** Tool names it listed. Absent when it could not be enumerated at all. */
  tools?: readonly string[];
  /**
   * Set when this container shows a FLOOR rather than the whole surface, and
   * why. A credential-free probe, an env var that hides tools, a browser server
   * whose surface follows the app it drives. An unmatched entry against a floor
   * is not evidence of a typo, so these are skipped.
   */
  partial?: string;
  /** Set when listing threw: the message. */
  error?: string;
}

/** What one booted image serves, by mount path (`/gmail`). */
export interface ObservedSurface {
  /**
   * The image these mounts came from. Config servers on any other image are
   * skipped — a `path: /gcs` on someone else's image is not this `/gcs`.
   *
   * The observer does not know its own image ref (it runs INSIDE the container),
   * so the caller asserts this identity. Compared with `sameRepository()` — the
   * registry, the owner and the repository, and not the TAG, because a booted
   * image's tag is not the config's tag: CI builds a per-run
   * `strad-bundle:ci-<run>` and every config names `strad-bundle:latest`. The
   * owner is half of it: `ghcr.io/someone-else/strad-bundle` shares a repository
   * name with this image and is not it.
   */
  image: string;
  mounts: Readonly<Record<string, ObservedMount>>;
}

/** A `tools:` entry that names nothing the mount serves. The finding. */
export interface PolicyFinding {
  slug: string;
  mount: string;
  /**
   * `reach` is a flow-through grant's `tools:` entry (src/config/reach.ts):
   * `slug` is then the SOURCE, and `mount` the target's.
   */
  kind: "allow" | "deny" | "reach";
  /** The entry as written in the config. */
  entry: string;
  /** The closest name the mount does serve, when there is an obvious one. */
  nearest?: string;
  /** How many tools the mount served, for the "is this even the right mount" case. */
  offered: number;
}

/** A slug whose policy was not checked, and the reason it was not. */
export interface SkippedPolicy {
  slug: string;
  reason: string;
}

export interface CheckedPolicy {
  slug: string;
  mount: string;
  /** Entries matched — allow plus deny. */
  entries: number;
}

export interface ToolSurfaceCheckResult {
  checked: CheckedPolicy[];
  skipped: SkippedPolicy[];
  findings: PolicyFinding[];
}

/**
 * Match every `tools:` policy in the config against what the image serves.
 *
 * Servers with no `tools:` block appear in neither list: there is no entry to be
 * wrong, and reporting them as "checked" would inflate the coverage this returns.
 */
export function checkToolSurface(
  config: StradConfig,
  surface: ObservedSurface,
): ToolSurfaceCheckResult {
  const policies = compileToolPolicies(config);
  const observedImage = parseImage(surface.image);

  const checked: CheckedPolicy[] = [];
  const skipped: SkippedPolicy[] = [];
  const findings: PolicyFinding[] = [];

  /** What this image lists at a server's mount, or why that cannot be known. */
  const observe = (
    server: StradConfig["servers"][number],
  ): { offered: readonly string[] } | { reason: string } => {
    if (server.kind !== "supplementary-image") {
      return {
        reason: `kind: ${server.kind} — not a mount of ${surface.image}, and nothing here can list its tools`,
      };
    }
    if (!sameRepository(parseImage(server.image), observedImage)) {
      return {
        reason: `runs ${server.image}, not ${surface.image} — a different image's ${server.path} is not this one`,
      };
    }
    const observed = surface.mounts[server.path];
    if (!observed) {
      return {
        reason: `${surface.image} mounts nothing at ${server.path} (it mounts ${Object.keys(surface.mounts).sort().join(", ")})`,
      };
    }
    if (observed.error !== undefined) {
      return {
        reason: `${server.path} would not list its tools: ${observed.error}`,
      };
    }
    if (observed.partial !== undefined) {
      return {
        reason: `${server.path} shows a partial surface here — ${observed.partial}`,
      };
    }
    if (!observed.tools) {
      return { reason: `${server.path} reported no tool list at all` };
    }
    return { offered: observed.tools };
  };

  for (const server of config.servers) {
    const policy = policies.get(server.slug);
    if (!policy) continue;

    const seen = observe(server);
    if ("reason" in seen) {
      skipped.push({ slug: server.slug, reason: seen.reason });
      continue;
    }
    const offered = seen.offered;
    const mount = (server as { path: string }).path;
    for (const kind of ["allow", "deny"] as const) {
      const unmatched =
        kind === "allow"
          ? unmatchedAllowEntries(policy, offered)
          : unmatchedDenyEntries(policy, offered);
      for (const entry of unmatched) {
        findings.push({
          slug: server.slug,
          mount,
          kind,
          entry,
          nearest: nearestName(entry, offered),
          offered: offered.length,
        });
      }
    }

    checked.push({
      slug: server.slug,
      mount,
      entries: (policy.allow?.size ?? 0) + (policy.deny?.size ?? 0),
    });
  }

  // FLOW-THROUGH GRANTS. A grant's tool list is exhaustive like an `allow:`,
  // so a typo in it silently grants one tool fewer. Checked against the
  // TARGET's mount; the source may run on any image.
  for (const source of config.servers) {
    if (source.kind !== "supplementary-image") continue;
    for (const grant of source.reaches) {
      const target = config.servers.find((s) => s.slug === grant.slug);
      if (!target) continue; // the schema refuses this already
      const label = `${source.slug} → ${grant.slug}`;
      const seen = observe(target);
      if ("reason" in seen) {
        skipped.push({ slug: label, reason: seen.reason });
        continue;
      }
      const have = new Set(seen.offered);
      const mount = (target as { path: string }).path;
      for (const entry of grant.tools.filter((t) => !have.has(t))) {
        findings.push({
          slug: source.slug,
          mount,
          kind: "reach",
          entry,
          nearest: nearestName(entry, seen.offered),
          offered: seen.offered.length,
        });
      }
      checked.push({ slug: label, mount, entries: grant.tools.length });
    }
  }

  return { checked, skipped, findings };
}

/**
 * The observer's document, validated.
 *
 * Zero mounts is a THROW, not an empty result: a dump that enumerated nothing
 * joins to nothing, and a check that silently covers nothing while exiting 0 is
 * the state this whole thing exists to end.
 */
export function parseObservedMounts(
  document: unknown,
): Readonly<Record<string, ObservedMount>> {
  if (typeof document !== "object" || document === null) {
    throw new Error("expected a JSON object");
  }
  const mounts = (document as { mounts?: unknown }).mounts;
  // `Array.isArray` explicitly: an array is a `typeof "object"`, and one would
  // survive as mounts keyed "0", "1", … — inert, because no config `path:` is
  // ever a bare index, and therefore a document that looks checked and is not.
  if (typeof mounts !== "object" || mounts === null || Array.isArray(mounts)) {
    throw new Error("expected a `mounts` object keyed by mount path");
  }

  const parsed: Record<string, ObservedMount> = {};
  for (const [path, value] of Object.entries(
    mounts as Record<string, unknown>,
  )) {
    if (typeof value !== "object" || value === null) {
      throw new Error(`mount ${path}: expected an object`);
    }
    const { tools, partial, error } = value as Record<string, unknown>;
    if (
      tools !== undefined &&
      !(Array.isArray(tools) && tools.every((t) => typeof t === "string"))
    ) {
      throw new Error(`mount ${path}: \`tools\` must be an array of names`);
    }
    if (partial !== undefined && typeof partial !== "string") {
      throw new Error(
        `mount ${path}: \`partial\` must be the reason, as a string`,
      );
    }
    if (error !== undefined && typeof error !== "string") {
      throw new Error(`mount ${path}: \`error\` must be a string`);
    }
    parsed[path] = {
      ...(tools ? { tools: tools as string[] } : {}),
      ...(partial ? { partial } : {}),
      ...(error ? { error } : {}),
    };
  }

  if (Object.keys(parsed).length === 0) {
    throw new Error("no mounts in the document — nothing could be checked");
  }
  return parsed;
}

/**
 * One line an operator can act on without opening anything.
 *
 * It names the slug, the entry and the mount, because "allow-list mismatch"
 * costs exactly the time this check is meant to save — and it names the near
 * miss, because the two shapes this catches are a typo and a rename, and both
 * have one.
 */
export function formatFinding(finding: PolicyFinding): string {
  const nearest = finding.nearest
    ? ` Did you mean "${finding.nearest}"?`
    : ` The ${finding.offered} tool(s) it does serve are listed above.`;
  return (
    `server "${finding.slug}": ` +
    (finding.kind === "reach"
      ? `a reaches: grant names "${finding.entry}", `
      : `tools.${finding.kind} names "${finding.entry}", `) +
    `which ${finding.mount} does not serve.${nearest}`
  );
}

/**
 * The closest served name, when one is close enough to be worth naming.
 *
 * A rename or a typo lands within a few edits; anything further is noise, and a
 * confidently wrong suggestion is worse than none. The threshold scales with the
 * name's length so `get_key` and `get_keys` count as near while two unrelated
 * short names do not — hence the floor of ONE rather than two: two edits on a
 * three-character name reaches most other three-character names.
 */
function nearestName(
  entry: string,
  offered: readonly string[],
): string | undefined {
  const limit = Math.max(1, Math.floor(entry.length / 3));
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const name of offered) {
    const distance = editDistance(entry, name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return bestDistance <= limit ? best : undefined;
}

/** Levenshtein, two rows wide. Names are short; this runs over tens of them. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
