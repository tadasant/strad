import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ErrorCode,
  McpError,
  type Tool,
  type Resource,
  type ReadResourceResult,
  type ClientCapabilities as SdkClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { ServerKind } from "../../config/schema.ts";
import { GATEWAY_UPSTREAM_CAPABILITIES } from "../clientCapabilities.ts";
import {
  errorKind,
  instruments,
  tracer,
  type ErrorKind,
  type SelfClassifyingError,
} from "../../telemetry/index.ts";
import { remedyText, type HostState, type LocalHost } from "../troubleshoot.ts";
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
 * One upstream connection, plus a count of the gateway requests using it.
 *
 * The connection is SHARED: one cached MCP `Client` per slug serves every
 * concurrent request for that server. Sharing is what keeps a full handshake off
 * every tool call, and it is also why closing one is not a decision a single
 * failing call gets to make on its own — `client.close()` tears down the
 * transport, and every request in flight on it dies at the same instant, whatever
 * they were doing.
 *
 * So retirement and closure are separated. `retire()` says "no further caller
 * should be handed this one"; the socket itself is closed only once the last
 * lease is released. A call that fails can therefore always take its connection
 * out of service, and can never take a peer's in-flight call down with it.
 */
class Conn {
  private leases = 0;
  private retired = false;
  private closed = false;

  /**
   * `onClosed` fires exactly once, when the socket actually goes. The adapter
   * uses it to forget this connection — a retired one detaches from the cache
   * immediately but can outlive that by a whole request, and something has to
   * still be able to reach it at shutdown.
   */
  constructor(
    readonly client: Client,
    private readonly onClosed: () => void,
  ) {}

  /**
   * Take a lease, if this connection is still in service.
   *
   * Returns false once retired, and the caller must then get another
   * connection: between `connect()` handing this one back and the caller
   * resuming a microtask later, a peer's failure can have retired and closed it.
   * Acquiring anyway would run the request on a closed socket — a small version
   * of exactly the failure the lease exists to prevent.
   */
  acquire(): boolean {
    if (this.retired) return false;
    this.leases += 1;
    return true;
  }

  /** Release one lease, closing the socket if this was the last one out. */
  release(): void {
    this.leases -= 1;
    if (this.retired && this.leases === 0) this.closeNow();
  }

  /**
   * Take this connection out of service. Idempotent: two callers failing on the
   * same dead socket retire it once.
   */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    if (this.leases === 0) this.closeNow();
  }

  /**
   * Close now, in-flight leases or not. Only adapter shutdown does this — the
   * process is going away, so waiting for a lease that may be blocked on a
   * two-minute upstream timeout buys nothing.
   */
  async closeHard(): Promise<void> {
    this.retired = true;
    if (this.closed) return;
    this.closed = true;
    this.onClosed();
    await this.client.close().catch(() => {});
  }

  private closeNow(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClosed();
    void this.client.close().catch(() => {});
  }
}

