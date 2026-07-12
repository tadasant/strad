#!/usr/bin/env node
/**
 * Streamable-HTTP entrypoint for the Good Eggs MCP server.
 *
 * This is the strad `supplementary-image` face of good-eggs. It reuses the
 * SAME `shared/` tool logic as the published stdio `local/` server (see
 * ../shared) — nothing about the 11 Playwright-driven tools is reimplemented
 * here. The only difference from `local/src/index.ts` is the transport: this
 * process is an internal HTTP component that strad's core gateway proxies to
 * over the private network, so it speaks StreamableHTTPServerTransport behind
 * an Express front door instead of StdioServerTransport.
 *
 * Browser lifecycle — PROVEN on App Platform's gVisor sandbox:
 *   - chromium.launch() costs ~1s every time and there is no cold start to warm
 *     away. So the browser is launched ONCE at startup (via the shared
 *     factory's background login) and kept alive; `shared/` holds a single
 *     logged-in Good Eggs page and reuses it across every tool call.
 *   - Per MCP SESSION we mint a cheap MCP Server + transport (see the endpoint
 *     below for why sessions, not per-POST statelessness). They are cheap; the
 *     expensive, stateful thing (the browser + login) lives in the factory
 *     closure and is shared across all of them.
 *
 * Credentials: strad injects secrets as GOODEGGS_EMAIL / GOODEGGS_PASSWORD (its
 * own naming convention). The shared logic reads GOOD_EGGS_USERNAME /
 * GOOD_EGGS_PASSWORD, so we bridge them below before anything else runs.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  createMCPServer,
  clientSupportsApps,
  logServerStart,
  logError,
  logWarning,
} from 'good-eggs-mcp-server-shared';

// --- strad secret naming -> shared/ env naming -------------------------------
if (!process.env.GOOD_EGGS_USERNAME && process.env.GOODEGGS_EMAIL) {
  process.env.GOOD_EGGS_USERNAME = process.env.GOODEGGS_EMAIL;
}
if (!process.env.GOOD_EGGS_PASSWORD && process.env.GOODEGGS_PASSWORD) {
  process.env.GOOD_EGGS_PASSWORD = process.env.GOODEGGS_PASSWORD;
}
// A container has no display; the browser must be headless.
if (!process.env.HEADLESS) process.env.HEADLESS = 'true';

// The shared factory's background login rejects its internal loginPromise on a
// bad credential; nothing awaits it until the first tool call, so without this
// guard Node's default surfaces it as an unhandled rejection. Fail fast and let
// App Platform restart us (which also retries a transient login failure).
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason);
  process.exit(1);
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
);
const VERSION: string = packageJson.version;

const PORT = parseInt(process.env.PORT || '8080', 10);
const MCP_PATH = process.env.MCP_PATH || '/mcp';

function validateEnvironment(): void {
  const missing = ['GOOD_EGGS_USERNAME', 'GOOD_EGGS_PASSWORD'].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    logError(
      'validateEnvironment',
      `Missing required credentials: ${missing.join(', ')}. ` +
        'Set GOODEGGS_EMAIL and GOODEGGS_PASSWORD (strad secrets).',
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  validateEnvironment();

  // The factory owns the single browser + logged-in Good Eggs session. We make
  // it ONCE; every request's handlers close over the same ready client.
  const { registerHandlers, cleanup, startBackgroundLogin } = createMCPServer({
    version: VERSION,
  });

  // Launch Chromium and log in now, in the background, so the first real tool
  // call doesn't also pay for a cold browser + a full sign-in flow. On failure,
  // mirror the stdio server: log, clean up, and exit non-zero.
  startBackgroundLogin((error: Error) => {
    logError('login', `Background login to Good Eggs failed: ${error.message}`);
    cleanup()
      .catch((e) => logError('cleanup', e))
      .finally(() => process.exit(1));
  });

  const app = express();
  app.use(express.json({ limit: '20mb' }));

  // Liveness. The process exits on a login failure (above), so if it is alive to
  // answer, its browser session is starting up or ready.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, server: 'good-eggs', version: VERSION });
  });

  // --- MCP endpoint: SESSION-ful streamable-HTTP ---------------------------
  //
  // Why session-ful (this changed from the original stateless-per-POST design):
  // whether a connection gets the MCP-App surface is decided from the client's
  // advertised `initialize` capabilities. Those capabilities arrive ONCE, on the
  // initialize POST — a stateless server that mints a fresh Server per POST never
  // sees them again on the tools/list, resources/read, tools/call that follow,
  // so it could not gate. Binding a Server to a session lets the capabilities the
  // client advertised at initialize govern that whole session.
  //
  // This does NOT change the browser model — the expensive, stateful thing (the
  // single logged-in Good Eggs page) still lives in the factory closure and is
  // shared across every session. A session only owns a cheap Server + transport.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post(MCP_PATH, async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && transports[sessionId]) {
        // An established session: reuse its Server (which already has the
        // capability-appropriate handlers registered).
        await transports[sessionId]!.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        // A new session. Read the client's advertised capabilities off the RAW
        // initialize body so opt-in `extensions` keys survive, and decide once
        // whether this session gets the MCP-App surface.
        const capabilities = (
          req.body as { params?: { capabilities?: unknown } }
        )?.params?.capabilities as
          | { extensions?: Record<string, unknown> }
          | undefined;
        const appUi = clientSupportsApps(capabilities);

        const server = new Server(
          { name: 'good-eggs-mcp-server', version: VERSION },
          {
            capabilities: {
              tools: {},
              // Only advertise `resources` when we will actually serve the
              // ui:// app resource — a plain client's capability set is unchanged.
              ...(appUi ? { resources: {} } : {}),
            },
          },
        );
        await registerHandlers(server, { appUi });

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) delete transports[sid];
          server.close().catch(() => {});
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Not an initialize and no known session — a malformed or expired client.
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session' },
        id: null,
      });
    } catch (error) {
      logError('mcp', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: String((error as Error)?.message ?? error),
          },
          id: null,
        });
      }
    }
  });

  // GET (server->client SSE stream) and DELETE (session teardown) are routed to
  // the existing session's transport.
  const handleSessionRequest = async (
    req: express.Request,
    res: express.Response,
  ): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sessionId]!.handleRequest(req, res);
  };
  app.get(MCP_PATH, handleSessionRequest);
  app.delete(MCP_PATH, handleSessionRequest);

  const handleShutdown = async () => {
    logWarning('shutdown', 'Received shutdown signal, closing browser...');
    await cleanup();
    process.exit(0);
  };
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  app.listen(PORT, '0.0.0.0', () => {
    logServerStart(`Good Eggs (streamable-HTTP :${PORT}${MCP_PATH})`, 'http');
    logWarning('login', 'Starting background login to Good Eggs...');
  });
}

main().catch((error) => {
  logError('main', error);
  process.exit(1);
});
