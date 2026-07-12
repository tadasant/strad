#!/usr/bin/env node
/**
 * Streamable-HTTP entrypoint for the PointsYeah MCP server.
 *
 * This is the strad `supplementary-image` face of pointsyeah. It reuses the SAME
 * `shared/` tool logic as the published stdio `local/` server (see ../shared) —
 * nothing about the three award-search tools is reimplemented here. The only
 * differences from the upstream `local/src/index.ts` are (1) the transport (an
 * internal Express + `StreamableHTTPServerTransport` component that strad's core
 * gateway proxies to over the private network) and (2) the browser lifecycle.
 *
 * Browser lifecycle — the strad-specific change:
 *   Upstream, `defaultClientFactory()` launches a BRAND-NEW Chromium on EVERY
 *   `search_flights` call and tears it down after. On App Platform's gVisor
 *   sandbox `chromium.launch()` costs ~1s each time with no cold-start to warm
 *   away — so paying it per call is exactly the anti-pattern to avoid. Here we
 *   inject a `PlaywrightSearchDeps` that launches ONE browser at process start,
 *   keeps it alive, and opens a fresh browser CONTEXT (~700ms, and cookie-
 *   isolated) per search. The shared/ tool logic is untouched; the reuse is
 *   entirely a matter of which dependency object we hand `PointsYeahClient`.
 *   Chromium runs `--no-sandbox --disable-dev-shm-usage` (peak ~545MB RSS → a
 *   1GB bundle; 1 vCPU serialises rendering).
 *
 * Credentials: PointsYeah auth is an AWS Cognito refresh token. It is OPTIONAL —
 * the server always boots and exposes its tools; the auth-requiring ones return
 * a "call set_refresh_token" error until a token is provided (via the
 * POINTSYEAH_REFRESH_TOKEN env var, injected by strad as a bundle-scoped secret,
 * or the `set_refresh_token` tool at runtime). No credential is baked in.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright';
import express from 'express';
import { trackBrowserContext, withBrowserTelemetry } from './telemetry.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createMCPServer,
  PointsYeahClient,
  setRefreshToken,
  setAuthenticated,
  logServerStart,
  logError,
  logWarning,
  logDebug,
} from 'pointsyeah-mcp-server-shared';
// Not exported from the package index; imported by path (the same way the
// upstream local/ entrypoint reaches it) purely to validate the env token at
// boot, exactly as local/src/index.ts does.
import { refreshCognitoTokens } from 'pointsyeah-mcp-server-shared/build/pointsyeah-client/lib/auth.js';
import type { PlaywrightSearchDeps } from 'pointsyeah-mcp-server-shared/build/pointsyeah-client/lib/search.js';

// The shared factory / client reject on transient network failures that nothing
// awaits until a tool call; without this guard Node surfaces them as unhandled
// rejections. Fail fast and let App Platform restart us.
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

// --- the ONE long-lived browser ---------------------------------------------
// Launched once, kept alive, reused across every search. getBrowser() also
// self-heals: if the browser process died, it relaunches on next use.
let browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  const { chromium } = await import('playwright');
  // Timed and counted. Because getBrowser() self-heals — it relaunches whenever
  // the browser process has died — the launch COUNTER is also strad's Chromium
  // crash-loop detector: in steady state this fires once, at boot. A launch rate
  // above zero means Chromium keeps dying, and the crash counter's
  // `memory.pressure` attribute says whether it was the OOM killer that did it.
  browser = await withBrowserTelemetry('pointsyeah', () =>
    chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }),
  );
  return browser;
}

/**
 * A `PlaywrightSearchDeps` that opens a new CONTEXT on the shared browser per
 * search — instead of launching a whole new browser each time (the upstream
 * default). The returned `close()` closes only the context, leaving the browser
 * alive for the next call. Shape mirrors upstream `defaultClientFactory()`.
 */
