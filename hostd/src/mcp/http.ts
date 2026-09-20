import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { CAPABILITIES, type CapabilityId } from "../capabilities.js";
import type { Config } from "../config.js";
import { bearerToken, keysMatch } from "./auth.js";
import { buildServer, type ServerDeps } from "./server.js";
import type { Capability } from "./tool.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * The MCP listener. Loopback only — the tunnel is the one thing meant to reach
 * it — and stateless: a fresh MCP server per request, because the state that
 * matters (grants, running commands, the DevTools socket) lives in the daemon
 * and is addressed by grant_id, not in an MCP session a gateway would have to
 * pin callers to.
 *
 * Each capability authenticates with ITS OWN key. The key strad holds for the
 * browser slug is a 401 on `/shell/mcp`.
 */
export function createMcpListener(
  config: Config,
  capabilities: Partial<Record<CapabilityId, Capability>>,
  deps: ServerDeps,
): HttpServer {
  const byPath = new Map<string, CapabilityId>();
  for (const id of Object.keys(capabilities) as CapabilityId[])
    byPath.set(CAPABILITIES[id].path, id);

  return createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      if (path === "/healthz") return send(res, 200, { ok: true });

      const id = byPath.get(path.replace(/\/+$/, ""));
      const capability = id && capabilities[id];
      if (!id || !capability) return send(res, 404, { error: "not found" });

      const expected = config.capabilities[id].key;
      const presented = bearerToken(req.headers.authorization);
      if (!expected || !presented || !keysMatch(presented, expected)) {
        return send(
          res,
          401,
          { error: "unauthorized" },
          { "www-authenticate": "Bearer" },
        );
      }
      if (req.method !== "POST")
        return send(
          res,
          405,
          { error: "method not allowed" },
          { allow: "POST" },
        );

      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: "invalid JSON body" });
      }

      const server = buildServer(id, capability, deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    });
  });
}
