#!/usr/bin/env node
/**
 * Streamable-HTTP entrypoint for the Fetch Pet MCP server.
 *
 * This is the strad `supplementary-image` face of fetchpet. It reuses the SAME
 * `shared/` tool logic as the published stdio `local/` server (see ../shared) —
 * nothing about the four Playwright-driven claim tools is reimplemented here.
 * The only difference from the upstream `local/src/index.ts` is the transport:
 * this process is an internal HTTP component that strad's core gateway proxies
 * to over the private network, so it speaks StreamableHTTPServerTransport behind
 * an Express front door instead of StdioServerTransport.
 *
 * Browser lifecycle — PROVEN on App Platform's gVisor sandbox:
 *   - chromium.launch() costs ~1s every time and there is no cold start to warm
 *     away. So the browser is launched ONCE at startup (via the shared factory's
 *     background login) and kept alive; `shared/` holds a single logged-in Fetch
 *     Pet page and reuses it across every tool call.
 *   - Per HTTP request we mint a fresh, stateless MCP Server + transport. They
 *     are cheap; the expensive, stateful thing (the browser + login) lives in
 *     the factory closure and is shared across all of them.
 *   - Chromium runs `--no-sandbox --disable-dev-shm-usage` (set by `shared/`).
 *
 * Credentials: strad injects FETCHPET_USERNAME / FETCHPET_PASSWORD (the same
 * names the shared logic reads). FETCHPET_EMAIL is accepted as an alias for the
 * username, mirroring good-eggs' strad-secret bridge convention.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createMCPServer,
  logServerStart,
  logError,
  logWarning,
} from 'fetchpet-mcp-server-shared';

// --- strad secret naming -> shared/ env naming -------------------------------
// The shared logic reads FETCHPET_USERNAME; accept FETCHPET_EMAIL as an alias so
// either strad-secret convention works.
if (!process.env.FETCHPET_USERNAME && process.env.FETCHPET_EMAIL) {
  process.env.FETCHPET_USERNAME = process.env.FETCHPET_EMAIL;
}
// A container has no display; the browser must be headless.
if (!process.env.HEADLESS) process.env.HEADLESS = 'true';

// A backstop for any promise nobody awaited. The background login is not one of
// them — the shared factory reports a failed attempt through the callback below
// and holds the error for the next tool call — but a browser server has plenty
// of other unawaited work, and an invisible rejection in one is worse than a
// restart.
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
  const missing = ['FETCHPET_USERNAME', 'FETCHPET_PASSWORD'].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    logError(
      'validateEnvironment',
      `Missing required credentials: ${missing.join(', ')}. ` +
        'Set FETCHPET_USERNAME (or FETCHPET_EMAIL) and FETCHPET_PASSWORD (strad secrets).',
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  validateEnvironment();

  // The factory owns the single browser + logged-in Fetch Pet session. We make
  // it ONCE; every request's handlers close over the same ready client.
  const { registerHandlers, cleanup, startBackgroundLogin } = createMCPServer({
    version: VERSION,
  });

  // Launch Chromium and log in now, in the background, so the first real tool
  // call doesn't also pay for a cold browser + a full sign-in flow.
  //
  // On failure, mirror the stdio server: log, clean up, and exit non-zero. This
  // container serves ONE server, so a process that cannot log in has nothing to
  // offer, and a failed health check is louder than a server that lists four
  // tools and errors on all of them. (Inside strad's bundle, where twenty
  // other servers are on board, the host takes the other option the shared
  // factory offers: mark the mount degraded and let the next tool call retry.)
  startBackgroundLogin((error: Error) => {
    logError('login', `Background login to Fetch Pet failed: ${error.message}`);
    cleanup()
      .catch((e) => logError('cleanup', e))
      .finally(() => process.exit(1));
  });

  const app = express();
  app.use(express.json({ limit: '20mb' }));

  // Liveness. The process exits on a login failure (above), so if it is alive to
  // answer, its browser session is starting up or ready.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, server: 'fetchpet', version: VERSION });
  });

  // The MCP endpoint. Stateless streamable-HTTP: a fresh Server + transport per
  // request, all sharing the one browser/session held by the factory. This is
  // the pattern proven against App Platform for a browser-backed MCP bundle.
  app.all(MCP_PATH, async (req, res) => {
    const server = new Server(
      { name: 'fetchpet-mcp-server', version: VERSION },
      { capabilities: { tools: {} } },
    );
    await registerHandlers(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
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

  const handleShutdown = async () => {
    logWarning('shutdown', 'Received shutdown signal, closing browser...');
    await cleanup();
    process.exit(0);
  };
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  app.listen(PORT, '0.0.0.0', () => {
    logServerStart(`Fetch Pet (streamable-HTTP :${PORT}${MCP_PATH})`, 'http');
    logWarning('login', 'Starting background login to Fetch Pet...');
  });
}

main().catch((error) => {
  logError('main', error);
  process.exit(1);
});
