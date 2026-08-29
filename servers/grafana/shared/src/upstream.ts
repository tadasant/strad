import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { type Env, upstreamEnv } from "./config.js";

/**
 * The supervised mcp-grafana process, and the MCP client that speaks to it.
 *
 * WHY A CHILD PROCESS AT ALL. Grafana ships its MCP server as a Go binary and a
 * Docker image, and as nothing else — there is no npm package to import the way
 * every other tree in this bundle is imported. The binary is baked into the
 * image at a pinned version with its SHA-256 verified at build time (see
 * servers/bundle/Dockerfile); this is the seam that turns it into a mount.
 *
 * WHY STDIO, when the binary also speaks streamable-HTTP. Because stdio needs no
 * port, opens no listener inside the container, and hands the process lifecycle
 * to the SDK transport, which spawns and reaps it. The reason to have reached
 * for HTTP would have been concurrency — and there is none to win: measured
 * against a Grafana that sleeps 2s per request, three concurrent tool calls over
 * one stdio child complete in 2007ms, not 6s. The binary reads the pipe and
 * answers on goroutines.
 *
 * ONE CHILD PER MOUNT, LAZILY. A slug's credential is one Grafana, so two slugs
 * pointing at two Grafanas are two children — the same shape telegram and
 * google-sheets take for the same reason. The child is not started at boot: a
 * mount nobody calls costs nothing, and a bundle that spawned every child at
 * boot would turn one unconfigured Grafana into 20 servers' worth of restart
 * noise.
 */

/**
 * The flags, and the argument that they are not a policy decision this file gets
 * to revisit.
 *
 * `-disable-write` drops the 13 write tools (create/update/delete of dashboards,
 * datasources, folders, annotations, incidents, snapshots) and narrows the
 * alerting tools to their read actions: 65 tools become 52. It is the flag the
 * hand-rolled stdio bootstrap this mount replaces already ran with, and the
 * point of it is that a write is IMPOSSIBLE rather than merely withheld.
 *
 * That is a deliberate exception to this container's rule that every upstream
 * runs at FULL capability and the gateway narrows it (servers/bundle/README.md).
 * The gateway can only ever withhold a tool, so a binary-level `-disable-write`
 * is strictly stronger than any `tools: deny` — and Grafana is a control plane
 * for the fleet's observability, where the cost of a wrong write is a dashboard
 * or an alert rule nobody notices is gone. A deployment that genuinely needs
 * writes adds a second mount that does not pass this flag, rather than loosening
 * this one.
 *
 * `-disable-proxied` is the less obvious half. "Proxied" tools are tools
 * mcp-grafana DISCOVERS at startup from MCP servers advertised by the Grafana's
 * own datasources — their names, their schemas and their side effects are
 * authored by whoever administers that Grafana, and `-disable-write` does not
 * constrain them, because they are not Grafana's tools. Leaving them on would
 * mean a read-only mount whose surface a remote administrator can extend with a
 * write, and a tool surface that changes when a datasource does — which also
 * makes it unenumerable by `scripts/check-tool-policy.ts`, whose whole job is to
 * compare a config's allow-list against the names a mount really serves. Off, it
 * serves the same 52 names everywhere.
 */
export const READ_ONLY_ARGS = [
  "-t",
  "stdio",
  "-disable-write",
  "-disable-proxied",
] as const;

/** Where the Dockerfile installs the pinned binary. */
export const DEFAULT_BINARY = "mcp-grafana";

/**
 * How long one proxied tool call may take.
 *
 * The SDK's default is 60s. A Prometheus range query over a wide window, or a
 * Sift investigation, is comfortably slower than that on a busy Grafana, and a
 * timeout here is indistinguishable to the caller from a broken mount. 120s is
 * still bounded — the point is that the child cannot hold a request open
 * forever, not that it is quick.
 */
export const REQUEST_TIMEOUT_MS = 120_000;

export interface UpstreamOptions {
  /** The strad slug this instance serves, for log attribution. */
  slug: string;
  /** The version the proxy identifies itself to the child as. */
  version: string;
  /** ONE slug's view of the container environment. */
  env: Env;
  /** Overridden by tests; the image puts the pinned binary on PATH. */
  binary?: string;
  /** Where a line of the child's stderr goes. Defaults to this process's. */
  log?: (line: string) => void;
  /**
   * Called with a reason when the child cannot be kept up, and with null when it
   * comes back. The bundle host reports this as the mount's `degraded` state, so
   * a Grafana mount whose binary is missing says so on /healthz instead of only
   * in the error of whoever called it next.
   */
  onDegraded?: (reason: string | null) => void;
}

export class GrafanaUpstream {
  readonly #slug: string;
  readonly #version: string;
  readonly #env: Env;
  readonly #binary: string;
  readonly #log: (line: string) => void;
  readonly #onDegraded: (reason: string | null) => void;

