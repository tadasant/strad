import { event } from "../telemetry/events.ts";
import { instruments } from "../telemetry/instruments.ts";
import {
  LocalHostRefusedError,
  LocalMachineOfflineError,
} from "./adapters/http.ts";
import type { ServerAdapter } from "./adapters/types.ts";
import {
  probeMountHealth,
  type BundleReportOutcome,
  type MountHealthOptions,
  type MountHealthReading,
  type MountState,
} from "./mount-health.ts";
import type { Registry } from "./registry.ts";
import { ServerUnconfiguredError } from "./unconfigured.ts";
import { DeadlineError, withDeadline } from "../util/deadline.ts";
import { errorText } from "../util/error-text.ts";

/**
 * Does each mounted server actually serve tools?
 *
 * ## Why this exists
 *
 * A slug can be configured, entitled, routed and completely dead, and until this
 * file the only way to find out was to hold a token and poll `tools/list`.
 * `/healthz` answered 200 with every slug listed while three of them served
 * nothing: staging's `bundle` was running an image that predated the `/secrets`
 * mount, so core POSTed to `/secrets` and Express answered `404 Cannot POST
 * /secrets` — and `listToolsFor` turned that into an empty list and a 200.
 *
 * A deployment being wrong in a way that no signal reports is worse than one
 * that is loudly wrong, so this turns "the slug serves nothing" into an
 * observation an operator, a health check and a deploy job can all read.
 *
 * ## Four states, because they call for different actions
 *
 * `unreachable` is an outage or a routing fault — the upstream refused, 404'd or
 * timed out. `empty` is a server that answered and offered no tools, which is
 * legal but is nearly always a credential the upstream declined to grant, on a
 * server that derives its tool surface from a live IAM probe (see
 * servers/secrets/shared/src/capabilities.ts). `ok` is a slug with a tool on it.
 * Collapsing the first two into "unhealthy" would send someone to the wrong page.
 *
 * `unconfigured` is the fifth, and like `offline` it is NOT a degraded state —
 * for the opposite reason. A slug whose `mayBeUnseeded:` credential has not been
 * seeded yet is a deploy that shipped AHEAD of a token, on purpose
 * (src/deploy/unseeded.ts): nothing is down, no component is misrouted, and no
 * amount of restarting or re-probing will change it. Counting it as `degraded`
 * would put it in the list the staging deploy gate asserts on and red the deploy
 * that the whole feature exists to let through — reinstating the fleet-wide
 * failure one layer further down. It is instead named on its own, in the
 * snapshot's `unconfigured` list, where a human can see exactly which slugs are
 * waiting on which credential.
 *
 * `offline` is the fourth, and it is NOT a degraded state. A `local-tunnel`'s
 * machine being switched off is the advertised behaviour of that kind rather
 * than a fault, the slug stays connectable while it lasts (it serves
 * `troubleshoot_host` — see gateway/troubleshoot.ts), and there is no component,
 * image or path for anyone to go and check. Reporting it as `unreachable`
 * answered a question nobody asked: it put a laptop somebody had shut into the
 * same bucket as a bundle that will not start, so a fleet with one sleeping
 * machine in it never read as healthy. It therefore stays OUT of `degraded`.
 *
 * A host that REFUSES is not this. It is answering, a credential has gone stale,
 * and it will not clear until somebody rotates it — so it keeps `unreachable`
 * and keeps counting as degraded.
 *
 * `kind` rides along because the kinds are not equally actionable: a
 * `supplementary-image` that cannot be reached is a component WE deploy and is a
 * deploy failure, while a `remote-http` on the public internet having a bad
 * afternoon is somebody else's. The deploy gate filters on it.
 *
 * ## What it will not do
 *
 * **It will not fail liveness.** App Platform restarts a component whose health
 * check fails, and restarting core because a third party is down helps nobody.
 * `/healthz` reports this snapshot and stays 200; the snapshot is what a deploy
 * job asserts on.
 *
 * **It will not carry an upstream's prose.** A failed probe's message is logged
 * here, where it is one of ours to read, and is NOT put in the snapshot: the
 * snapshot is served on a public, unauthenticated route, and the message on the
 * probe that motivated this file was a whole HTML error page from someone else's
 * Express. Same rule as gateway/bundle-presence.ts — the status, not the body.
 * What IS public is a state word and a count, about slugs `/healthz` already
 * named; the tool NAMES still require a token.
 *
 * **It does not apply the `tools:` policy.** This measures what the UPSTREAM
 * serves, not what a given slug's clients see, so a slug whose allow-list
 * filtered every tool away reads `ok` here. That case has its own signal —
 * `mcp.policy_unmatched_tools` on the listing path — and conflating the two
 * would make one number answer two questions.
 *
 * **It cannot see a mount that lists and then fails every call.** A stale login
 * does exactly that, and only the bundle knows — so, in core, the monitor also
 * reads each bundle's own report on the same interval (gateway/mount-health.ts)
 * and carries it BESIDE the surface state, as `mount` and `mountDegraded`. Beside
 * and never inside: `degraded` here is "serves no tools" and is what the deploy
 * gate and the fast retry key on; a mount that says it is unwell is neither.
 */

