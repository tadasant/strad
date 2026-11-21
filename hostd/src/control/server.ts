import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import { join } from "node:path";

import { WebSocketServer } from "ws";

import type { AuditLog } from "../audit.js";
import type { ExtensionBridge } from "../browser/bridge.js";
import {
  displayName,
  enabledCapabilities,
  onTimeoutFor,
  type Config,
} from "../config.js";
import type { ConsentGate } from "../consent/gate.js";
import type { PackedExtension } from "../extension/crx.js";
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
  /** The same for `strad-hostd-messages`, when the messages server is enabled. */
  messagesHelperState?: () => { connected: boolean; error?: string };
  /** The custody vault's counts, when the custody server is enabled. */
  custodyState?: () => {
    handles: number;
    tainted_tabs: number;
    capturing: number;
  };
  /** Where to write the control token, for the CLI. Omitted in tests. */
  stateDir?: string;
  /**
   * The Chrome extension's door: the bridge its WebSocket lands on, and the
   * packed CRX plus update manifest a policy-installed Chrome fetches from
   * here. On THIS listener because it is the one the tunnel never routes.
   */
  extension?: {
    bridge: ExtensionBridge;
    packed: () => PackedExtension;
    /** The manifest names the CRX by the port this listener really got. */
    updateXml: (packed: PackedExtension, controlPort: number) => string;
  };
  /** Re-read the servers' keys from the config file: `strad-hostd key add` calls it. */
  reloadKeys?: () => void;
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
      cooldownSeconds: config.consent.rejectCooldownSeconds,
    },
    servers: enabledCapabilities(config).map((id) => ({
      id,
      name: displayName(config, id),
      onTimeout: onTimeoutFor(config, id),
    })),
    // Caller-authored text, redacted as the audit is: a purpose or a running
    // command is on this page for as long as the grant is, refreshed every 4s.
    pending: [...gate.pending.values()].map((p) => ({
      ...p,
      purpose: deps.audit.scrub(p.purpose),
    })),
    grants: gate.grants.active().map((g) => ({
      ...g,
      purpose: deps.audit.scrub(g.purpose),
      running: deps.runningFor(g.id).map((c) => deps.audit.scrub(c, 160)),
    })),
    helper: deps.helperState?.(),
    messagesHelper: deps.messagesHelperState?.(),
    extension: deps.extension?.bridge.state(),
    custody: deps.custodyState?.(),
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
  /** Loopback `Host`, and no header a proxy or a tunnel would have added. */
  function local(req: IncomingMessage): boolean {
    const port = (server.address() as { port: number } | null)?.port;
    const host = req.headers.host ?? "";
    const hostOk =
      allowedHosts.has(host) ||
      host === `127.0.0.1:${port}` ||
      host === `localhost:${port}`;
    return hostOk && !PROXIED.some((h) => req.headers[h] !== undefined);
  }

  const server = createServer((req, res) => {
    void (async () => {
      const plain = (status: number, body: string) => {
        res.writeHead(status, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(body);
      };
      if (!local(req)) {
        return plain(403, "The control page answers on this machine only.\n");
      }
      const path = (req.url ?? "/").split("?")[0];

      // What a policy-installed Chrome fetches: the update manifest, then the
      // CRX it names. Neither is secret — the extension does nothing without
      // the token — and both are loopback-only like everything else here.
      if (req.method === "GET" && deps.extension) {
        if (path === "/extension/update.xml") {
          const port = (server.address() as { port: number }).port;
          const xml = deps.extension.updateXml(deps.extension.packed(), port);
          res.writeHead(200, {
            "content-type": "application/xml; charset=utf-8",
            "cache-control": "no-store",
          });
          return res.end(xml);
        }
        if (path === "/extension/strad-hostd.crx") {
          const { crx } = deps.extension.packed();
          res.writeHead(200, {
            "content-type": "application/x-chrome-extension",
            "content-length": String(crx.length),
            "cache-control": "no-store",
          });
          return res.end(crx);
        }
      }

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
      else if (path === "/reload-keys" && deps.reloadKeys) {
        try {
          deps.reloadKeys();
        } catch (err) {
          return plain(400, `${(err as Error).message}\n`);
        }
        return plain(200, "keys reloaded\n");
      } else return plain(404, "not found\n");

      res.writeHead(303, { location: "/" });
      res.end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  // The extension's WebSocket. Three guards before the bridge sees it: the
  // same loopback-and-unproxied test as every request here, an Origin that
  // only an extension carries (a web page's says its site, and a browser does
  // not let a page forge it), and then the pairing token in the bridge — which
  // is the guard a non-browser process on this machine cannot pass.
  if (deps.extension) {
    const { bridge } = deps.extension;
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "/").split("?")[0];
      const origin = req.headers.origin ?? "";
      if (
        path !== "/extension" ||
        !local(req) ||
        !origin.startsWith("chrome-extension://")
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => bridge.accept(ws, req));
    });
  }
  return { server, token };
}
