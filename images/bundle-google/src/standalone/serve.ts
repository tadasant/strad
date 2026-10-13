/**
 * Run ONE of this image's servers on its own, without strad and without the
 * other three: over stdio for a local MCP client, or over Streamable HTTP on a
 * localhost port.
 *
 * Each per-server entrypoint beside this file (`google-calendar.ts`) is a few
 * lines that hand `serveStandalone` a factory. The factory is the same one
 * `src/index.ts` mounts, so a standalone server is the bundled server, not a
 * second implementation of it.
 *
 *   node dist/standalone/<server>.js                              # stdio
 *   node dist/standalone/<server>.js --transport http [--port N] [--host H]
 *
 * The port is `--port`, else `PORT`, else 3000. The host defaults to
 * 127.0.0.1, and on a loopback host a request whose `Host` header is not
 * loopback is refused, so a web page cannot reach the server by DNS rebinding.
 * Any other host turns that check off. There is no authentication on this
 * endpoint: bind it off loopback only behind something that authenticates.
 *
 * HTTP is STATELESS, as in `src/index.ts`: a fresh server and transport per
 * POST, the same 8mb body limit, and no standalone SSE stream, so GET and
 * DELETE answer 405. Nothing here reads a credential; each server reads its
 * own env lazily, at the first tool call, so `tools/list` answers with none
 * set.
 *
 * stdout belongs to the protocol in stdio mode, so everything this file logs
 * goes to stderr.
 */
import { parseArgs } from "node:util";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";

export interface StandaloneServer {
  /** The name logged at startup and reported by `/healthz`. */
  name: string;
  /** Build a fresh, unconnected server. Called once for stdio, once per request for HTTP. */
  build: () => { server: Server; registerHandlers: (server: Server) => Promise<void> };
  /** Credential variables to warn about at startup when unset. Never required to boot. */
  credentialEnv?: string[];
  /**
   * Refuse to start on a setting the server would otherwise misread. Returns
   * the reason, or undefined. Checked before anything is served.
   */
  validateEnv?: (env: NodeJS.ProcessEnv) => string | undefined;
}

export interface StandaloneOptions {
  transport: "stdio" | "http";
  port: number;
  host: string;
}

const USAGE = `usage: <server> [--transport stdio|http] [--port N] [--host H]

  --transport  stdio (default) or http (Streamable HTTP at /mcp)
  --port       HTTP port; defaults to $PORT, then 3000
  --host       HTTP bind address; defaults to 127.0.0.1`;

export class UsageError extends Error {}

/** `--help` was asked for: print the usage to stdout and exit 0. */
export class HelpRequested extends Error {
  constructor() {
    super(USAGE);
  }
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/** Parse argv into options. Throws a `UsageError` on anything it does not know. */
export function parseOptions(argv: string[], env: NodeJS.ProcessEnv): StandaloneOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        transport: { type: "string" },
        port: { type: "string" },
        host: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }
  if (values.help) throw new HelpRequested();

  const transport = values.transport ?? "stdio";
  if (transport !== "stdio" && transport !== "http") {
    throw new UsageError(`--transport must be stdio or http, got "${transport}"\n\n${USAGE}`);
  }
  const host = values.host ?? "127.0.0.1";
  // stdio has no port, so a stray `PORT` in the environment must not stop it.
  if (transport === "stdio") return { transport, port: 0, host };

  const rawPort = values.port ?? env.PORT ?? "3000";
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!(port >= 0 && port <= 65535)) {
    throw new UsageError(`port must be an integer from 0 to 65535, got "${rawPort}"\n\n${USAGE}`);
  }
  return { transport, port, host };
}

/** Start the server and resolve once it is listening (HTTP) or connected (stdio). */
export async function serveStandalone(
  spec: StandaloneServer,
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let options: StandaloneOptions;
  try {
    options = parseOptions(argv, env);
  } catch (err) {
    if (err instanceof HelpRequested) {
      console.log(err.message);
      process.exit(0);
    }
    if (err instanceof UsageError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  const invalid = spec.validateEnv?.(env);
  if (invalid) {
    console.error(`[${spec.name}] ${invalid}`);
    process.exit(2);
  }

  const missing = (spec.credentialEnv ?? []).filter((name) => !env[name]);
  if (missing.length > 0) {
    console.error(
      `[${spec.name}] ${missing.join(", ")} not set: tools will list, and every tool call will fail until they are.`,
    );
  }

  if (options.transport === "stdio") {
    const { server, registerHandlers } = spec.build();
    await registerHandlers(server);
    await server.connect(new StdioServerTransport());
    console.error(`[${spec.name}] serving MCP on stdio`);
    return;
  }

  await serveHttp(spec, options);
}

async function serveHttp(spec: StandaloneServer, options: StandaloneOptions): Promise<void> {
  const app = express();
  app.disable("x-powered-by");
  if (LOOPBACK_HOSTS.includes(options.host)) app.use(localhostHostValidation());
  app.use(express.json({ limit: "8mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, server: spec.name });
  });

  // Stateless: no session to resume over GET, none to end over DELETE.
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.post("/mcp", (req: Request, res: Response) => {
    void (async () => {
      const { server, registerHandlers } = spec.build();
      await registerHandlers(server);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    })().catch((err: unknown) => {
      console.error(`[${spec.name}] request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal error" },
          id: null,
        });
      }
    });
  });

  // A body that is not JSON, or is over the limit, gets a JSON-RPC error rather
  // than Express's default HTML page with a stack trace in it.
  app.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = err.status ?? 500;
    res.status(status).json({
      jsonrpc: "2.0",
      error: { code: status === 400 ? -32700 : -32603, message: status === 400 ? "parse error" : err.message },
      id: null,
    });
  });

  await new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      const address = httpServer.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      const host = options.host.includes(":") ? `[${options.host}]` : options.host;
      console.error(`[${spec.name}] serving MCP on http://${host}:${port}/mcp`);
      resolve();
    });
    httpServer.on("error", reject);
    const shutdown = (): void => {
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).set("allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "method not allowed: this server is stateless, POST only" },
    id: null,
  });
}