export type SurfaceState =
  "ok" | "empty" | "unreachable" | "offline" | "unconfigured";

export interface ToolSurface {
  slug: string;
  state: SurfaceState;
  /** How many tools the slug offered. Zero for anything but `ok`. */
  tools: number;
  /** Ours to fix, or a third party's. See the header. */
  kind: ServerAdapter["kind"] | "unmounted";
  /**
   * What the bundle hosting this slug's mount says about it, reduced to one of
   * two words. Absent when there is no reading: not a `supplementary-image`,
   * not core, or a bundle that could not be read this probe.
   */
  mount?: MountState;
}

export interface ToolSurfaceSnapshot {
  observedAt: string;
  surfaces: ToolSurface[];
  /**
   * The slugs something is WRONG with, for a caller that wants one field to
   * test.
   *
   * Not simply "everything that is not `ok`": an `offline` local-tunnel is
   * excluded, because its machine being off is that kind's normal state and the
   * slug is still connectable. Anything in this list is a thing to go and look
   * at; a sleeping laptop is not. The per-slug `state` still says what is true,
   * so nothing is hidden — it just stops being reported as a problem.
   */
  degraded: string[];
  /**
   * The slugs waiting on a credential a human has not seeded yet.
   *
   * Separate from `degraded` (nothing is broken) and separate from the per-slug
   * `state` (which a caller would have to filter for), because this is the one
   * list an operator acts on directly: each entry is a slug that will start
   * serving the moment a value lands in the store, and nothing else will make it.
   * On `/healthz` beside `degraded`, so "which slugs are waiting on a token" is
   * one unauthenticated read rather than a console login.
   *
   * Slugs only. WHICH `${NAME}` is missing is in the logs and in the console —
   * `/healthz` is public, and a secret name is a fact about a deployment that a
   * public route has no reason to publish.
   */
  unconfigured: string[];
  /**
   * The slugs whose bundle reports their mount degraded — serving a tool list,
   * and saying (a failed login, a missing credential) that calls will fail.
   *
   * Its own list, and NOT folded into `degraded`, for the reason `unconfigured`
   * is not: the deploy gate asserts on the surface state, and "degraded" means a
   * different thing per server (HACKS.md #40), so it is reported and never
   * gated on. Slugs only — the bundle's reason is dropped where it is parsed.
   * Absent when nothing reads the bundles: a bundle-mode process, or a test.
   *
   * Degraded AMONG THE MOUNTS READ this probe — which is why `mountUnread` sits
   * beside it.
   */
  mountDegraded?: string[];
  /**
   * The `supplementary-image` slugs with no mount reading this probe: their
   * bundle could not be read, or did not list their path. Without it, a bundle
   * whose report went unreadable would publish an empty `mountDegraded` — "all
   * clear" about mounts nobody looked at. Slugs only, like its neighbours.
   */
  mountUnread?: string[];
}

