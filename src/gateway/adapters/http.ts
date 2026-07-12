import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  Tool,
  Resource,
  ReadResourceResult,
  ClientCapabilities as SdkClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { GATEWAY_UPSTREAM_CAPABILITIES } from "../clientCapabilities.ts";
import { errorKind, instruments, tracer } from "../../telemetry/index.ts";
import type { CallToolResult, ServerAdapter } from "./types.ts";

/**
 * Proxies an MCP server reachable over Streamable HTTP.
 *
 * This backs TWO config kinds, because at runtime they are the same thing:
 *
 *   remote-http          -> some URL on the internet (Granola's server, ...)
 *   supplementary-image  -> a container we deployed, at ${bundle.PRIVATE_URL}
 *
 * The only difference is who resolved the URL. Keeping one implementation means
 * a supplementary image gets the same retry/timeout behaviour as a third-party
 * server, for free.
 */
export class HttpServerAdapter implements ServerAdapter {
  readonly slug: string;
  readonly kind: "remote-http" | "supplementary-image";

  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    private readonly opts: {
      slug: string;
      kind: "remote-http" | "supplementary-image";
      url: string;
      headers: Record<string, string>;
      /**
       * The MCP SDK's default request timeout is 60 SECONDS, and it applies at
       * EVERY hop. Left alone, a long tool call dies at exactly 60s and looks
       * for all the world like an App Platform bug. It is not. Set it here.
       */
      timeoutMs: number;
      /**
       * Set when the upstream is ITSELF a strad gateway (a bundle component).
       *
       * A bundle is a strad process, so it has already namespaced its tools as
       * `<slug>__<tool>` before we ever see them. Namespacing again would give
       * the client `bundled__bundled__whoami`, and a tools/call would strip only
       * the outer prefix and forward a bare `whoami` that the bundle cannot
       * route. So for these upstreams we strip the inner prefix on the way out
       * and restore it on the way back in — the wire format the bundle expects
       * is its business, not the client's.
       *
       * Unset for third-party servers (remote-http, supplementary-image): those
       * don't know what a strad slug is and name their tools plainly.
       */
      innerPrefix?: string;
    },
  ) {
    this.slug = opts.slug;
    this.kind = opts.kind;
  }

  /**
   * Connect lazily and keep the connection. Reconnecting per request would add
   * a full MCP handshake to every tool call.
   */
  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const transport = new StreamableHTTPClientTransport(
        new URL(this.opts.url),
        {
          requestInit: { headers: this.opts.headers },
          // Inject W3C trace context (`traceparent`) into every upstream request.
          //
          // This is what makes a bundle's spans join the core's trace instead of
          // floating free, and it is the difference between "the request took 8s"
          // and "the request took 8s, of which 7.6s was Chromium inside
          // bundle-fetchpet". After the collapse — when one container holds
          // everything — an unstitched trace would be nearly useless, because the
          // only way to attribute the shared 1 vCPU is to see the whole waterfall.
          //
          // `requestInit.headers` above is static (it is the auth header, set at
          // construction), so the per-request context has to be injected here.
          // When no SDK is registered, `propagation.inject` is a no-op and this
          // adds exactly one empty object to each call.
          fetch: (url, init) => {
            const headers = new Headers(init?.headers);
            propagation.inject(context.active(), headers, {
              set: (h, k, v) => h.set(k, v),
            });
            return fetch(url, { ...init, headers });
          },
        },
      );

      const client = new Client(
        { name: "strad-gateway", version: "0.1.0" },
        // Advertise MCP-Apps capability upstream so an app-server offers its
        // `ui://` resource + tool `_meta` to the gateway, which relays them to
        // the end client. Constant across requests, so the cached connection
        // below stays correct for every caller (see clientCapabilities.ts).
        //
        // Cast: our structural ClientCapabilities is intentionally looser than
        // the SDK's (it must let arbitrary `extensions` keys through), so we
        // hand the SDK its own shape here.
        {
          capabilities:
            GATEWAY_UPSTREAM_CAPABILITIES as unknown as SdkClientCapabilities,
        },
      );

      // The handshake is a hop like any other, and on a saturated box it is
      // often the FIRST thing to get slow — a bundle too busy to answer
      // `initialize` inside the timeout looks, from the client's side, like a
      // server that does not exist.
      await this.hop("connect", () => client.connect(transport));
      this.client = client;
      return client;
    })();

    try {
      return await this.connecting;
    } catch (err) {
      // Don't cache a failed connect — the upstream may just be starting up.
      this.connecting = null;
      throw new UpstreamError(this.slug, err);
    } finally {
      this.connecting = null;
    }
  }

  /**
   * One instrumented hop to this upstream.
   *
   * Every network round-trip strad makes on a client's behalf goes through here,
   * which is what gives us a per-server latency histogram — the thing that
   * answers "which server is starving the others" when 26 of them share a box.
   *
   * Timeouts get their own counter, deliberately. The MCP SDK's request timeout
   * defaults to 60s and applies at EVERY hop, so a slow tool behind the gateway
   * dies at exactly 60s and presents as a mysterious platform failure. Counting
   * them separately from other upstream errors turns that into a one-glance
   * diagnosis.
   */
  private async hop<T>(op: string, run: () => Promise<T>): Promise<T> {
    const inst = instruments();
    const attrs = {
      "mcp.server": this.slug,
      "mcp.upstream.kind": this.kind,
      "mcp.upstream.op": op,
    };
    const span = tracer().startSpan(`mcp.upstream.${op}`, {
      kind: SpanKind.CLIENT,
      attributes: { ...attrs, "mcp.upstream.timeout_ms": this.opts.timeoutMs },
    });
    const startedAt = process.hrtime.bigint();

    try {
      const result = await context.with(
        trace.setSpan(context.active(), span),
        run,
      );
      inst.upstreamDuration.record(elapsedSeconds(startedAt), {
        ...attrs,
        outcome: "ok",
      });
      return result;
    } catch (err) {
      const kind = errorKind(err);
      span.setAttribute("error.kind", kind);
      // No recordException — an upstream's error message is not ours to export.
      // See src/telemetry/redact.ts.
      span.setStatus({ code: SpanStatusCode.ERROR });

      inst.upstreamDuration.record(elapsedSeconds(startedAt), {
        ...attrs,
        outcome: "error",
      });
      inst.upstreamErrors.add(1, { ...attrs, "error.kind": kind });
      if (kind === "timeout") inst.upstreamTimeouts.add(1, attrs);

      throw err;
    } finally {
      span.end();
    }
  }

  async listTools(): Promise<Tool[]> {
    const client = await this.connect();
    try {
      const res = await this.hop("list_tools", () =>
        client.listTools({}, { timeout: this.opts.timeoutMs }),
      );
      return res.tools.map((t) => ({ ...t, name: this.strip(t.name) }));
    } catch (err) {
      this.reset();
      throw new UpstreamError(this.slug, err);
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const client = await this.connect();
    try {
      const res = await this.hop("call_tool", () =>
        client.callTool(
          { name: this.restore(name), arguments: args },
          undefined,
          { timeout: this.opts.timeoutMs },
        ),
      );
      return res as unknown as CallToolResult;
    } catch (err) {
      // Drop the cached client on failure, exactly as listTools does. A timeout
      // or a dropped transport leaves the Client unusable; without this reset it
      // stays cached and every subsequent call to this server keeps reusing the
      // dead connection until the process restarts.
      this.reset();
      throw new UpstreamError(this.slug, err);
    }
  }

  /**
   * List this upstream's resources (e.g. an MCP App's `ui://` template).
   *
   * A tools-only upstream never advertised the `resources` capability, so the
   * SDK client rejects the call locally; we treat that as "no resources" rather
   * than an error, so proxying resources never destabilises a plain server.
   */
  async listResources(): Promise<Resource[]> {
    const client = await this.connect();
    try {
      const res = await this.hop("list_resources", () =>
        client.listResources({}, { timeout: this.opts.timeoutMs }),
      );
      return res.resources;
    } catch (err) {
      if (isUnsupportedCapability(err)) return [];
      this.reset();
      throw new UpstreamError(this.slug, err);
    }
  }

  /** Read one resource by URI from this upstream. */
  async readResource(uri: string): Promise<ReadResourceResult> {
    const client = await this.connect();
    try {
      // The URI is NOT recorded as an attribute. A `ui://` app template is
      // harmless, but readResource is a general-purpose read and a URI can name
      // a file path or an object key. Identifier-shaped is not the same as
      // safe-to-export, and this one is not worth the argument.
      return await this.hop("read_resource", () =>
        client.readResource({ uri }, { timeout: this.opts.timeoutMs }),
      );
    } catch (err) {
      this.reset();
      throw new UpstreamError(this.slug, err);
    }
  }

  /** `bundled__whoami` -> `whoami`, for a strad-bundle upstream. */
  private strip(name: string): string {
    const prefix = this.opts.innerPrefix;
    if (!prefix) return name;
    const full = `${prefix}__`;
    return name.startsWith(full) ? name.slice(full.length) : name;
  }

  /** `whoami` -> `bundled__whoami`, for a strad-bundle upstream. */
  private restore(name: string): string {
    const prefix = this.opts.innerPrefix;
    return prefix ? `${prefix}__${name}` : name;
  }

  private reset(): void {
    const client = this.client;
    this.client = null;
    void client?.close().catch(() => {});
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => {});
  }
}

/** Seconds elapsed since an `hrtime.bigint()` mark. */
function elapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}

/**
 * The SDK client rejects a call locally when the connected server never
 * advertised the required capability (e.g. calling resources/list on a
 * tools-only server). That is not a failure to surface — it just means "none".
 */
function isUnsupportedCapability(err: unknown): boolean {
  return (
    err instanceof Error && /does not support resources/i.test(err.message)
  );
}

export class UpstreamError extends Error {
  constructor(
    readonly slug: string,
    readonly cause: unknown,
  ) {
    super(
      `upstream MCP server "${slug}" failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}
