import type { Express } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StradConfig } from "../config/schema.ts";
import type { Registry } from "./registry.ts";
import type { ToolSurfaceMonitor } from "./reachability.ts";

/**
 * Everything in this process that is built FROM the config.
 *
 * The list is short because most of strad already re-reads the config per
 * request — entitlements, tool selection, every `${NAME}`, every url and header
 * (src/gateway/registry.ts resolves an endpoint per operation). What is left is
 * the three things that genuinely capture: the adapters, the Express routes
 * that closed over the config object, and the probe loop keyed by slug.
 */
export interface GatewayInstance {
  config: StradConfig;
  registry: Registry;
  app: Express;
  toolSurfaces: ToolSurfaceMonitor;
}

export type GatewayBuilder = (config: StradConfig) => Promise<GatewayInstance>;

export interface ReloadOptions {
  /**
   * How long the outgoing registry's adapters are left open after the swap.
   *
   * Not zero, and not forever. An adapter holds live MCP connections, and a
   * request that was mid-`tools/call` when the swap happened is still holding
   * one — closing underneath it turns a successful call into a transport error
   * for no reason. Waiting forever instead leaks a connection per reload.
   *
   * The window only has to outlast a request already in flight, and every
   * adapter carries its own `timeoutMs` (120s by default) — so this is not a
   * correctness bound, it is how much of a pathological request we are willing
   * to wait out. A call still running after it gets its transport closed, which
   * is the same thing a redeploy would have done to it.
   */
  drainMs?: number;
  setTimeoutImpl?: typeof setTimeout;
}

const DEFAULT_DRAIN_MS = 30_000;

/**
 * A gateway that can be rebuilt underneath a listening socket.
 *
 * ## Why rebuild rather than mutate
 *
 * The alternative was to thread a live `() => config` getter through every
 * place that captured one. That is a wider diff and a worse invariant: it makes
 * every reader responsible for tolerating a config that changes between two
 * lines of the same function, forever, and the compiler cannot tell you which
 * readers got it wrong. Rebuilding keeps the existing contract exactly as it
 * was — every component still gets ONE config for its whole life — and moves
 * the entire problem to one atomic pointer swap.
 *
 * It is also the honest model of what a config change IS. A different roster is
 * a different gateway; the only thing being preserved across the change is the
 * socket, and that is the one thing a human notices being taken away.
 *
 * ## Why the socket is not an Express app
 *
 * `http.createServer(gateway.handle)` rather than `outer.use(inner)`. Mounting
 * one Express app inside another runs both `expressInit` middlewares, so
 * `req.app` — which is where `req.protocol` looks for `trust proxy` — depends
 * on which one ran last. The console's `?servers=` URL is built from
 * `req.protocol`, so getting that wrong behind App Platform's proxy means every
 * copied URL is `http://` on an https deployment. A plain dispatch has no
 * second app and no question.
 */
export class ReloadableGateway {
  private instance: GatewayInstance;
  private probing = false;
  private readonly drainMs: number;
  /**
   * Injected only by a test that wants to observe the drain. Otherwise the
   * global is looked up AT CALL TIME rather than captured here — a captured
   * `setTimeout` is the real one forever, which makes this class quietly
   * insensitive to a timer swapped in after construction.
   */
  private readonly setTimeoutImpl: typeof setTimeout | undefined;
  /** Registries swapped out and not yet closed, so `close()` can finish them. */
  private readonly draining = new Set<Registry>();

  private constructor(
    instance: GatewayInstance,
    private readonly builder: GatewayBuilder,
    opts: ReloadOptions,
  ) {
    this.instance = instance;
    this.drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
    this.setTimeoutImpl = opts.setTimeoutImpl;
  }

  static async start(
    builder: GatewayBuilder,
    config: StradConfig,
    opts: ReloadOptions = {},
  ): Promise<ReloadableGateway> {
    return new ReloadableGateway(await builder(config), builder, opts);
  }

  /** The request handler to hand `http.createServer`. Stable for the process. */
  readonly handle = (req: IncomingMessage, res: ServerResponse): void => {
    this.instance.app(req as never, res as never);
  };

  get current(): GatewayInstance {
    return this.instance;
  }

  get registry(): Registry {
    return this.instance.registry;
  }

  get toolSurfaces(): ToolSurfaceMonitor {
    return this.instance.toolSurfaces;
  }

  /**
   * Begin probing, and keep probing across reloads.
   *
   * A flag rather than a caller's responsibility: the probe is started after
   * `listen()` at boot, and a reload that happens later must not silently leave
   * the gateway un-probed because nobody remembered to start the new monitor.
   */
  startProbing(): void {
    this.probing = true;
    this.instance.toolSurfaces.start();
  }

  /**
   * Build on the new config and swap.
   *
   * A throw from `builder` leaves everything exactly as it was — the new
   * instance is never assigned, and the old registry is never drained. That is
   * what lets `RuntimeConfig.apply` treat a rebuild failure as a refusal rather
   * than an outage.
   */
  async reload(config: StradConfig): Promise<void> {
    const next = await this.builder(config);
    const previous = this.instance;

    // The swap. Everything after this line is cleanup of a gateway that is no
    // longer serving anything new.
    this.instance = next;

    previous.toolSurfaces.stop();
    if (this.probing) next.toolSurfaces.start();

    this.draining.add(previous.registry);
    const later = this.setTimeoutImpl ?? globalThis.setTimeout;
    later(() => {
      void previous.registry
        .close()
        .catch(() => undefined)
        .finally(() => this.draining.delete(previous.registry));
    }, this.drainMs).unref?.();
  }

  /** Stop probing and close every registry, including ones still draining. */
  async close(): Promise<void> {
    this.probing = false;
    this.instance.toolSurfaces.stop();
    const pending = [...this.draining];
    this.draining.clear();
    await Promise.all(
      [this.instance.registry, ...pending].map((r) =>
        r.close().catch(() => undefined),
      ),
    );
  }
}