export interface ProbeOptions {
  registry: Registry;
  /** Which slugs to probe. Defaults to everything the registry mounted. */
  slugs?: string[];
  /** Per-slug deadline. One wedged upstream must not stall the snapshot. */
  timeoutMs?: number;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Probe every slug concurrently and classify what came back.
 *
 * Never throws: a probe that cannot run is an observation, not an exception. The
 * whole point is that the caller gets an answer it can report rather than a
 * failure it has to swallow.
 */
export async function probeToolSurfaces(opts: ProbeOptions): Promise<{
  snapshot: ToolSurfaceSnapshot;
  failures: Map<string, string>;
  /**
   * The slugs whose machine ANSWERED and refused strad's credentials.
   *
   * Kept apart from `failures` because the two lead an operator to different
   * places, and this one is the only local-tunnel failure that will not fix
   * itself: an offline laptop comes back when somebody opens it, and a stale
   * access token stays stale. It is not on the snapshot — that is served
   * unauthenticated on `/healthz`, and `unreachable` is all a public reader
   * needs. See the reason text in `refresh()`.
   */
  refused: Set<string>;
  /**
   * `slug -> the ${NAME}s it is waiting on`, for the slugs that are
   * `unconfigured`.
   *
   * Kept off the snapshot deliberately. `/healthz` is unauthenticated, and a
   * secret NAME is a fact about a deployment that a public route has no reason
   * to publish — the snapshot's `unconfigured` list of slugs is all a public
   * reader needs. These names come from strad's own config and go to the log
   * line, where the human who has to seed them is the only reader.
   */
  unconfigured: Map<string, string[]>;
}> {
  const slugs = opts.slugs ?? opts.registry.slugs;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures = new Map<string, string>();
  const refused = new Set<string>();
  const unconfigured = new Map<string, string[]>();

  const surfaces = await Promise.all(
    slugs.map(async (slug): Promise<ToolSurface> => {
      const adapter = opts.registry.get(slug);
      if (!adapter) {
        failures.set(slug, "the registry mounted no adapter for this slug");
        return { slug, state: "unreachable", tools: 0, kind: "unmounted" };
      }
      try {
        // A deadline the adapter does not impose on itself.
        // `HttpServerAdapter` passes `timeoutMs` to the MCP SDK, but a builtin
        // has no timeout at all and a transport can wedge before the SDK's timer
        // is armed. A monitor that can hang is a monitor that stops reporting,
        // which is the failure mode it exists to catch.
        const tools = await withDeadline(
          () => adapter.listTools(),
          timeoutMs,
          "tools/list",
        );
        return {
          slug,
          state: tools.length > 0 ? "ok" : "empty",
          tools: tools.length,
          kind: adapter.kind,
        };
      } catch (err) {
        // FIRST, and by class rather than by message: this error is raised inside
        // the endpoint thunk before any transport work happens, so it can never
        // be a symptom of a machine being off — and it is not a FAILURE either,
        // so it stays out of `failures`, which is the map of things that went
        // wrong. The names go to `unconfigured` instead.
        if (err instanceof ServerUnconfiguredError) {
          unconfigured.set(slug, err.names);
          return { slug, state: "unconfigured", tools: 0, kind: adapter.kind };
        }
        failures.set(slug, errorText(err));
        if (err instanceof LocalHostRefusedError) refused.add(slug);
        // A machine somebody switched off gets its own state and is NOT
        // degraded — see the header. Narrowed to the OFFLINE error rather than
        // to the kind: a local-tunnel that 404s or refuses is a real fault on a
        // machine that is answering, and calling that "offline" would hide it.
        //
        // `withDeadline` expiring on a local-tunnel counts as offline too, and
        // has to: that deadline and the adapter's `connectTimeoutMs` are set
        // independently, so a config raising the second above the first makes
        // OURS fire first — with a plain Error, on exactly the switched-off
        // laptop the adapter was about to describe properly. Without this the
        // verdict would silently depend on which of two unrelated numbers is
        // larger.
        const offline =
          err instanceof LocalMachineOfflineError ||
          (adapter.kind === "local-tunnel" && err instanceof DeadlineError);
        return {
          slug,
          state: offline ? "offline" : "unreachable",
          tools: 0,
          kind: adapter.kind,
        };
      }
    }),
  );

  return {
    snapshot: {
      observedAt: (opts.now?.() ?? new Date()).toISOString(),
      surfaces,
      degraded: surfaces
        .filter(
          (s) =>
            s.state !== "ok" &&
            s.state !== "offline" &&
            s.state !== "unconfigured",
        )
        .map((s) => s.slug),
      unconfigured: surfaces
        .filter((s) => s.state === "unconfigured")
        .map((s) => s.slug),
    },
    failures,
    refused,
    unconfigured,
  };
}

/**
 * The tool-surface snapshot, with each bundle's report on its mounts beside it.
 *
 * Beside, and nothing else moves: `state`, `degraded` and `unconfigured` are
 * exactly what the probe found. A mount that says it is unwell while it lists
 * its tools is `ok` there and `degraded` here, and both are true.
 */
export function withMountHealth(
  snapshot: ToolSurfaceSnapshot,
  reading: MountHealthReading,
): ToolSurfaceSnapshot {
  const surfaces = snapshot.surfaces.map((surface) => {
    const mount = reading.mounts.get(surface.slug);
    return mount ? { ...surface, mount } : surface;
  });
  return {
    ...snapshot,
    surfaces,
    mountDegraded: surfaces
      .filter((s) => s.mount === "degraded")
      .map((s) => s.slug),
    mountUnread: reading.unread,
  };
}

export interface MonitorOptions extends ProbeOptions {
  /** How often to re-probe when everything is serving. */
  intervalMs?: number;
  /**
   * How soon to re-probe while something is degraded.
   *
   * Shorter than `intervalMs` on purpose: the common degraded moment is the
   * seconds after a deploy, when core is up and a bundle is not yet, and a
   * deploy job asserting on this should not have to wait out a steady-state
   * interval to watch it converge.
   */
  retryIntervalMs?: number;
  /**
   * How many consecutive degraded probes get the fast interval before it gives
   * up and falls back to `intervalMs`.
   *
   * Bounded, because the fast interval exists for a deploy converging in the
   * next couple of minutes — not for a fault that lasts a week. The one that
   * motivated this file lasted seven days; at 10s and no bound that is 60,000
   * `tools/list` round trips, most of them at third parties, to re-learn a fact
   * nothing had changed.
   */
  retryProbes?: number;
  /**
   * Which bundles to ask about their own mounts, alongside every probe.
   *
   * Core only: it is the process that routes `supplementary-image` slugs and
   * holds the bundles' private URLs. Absent, nothing is asked and the snapshot
   * carries no `mountDegraded`. See gateway/mount-health.ts.
   */
  mounts?: MountHealthOptions;
  log?: (event: Record<string, unknown>) => void;
  warn?: (event: Record<string, unknown>) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RETRY_INTERVAL_MS = 10_000;
/** ~2 minutes of fast retries, which covers a deploy and not much else. */
const DEFAULT_RETRY_PROBES = 12;

/**
 * Keeps a current answer to "which slugs serve nothing", and says so out loud.
 *
 * Polled rather than computed on request, because `/healthz` is App Platform's
 * liveness probe and must not wait on 27 upstreams — it reads the last snapshot
 * and returns immediately.
 *
 * Everything it logs is on CHANGE, not on every tick — a per-slug line when a
 * slug's state moves, and the summary when the degraded SET moves. A slug that
 * has been dead for six hours should not have written 2,000 identical lines, and
 * the current state is readable from `/healthz` at any time anyway. The first
 * probe always logs both, so a boot that comes up degraded says so in the logs
 * of that boot.
 */
export class ToolSurfaceMonitor {
  private current: ToolSurfaceSnapshot | null = null;
  private previous = new Map<string, SurfaceState>();
  /** Last KNOWN mount state per slug — kept across a probe with no reading. */
  private previousMount = new Map<string, MountState>();
  private previousReport = new Map<string, BundleReportOutcome>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /**
   * Bumped by every start()/stop(). A tick from a previous run whose refresh()
   * was still in flight when stop() landed would otherwise re-arm itself against
   * a monitor that has since been restarted, and the two chains would both tick.
   */
  private generation = 0;
  private consecutiveDegraded = 0;
  private lastSummary: string | null = null;
  private readonly log: (event: Record<string, unknown>) => void;
  private readonly warn: (event: Record<string, unknown>) => void;