const reusingPlaywrightDeps: PlaywrightSearchDeps = {
  launchBrowser: async () => {
    const b = await getBrowser();
    const context = await b.newContext();
    // A context is opened per SEARCH and closed at the end of it, so this gauge
    // should sit at ~0 between calls. If it climbs, contexts are leaking, and a
    // leaked Chromium context is a slow memory leak that ends in an OOM kill —
    // exactly the failure the collapse makes more likely.
    const contextClosed = trackBrowserContext('pointsyeah');
    return {
      addCookies: (cookies) => context.addCookies(cookies),
      newPage: async () => {
        const page = await context.newPage();
        return {
          goto: (url: string, options?: { waitUntil?: string; timeout?: number }) =>
            page.goto(url, options as Parameters<typeof page.goto>[1]).then(() => {}),
          waitForResponse: (
            predicate: (response: { url: () => string; json: () => Promise<unknown> }) => boolean,
            options?: { timeout?: number },
          ) =>
            page
              .waitForResponse((res) => predicate(res), options)
              .then((res) => ({
                url: () => res.url(),
                json: () => res.json(),
              })),
          close: () => page.close(),
        };
      },
      // Close the CONTEXT only; the browser is kept alive for reuse.
      close: async () => {
        await context.close();
        contextClosed();
      },
    };
  },
};

// One client, reused across requests: it caches Cognito tokens and shares the
// one browser. The refresh token lives in module state (seeded below or via the
// set_refresh_token tool), which the client reads per call.
const sharedClient = new PointsYeahClient(reusingPlaywrightDeps);
const clientFactory = () => sharedClient;

/**
 * If POINTSYEAH_REFRESH_TOKEN is set, validate it and seed auth state. If not
 * set or invalid, auth-requiring tools return errors directing users to call
 * set_refresh_token. Mirrors the upstream local/ startup behaviour (non-fatal).
 */
async function initializeAuth(): Promise<void> {
  const envToken = process.env.POINTSYEAH_REFRESH_TOKEN;
  if (!envToken) {
    logWarning(
      'config',
      'POINTSYEAH_REFRESH_TOKEN not set. Flight search tools will require authentication via set_refresh_token.',
    );
    return;
  }
  try {
    logDebug('auth', 'Validating refresh token from environment...');
    await refreshCognitoTokens(envToken);
    setRefreshToken(envToken);
    setAuthenticated(true);
    logDebug('auth', 'Refresh token validated successfully');
  } catch (error) {
    logWarning(
      'auth',
      `Refresh token from environment is invalid: ${error instanceof Error ? error.message : 'Unknown error'}. ` +
        'Server starting in unauthenticated mode — use the set_refresh_token tool to provide a valid token.',
    );
  }
}

async function main(): Promise<void> {
  await initializeAuth();

  if (process.env.ENABLED_TOOLGROUPS) {
    logWarning('config', `Tool groups filter active: ${process.env.ENABLED_TOOLGROUPS}`);
  }

  // Warm the one browser at process start so the first search does not also pay
  // the ~1s Chromium launch. Best-effort: a failure here is retried lazily by
  // getBrowser() on first real use, so it must not take the server down.
  getBrowser()
    .then(() => logDebug('browser', 'Chromium launched and ready'))
    .catch((e) =>
      logWarning(
        'browser',
        `Eager Chromium launch failed, will retry on first search: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );

  const { registerHandlers } = createMCPServer({ version: VERSION });

  const app = express();
  app.use(express.json({ limit: '20mb' }));

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, server: 'pointsyeah', version: VERSION });
  });

  // Stateless streamable-HTTP: a fresh Server + transport per request, all
  // sharing the one browser and the one token-caching client.
  app.all(MCP_PATH, async (req, res) => {
    const server = new Server(
      { name: 'pointsyeah-mcp-server', version: VERSION },
      { capabilities: { resources: {}, tools: {} } },
    );
    await registerHandlers(server, clientFactory);

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
    try {
      if (browser) await browser.close();
    } catch (e) {
      logError('shutdown', e);
    }
    process.exit(0);
  };
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  app.listen(PORT, '0.0.0.0', () => {
    logServerStart(`PointsYeah (streamable-HTTP :${PORT}${MCP_PATH})`, 'http');
  });
}

main().catch((error) => {
  logError('main', error);
  process.exit(1);
});
