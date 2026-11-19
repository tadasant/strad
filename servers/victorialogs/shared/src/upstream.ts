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
 * The supervised mcp-victorialogs process, and the MCP client that speaks to it.
 *
 * THE SAME SEAM AS GRAFANA'S, for the same reasons. VictoriaMetrics ships its
 * MCP server as a Go binary and a Docker image and nothing else, so the
 * Dockerfile bakes the pinned, SHA-256-verified binary onto PATH and this file
 * turns it into a mount: one child per mount, started lazily on the first call,
 * over stdio, with concurrent first calls sharing one start and a dead child
 * replaced on the next call. servers/grafana/shared/src/upstream.ts is the
 * long-form argument for each of those choices; this is a second copy of that
 * supervisor rather than a shared one because each tree is its own npm project
 * with its own lockfile, built in its own Docker stage.
 *
 * NO FLAGS. mcp-victorialogs is configured entirely by its environment (see
 * config.ts), and it has no write tools to disable: its thirteen tools are all
 * annotated `readOnlyHint: true`, because VictoriaLogs' query API has nothing
 * to write with. Its `/insert` and `/delete` endpoints are not tools it serves.
 */

/** Where the Dockerfile installs the pinned binary. */
export const DEFAULT_BINARY = "mcp-victorialogs";

/**
 * How long one proxied tool call may take. A LogsQL query over a wide window on
 * a busy VictoriaLogs is comfortably slower than the SDK's 60s default; 120s is
 * still a bound.
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
   * a VictoriaLogs mount whose binary is missing says so on /healthz instead of only
   * in the error of whoever called it next.
   */
  onDegraded?: (reason: string | null) => void;
}

export class VictoriaLogsUpstream {
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
      ((line) => process.stderr.write(`[victorialogs:${options.slug}] ${line}\n`));
    this.#onDegraded = options.onDegraded ?? (() => {});
  }

  /** The tools the child serves, as it lists them. */
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
   * schema this file maintains: the tools are VictoriaMetrics', their arguments are
   * VictoriaMetrics', and a proxy that reshapes them is a proxy that silently drops the
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
    if (this.#closed) throw new Error(`victorialogs (${this.#slug}): mount is closed`);
    if (this.#connection) return this.#connection;

    const generation = this.#generation;
    const attempt = this.#connect(generation);
    this.#connection = attempt;
    attempt.catch((error: unknown) => {
      this.#invalidate(generation);
      this.#onDegraded(`mcp-victorialogs could not be started: ${errMessage(error)}`);
    });
    return attempt;
  }

  async #connect(generation: number): Promise<Client> {
    const transport = new StdioClientTransport({
      command: this.#binary,
      args: [],
      // The whole environment the child gets. See config.ts: this is an
      // allowlist precisely so the bundle's other credentials stay out of it.
      env: upstreamEnv(this.#env),
      // mcp-victorialogs logs to stderr and speaks JSON-RPC on stdout. Piping keeps
      // its lines attributable to this slug in a container that has dozens of mounts;
      // inheriting would interleave them namelessly with the host's own.
      stderr: "pipe",
    });

    const client = new Client(
      { name: "strad-victorialogs-proxy", version: this.#version },
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
        this.#log("mcp-victorialogs exited; the next tool call restarts it");
      }
    };

    this.#onDegraded(null);
    this.#log(`mcp-victorialogs up (${this.#binary})`);
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