  constructor(private readonly opts: MonitorOptions) {
    // `event` for both: it routes a `_degraded` evt to stderr itself, and
    // ships the allowlisted fields to the collector on the way past.
    this.log = opts.log ?? event;
    this.warn = opts.warn ?? event;
  }

  /** The last observation, or null before the first probe completes. */
  snapshot(): ToolSurfaceSnapshot | null {
    return this.current;
  }

  async refresh(): Promise<ToolSurfaceSnapshot> {
    // Concurrently: the bundle reads are one private-network GET per bundle and
    // must not add their deadline to the probe's. Neither call throws.
    const [probe, reading] = await Promise.all([
      probeToolSurfaces(this.opts),
      this.opts.mounts ? probeMountHealth(this.opts.mounts) : null,
    ]);
    const { failures, refused, unconfigured } = probe;
    const snapshot = reading
      ? withMountHealth(probe.snapshot, reading)
      : probe.snapshot;
    const first = this.current === null;
    this.current = snapshot;
    if (reading) this.reportMounts(snapshot, reading);

    // METRICS as well as the log line, and they answer different questions. The
    // events below ship too (telemetry/events.ts), but they are discrete and
    // change-triggered; a gauge is the thing you can alert on without having to
    // reason about whether the interesting record was emitted while you were
    // looking. It sits at zero for a slug serving nothing.
    //
    // THE ATTRIBUTES ARE ONLY THINGS THAT CANNOT CHANGE FOR A SLUG. `state`
    // belongs in the log line and on /healthz, and emphatically NOT here: OTLP
    // defaults to CUMULATIVE temporality, under which every attribute set ever
    // recorded is re-exported at its last value on every cycle, forever, with no
    // expiry. A `state="unreachable"` series would be minted by the first probe
    // of nearly every deploy — core comes up before the bundles do — and would
    // then sit at 0 for the life of the process, so an alert on
    // `min_over_time(... ) == 0` would latch permanently the first time anything
    // recovered. The VALUE already carries the fact: zero means serving nothing.
    // `slug` and `kind` are fixed at Registry.build time and cannot go stale.
    const inst = instruments();
    for (const surface of snapshot.surfaces) {
      inst.toolSurface.record(surface.tools, {
        "mcp.server": surface.slug,
        "mcp.upstream.kind": surface.kind,
      });
    }

    for (const surface of snapshot.surfaces) {
      const was = this.previous.get(surface.slug);
      this.previous.set(surface.slug, surface.state);
      if (!first && was === surface.state) continue;

      if (surface.state === "ok") {
        // Only interesting as a recovery. A slug that has been fine since boot
        // is reported in the summary below and does not need its own line.
        if (!first) {
          this.log({
            evt: "strad.tool_surface_recovered",
            slug: surface.slug,
            tool_count: surface.tools,
          });
        }
        continue;
      }

      if (surface.state === "unconfigured") {
        // A deploy that shipped ahead of a token, which is a supported state and
        // not a fault. `log`, not `warn`, and NOT `_degraded` — that event is
        // what an alert rule keys on and what the deploy gate reads, and paging
        // somebody about a credential they have not seeded yet would make the
        // deferral useless. The line still gets written, because "which slug is
        // still waiting" is a real question and this is where a boot answers it.
        this.log({
          evt: "strad.tool_surface_unconfigured",
          slug: surface.slug,
          kind: surface.kind,
          // From strad's own config, never from an upstream: the names this
          // slug declared `mayBeUnseeded:` for and the store does not hold.
          // Without them the line says a slug is waiting and not what for,
          // which is the half a human needs to finish the job.
          names: unconfigured.get(surface.slug) ?? [],
        });
        continue;
      }

      if (surface.state === "offline") {
        // A machine somebody switched off, which is this kind's normal state.
        // It gets a line, because "when is that laptop actually up" is a real
        // operational question — but `log`, not `warn`, and NOT the `_degraded`
        // event, which is what an alert rule keys on and what the deploy gate
        // reads. There is nothing here for anyone to fix.
        this.log({
          evt: "strad.tool_surface_offline",
          slug: surface.slug,
          kind: surface.kind,
        });
        continue;
      }

      this.warn({
        evt: "strad.tool_surface_degraded",
        slug: surface.slug,
        state: surface.state,
        // OUR sentence, not the upstream's. The upstream's own message follows
        // in `detail` for `unreachable`, where a human reading these logs is the
        // only consumer — it never reaches the snapshot or a page.
        reason:
          surface.state === "unreachable"
            ? surface.kind === "local-tunnel"
              ? refused.has(surface.slug)
                ? // A local-tunnel reaching this warning is NOT a laptop that is
                  // off — that is `offline`, and it is logged above without ever
                  // getting here. This is a machine that ANSWERED and said no,
                  // which will not clear on its own, and it is the only
                  // operator-facing signal for it since a refusal no longer
                  // fails a listing (see HACKS.md #60).
                  "this slug is a local-tunnel and its machine REFUSED strad's credentials. " +
                  "The machine is answering, so this is not a laptop that is off and it will " +
                  "not clear on its own: a credential has gone stale — the access token in " +
                  "front of the tunnel, or the bearer the server on that machine checks."
                : // Answering, and not refusing: a wrong path in this slug's own
                  // `url`, or a server on that machine running and erroring.
                  // Also not a laptop that is off, and also not fixed by
                  // restarting a tunnel.
                  "this slug is a local-tunnel and its machine ANSWERED, but not as an MCP " +
                  "server — so this is not a machine that is off. Check this slug's `url` " +
                  "against what that machine actually serves."
              : "this slug's upstream did not answer tools/list, so it serves NOTHING. " +
                "A client selecting it sees an empty toolset. Check that the component " +
                "is running an image that mounts the path this slug routes to."
            : "this slug answered tools/list with no tools, so it serves NOTHING. " +
              "Its upstream withheld every tool it has — on a server that derives " +
              "its surface from a live credential probe, that means the credential " +
              "did not grant what the probe asked about.",
        ...(failures.has(surface.slug)
          ? { detail: failures.get(surface.slug) }
          : {}),
      });
    }

    // The SET, not its length: `a` recovering while `b` dies is a change worth a
    // line, and two degraded slugs for six hours is not.
    // BOTH sets, or the line goes stale: a slug that gets its credential seeded
    // leaves `unconfigured` without touching `degraded`, and a summary keyed on
    // `degraded` alone would keep reporting it as waiting for as long as nothing
    // else changed.
    const summary = `${snapshot.degraded.join(",")}|${snapshot.unconfigured.join(",")}`;
    if (first || summary !== this.lastSummary) {
      this.lastSummary = summary;
      this.log({
        evt: "strad.tool_surface",
        observedAt: snapshot.observedAt,
        server_count: snapshot.surfaces.length,
        serving_count: snapshot.surfaces.filter((s) => s.state === "ok").length,
        degraded: snapshot.degraded,
        unconfigured: snapshot.unconfigured,
      });
    }

    // Counted off the SAME question `nextDelay()` asks, or the two disagree:
    // `degraded` no longer contains an offline laptop, but a refused or 404ing
    // tunnel is still in it — and if that fed the counter while `nextDelay()`
    // excluded it by kind, one permanently broken tunnel would hold the budget
    // spent forever and the fast retry would never engage for the bundle that
    // needed it during a deploy.
    this.consecutiveDegraded = this.needsFastRetry()
      ? this.consecutiveDegraded + 1
      : 0;

    return snapshot;
  }

