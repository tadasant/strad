import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  Tool,
  Resource,
  ReadResourceResult,
  ClientCapabilities as SdkClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { GATEWAY_UPSTREAM_CAPABILITIES } from "../clientCapabilities.ts";
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
        { requestInit: { headers: this.opts.headers } },
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

      await client.connect(transport);
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

  async listTools(): Promise<Tool[]> {
    const client = await this.connect();
    try {
      const res = await client.listTools({}, { timeout: this.opts.timeoutMs });
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
      const res = await client.callTool(
        { name: this.restore(name), arguments: args },
        undefined,
        { timeout: this.opts.timeoutMs },
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
      const res = await client.listResources(
        {},
        { timeout: this.opts.timeoutMs },
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
      return await client.readResource(
        { uri },
        { timeout: this.opts.timeoutMs },
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
