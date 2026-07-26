import { createHash } from "node:crypto";
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

/** Where this adapter connects, and with what credential. */
export interface HttpEndpoint {
  url: string;
  headers: Record<string, string>;
}

/**
 * Internal: a handshake completed against a credential that has since been
 * superseded. Never escapes `connect()` — it triggers one retry against the
 * current credential. It carries the slug and nothing else.
 */
class StaleCredentialError extends Error {
  constructor(slug: string) {
    super(`upstream "${slug}": credential rotated during connect`);
    this.name = "StaleCredentialError";
  }
}

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
 *
 * ## The endpoint is a thunk, not a value
 *
 * `endpoint()` is resolved on EVERY operation rather than captured once at
 * construction, because the URL and headers may contain `${SECRET}` references
 * whose values live in a store that a human can change while this process runs.
 * Baking them into the constructor is what makes a rotated credential require a
 * redeploy.
 *
 * The cost is a map lookup against a warm cache in the common case (see
 * src/secrets/provider/store.ts), not a network call. When the resolved endpoint
 * CHANGES, the cached MCP connection is torn down and rebuilt — an established
 * transport still carries the old `Authorization` header, so keeping it would
 * make the rotation invisible until the next restart.
 */
export class HttpServerAdapter implements ServerAdapter {
  readonly slug: string;
  readonly kind: "remote-http" | "supplementary-image";

  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  /** Digest of the credential currently believed current. */
  private fingerprint: string | null = null;
  /**
   * Bumped whenever the credential changes.
   *
   * The fingerprint alone cannot serve as the "is this attempt still valid"
   * check, because `reset()` — which every request-path failure calls — would
   * have to clear it, and a cleared fingerprint reads as a rotation to any
   * in-flight connect, making it discard a perfectly good connection. Separating
   * "what the credential is" from "how many times it has changed" lets a dropped
   * SOCKET and a rotated CREDENTIAL stop being the same event.
   */
  private epoch = 0;
  /** Set by close(), so a late attempt cannot revive a shut-down adapter. */
  private closed = false;

  constructor(
    private readonly opts: {
      slug: string;
      kind: "remote-http" | "supplementary-image";
      /** Resolve the current URL + headers. Called on every operation. */
      endpoint: () => Promise<HttpEndpoint>;
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
   *
   * The endpoint is resolved first, and its digest compared with the one the
   * cached connection was built from. Equal (the overwhelmingly common case) ->
   * reuse. Different -> a secret was rotated or a URL changed under us, so drop
   * the connection and handshake again with the new credential. That comparison
   * is the whole runtime-rotation mechanism.
   */
  private async connect(attemptsLeft = 3): Promise<Client> {
    // Snapshot the epoch BEFORE resolving. `endpoint()` can await (a cache miss
    // reaches the store), so two callers can resolve interleaved and a slow one
    // can return older values than a fast one that already landed. Comparing
    // against the epoch as it was when THIS resolution started is what stops a
    // late straggler from installing a superseded credential over a newer one.
    const startedAt = this.epoch;
    const endpoint = await this.opts.endpoint();
    const fingerprint = fingerprintOf(endpoint);

    if (
      startedAt === this.epoch &&
      this.fingerprint !== null &&
      this.fingerprint !== fingerprint
    ) {
      // Rotated, and nothing newer has been observed since this resolution
      // began. Abandon the cached client and any in-flight connect: both are
      // bound to the superseded credential.
      this.epoch += 1;
      this.fingerprint = fingerprint;
      this.dropClient();
      this.connecting = null;
    } else if (this.fingerprint === null) {
      this.fingerprint = fingerprint;
    }

    if (this.client) return this.client;

    // Join an in-flight attempt — but through the same handler below, not by
    // returning its promise raw. A raw return skips the retry and the
    // UpstreamError wrap, so a joiner would receive a StaleCredentialError
    // verbatim out of listTools()/callTool().
    const existing = this.connecting;
    if (existing) return this.settle(existing, attemptsLeft);

    const epoch = this.epoch;
    this.connecting = (async () => {
      const transport = new StreamableHTTPClientTransport(
        new URL(endpoint.url),
        {
          requestInit: { headers: endpoint.headers },
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

      // Only publish this client if the credential it was built with is still
      // the current one, and the adapter is still open. Two concurrent calls
      // straddling a rotation would otherwise race: the OLD one can finish last
      // and clobber `this.client` with a connection carrying the superseded
      // Authorization header — while `this.fingerprint` already reads "new", so
      // nothing ever reconnects and the rotation is permanently invisible.
      // Losing the race means throwing this connection away, not installing it.
      if (this.epoch !== epoch || this.closed) {
        void client.close().catch(() => {});
        throw new StaleCredentialError(this.slug);
      }
      this.client = client;
      return client;
    })();

    const attempt = this.connecting;
    // Clear only OUR attempt. A blanket `this.connecting = null` would also wipe
    // a newer attempt that a rotation started while this one was in flight,
    // sending the next caller off to open a third connection.
    void attempt
      .catch(() => {})
      .finally(() => {
        if (this.connecting === attempt) this.connecting = null;
      });

    return this.settle(attempt, attemptsLeft);
  }

  /**
   * Await one connect attempt, translating its failures.
   *
   * Both the caller that STARTED an attempt and any caller that joined one go
   * through here, so the retry and the error wrapping apply identically. A
   * `StaleCredentialError` is internal and must never escape: it means the
   * credential moved mid-handshake, which is a reason to try again, not an error
   * the client asked about.
   */
  private async settle(
    attempt: Promise<Client>,
    attemptsLeft: number,
  ): Promise<Client> {
    try {
      return await attempt;
    } catch (err) {
      if (
        err instanceof StaleCredentialError &&
        attemptsLeft > 1 &&
        !this.closed
      ) {
        // Bounded, so a rotation arriving faster than a handshake completes
        // fails loudly rather than spinning.
        return this.connect(attemptsLeft - 1);
      }
      throw new UpstreamError(this.slug, err);
    }
  }

  /**
   * One instrumented hop to this upstream.
   *
   * Every network round-trip strad makes on a client's behalf goes through here,
   * which is what gives us a per-server latency histogram — the thing that
   * answers "which server is starving the others" when 14 of them share a box.
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

  /**
   * Drop the cached connection after a transport failure.
   *
   * Deliberately does NOT touch the fingerprint. A dead socket says nothing
   * about the credential, and clearing it would manufacture a phantom rotation:
   * an in-flight connect would see its epoch check fail, close a working
   * connection, and handshake again for no reason.
   */
  private dropClient(): void {
    const client = this.client;
    this.client = null;
    void client?.close().catch(() => {});
  }

  private reset(): void {
    this.dropClient();
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = null;
    this.fingerprint = null;
    // Abandon any in-flight attempt too. Without this it completes after the
    // adapter is shut, and would open a fresh connection on a closed adapter.
    this.connecting = null;
    await client?.close().catch(() => {});
  }
}

/**
 * A stable digest of an endpoint, used ONLY to detect that it changed.
 *
 * It is a hash, not the values, and it never leaves this process — but it is
 * derived from a live credential, so it is treated as one: it is never logged,
 * never a span attribute, and never returned. Header NAMES are sorted so that a
 * map with the same content in a different insertion order does not read as a
 * rotation and force a pointless reconnect on every request.
 */
function fingerprintOf(endpoint: HttpEndpoint): string {
  const headers = Object.entries(endpoint.headers).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return createHash("sha256")
    .update(JSON.stringify([endpoint.url, headers]))
    .digest("hex");
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