  /**
   * The bundles' own reports: a gauge on every reading, an event on change.
   *
   * Every value that leaves here is a slug or a bundle name from the CONFIG, or
   * one of this repo's words. There is no bundle-authored reason in scope to
   * leak — mount-health.ts dropped it at the parse — and that is the property
   * `test/mount-health.test.ts` pins against the gauge, the exported records and
   * the streams.
   */
  private reportMounts(
    snapshot: ToolSurfaceSnapshot,
    reading: MountHealthReading,
  ): void {
    const bundleOf = new Map(
      (this.opts.mounts?.targets ?? []).map((t) => [t.slug, t.bundle]),
    );
    const inst = instruments();

    for (const surface of snapshot.surfaces) {
      const state = surface.mount;
      if (state === undefined) continue;

      // The fact is in the VALUE and the attributes are tool_surface's two, for
      // the reason spelled out above that gauge: a varying attribute would be
      // re-exported at its last value for the life of the process. A slug with
      // no reading this probe records nothing, so the series holds its last
      // value while a bundle cannot be read — `strad.mount_report` says when.
      inst.mountDegraded.record(state === "degraded" ? 1 : 0, {
        "mcp.server": surface.slug,
        "mcp.upstream.kind": surface.kind,
      });

      // Transitions against the last KNOWN state, so a bundle that could not be
      // read for a probe does not turn its degraded mounts into a recovery. A
      // mount first seen serving needs no line.
      const was = this.previousMount.get(surface.slug);
      this.previousMount.set(surface.slug, state);
      if (was === state) continue;
      if (was === undefined && state === "ok") continue;

      // `log`, not `warn`, and NOT a `_degraded` event — so Info, and nothing
      // that keys on `severity >= ERROR` pages on it. One bit cannot tell a
      // failed login from a credential a human deferred on purpose
      // (`mayBeUnseeded:` on a bundle's `env:` leaves the mount to say so
      // itself), and the deferred case is documented as never paging. The
      // gauge carries the same fact for an alert scoped by slug.
      this.log({
        evt: "strad.mount_state",
        slug: surface.slug,
        bundle: bundleOf.get(surface.slug),
        state,
        // OURS, and constant. The bundle's own reason is not in scope here.
        ...(state === "degraded"
          ? {
              reason:
                "the bundle hosting this slug's mount reports it degraded: it " +
                "lists its tools, and says its calls will fail — a failed login, " +
                "or a credential that is missing or was rejected. The bundle's " +
                "own /healthz and log say which; that text is the bundle's, and " +
                "core does not carry it.",
            }
          : {}),
      });
    }

    for (const [bundle, outcome] of reading.bundles) {
      const was = this.previousReport.get(bundle);
      // Before a bundle has EVER been read, `unreachable` is the ordinary
      // shape of a deploy — core boots before its bundles — and the tool-surface
      // probe already reports a bundle that stays down. So it is not recorded
      // as a state to move away from, and the `ok` that follows is silent too.
      if (was === undefined && outcome === "unreachable") continue;
      this.previousReport.set(bundle, outcome);
      if (was === outcome) continue;
      // A bundle read cleanly from the first probe needs no line; the moment
      // its report becomes unreadable, and the moment it comes back, do —
      // because in between, the gauge above is holding a stale value.
      if (was === undefined && outcome === "ok") continue;
      this.log({ evt: "strad.mount_report", bundle, outcome });
    }
  }

