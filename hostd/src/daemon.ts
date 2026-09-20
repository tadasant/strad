import type { Server as HttpServer } from "node:http";

import { AuditLog } from "./audit.js";
import { browserCapability } from "./browser/tools.js";
import type { CapabilityId } from "./capabilities.js";
import { enabledCapabilities, type Config } from "./config.js";
import { ConsentGate } from "./consent/gate.js";
import type { Notifier } from "./consent/notifier.js";
import { platformPrompter, type Prompter } from "./consent/prompter.js";
import { createControlListener } from "./control/server.js";
import { KillSwitch } from "./killswitch.js";
import { createMcpListener } from "./mcp/http.js";
import type { ServerDeps } from "./mcp/server.js";
import type { Capability } from "./mcp/tool.js";
import { shellCapability } from "./shell/tools.js";
import { TunnelSupervisor } from "./tunnel.js";

/** How often grants are checked against the kill-switch file and their clocks. */
export const ENFORCE_EVERY_MS = 2000;

export interface Core {
  deps: ServerDeps;
  capabilities: Partial<Record<CapabilityId, Capability>>;
  runningFor: (grantId: string) => string[];
  close: () => Promise<void>;
}

/**
 * Everything both transports share: the gate, the switch, the log and the
 * capabilities. `serve` puts HTTP listeners in front of it and `stdio` puts a
 * pipe in front of it, and that is the whole difference between running behind
 * strad and running on a friend's laptop.
 */
export function buildCore(
  config: Config,
  opts: {
    stateDir: string;
    prompter?: Prompter;
    notifier?: Notifier;
    controlUrl?: string;
    only?: CapabilityId[];
  },
): Core {
  const killSwitch = new KillSwitch(opts.stateDir);
  const audit = new AuditLog(opts.stateDir);
  const gate = new ConsentGate({
    config,
    prompter: opts.prompter ?? platformPrompter(),
    killSwitch,
    audit,
    notifier: opts.notifier,
    controlUrl: opts.controlUrl,
  });

  const ids = opts.only ?? enabledCapabilities(config);
  const capabilities: Partial<Record<CapabilityId, Capability>> = {};
  const shell = ids.includes("shell") ? shellCapability(config) : undefined;
  if (shell) capabilities.shell = shell;
  if (ids.includes("browser")) capabilities.browser = browserCapability(config);

  const sweep = setInterval(() => gate.enforce(), ENFORCE_EVERY_MS);
  sweep.unref();

  return {
    deps: { config, gate, killSwitch, audit },
    capabilities,
    runningFor: (grantId) =>
      shell?.processes
        .list(grantId)
        .filter((c) => c.status === "running")
        .map((c) => c.command.slice(0, 160)) ?? [],
    close: async () => {
      clearInterval(sweep);
      gate.grants.endAll("killed");
      for (const c of Object.values(capabilities)) await c?.close?.();
    },
  };
}

function listen(server: HttpServer, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1, literally. Not "localhost", which can resolve to more, and not
    // 0.0.0.0: the tunnel is the only door, and it dials out.
    server.listen(port, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port),
    );
  });
}

export interface RunningDaemon {
  mcpPort: number;
  controlPort: number;
  controlToken: string;
  core: Core;
  stop: () => Promise<void>;
}

export async function startDaemon(
  config: Config,
  opts: {
    stateDir: string;
    prompter?: Prompter;
    /** Omitted, nothing is notified. `serve` passes the platform's. */
    notifier?: Notifier;
    log?: (line: string) => void;
    ephemeralPorts?: boolean;
  },
): Promise<RunningDaemon> {
  if (config.consent.mode === "none") {
    throw new Error(
      'consent.mode "none" is refused by `serve`: a server reachable over a listener never runs without the consent gate. It is for `stdio` only.',
    );
  }
  for (const id of enabledCapabilities(config)) {
    if (!config.capabilities[id].key) {
      throw new Error(
        `capabilities.${id} is enabled and has no key; run \`strad-hostd init\` or set one (32+ characters)`,
      );
    }
  }
  const log = opts.log ?? (() => {});
  const core = buildCore(config, {
    ...opts,
    controlUrl: `http://127.0.0.1:${config.controlPort}`,
  });
  const tunnel = new TunnelSupervisor(config, core.deps.killSwitch, (l) =>
    log(`[tunnel] ${l}`),
  );

  const mcp = createMcpListener(config, core.capabilities, core.deps);
  const control = createControlListener({
    ...core.deps,
    tunnelState: () => tunnel.state,
    runningFor: core.runningFor,
    stateDir: opts.stateDir,
  });

  const mcpPort = await listen(mcp, opts.ephemeralPorts ? 0 : config.port);
  const controlPort = await listen(
    control.server,
    opts.ephemeralPorts ? 0 : config.controlPort,
  );
  tunnel.start();
  log(
    `mcp on http://127.0.0.1:${mcpPort} · control page on http://127.0.0.1:${controlPort}`,
  );

  return {
    mcpPort,
    controlPort,
    controlToken: control.token,
    core,
    stop: async () => {
      tunnel.stop();
      await core.close();
      mcp.closeAllConnections();
      control.server.closeAllConnections();
      await Promise.all([
        new Promise((r) => mcp.close(r)),
        new Promise((r) => control.server.close(r)),
      ]);
    },
  };
}
