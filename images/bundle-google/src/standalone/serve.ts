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
 * 127.0.0.1, and on a loopback host the SDK's `createMcpExpressApp` rejects a
 * request whose `Host` header is not loopback, so a web page cannot reach the
 * server by DNS rebinding. There is no authentication on this endpoint: bind
 * it anywhere other than loopback only behind something that authenticates.
 *
 * HTTP is STATELESS, as in `src/index.ts`: a fresh server and transport per
 * request. Nothing here reads a credential; each server reads its own env
 * lazily, at the first tool call, so `tools/list` answers with none set.
 *
 * stdout belongs to the protocol in stdio mode, so everything this file logs
 * goes to stderr.
 */
import { parseArgs } from "node:util";
import type { Request, Response } from "express";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";

export interface StandaloneServer {
  /** The name logged at startup and reported by `/healthz`. */
  name: string;
  /** Build a fresh, unconnected server. Called once for stdio, once per request for HTTP. */
  build: () => { server: Server; registerHandlers: (server: Server) => Promise<void> };
  /** Credential variables to warn about at startup when unset. Never required to boot. */
  credentialEnv?: string[];
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

/** Parse argv into options. Throws with the usage text on anything it does not know. */
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
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }
  if (values.help) throw new Error(USAGE);

  const transport = values.transport ?? "stdio";
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`--transport must be stdio or http, got "${transport}"\n\n${USAGE}`);
  }
  const rawPort = values.port ?? env.PORT ?? "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`port must be an integer from 0 to 65535, got "${rawPort}"\n\n${USAGE}`);
  }
  return { transport, port, host: values.host ?? "127.0.0.1" };
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
    console.error(err instanceof Error ? err.message : String(err));
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
  const app = createMcpExpressApp({ host: options.host });
  app.disable("x-powered-by");

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, server: spec.name });
  });

  app.all("/mcp", (req: Request, res: Response) => {
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

  await new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(options.port, options.host, () => {
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
