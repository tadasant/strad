/**
 * bundle-google — a strad supplementary image.
 *
 * One container, four Google Workspace MCP servers, each mounted on its own
 * path and spoken over Streamable HTTP:
 *
 *   /gmail             -> gmail-workspace-mcp-server
 *   /google-calendar   -> google-calendar-workspace-mcp-server
 *   /google-docs       -> google-docs-workspace-mcp-server
 *   /google-sheets     -> google-sheets-workspace-mcp-server
 *
 * strad's gateway registers each as a `supplementary-image` server that shares
 * this one `bundle-google` component, differing only by `path`. The gateway
 * reaches us at ${bundle-google.PRIVATE_URL}<path> over the private network and
 * proxies with a StreamableHTTPClientTransport — so we serve the matching
 * StreamableHTTPServerTransport here.
 *
 * STATELESS, exactly like strad's own /mcp handler: a FRESH Server + transport
 * is built per request (`sessionIdGenerator: undefined`) and torn down when the
 * response closes. The toolset is a pure function of the request, never of
 * session state — which is what strad's stateless, connection-reusing gateway
 * client expects. (A single long-lived transport instead answers the first
 * request and then 500s every follow-up: the SDK's stateless transport is
 * one-request-per-instance by design.)
 *
 * The image is CREDENTIAL-FREE. Each upstream server reads its own auth env vars
 * lazily, only when a tool is actually called (see each shared factory's
 * createDefaultClient). Booting, listing tools, and health checks all work with
 * no credentials present; the real service-account / OAuth secrets are injected
 * downstream (tadasant-internal) as App Platform SECRET env vars.
 */
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { createMCPServer as createGmailServer } from "./gmail.js";
import { createMCPServer as createCalendarServer } from "google-calendar-workspace-mcp-server-shared";
import { createMCPServer as createDocsServer } from "google-docs-workspace-mcp-server-shared";
import { createMCPServer as createSheetsServer } from "google-sheets-workspace-mcp-server-shared";

const VERSION = process.env.BUNDLE_GOOGLE_VERSION ?? "0.1.0";
const PORT = Number(process.env.PORT ?? 8080);

/** The shape every shared factory returns. `registerHandlers` takes an optional
 *  clientFactory we deliberately omit, so each server builds its default client
 *  from env vars — lazily, at tool-call time. */
interface CreatedServer {
  server: Server;
  registerHandlers: (server: Server) => Promise<void>;
}

interface Mount {
  path: string;
  slug: string;
  /** Build a FRESH server for a single request (stateless). */
  build: () => CreatedServer;
}

const MOUNTS: Mount[] = [
  {
    path: "/gmail",
    slug: "gmail",
    // Through strad's own `./gmail.js` rather than the vendored factory
    // directly: that wrapper reads an INJECTED env, which is what lets the
    // collapsed bundle (servers/bundle) mount this same server once per slug,
    // one Google account each. This image keeps the single conventional mount
    // and hands it `process.env`, so nothing about it changes.
    build: () => createGmailServer({ version: VERSION }),
  },
  {
    path: "/google-calendar",
    slug: "google-calendar",
    // The calendar server reads its tool-group toggle from a bare
    // `ENABLED_TOOLGROUPS` by default; pass a namespaced var through explicitly
    // so it lines up with GMAIL_ENABLED_TOOLGROUPS / GOOGLE_DOCS_ENABLED_TOOLGROUPS
    // and never collides with a sibling in the same container.
    build: () =>
      createCalendarServer({
        version: VERSION,
        enabledToolGroups: process.env.GOOGLE_CALENDAR_ENABLED_TOOLGROUPS,
      }),
  },
  {
    path: "/google-docs",
    slug: "google-docs",
    build: () => createDocsServer({ version: VERSION }),
  },
  {
    path: "/google-sheets",
    slug: "google-sheets",
    // ONE account per credential, read from `process.env` here. The collapsed
    // bundle (servers/bundle) mounts this same server once PER SLUG instead, so
    // several Google accounts can be served from one container; this image keeps
    // the single conventional mount it has always had.
    build: () => createSheetsServer({ version: VERSION }),
  },
];

/**
 * Handle one MCP request against a freshly-built server + transport, torn down
 * when the response closes. Mirrors strad's own `createMcpHandler`.
 */
async function handleRequest(mount: Mount, req: Request, res: Response): Promise<void> {
  const { server, registerHandlers } = mount.build();
  await registerHandlers(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

async function main(): Promise<void> {
  const app = express();
  app.disable("x-powered-by");
  // Gmail/Docs payloads (attachments, document bodies) can be large; give the
  // JSON body parser real headroom rather than the 100kb default.
  app.use(express.json({ limit: "8mb" }));

  // App Platform / CI liveness. Dependency-free on purpose: it must not depend
  // on Google being reachable, or a flaky upstream would get the whole
  // component restarted.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, version: VERSION, servers: MOUNTS.map((m) => m.slug) });
  });

  for (const mount of MOUNTS) {
    app.all(mount.path, (req: Request, res: Response) => {
      void handleRequest(mount, req, res).catch((err: unknown) => {
        console.error(
          JSON.stringify({
            evt: "bundle-google.request_error",
            path: mount.path,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "internal error" },
            id: null,
          });
        }
      });
    });
  }

  const httpServer = app.listen(PORT, () => {
    console.log(
      JSON.stringify({
        evt: "bundle-google.listening",
        port: PORT,
        version: VERSION,
        paths: MOUNTS.map((m) => m.path),
      }),
    );
  });

  // App Platform sends SIGTERM and does not wait long. Close cleanly, but don't
  // hang forever if a connection is wedged.
  const shutdown = (signal: string): void => {
    console.log(JSON.stringify({ evt: "bundle-google.shutdown", signal }));
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[bundle-google] failed to start:", err);
  process.exit(1);
});
