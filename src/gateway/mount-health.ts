import type { StradConfig } from "../config/schema.ts";
import { bundleUrlEnvName } from "./registry.ts";

/**
 * What each bundle says about its own mounts, read by core.
 *
 * ## Why this exists
 *
 * A mount can list its tools perfectly and fail every call. fetchpet's login
 * selector went stale when Fetch redesigned its form, and the mount spent weeks
 * in both environments listing four tools and answering `Login failed` to every
 * one (strad#28); good-eggs did the same in prod on 2026-08-28 (strad#195). Tool
 * lists are static and a login is not, so the tool-surface probe
 * (gateway/reachability.ts) read `ok` the whole time. The bundle KNEW: its own
 * `/healthz` carries a per-mount `degraded` string for exactly this
 * (`servers/bundle/host/src/index.ts`). Nothing read it — not core, not the
 * staging deploy, not a metric — so the only symptom was a stdout WARN on a
 * stream that reaches nobody (HACKS.md #37).
 *
 * This is the reading. The monitor calls it on the same interval as the
 * tool-surface probe, and turns the answer into a gauge, a change-triggered
 * event, and a slug list on core's `/healthz` the staging deploy annotates.
 *
 * ## The boundary: the bundle's words stop here
 *
 * The `degraded` value is text core did not author. It is
 * `login failed: ${error.message}` — a browser automation library's message,
 * quoting whatever page it failed on — or `refresh token invalid: …`, or a
 * sentence naming missing variables. None of it may leave the process, and the
 * way this file makes that true is STRUCTURAL rather than a filter:
 * `parseBundleHealth` reads the value for its truthiness and nothing else, so no
 * reason string survives past the parse. Everything downstream — the gauge, the
 * events, `/healthz`, the deploy annotation — is built from three things this
 * repo wrote down: a slug and a bundle name from the CONFIG, and one of the two
 * words in `MountState`.
 *
 * The same holds for the bundle's own slugs and paths. They are only ever used
 * as LOOKUP KEYS against paths core already routes to; a mount the bundle
 * reports and core does not route to is ignored rather than named, so a bundle
 * cannot mint a slug, a series, or a log field of its choosing.
 *
 * ## Why a boolean, and not a classification
 *
 * The obvious richer shape is a closed set — `login_failed`,
 * `credential_missing`, `token_invalid` — and it is deliberately not this one.
 *
 * - The bundle does not send a classification; it sends prose. Deriving one here
 *   means pattern-matching that prose, so the class would be decided by an
 *   upstream's error message: safe to export, because the output is still one of
 *   our words, but wrong whenever a login error happens to say "not set". A
 *   faithful class has to be authored where `degraded` is SET, per mount, in the
 *   bundle host — which is the harder half HACKS.md #40 leaves open, because
 *   "degraded" means something different per server.
 * - It would have to be an ATTRIBUTE, and a varying attribute is the trap
 *   reachability.ts documents for `state`: under cumulative temporality every
 *   attribute set ever recorded is re-exported at its last value forever, so a
 *   `class="login_failed"` series minted once would outlive the recovery.
 * - Nothing gates on it. The deploy annotates and an alert pages; for both,
 *   "this mount says it is not working" is the whole signal, and the WHY is one
 *   read of the bundle's own `/healthz` or log away from whoever acts on it.
 */

export interface MountTarget {
  /** The core slug. From the config. */
  slug: string;
  /** The component that hosts it. From the config. */
  bundle: string;
  /** The path core routes the slug to on that component. From the config. */
  path: string;
}

/** What a bundle reports about one mount — reduced to one of two words. */
export type MountState = "ok" | "degraded";

/**
 * How reading one bundle's report went.
 *
 * `unreachable` is no answer inside the deadline, or a non-2xx status.
 * `unrecognised` is a 2xx whose body is not a bundle host's report — a
 * standalone supplementary image, or a bundle whose `/healthz` shape moved.
 * `unwired` is no private URL bound for the component, which a core registry
 * refuses to boot with, so it is here for the probe's own honesty rather than
 * because a live deployment produces it.
 */
export type BundleReportOutcome =
  "ok" | "unwired" | "unreachable" | "unrecognised";

export interface MountHealthReading {
  /**
   * config slug -> what its bundle reports. ONLY the slugs whose bundle
   * answered and listed the path; a slug with no reading this probe is absent,
   * not `ok`.
   */
  mounts: Map<string, MountState>;
  /** bundle -> how reading its report went. */
  bundles: Map<string, BundleReportOutcome>;
}

