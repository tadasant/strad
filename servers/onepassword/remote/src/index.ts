#!/usr/bin/env node
/**
 * Streamable-HTTP entrypoint for the 1Password MCP server.
 *
 * This is the strad `supplementary-image` face of onepassword. It reuses the
 * SAME `shared/` tool logic as the upstream stdio `local/` server (see
 * ../shared) — none of the nine 1Password tools, the credential redaction, or
 * the elicitation gating is reimplemented here. The only difference from the
 * upstream `local/src/index.ts` is the transport: this process is an internal
 * HTTP component that strad's core gateway proxies to over the private network,
 * so it speaks StreamableHTTPServerTransport behind an Express front door
 * instead of StdioServerTransport.
 *
 * The `op` CLI — how this server actually talks to 1Password — is NOT bundled
 * as an npm dependency; it is a pinned binary baked into the Docker image and
 * invoked via child_process (`spawn('op', ...)`, see shared/). It must be on
 * PATH inside the container. See the Dockerfile.
 *
 * Statelessness — the same pattern good-eggs proved against App Platform: per
 * HTTP request we mint a fresh MCP Server + StreamableHTTPServerTransport with
 * `sessionIdGenerator: undefined`. They are cheap and hold no cross-request
 * state; the `op` binary and the service-account token in the environment are
 * the only shared things, and both are stateless.
 *
 * Credentials: strad injects the 1Password service-account token as
 * OP_SERVICE_ACCOUNT_TOKEN — the exact name the shared code reads — so, unlike
 * good-eggs, there is no secret-name bridging to do. The image itself is
 * credential-free; the token arrives from the environment at runtime.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createMCPServer,
  OnePasswordClient,
  checkElicitationSafety,
  logServerStart,
  logError,
  logWarning,
} from 'onepassword-mcp-server-shared';

// A stray rejection (e.g. a bad token surfacing on the first `op` call) should
// crash us so App Platform restarts, not linger as an unhandled rejection.
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

/**
 * Boot-time guards, mirroring the upstream stdio server so the HTTP face keeps
 * the same security contract:
 *
 *   1. OP_SERVICE_ACCOUNT_TOKEN must be set. The image ships no credential; the
 *      token is injected by strad at runtime. Fail fast (crashloop) if absent.
 *   2. Elicitation must be configured. This server redacts secret fields by
 *      default and only reveals them behind a confirmation prompt. Because a
 *      stateless streamable-HTTP transport (sessionIdGenerator: undefined)
 *      cannot round-trip a *native* MCP elicitation, the operator must pick a
 *      posture explicitly: configure the HTTP elicitation fallback
 *      (ELICITATION_REQUEST_URL + ELICITATION_POLL_URL), or accept the risk
 *      with DANGEROUSLY_SKIP_ELICITATIONS=true. Refusing to start otherwise is
 *      the upstream default and the safe one for a credentials manager.
 */
function validateEnvironment(): void {
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    logError(
      'validateEnvironment',
      'Missing required credential: OP_SERVICE_ACCOUNT_TOKEN. ' +
        'strad injects it as a per-bundle SECRET; the image itself ships none.',
    );
    process.exit(1);
  }

  const safety = checkElicitationSafety();
  if (!safety.safe) {
    logError(
      'validateEnvironment',
      'Server cannot start: no elicitation mechanism is configured. This server ' +
        'redacts secret fields unless a reveal is confirmed, and a stateless ' +
        'HTTP transport cannot serve a native elicitation prompt. Configure the ' +
        'HTTP fallback (ELICITATION_REQUEST_URL + ELICITATION_POLL_URL), or set ' +
        'DANGEROUSLY_SKIP_ELICITATIONS=true to opt out (reveals every secret ' +
        'without approval).',
    );
    process.exit(1);
  }
  if (safety.reason === 'dangerously_skip') {
    logWarning(
      'security',
      'DANGEROUSLY_SKIP_ELICITATIONS=true — confirmation prompts are disabled; ' +
        'secrets are revealed without approval.',
    );
  }

  if (process.env.ENABLED_TOOLGROUPS) {
    logWarning('config', `Tool groups filter active: ${process.env.ENABLED_TOOLGROUPS}`);
  }
}

async function main(): Promise<void> {
  validateEnvironment();

  const app = express();
  app.use(express.json({ limit: '20mb' }));

  // Liveness. The process exits on a missing token / unsafe elicitation config
  // (above), so if it is alive to answer, its boot guards passed.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, server: 'onepassword', version: VERSION });
  });

  // The MCP endpoint. Stateless streamable-HTTP: a fresh Server + transport per
  // request, each wired to a fresh OnePasswordClient that reads the token from
  // the environment and shells out to the baked-in `op` binary. `registerHandlers`
  // reads ENABLED_TOOLGROUPS / the elicitation config from the environment at
  // registration time, so the read-only vs read-write posture is whatever strad
  // injected — no per-request state to leak.
  app.all(MCP_PATH, async (req, res) => {
    const { server, registerHandlers } = createMCPServer({ version: VERSION });
    await registerHandlers(
      server,
      () => new OnePasswordClient(process.env.OP_SERVICE_ACCOUNT_TOKEN!),
    );

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

  const handleShutdown = () => {
    logWarning('shutdown', 'Received shutdown signal, exiting.');
    process.exit(0);
  };
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  app.listen(PORT, '0.0.0.0', () => {
    logServerStart(`1Password (streamable-HTTP :${PORT}${MCP_PATH})`, 'http');
  });
}

main().catch((error) => {
  logError('main', error);
  process.exit(1);
});