/**
 * Proxies an MCP server reachable over Streamable HTTP.
 *
 * This backs THREE config kinds, because at runtime they are the same thing:
 *
 *   remote-http          -> some URL on the internet (Granola's server, ...)
 *   local-tunnel         -> a URL that tunnels to a machine a human owns
 *   supplementary-image  -> a container we deployed, at ${bundle.PRIVATE_URL}
 *
 * The only difference is who resolved the URL. Keeping one implementation means
 * a supplementary image gets the same retry/timeout behaviour as a third-party
 * server, for free.
 *
 * `local-tunnel` differs in one respect that IS behavioural rather than
 * cosmetic: its upstream is expected to be absent much of the time, so the
 * handshake is bounded by `connectTimeoutMs` and a connection failure is
 * reported as a machine that is offline. See `LocalMachineOfflineError`.
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
  readonly kind: Exclude<ServerKind, "builtin">;
  /** See `ServerAdapter.host`. Set for `local-tunnel` and nothing else. */
  readonly host?: LocalHost;

  private conn: Conn | null = null;
  private connecting: Promise<Conn> | null = null;
  /**
   * Every connection still holding a socket, cached or not.
   *
   * A retired connection detaches from `conn` while its last request finishes,
   * which leaves it reachable by nobody — and `close()` has to be able to reach
   * it, or a shutdown returns having closed a socket that is still open.
   */
  private readonly live = new Set<Conn>();
  /** Digest of the credential currently believed current. */
  private fingerprint: string | null = null;
  /**
   * Bumped whenever the credential changes.
   *
   * The fingerprint alone cannot serve as the "is this attempt still valid"
   * check, because retiring a connection — which a transport failure does —
   * would have to clear it, and a cleared fingerprint reads as a rotation to any
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
      kind: Exclude<ServerKind, "builtin">;
      /** Resolve the current URL + headers. Called on every operation. */
      endpoint: () => Promise<HttpEndpoint>;
      /**
       * The MCP SDK's default request timeout is 60 SECONDS, and it applies at
       * EVERY hop. Left alone, a long tool call dies at exactly 60s and looks
       * for all the world like an App Platform bug. It is not. Set it here.
       */
      timeoutMs: number;
      /**
       * Bound on the HANDSHAKE specifically. Unset -> the handshake is bounded
       * by `timeoutMs` like every other hop.
       *
       * Worth separating for an upstream that is legitimately absent much of the
       * time, because the two answer different questions: `timeoutMs` is "how
       * long may this work take", and this is "how long until I conclude nobody
       * is there". A closed laptop should not cost a caller the former.
       *
       * It is applied TWICE, deliberately. The SDK's own request timeout rejects
       * the `initialize` call, and an `AbortSignal` on the underlying fetch kills
       * the socket. Only the second one covers the case that actually hurts: a
       * host that accepts a TCP connection and then says nothing, where undici
       * would otherwise sit on it for its 300s headers timeout with the SDK
       * timer unable to free the socket.
       */
      connectTimeoutMs?: number;
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
      /**
       * The machine behind a `local-tunnel`, as the config describes it.
       *
       * Present for that kind alone. It is what turns "this upstream failed"
       * into "go and run these two commands on that laptop" — both in the error
       * a tool call raises and in the troubleshooting tool the listing offers.
       */
      host?: LocalHost;
    },
  ) {
    this.slug = opts.slug;
    this.kind = opts.kind;
    this.host = opts.host;
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
  private async connect(attemptsLeft = 3): Promise<Conn> {
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
      // began. Abandon the cached connection and any in-flight connect: both are
      // bound to the superseded credential. Requests already running on the old
      // connection keep it alive until they finish — they were authorized when
      // they started, and killing them mid-flight would turn every rotation into
      // a handful of failed client calls.
      this.epoch += 1;
      this.fingerprint = fingerprint;
      this.retireCurrent();
      this.connecting = null;
    } else if (this.fingerprint === null) {
      this.fingerprint = fingerprint;
    }

    if (this.conn) return this.conn;

    // Join an in-flight attempt — but through the same handler below, not by
    // returning its promise raw. A raw return skips the retry and the
    // UpstreamError wrap, so a joiner would receive a StaleCredentialError
    // verbatim out of listTools()/callTool().
    const existing = this.connecting;
    if (existing) return this.settle(existing, attemptsLeft);

    const epoch = this.epoch;
    const connectTimeoutMs = this.opts.connectTimeoutMs;
    this.connecting = (async () => {
      // Flipped once the handshake is done. The fetch wrapper below closes over
      // it so that the connect deadline applies to the handshake's HTTP request
      // and NOT to the tool calls that later run on the same transport — a
      // 5s bound is right for "is anyone home" and quite wrong for a tool that
      // drives a browser.
      let handshaking = connectTimeoutMs !== undefined;

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
            // POSTs only. The SDK opens the long-lived server->client SSE
            // stream with a GET, fired from `send()` WITHOUT being awaited, so
            // it lands here a microtask before the handshake resolves and would
            // otherwise inherit the connect deadline — killing the notification
            // stream a few seconds into every connection and making the SDK
            // reconnect it. A deadline meant for "is anyone home" has no
            // business on a stream that is supposed to stay open.
            const isGet = (init?.method ?? "GET").toUpperCase() === "GET";
            if (!handshaking || isGet || connectTimeoutMs === undefined) {
              return fetch(url, { ...init, headers });
            }
            // Compose rather than replace: the SDK sets its own signal on this
            // request, and dropping it would strip the caller's cancellation.
            const deadline = AbortSignal.timeout(connectTimeoutMs);
            const signal = init?.signal
              ? AbortSignal.any([init.signal, deadline])
              : deadline;
            return fetch(url, { ...init, headers, signal });
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
      try {
        await this.hop("connect", () =>
          client.connect(
            transport,
            connectTimeoutMs === undefined
              ? undefined
              : { timeout: connectTimeoutMs },
          ),
        );
      } finally {
        // Whatever happened, the connect deadline stops applying: on success
        // the transport goes on to serve tool calls, and on failure it is
        // discarded. Clearing it in `finally` is what keeps a retry from
        // inheriting a signal that has already fired.
        handshaking = false;
      }

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
      const conn: Conn = new Conn(client, () => this.live.delete(conn));
      this.live.add(conn);
      this.conn = conn;
      return conn;
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
    attempt: Promise<Conn>,
    attemptsLeft: number,
  ): Promise<Conn> {
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
      throw this.wrap(err, "connect");
    }
  }

  /**
   * Turn an upstream failure into the error a caller should see.
   *
   * "The machine is off" is a claim about the TRANSPORT, and only about it.
   *
   * It is tempting to reuse `isConnectionFault` here, since both questions look
   * like "was this the connection's fault". They are not the same question.
   * That predicate decides whether to RETIRE A SOCKET, where guessing wrong
   * costs one handshake, so it answers `true` for everything it does not
   * recognise. This decides what to TELL A HUMAN, and what
   * `listToolsFor` may quietly drop — and there, guessing wrong means a running
   * machine is reported as switched off and its failure disappears from a
   * listing that should have failed. So this predicate is narrow, and anything
   * it is unsure about stays an ordinary upstream error.
   */
  private wrap(err: unknown, phase: "connect" | "request"): UpstreamError {
    if (this.kind !== "local-tunnel") return new UpstreamError(this.slug, err);
    // The remedy rides on the error, not just on the troubleshooting tool: a
    // client calling a REAL tool on a sleeping laptop gets this message, and
    // there is no version of this where that caller deserves less help than one
    // who happened to list tools first. Built per branch rather than up front —
    // an ordinary 404 from this kind is a failure like any other and should not
    // pay for prose nobody will read.
    const host = this.opts.host;

    // A door that said no. Narrow on purpose — 401/403 only, and only for this
    // kind — because it is the one 4xx whose fix is a credential somebody owns
    // rather than a strad config error. A 404 (wrong path) and a 500 (the
    // server ran and threw) stay ordinary upstream failures.
    if (refusedByHost(err)) {
      return new LocalHostRefusedError(
        this.slug,
        err,
        host && remedyText(host, "refused"),
      );
    }

    const verdict = this.offlineReason(err, phase);
    if (!verdict) return new UpstreamError(this.slug, err);
    return new LocalMachineOfflineError(
      this.slug,
      err,
      // A duration is only honest when a deadline is what expired, and only the
      // handshake's deadline is this one. A refused connection came back in a
      // millisecond, and saying "no answer within 5000ms" about it invites
      // someone to go looking for a slow network.
      verdict === "timeout" ? this.opts.connectTimeoutMs : undefined,
      host && remedyText(host, "offline"),
    );
  }

  /**
   * Is this failure, on this adapter, a machine that is not there?
   *
   * The kind check belongs with the verdict rather than at each caller: only a
   * `local-tunnel` HAS a machine to be off, and every other kind's unreachable
   * upstream is a hosted component that should be investigated.
   */
  private offlineReason(
    err: unknown,
    phase: "connect" | "request",
  ): "timeout" | "unreachable" | null {
    return this.kind === "local-tunnel" ? offlineVerdict(err, phase) : null;
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
      // The RAW failure, ahead of `wrap()` — this hop runs inside the try that
      // wraps it, so the `LocalMachineOfflineError` built from this error does
      // not exist yet and a kind it declares cannot reach here. The verdict has
      // to be asked for directly, from the same predicate `wrap()` uses, or the
      // counter and the error a caller receives disagree about the same failure:
      // a switched-off laptop was scattered across `upstream_unavailable` (a
      // refused connection), `timeout` (a black hole) and `unknown` (a tunnel
      // edge answering 502/530, which is the commonest shape and the one prod
      // logged 239 of), with no way to tell any of them from a real fault.
      const offline = this.offlineReason(
        err,
        op === "connect" ? "connect" : "request",
      );
      const kind = offline ? "local_machine_offline" : errorKind(err);
      span.setAttribute("error.kind", kind);
      // No recordException — an upstream's error message is not ours to export.
      // See src/telemetry/redact.ts.
      span.setStatus({ code: SpanStatusCode.ERROR });

      inst.upstreamDuration.record(elapsedSeconds(startedAt), {
        ...attrs,
        outcome: "error",
      });
      inst.upstreamErrors.add(1, { ...attrs, "error.kind": kind });
      // A deadline expired is a deadline expired, whoever's machine it was. The
      // offline verdict renames the ERROR KIND, and letting it also suppress
      // this counter would quietly drop every handshake that blew
      // `connectTimeoutMs` out of the one series that answers "how long are we
      // waiting on people who are not there".
      if (kind === "timeout" || offline === "timeout") {
        inst.upstreamTimeouts.add(1, attrs);
      }

      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Run one request on a leased connection.
   *
   * This is the only path that touches the shared client, and it is where the
   * "a failure retires the connection" rule lives — narrowed to failures that
   * actually mean the connection is unusable. An upstream that ANSWERS, even
   * with a JSON-RPC error, has a working transport, so retiring it would be
   * pointless churn; the lease is what keeps that churn from also being fatal to
   * whatever else is running on the connection.
   */
  private async lease<T>(
    conn: Conn,
    op: string,
    run: (client: Client) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.hop(op, () => run(conn.client));
    } catch (err) {
      if (isConnectionFault(err)) this.retire(conn);
      // A request failure CAN be an offline verdict, and usually is the first
      // one anyone sees: the connection is cached, so shutting a laptop is
      // discovered by a request running on a socket that has just died rather
      // than by a fresh handshake. What `phase` buys is the narrower reading of
      // a DEADLINE here — the machine answered the handshake this request is
      // running on, so a timeout now is a slow tool, not an absent machine.
      throw this.wrap(err, "request");
    } finally {
      conn.release();
    }
  }

  /**
   * A connection with a lease already taken on it. Every request path starts
   * here, and `lease()` releases it.
   *
   * The retry covers the handoff: `connect()` can hand back a connection that a
   * peer's failure retires before this caller resumes. That connection is
   * already detached from the cache, so connecting again builds a fresh one.
   * Bounded, because "the connection I was just given is gone" repeating without
   * end is a bug, not a condition to spin on.
   */
  private async leased(attemptsLeft = 3): Promise<Conn> {
    const conn = await this.connect();
    if (conn.acquire()) return conn;
    if (attemptsLeft > 1) return this.leased(attemptsLeft - 1);
    throw new UpstreamError(
      this.slug,
      new Error("every connection was retired before it could be used"),
    );
  }

  async listTools(): Promise<Tool[]> {
    const conn = await this.leased();
    const res = await this.lease(conn, "list_tools", (client) =>
      client.listTools({}, { timeout: this.opts.timeoutMs }),
    );
    return res.tools.map((t) => ({ ...t, name: this.strip(t.name) }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const conn = await this.leased();
    const res = await this.lease(conn, "call_tool", (client) =>
      client.callTool(
        { name: this.restore(name), arguments: args },
        undefined,
        {
          timeout: this.opts.timeoutMs,
        },
      ),
    );
    return res as unknown as CallToolResult;
  }

  /**
   * List this upstream's resources (e.g. an MCP App's `ui://` template).
   *
   * Whether a server HAS resources is answered by its handshake, not by asking
   * and reading the refusal. Most servers strad proxies are tools-only: they
   * advertise `{ tools: {} }`, have no `resources/list` handler, and answer the
   * call with `-32601 Method not found`. Sending it anyway costs a round trip
   * per client listing and produces a failure for something that is not one.
   *
   * `-32601` is tolerated as well, for a server that advertises the capability
   * and does not implement it. That is a protocol CODE, not a phrase. The SDK's
   * own client-side capability check is gated on `enforceStrictCapabilities`,
   * which the gateway does not set, so no refusal is ever raised locally and the
   * answer has to come from the handshake or from the code on the wire.
   */
  async listResources(): Promise<Resource[]> {
    const conn = await this.leased();
    if (!conn.client.getServerCapabilities()?.resources) {
      // Nothing was sent, so there is nothing to release but the lease itself.
      conn.release();
      return [];
    }
    try {
      const res = await this.lease(conn, "list_resources", (client) =>
        client.listResources({}, { timeout: this.opts.timeoutMs }),
      );
      return res.resources;
    } catch (err) {
      if (isMethodNotFound(err)) return [];
      throw err;
    }
  }

  /**
   * Read one resource by URI from this upstream.
   *
   * Gated on the same advertised capability as `listResources`, because the
   * router SWEEPS: a read whose URI hint misses tries every other selected
   * server in turn. Without the gate that sweep spends a round trip on each
   * tools-only slug — most of them — to be told `-32601` every time.
   */
  async readResource(uri: string): Promise<ReadResourceResult> {
    const conn = await this.leased();
    if (!conn.client.getServerCapabilities()?.resources) {
      conn.release();
      throw new UpstreamError(
        this.slug,
        new Error("this server does not serve resources"),
      );
    }
    // The URI is NOT recorded as an attribute. A `ui://` app template is
    // harmless, but readResource is a general-purpose read and a URI can name
    // a file path or an object key. Identifier-shaped is not the same as
    // safe-to-export, and this one is not worth the argument.
    return this.lease(conn, "read_resource", (client) =>
      client.readResource({ uri }, { timeout: this.opts.timeoutMs }),
    );
  }

  async postRaw(path: string, req: Request, res: Response): Promise<void> {
    const endpoint = await this.opts.endpoint();
    const url = new URL(endpoint.url);
    url.pathname = joinPath(url.pathname, path);
    url.search = "";

    const headers = new Headers(endpoint.headers);
    const contentType = req.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    const contentLength = req.get("content-length");
    if (contentLength) headers.set("content-length", contentLength);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const upstream = await this.hop("post_raw", () =>
        fetch(url, {
          method: "POST",
          headers,
          body: req,
          duplex: "half",
          signal: controller.signal,
        } as RequestInit & { duplex: "half" }),
      );
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (key.toLowerCase() === "transfer-encoding") return;
        res.setHeader(key, value);
      });
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.send(buffer);
    } finally {
      clearTimeout(timeout);
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
   * Take a specific connection out of service after a transport failure.
   *
   * Scoped to the connection the failing call actually used: by the time a slow
   * request fails, another caller may already have installed a fresh, healthy
   * connection, and evicting THAT one would make each failure cost the next
   * request a handshake it did not need.
   *
   * Deliberately does NOT touch the fingerprint. A dead socket says nothing
   * about the credential, and clearing it would manufacture a phantom rotation:
   * an in-flight connect would see its epoch check fail, close a working
   * connection, and handshake again for no reason.
   */
  private retire(conn: Conn): void {
    if (this.conn === conn) this.conn = null;
    conn.retire();
  }

  /** Retire whatever is cached, if anything. */
  private retireCurrent(): void {
    const conn = this.conn;
    this.conn = null;
    conn?.retire();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.conn = null;
    this.fingerprint = null;
    // Abandon any in-flight attempt too. Without this it completes after the
    // adapter is shut, and would open a fresh connection on a closed adapter.
    this.connecting = null;
    // Every live connection, not just the cached one: a retired connection
    // waiting on its last request is exactly the socket a shutdown must not
    // leave behind.
    const live = [...this.live];
    this.live.clear();
    await Promise.all(live.map((conn) => conn.closeHard()));
  }
}

function joinPath(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
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
 * Does this failure mean the CONNECTION is unusable — as opposed to the request?
 *
 * The distinction is the whole reason one server's bad answer can no longer cost
 * another request its connection. An `McpError` carrying any code other than the
 * two the SDK raises locally ARRIVED, in a JSON-RPC error response, over a
 * transport that is by definition still working. A timeout, a closed connection,
 * a DNS failure or an aborted fetch is the opposite: the cached client is
 * suspect, and the next caller should get a fresh one.
 *
 * Unrecognised failures are treated as connection faults. Retiring a good
 * connection costs one handshake; keeping a dead one costs every subsequent
 * request until the process restarts.
 */
function isConnectionFault(err: unknown): boolean {
  if (err instanceof McpError) {
    return (
      err.code === ErrorCode.ConnectionClosed ||
      err.code === ErrorCode.RequestTimeout
    );
  }
  return true;
}

/**
 * HTTP statuses that mean "the edge is up, the machine behind it is not".
 *
 * A tunnel is two hops, and the far one is the machine. When the machine goes,
 * the near hop stays up and answers on its behalf: Cloudflare says 530 (or 521
 * / 522 / 523 / 524), a plain reverse proxy says 502 / 503 / 504. This is the
 * COMMONEST offline shape in practice — the hostname still resolves, still
 * terminates TLS, and still answers — and reading it as an ordinary HTTP error
 * would mean the one failure this kind exists for is the one it misses.
 *
 * 4xx is deliberately absent. A 404 means something answered and did not have
 * that path, which is a config error and not a closed lid; a 500 means the
 * server itself is running and threw. Calling either of those "your machine is
 * off" sends someone to check a laptop that was never the problem.
 */
const ORIGIN_UNREACHABLE_STATUSES = new Set([
  502, 503, 504, 521, 522, 523, 524, 530,
]);

/**
 * Is this handshake failure a machine that is not there?
 *
 * Returns why, or null for "not an offline verdict". Null is the safe answer
 * and the default for anything unrecognised: an ordinary upstream error is
 * merely unhelpful, while a false offline verdict both misdescribes the fault
 * and lets `listToolsFor` drop the slug from a listing in silence.
 */
function offlineVerdict(
  err: unknown,
  phase: "connect" | "request",
): "timeout" | "unreachable" | null {
  if (err instanceof McpError) {
    // A deadline expiring means "nobody answered" during the HANDSHAKE and
    // "this tool is slow" during a request — the machine already proved it was
    // there by completing the handshake this request is running on.
    if (err.code === ErrorCode.RequestTimeout) {
      return phase === "connect" ? "timeout" : null;
    }
    if (err.code === ErrorCode.ConnectionClosed) return "unreachable";
    // Any other code ARRIVED, in a JSON-RPC response, over a working
    // transport. The machine is up and said no.
    return null;
  }
  if (err instanceof StreamableHTTPError) {
    // `code` is the HTTP status, and -1 for "unexpected content type" — which
    // is a response, so not an offline verdict either.
    return err.code !== undefined && ORIGIN_UNREACHABLE_STATUSES.has(err.code)
      ? "unreachable"
      : null;
  }
  // An abort — ours, from the connect deadline — or a fetch that never got a
  // response at all: DNS failure, connection refused, TLS failure.
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError")
      return "timeout";
    if (
      /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(
        err.message,
      )
    ) {
      return "unreachable";
    }
    // `fetch` wraps the real reason in `cause`, and the message above is often
    // just "fetch failed" with everything useful one level down.
    const cause = (err as { cause?: unknown }).cause;
    if (
      cause instanceof Error &&
      /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(cause.message)
    ) {
      return "unreachable";
    }
  }
  return null;
}

/** A JSON-RPC `-32601`, through the `UpstreamError` wrapper or raw. */
function isMethodNotFound(err: unknown): boolean {
  const cause = err instanceof UpstreamError ? err.cause : err;
  return cause instanceof McpError && cause.code === ErrorCode.MethodNotFound;
}

export class UpstreamError extends Error {
  constructor(
    readonly slug: string,
    readonly cause: unknown,
    message?: string,
  ) {
    super(
      message ??
        `upstream MCP server "${slug}" failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
    );
  }
}

/**
 * A `local-tunnel` server that is not serving because of its HOST — the machine
 * is not there, or it is there and said no.
 *
 * The distinction from a plain `UpstreamError` is not decoration. For every
 * other kind, "the upstream did not answer" is a fault worth investigating; for
 * this one it is a condition with a named owner and a known remedy, and the only
 * useful thing to tell anyone is WHICH machine and WHAT TO RUN ON IT. It
 * subclasses `UpstreamError` so that every existing catch, retire and telemetry
 * path treats it identically — only the words differ.
 *
 * TELEMETRY is the one place it must NOT be identical, and for a while it was.
 * `errorKind()` reads a message when it has nothing better, and these messages
 * are strad's own reassurance rather than an upstream's stack, so they matched
 * nothing and exported as `unknown` — the same word an unclassified fault gets.
 * Hence `telemetryKind`: the constructor knows what this is, so it says so
 * instead of leaving the exporter to guess. See `SelfClassifyingError` in
 * redact.ts.
 *
 * The two subclasses declare DIFFERENT kinds, and that is the point. A machine
 * that is off is the one upstream failure this repo documents as expected. A
 * machine that REFUSES is an ordinary fault that happens to have a friendly
 * remedy attached — a credential has gone stale and somebody must act — so it
 * keeps `upstream_error` and keeps paging.
 *
 * It is also the licence `listToolsFor` needs: an error of this class is what
 * lets a slug be replaced by its troubleshooting tool rather than failing a
 * listing. That is why the two subclasses below are the ONLY things that may
 * produce it, and why both are narrow.
 *
 * The message is strad's OWN, built from the slug, a duration and the config's
 * `recovery:` block. It relays no upstream prose, which is what makes it safe to
 * hand to a client verbatim — see the note in gateway/mcpServer.ts.
 */
export abstract class LocalHostUnavailableError
  extends UpstreamError
  implements SelfClassifyingError
{
  /** Which shape of unavailable, for the troubleshooting surface. */
  abstract readonly state: HostState;
  abstract readonly telemetryKind: ErrorKind;
}

/** The machine is not there: asleep, shut down, or its tunnel is stopped. */
export class LocalMachineOfflineError extends LocalHostUnavailableError {
  readonly state = "offline" as const;
  readonly telemetryKind = "local_machine_offline" as const;

  constructor(
    slug: string,
    cause: unknown,
    waitedMs: number | undefined,
    remedy?: string,
  ) {
    super(
      slug,
      cause,
      `the machine hosting "${slug}" is not reachable` +
        (waitedMs === undefined ? "" : ` (no answer within ${waitedMs}ms)`) +
        `. "${slug}" is a local-tunnel server: it works only while that machine ` +
        `is running the server and its tunnel is up. Nothing is wrong with strad.` +
        (remedy ? `\n\n${remedy}` : ""),
    );
  }
}

/**
 * The machine is there and refused strad: a `401` or a `403`.
 *
 * Deliberately NOT an "offline" verdict, however similar the symptom looks from
 * a listing. The machine is up, so telling its owner to restart a tunnel wastes
 * their time — an access token expired, or an app bearer stopped matching. The
 * two states exist to carry exactly that difference into the remedy.
 */
export class LocalHostRefusedError extends LocalHostUnavailableError {
  readonly state = "refused" as const;
  // NOT `local_machine_offline`. That kind exempts one condition from being a
  // fault — a laptop that is switched off — and this is not it: the machine is
  // answering, a credential has gone stale, and it will not clear until
  // somebody rotates it. It should page like any other upstream error.
  readonly telemetryKind = "upstream_error" as const;

  constructor(slug: string, cause: unknown, remedy?: string) {
    super(
      slug,
      cause,
      `the machine hosting "${slug}" refused strad's credentials. It is ANSWERING — ` +
        `this is not a machine that is switched off — so what is stale is a credential: ` +
        `the access token in front of the tunnel, or the server's own bearer.` +
        (remedy ? `\n\n${remedy}` : ""),
    );
  }
}

/**
 * A `401`/`403` from the far side of a tunnel.
 *
 * `StreamableHTTPError.code` is the HTTP status. Only these two: a `404` is a
 * wrong path in strad's own config and a `500` is the server running and
 * throwing, and neither is fixed by anyone at the machine.
 */
function refusedByHost(err: unknown): boolean {
  return (
    err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)
  );
}