export interface MountHealthOptions {
  targets: MountTarget[];
  env: NodeJS.ProcessEnv;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-bundle deadline, covering the body read as well as the headers. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Every enabled `supplementary-image` slug, and where core routes it.
 *
 * Several slugs can share one path — the capability variants (`gmail-ro`,
 * `gmail-rw`, `gmail-rw-external`) are one mount in one container — and each
 * gets its own reading, so the gauge joins `strad.mcp.tool_surface` slug for
 * slug.
 */
export function mountTargets(config: StradConfig): MountTarget[] {
  const out: MountTarget[] = [];
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    out.push({ slug: server.slug, bundle: server.bundle, path: server.path });
  }
  return out;
}

/**
 * Read every bundle's `/healthz` concurrently and map it onto the targets.
 *
 * One request per BUNDLE, not per slug: the report covers every mount, and two
 * components answer for the whole staging fleet.
 *
 * Never throws. A bundle that cannot be read is an outcome, not an exception —
 * the monitor calling this must keep reporting whatever else it saw.
 */
export async function probeMountHealth(
  opts: MountHealthOptions,
): Promise<MountHealthReading> {
  const byBundle = new Map<string, MountTarget[]>();
  for (const target of opts.targets) {
    const list = byBundle.get(target.bundle) ?? [];
    list.push(target);
    byBundle.set(target.bundle, list);
  }

  const mounts = new Map<string, MountState>();
  const bundles = new Map<string, BundleReportOutcome>();

  const results = await Promise.all(
    [...byBundle.keys()].map(
      async (bundle) => [bundle, await readBundle(bundle, opts)] as const,
    ),
  );

  for (const [bundle, result] of results) {
    bundles.set(bundle, result.outcome);
    if (result.outcome !== "ok") continue;
    for (const target of byBundle.get(bundle) ?? []) {
      const degraded = result.report.get(normalisePath(target.path));
      if (degraded === undefined) continue;
      mounts.set(target.slug, degraded ? "degraded" : "ok");
    }
  }

  return { mounts, bundles };
}

type BundleRead =
  | { outcome: "ok"; report: Map<string, boolean> }
  | { outcome: Exclude<BundleReportOutcome, "ok"> };

async function readBundle(
  bundle: string,
  opts: MountHealthOptions,
): Promise<BundleRead> {
  const base = opts.env[bundleUrlEnvName(bundle)];
  if (!base) return { outcome: "unwired" };

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    // No internal token. The bundle serves `/healthz` outside its token gate on
    // purpose — App Platform's prober holds none — so a credential sent here is
    // checked by nobody and only travels further than it has to.
    const res = await doFetch(`${base.replace(/\/$/, "")}/healthz`, {
      signal: controller.signal,
    });
    if (!res.ok) return { outcome: "unreachable" };
    // Inside the deadline, not after it: a component that sends its headers and
    // trickles the body is the stall a headers-only bound does not catch.
    const report = parseBundleHealth(await res.json());
    return report ? { outcome: "ok", report } : { outcome: "unrecognised" };
  } catch (err) {
    // A body that is not JSON answered, but not as a bundle host; anything else
    // (a refused connection, the deadline) is no answer at all.
    return err instanceof SyntaxError
      ? { outcome: "unrecognised" }
      : { outcome: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A bundle host's `/healthz` body -> `path -> is it degraded`, or null.
 *
 * THE BOUNDARY. `degraded` is read for its truthiness — the host includes it
 * only when it holds a reason — and the reason itself is never stored, returned
 * or logged. See the header.
 *
 * Null when `servers` is not an array: that is not a bundle host's report, and
 * reading "no mounts" into it would be a confident answer about nothing. An
 * individual entry without a string `path` is skipped rather than failing the
 * report, because one odd entry says nothing about the other twenty-one.
 */
export function parseBundleHealth(body: unknown): Map<string, boolean> | null {
  if (typeof body !== "object" || body === null) return null;
  const servers = (body as Record<string, unknown>).servers;
  if (!Array.isArray(servers)) return null;

  const out = new Map<string, boolean>();
  for (const entry of servers) {
    if (typeof entry !== "object" || entry === null) continue;
    const { path, degraded } = entry as Record<string, unknown>;
    if (typeof path !== "string") continue;
    out.set(normalisePath(path), Boolean(degraded));
  }
  return out;
}

/** `/gmail/` and `/gmail?x=1` route to the same mount as `/gmail`. */
function normalisePath(path: string): string {
  const bare = path.split("?")[0]!.replace(/\/+$/, "");
  return bare === "" ? "/" : bare;
}