  /**
   * Probe now, then keep probing.
   *
   * Self-scheduling rather than `setInterval`, so the delay can depend on what
   * the last probe found, and so a slow probe can never stack up behind itself.
   * The timer is unref'd: this must never be the reason the process stays alive.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    const tick = (): void => {
      void this.refresh()
        .catch(() => {})
        .finally(() => {
          if (!this.running || this.generation !== generation) return;
          const timer = setTimeout(tick, this.nextDelay());
          timer.unref?.();
          this.timer = timer;
        });
    };
    tick();
  }

  /**
   * Fast while a deploy might still be converging, then steady.
   *
   * Falling back rather than staying fast is the whole point of `retryProbes`:
   * a fault that has survived two minutes of retries is not going to be fixed by
   * a third, and 27 upstreams do not need asking every ten seconds about it.
   */
  private nextDelay(): number {
    // A local-tunnel does not drive the fast retry. The fast interval exists to
    // catch a deploy converging, which finishes in a couple of minutes; a
    // machine that is off is off for hours, and letting it hold the gateway at
    // a ten-second cadence would mean re-probing 27 healthy upstreams six times
    // a minute for as long as somebody's laptop is shut.
    const budget = this.opts.retryProbes ?? DEFAULT_RETRY_PROBES;
    return this.needsFastRetry() && this.consecutiveDegraded < budget
      ? (this.opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS)
      : (this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  /**
   * Is anything wrong that a re-probe in ten seconds might see fixed?
   *
   * Every `local-tunnel` is excluded, not just the `offline` ones: a machine
   * that is off is off for hours, and a tunnel that refuses stays refused until
   * somebody rotates a credential. Neither is a deploy converging, which is the
   * only thing the fast interval exists to catch.
   */
  private needsFastRetry(): boolean {
    return (this.current?.surfaces ?? []).some(
      (s) =>
        s.state !== "ok" &&
        // An unseeded credential is not a deploy converging. It clears when a
        // human writes a value, which is minutes or days away, and re-probing
        // every ten seconds until then would hold the whole fleet at the fast
        // cadence for the entire window the feature exists to make comfortable.
        s.state !== "unconfigured" &&
        s.kind !== "local-tunnel",
    );
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
