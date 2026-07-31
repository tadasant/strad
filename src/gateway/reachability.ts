import type { Registry } from "./registry.ts";

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
 * ## Three states, because they call for different actions
 *
 * `unreachable` is an outage or a routing fault — the upstream refused, 404'd or
 * timed out. `empty` is a server that answered and offered no tools, which is
 * legal but is nearly always a credential the upstream declined to probe (see
 * servers/secrets/shared/src/capabilities.ts) or a `tools:` allow-list that
 * matched nothing. `ok` is a slug with a tool on it. Collapsing the first two
 * into "unhealthy" would send someone to the wrong page.
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
 */

export type SurfaceState = "ok" | "empty" | "unreachable";

export interface ToolSurface {
  slug: string;
  state: SurfaceState;
  /** How many tools the slug offered. Zero for anything but `ok`. */
  tools: number;
}

export interface ToolSurfaceSnapshot {
  observedAt: string;
  surfaces: ToolSurface[];
  /** The slugs that are not `ok`, for a caller that wants one field to test. */
  degraded: string[];
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
export async function probeToolSurfaces(
  opts: ProbeOptions,
): Promise<{ snapshot: ToolSurfaceSnapshot; failures: Map<string, string> }> {
  const slugs = opts.slugs ?? opts.registry.slugs;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures = new Map<string, string>();

  const surfaces = await Promise.all(
    slugs.map(async (slug): Promise<ToolSurface> => {
      const adapter = opts.registry.get(slug);
      if (!adapter) {
        failures.set(slug, "the registry mounted no adapter for this slug");
        return { slug, state: "unreachable", tools: 0 };
      }
      try {
        const tools = await withDeadline(adapter.listTools(), timeoutMs, slug);
        return {
          slug,
          state: tools.length > 0 ? "ok" : "empty",
          tools: tools.length,
        };
      } catch (err) {
        failures.set(slug, err instanceof Error ? err.message : String(err));
        return { slug, state: "unreachable", tools: 0 };
      }
    }),
  );

  return {
    snapshot: {
      observedAt: (opts.now?.() ?? new Date()).toISOString(),
      surfaces,
      degraded: surfaces.filter((s) => s.state !== "ok").map((s) => s.slug),
    },
    failures,
  };
}

/**
 * A deadline the adapter does not impose on itself.
 *
 * `HttpServerAdapter` passes `timeoutMs` to the MCP SDK, but a builtin has no
 * timeout at all and a transport can wedge before the SDK's timer is armed. A
 * monitor that can hang is a monitor that stops reporting, which is the failure
 * mode it exists to catch.
 */
function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  slug: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`tools/list did not answer within ${timeoutMs}ms`, {
              cause: slug,
            }),
          ),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
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
  log?: (event: Record<string, unknown>) => void;
  warn?: (event: Record<string, unknown>) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RETRY_INTERVAL_MS = 10_000;

/**
 * Keeps a current answer to "which slugs serve nothing", and says so out loud.
 *
 * Polled rather than computed on request, because `/healthz` is App Platform's
 * liveness probe and must not wait on 27 upstreams — it reads the last snapshot
 * and returns immediately.
 *
 * Logging is on CHANGE, not on every tick: a slug that has been dead for six
 * hours should not have written 360 identical lines, and the current state is
 * always readable from `/healthz` anyway. The first probe always logs, so a boot
 * that comes up degraded says so in the logs of that boot.
 */
export class ToolSurfaceMonitor {
  private current: ToolSurfaceSnapshot | null = null;
  private previous = new Map<string, SurfaceState>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly log: (event: Record<string, unknown>) => void;
  private readonly warn: (event: Record<string, unknown>) => void;

  constructor(private readonly opts: MonitorOptions) {
    this.log = opts.log ?? ((e) => console.log(JSON.stringify(e)));
    this.warn = opts.warn ?? ((e) => console.error(JSON.stringify(e)));
  }

  /** The last observation, or null before the first probe completes. */
  snapshot(): ToolSurfaceSnapshot | null {
    return this.current;
  }

  async refresh(): Promise<ToolSurfaceSnapshot> {
    const { snapshot, failures } = await probeToolSurfaces(this.opts);
    const first = this.current === null;
    this.current = snapshot;

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
            tools: surface.tools,
          });
        }
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
            ? "this slug's upstream did not answer tools/list, so it serves NOTHING. " +
              "A client selecting it sees an empty toolset. Check that the component " +
              "is running an image that mounts the path this slug routes to."
            : "this slug answered tools/list with no tools, so it serves NOTHING. " +
              "Either its upstream withheld every tool (a credential it probes may " +
              "not resolve) or its `tools:` allow-list matched nothing.",
        ...(failures.has(surface.slug)
          ? { detail: failures.get(surface.slug) }
          : {}),
      });
    }

    if (first || snapshot.degraded.length > 0) {
      this.log({
        evt: "strad.tool_surface",
        observedAt: snapshot.observedAt,
        servers: snapshot.surfaces.length,
        serving: snapshot.surfaces.filter((s) => s.state === "ok").length,
        degraded: snapshot.degraded,
      });
    }

    return snapshot;
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
    const tick = (): void => {
      void this.refresh()
        .catch(() => {})
        .finally(() => {
          if (!this.running) return;
          const degraded = (this.current?.degraded.length ?? 0) > 0;
          const delay = degraded
            ? (this.opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS)
            : (this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
          const timer = setTimeout(tick, delay);
          timer.unref?.();
          this.timer = timer;
        });
    };
    tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
