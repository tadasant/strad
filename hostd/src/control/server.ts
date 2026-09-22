import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import { join } from "node:path";

import type { AuditLog } from "../audit.js";
import { displayName, enabledCapabilities, type Config } from "../config.js";
import type { ConsentGate } from "../consent/gate.js";
import type { KillSwitch } from "../killswitch.js";
import { keysMatch } from "../mcp/auth.js";
import { renderPage, type ControlState } from "./page.js";

export interface ControlDeps {
  config: Config;
  gate: ConsentGate;
  killSwitch: KillSwitch;
  audit: AuditLog;
  tunnelState: () => string;
  /** The commands a grant has running, for the status page. */
  runningFor: (grantId: string) => string[];
  /** Whether the native helper is reachable, for the status page. */
  helperState?: () => { connected: boolean; error?: string };
  /** Where to write the control token, for the CLI. Omitted in tests. */
  stateDir?: string;
}

/** Headers a request only carries when it came through a proxy or a tunnel. */
const PROXIED = [
  "cf-connecting-ip",
  "cf-ray",
  "x-forwarded-for",
  "x-forwarded-host",
  "forwarded",
];

export function collectState(deps: ControlDeps): ControlState {
  const { config, gate } = deps;
  return {
    machine: config.machine,
    disabled: deps.killSwitch.isDisabled(),
    tunnel: deps.tunnelState(),
    consent: {
      mode: config.consent.mode,
      windowSeconds: config.consent.windowSeconds,
      onTimeout: config.consent.onTimeout,
    },
    servers: enabledCapabilities(config).map((id) => ({
      id,
      name: displayName(config, id),
    })),
    pending: [...gate.pending.values()],
    grants: gate.grants
      .active()
      .map((g) => ({ ...g, running: deps.runningFor(g.id) })),
    helper: deps.helperState?.(),
    audit: deps.audit.tail(40),
    now: Date.now(),
  };
}

async function formBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_384) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * The owner's side: what is in control of this machine right now, a kill button
 * per grant, and the switch that turns the whole thing off.
 *
 * It is a SECOND listener on a second port, and that is the security property:
 * the tunnel's ingress names the MCP port and nothing else, so no configuration
 * of strad, Cloudflare or a caller can route a request here. Three further
 * checks hold if someone points an ingress at it anyway — a loopback `Host`
 * (which also defeats DNS rebinding), no proxy headers, and a per-boot token on
 * every write, so a web page open in the owner's browser cannot post a kill —
 * or, worse, an enable.
 */
export function createControlListener(deps: ControlDeps): {
  server: HttpServer;
  token: string;
} {
  const token = randomBytes(24).toString("base64url");
  if (deps.stateDir)
    writeFileSync(join(deps.stateDir, "control-token"), token, { mode: 0o600 });
  const allowedHosts = new Set([
    `127.0.0.1:${deps.config.controlPort}`,
    `localhost:${deps.config.controlPort}`,
  ]);

  const server = createServer((req, res) => {
    void (async () => {
      const plain = (status: number, body: string) => {
        res.writeHead(status, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(body);
      };
      const port = (server.address() as { port: number } | null)?.port;
      const host = req.headers.host ?? "";
      const hostOk =
        allowedHosts.has(host) ||
        host === `127.0.0.1:${port}` ||
        host === `localhost:${port}`;
      if (!hostOk || PROXIED.some((h) => req.headers[h] !== undefined)) {
        return plain(403, "The control page answers on this machine only.\n");
      }
      const path = (req.url ?? "/").split("?")[0];

      if (req.method === "GET" && path === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
          "x-frame-options": "DENY",
        });
        return res.end(renderPage(collectState(deps), token));
      }
      if (req.method === "GET" && path === "/state.json") {
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        return res.end(JSON.stringify(collectState(deps)));
      }
      if (req.method !== "POST") return plain(404, "not found\n");

      const form = await formBody(req);
      if (!keysMatch(form.get("token") ?? "", token))
        return plain(403, "bad token\n");

      if (path === "/kill")
        deps.gate.grants.end(form.get("grant") ?? "", "killed");
      else if (path === "/kill-all") deps.gate.grants.endAll("killed");
      else if (path === "/disable")
        deps.gate.disableAll("disabled from the control page");
      else if (path === "/enable") deps.gate.enable();
      else return plain(404, "not found\n");

      res.writeHead(303, { location: "/" });
      res.end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  return { server, token };
}
