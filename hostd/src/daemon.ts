import { statSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import { AuditLog } from "./audit.js";
import { ExtensionBridge } from "./browser/bridge.js";
import { browserCapability } from "./browser/tools.js";
import { CAPABILITIES, helperFor, type CapabilityId } from "./capabilities.js";
import { computerCapability } from "./computer/foreground.js";
import { computerHeadlessCapability } from "./computer/headless.js";
import { enabledCapabilities, reloadKeys, type Config } from "./config.js";
import { ConsentGate } from "./consent/gate.js";
import type { Notifier } from "./consent/notifier.js";
import { platformPrompter, type Prompter } from "./consent/prompter.js";
import { createControlListener } from "./control/server.js";
import { KillSwitch } from "./killswitch.js";
import {
  listExtensionFiles,
  loadOrCreateSigningKey,
  packExtension,
  updateManifestXml,
  type PackedExtension,
} from "./extension/crx.js";
import {
  crxUrl,
  extensionDir,
  extensionKeyPath,
  extensionTokenPath,
} from "./extension/paths.js";
import { pairingToken } from "./extension/secret.js";
import { createMcpListener } from "./mcp/http.js";
import { messagesCapability, type MessagesHello } from "./messages/tools.js";
import type { ServerDeps } from "./mcp/server.js";
import type { Capability } from "./mcp/tool.js";
import { HelperClient } from "./native/client.js";
import { Presence } from "./native/presence.js";
import {
  helperConnector,
  messagesHelperSpec,
  nativeConnector,
} from "./native/transport.js";
import { shellCapability } from "./shell/tools.js";
import { TunnelSupervisor } from "./tunnel.js";

/** How often grants are checked against the kill-switch file and their clocks. */
export const ENFORCE_EVERY_MS = 2000;

export interface Core {
  deps: ServerDeps;
  capabilities: Partial<Record<CapabilityId, Capability>>;
  helper: HelperClient;
  /** `strad-hostd-messages`, when the messages server is served. */
  messagesHelper?: HelperClient;
  presence: Presence;
  /** The Chrome extension's bridge, when the browser server is served with a listener. */
  bridge?: ExtensionBridge;
  runningFor: (grantId: string) => string[];
  close: () => Promise<void>;
}

/**
 * Everything both transports share: the gate, the switch, the log, the
 * native helper and the capabilities. `serve` puts HTTP listeners in front of
 * it and `stdio` puts a pipe in front of it, and that is the whole difference
 * between running behind strad and running on a friend's laptop.
 */
export function buildCore(
  config: Config,
  opts: {
    stateDir: string;
    prompter?: Prompter;
    notifier?: Notifier;
    controlUrl?: string;
    only?: CapabilityId[];
    /** A transport to the native helper, in place of the socket-or-spawn default. Tests. */
    helperTransport?: () => Promise<Duplex>;
    /** The same for `strad-hostd-messages`. Tests. */
    messagesTransport?: () => Promise<Duplex>;
    /**
     * The Chrome extension's pairing token. Given, the browser server is
     * served through the extension whenever one is connected; `serve` passes
     * the state directory's, and `stdio` passes nothing because it has no
     * listener for the extension to reach.
     */
    extensionToken?: string;
    log?: (line: string) => void;
  },
): Core {
  const log = opts.log ?? (() => {});
  const killSwitch = new KillSwitch(opts.stateDir);
  const audit = new AuditLog(opts.stateDir);
  const bridge = opts.extensionToken
    ? new ExtensionBridge({
        token: opts.extensionToken,
        disabled: () => killSwitch.isDisabled(),
        log,
      })
    : undefined;

  // The gate and the helper each need the presence sync, which needs both.
  const late: { presence?: Presence } = {};
  const gate = new ConsentGate({
    config,
    prompter: opts.prompter ?? platformPrompter(),
    killSwitch,
    audit,
    notifier: opts.notifier,
    controlUrl: opts.controlUrl,
    onChange: () => {
      void late.presence?.sync();
      // Thrown, the switch has ended every grant, and each grant's backend
      // released what it held; this is the check that holds if one did not.
      if (killSwitch.isDisabled()) void bridge?.detachAll();
    },
  });

  const helper = new HelperClient({
    connect:
      opts.helperTransport ?? helperConnector(config, opts.stateDir, log),
    requestTimeoutMs: config.native.requestTimeoutMs,
    log,
    // The helper (re)started: its banner is blank until told otherwise.
    onConnect: () => void late.presence?.sync(),
    onEvent: (event) => {
      // The person at the machine pressed something. Every one of these ends
      // in the gate, which is the only thing that ends a grant.
      if (event.event === "kill") {
        gate.grants.end(event.grant_id, "killed");
      } else if (event.event === "disable") {
        gate.disableAll("disabled from the banner");
      } else if (event.event === "owner_input") {
        const g = gate.grants.active().find((x) => x.id === event.grant_id);
        if (g && CAPABILITIES[g.capability].mode === "foreground")
          gate.grants.end(g.id, "owner_input");
      }
    },
  });
  const presence = new Presence({
    helper,
    gate,
    killSwitch,
    controlUrl: opts.controlUrl,
    log,
  });
  late.presence = presence;

  const ids = opts.only ?? enabledCapabilities(config);
  const capabilities: Partial<Record<CapabilityId, Capability>> = {};
  const shell = ids.includes("shell") ? shellCapability(config) : undefined;
  if (shell) capabilities.shell = shell;
  if (ids.includes("browser"))
    capabilities.browser = browserCapability(config, bridge);
  if (ids.includes("computer-headless"))
    capabilities["computer-headless"] = computerHeadlessCapability(
      config,
      helper,
    );
  if (ids.includes("computer"))
    capabilities.computer = computerCapability(config, helper);
  // Its own helper and its own connection: the process holding Full Disk
  // Access is not the one that can post input, and neither one's failure
  // takes the other's servers down.
  const messagesHelper = ids.includes("messages")
    ? new HelperClient({
        connect:
          opts.messagesTransport ??
          nativeConnector(
            config,
            messagesHelperSpec(config, opts.stateDir),
            log,
          ),
        requestTimeoutMs: config.native.requestTimeoutMs,
        name: "strad-hostd-messages",
        log: (l) => log(`messages ${l}`),
      })
    : undefined;
  if (messagesHelper)
    capabilities.messages = messagesCapability(config, messagesHelper);

  const sweep = setInterval(() => {
    // A `touch`ed DISABLED file calls nothing: the sweep is what notices it,
    // ends the grants, and takes the extension off every tab.
    if (gate.enforce() > 0 || killSwitch.isDisabled()) void bridge?.detachAll();
  }, ENFORCE_EVERY_MS);
  sweep.unref();
  presence.start();

  return {
    deps: { config, gate, killSwitch, audit },
    capabilities,
    helper,
    messagesHelper,
    presence,
    bridge,
    runningFor: (grantId) =>
      shell?.processes
        .list(grantId)
        .filter((c) => c.status === "running")
        .map((c) => c.command.slice(0, 160)) ?? [],
    close: async () => {
      clearInterval(sweep);
      presence.stop();
      gate.grants.endAll("killed");
      await presence.close();
      for (const c of Object.values(capabilities)) await c?.close?.();
      bridge?.close();
      helper.close();
    },
  };
}

/** A packer that re-signs only when the extension directory's files change. */
function memoisedPack(dir: string, keyPath: string): () => PackedExtension {
  let last: { stamp: string; packed: PackedExtension } | undefined;
  return () => {
    const stamp = listExtensionFiles(dir)
      .map((f) => {
        const st = statSync(join(dir, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      })
      .join("\n");
    if (!last || last.stamp !== stamp) {
      last = {
        stamp,
        packed: packExtension(dir, loadOrCreateSigningKey(keyPath)),
      };
    }
    return last.packed;
  };
}

/** Whether any enabled server needs `strad-hostd-ax`. */
export function helperWanted(ids: CapabilityId[]): boolean {
  return ids.some((id) => helperFor(id) === "strad-hostd-ax");
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
    helperTransport?: () => Promise<Duplex>;
    log?: (line: string) => void;
    ephemeralPorts?: boolean;
    /** The unpacked extension to pack and serve. Defaults to the package's own. */
    extensionDir?: string;
    /** Where `strad-hostd key add` wrote: re-read on `POST /reload-keys`. Omitted, keys are fixed for the run. */
    configPath?: string;
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
  const serveBrowser = enabledCapabilities(config).includes("browser");
  const core = buildCore(config, {
    ...opts,
    log,
    controlUrl: `http://127.0.0.1:${config.controlPort}`,
    extensionToken: serveBrowser
      ? pairingToken(extensionTokenPath(opts.stateDir))
      : undefined,
  });
  const tunnel = new TunnelSupervisor(config, core.deps.killSwitch, (l) =>
    log(`[tunnel] ${l}`),
  );

  const mcp = createMcpListener(config, core.capabilities, core.deps);
  const control = createControlListener({
    ...core.deps,
    tunnelState: () => tunnel.state,
    runningFor: core.runningFor,
    helperState: helperWanted(enabledCapabilities(config))
      ? () => ({
          connected: core.helper.connected,
          error: core.helper.error,
        })
      : undefined,
    messagesHelperState: core.messagesHelper
      ? () => ({
          connected: core.messagesHelper!.connected,
          error: core.messagesHelper!.error,
        })
      : undefined,
    stateDir: opts.stateDir,
    extension: core.bridge
      ? {
          bridge: core.bridge,
          // Packed on first request and again only when a file in the
          // directory changes: signing is an RSA operation, and the route is
          // reachable by any local page in a loop.
          packed: memoisedPack(
            opts.extensionDir ?? extensionDir(),
            extensionKeyPath(opts.stateDir),
          ),
          updateXml: (packed, port) =>
            updateManifestXml(packed.id, packed.version, crxUrl(port)),
        }
      : undefined,
    reloadKeys: opts.configPath
      ? () => reloadKeys(config, opts.configPath)
      : undefined,
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
  // Reach the helper once at boot, so the status page can say whether it is
  // there and the banner is blank rather than stale.
  if (helperWanted(enabledCapabilities(config))) {
    core.helper
      .hello()
      .then((h) =>
        log(
          `helper ${h.version} · accessibility ${h.trusted.accessibility ? "granted" : "NOT granted"} · screen recording ${h.trusted.screen_recording ? "granted" : "NOT granted"}`,
        ),
      )
      .catch((err: Error) => log(`helper not reachable: ${err.message}`));
  }
  if (core.messagesHelper) {
    core.messagesHelper
      .call<MessagesHello>("hello", {}, 5000)
      .then((h) =>
        log(
          `messages helper ${h.version} · ${h.chat_db.path}: ${h.chat_db.state === "readable" ? "readable" : `NOT readable (${h.chat_db.state}${h.chat_db.state === "denied" ? ": grant Full Disk Access" : ""})`}`,
        ),
      )
      .catch((err: Error) =>
        log(`messages helper not reachable: ${err.message}`),
      );
  }

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