  /** The in-flight or established connection, or null when there is none. */
  #connection: Promise<Client> | null = null;
  /**
   * Which connection the cache holds, as a number.
   *
   * A child that exits reports it through `onclose`, and that can arrive at any
   * time — including after a reconnect has already replaced the connection it
   * refers to. Comparing promise identity almost works and is easy to get subtly
   * wrong (the promise the cache holds is not always the one the caller was
   * handed); a counter that only ever moves forward cannot be.
   */
  #generation = 0;
  /** Set by close(); stops a reconnect racing the shutdown. */
  #closed = false;

  constructor(options: UpstreamOptions) {
    this.#slug = options.slug;
    this.#version = options.version;
    this.#env = options.env;
    this.#binary = options.binary ?? DEFAULT_BINARY;
    this.#log =
      options.log ??
      ((line) => process.stderr.write(`[grafana:${options.slug}] ${line}\n`));
    this.#onDegraded = options.onDegraded ?? (() => {});
  }

  /** The 52 read tools the child serves. */
  async listTools(): Promise<Tool[]> {
    const client = await this.#client();
    const result = await client.request(
      { method: "tools/list", params: {} },
      ListToolsResultSchema,
      { timeout: REQUEST_TIMEOUT_MS },
    );
    return result.tools;
  }

  /**
   * One tool call, forwarded verbatim.
   *
   * The params go through as they arrived rather than being rebuilt from a
   * schema this file maintains: the tools are Grafana's, their arguments are
   * Grafana's, and a proxy that reshapes them is a proxy that silently drops the
   * argument added in the next release.
   */
  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    const client = await this.#client();
    return await client.request(
      { method: "tools/call", params },
      CallToolResultSchema,
      { timeout: REQUEST_TIMEOUT_MS },
    );
  }

  /** Stop the child. Idempotent. */
  async close(): Promise<void> {
    this.#closed = true;
    const connection = this.#connection;
    this.#invalidate(this.#generation);
    if (!connection) return;
    await connection.then(
      (client) => client.close(),
      // A connection that never established has no process to stop.
      () => {},
    );
  }

  /**
   * The connected client, starting the child if it is not up.
   *
   * CONCURRENT CALLERS SHARE ONE ATTEMPT. The promise is cached before it
   * resolves, so twenty simultaneous tool calls against a cold mount start one
   * process rather than twenty.
   *
   * A FAILED ATTEMPT IS NOT CACHED. Clearing it on rejection is what makes the
   * next call retry: the failure modes here are a binary that is not there yet
   * and a child that was OOM-killed, and neither should turn into a mount that
   * stays broken until the container restarts. The same clearing on `onclose` is
   * what makes a child that DIED get replaced.
   */
  async #client(): Promise<Client> {
    if (this.#closed) throw new Error(`grafana (${this.#slug}): mount is closed`);
    if (this.#connection) return this.#connection;

    const generation = this.#generation;
    const attempt = this.#connect(generation);
    this.#connection = attempt;
    attempt.catch((error: unknown) => {
      this.#invalidate(generation);
      this.#onDegraded(`mcp-grafana could not be started: ${errMessage(error)}`);
    });
    return attempt;
  }

  async #connect(generation: number): Promise<Client> {
    const transport = new StdioClientTransport({
      command: this.#binary,
      args: [...READ_ONLY_ARGS],
      // The whole environment the child gets. See config.ts: this is an
      // allowlist precisely so the bundle's other credentials stay out of it.
      env: upstreamEnv(this.#env),
      // mcp-grafana logs to stderr and speaks JSON-RPC on stdout. Piping keeps
      // its lines attributable to this slug in a container that has 20 mounts;
      // inheriting would interleave them namelessly with the host's own.
      stderr: "pipe",
    });

    const client = new Client(
      { name: "strad-grafana-proxy", version: this.#version },
      { capabilities: {} },
    );

    await client.connect(transport);

    const stderr = transport.stderr;
    if (stderr) {
      let buffered = "";
      stderr.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        let index: number;
        while ((index = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, index);
          buffered = buffered.slice(index + 1);
          if (line.trim()) this.#log(line);
        }
      });
    }

    client.onclose = () => {
      // Only clears the cache if it still holds THIS child. A close that arrives
      // after a reconnect has already replaced it would otherwise throw away a
      // healthy process.
      if (this.#invalidate(generation) && !this.#closed) {
        this.#log("mcp-grafana exited; the next tool call restarts it");
      }
    };

    this.#onDegraded(null);
    this.#log(`mcp-grafana up (${[this.#binary, ...READ_ONLY_ARGS].join(" ")})`);
    return client;
  }

  /**
   * Drop the cached connection if it is still generation `generation`, and
   * report whether it was.
   *
   * Moving the counter is what makes this idempotent: a second `onclose` for a
   * child already replaced compares unequal and does nothing.
   */
  #invalidate(generation: number): boolean {
    if (generation !== this.#generation) return false;
    this.#connection = null;
    this.#generation += 1;
    return true;
  }
}

export function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
