#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  CAPABILITY_IDS,
  isCapabilityId,
  needsHelper,
  slugFor,
} from "./capabilities.js";
import {
  configPath,
  ConfigSchema,
  displayName,
  ensureStateDir,
  loadConfig,
} from "./config.js";
import { platformNotifier } from "./consent/notifier.js";
import { buildCore, startDaemon } from "./daemon.js";
import { KillSwitch } from "./killswitch.js";
import { buildServer } from "./mcp/server.js";

const USAGE = `strad-hostd — MCP servers that operate the machine they run on.

  strad-hostd init [--machine "Name"] [--suffix tadas-mbp] [--force]
      Write ~/.strad-hostd/config.json with fresh per-server keys.
  strad-hostd add <${CAPABILITY_IDS.join("|")}> [--suffix tadas-mbp]
      Enable one more server in an existing config, with a fresh key. Idempotent.
  strad-hostd serve
      Run the daemon: MCP on 127.0.0.1, the control page, and (if configured) the tunnel.
  strad-hostd stdio <${CAPABILITY_IDS.join("|")}> [--no-consent]
      Serve ONE server over stdio, for a local MCP client. No tunnel, no keys.
  strad-hostd keys
      Print each server's bearer key, for pasting into strad's secrets page.
  strad-hostd helper
      Report whether strad-hostd-ax is reachable and which permissions it holds.
  strad-hostd status | disable | enable | kill <grant_id|--all>
      See and stop what is in control. \`disable\` works with the daemon down.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function control(
  path: string,
  fields: Record<string, string> = {},
): Promise<Response> {
  const dir = ensureStateDir();
  const config = loadConfig();
  const token = readFileSync(join(dir, "control-token"), "utf8").trim();
  return fetch(`http://127.0.0.1:${config.controlPort}${path}`, {
    method: path === "/state.json" ? "GET" : "POST",
    redirect: "manual",
    ...(path === "/state.json"
      ? {}
      : { body: new URLSearchParams({ token, ...fields }) }),
  });
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;

  switch (command) {
    case "init": {
      const dir = ensureStateDir();
      const path = configPath();
      if (existsSync(path) && !args.includes("--force")) {
        console.error(
          `${path} exists; pass --force to replace it (this rotates every key).`,
        );
        return 1;
      }
      const suffix = flag(args, "--suffix") ?? "hostd";
      const config = ConfigSchema.parse({
        machine: flag(args, "--machine") ?? "this machine",
        capabilities: Object.fromEntries(
          CAPABILITY_IDS.map((id) => [
            id,
            {
              enabled: true,
              key: randomBytes(32).toString("base64url"),
              displayName: slugFor(id, suffix),
            },
          ]),
        ),
      });
      writeFileSync(path, JSON.stringify(config, null, 2) + "\n", {
        mode: 0o600,
      });
      console.log(
        `wrote ${path} (state directory: ${dir}). Keys are inside it; \`strad-hostd keys\` prints them.`,
      );
      return 0;
    }

    case "add": {
      const id = args[0] ?? "";
      if (!isCapabilityId(id)) {
        console.error(`add needs one of: ${CAPABILITY_IDS.join(", ")}`);
        return 1;
      }
      const path = configPath();
      if (!existsSync(path)) {
        console.error(
          `${path} does not exist; run \`strad-hostd init\` first.`,
        );
        return 1;
      }
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        capabilities?: Record<string, { enabled?: boolean; key?: string }>;
      };
      raw.capabilities ??= {};
      const existing = raw.capabilities[id];
      if (existing?.enabled && existing.key) {
        console.log(`${id} is already enabled in ${path}.`);
        return 0;
      }
      const suffix = flag(args, "--suffix");
      raw.capabilities[id] = {
        ...existing,
        enabled: true,
        key: existing?.key ?? randomBytes(32).toString("base64url"),
        ...(suffix ? { displayName: slugFor(id, suffix) } : {}),
      };
      ConfigSchema.parse(raw);
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
      console.log(
        `enabled ${id} in ${path}${needsHelper(id) ? " (it needs strad-hostd-ax: see `strad-hostd helper`)" : ""}. Restart the daemon to serve it.`,
      );
      return 0;
    }

    case "helper": {
      const dir = ensureStateDir();
      const config = loadConfig();
      const core = buildCore(config, { stateDir: dir, only: [] });
      try {
        const hello = await core.helper.hello();
        console.log(
          `strad-hostd-ax ${hello.version} at ${hello.executable}\n  accessibility:    ${hello.trusted.accessibility ? "granted" : "NOT granted — System Settings › Privacy & Security › Accessibility"}\n  screen recording: ${hello.trusted.screen_recording ? "granted" : "NOT granted — System Settings › Privacy & Security › Screen & System Audio Recording"}`,
        );
        await core.close();
        return hello.trusted.accessibility ? 0 : 1;
      } catch (err) {
        console.log(
          `strad-hostd-ax is not reachable: ${(err as Error).message}`,
        );
        await core.close();
        return 1;
      }
    }

    case "serve": {
      const dir = ensureStateDir();
      const daemon = await startDaemon(loadConfig(), {
        stateDir: dir,
        log: (l) => console.error(l),
        notifier: platformNotifier(),
      });
      const stop = () => void daemon.stop().then(() => process.exit(0));
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      return await new Promise<number>(() => {});
    }

    case "stdio": {
      const id = args[0] ?? "";
      if (!isCapabilityId(id)) {
        console.error(`stdio needs one of: ${CAPABILITY_IDS.join(", ")}`);
        return 1;
      }
      const loaded = loadConfig();
      // The person who started this process is the person at the keyboard, and
      // their MCP client asks them about each tool call. --no-consent lets them
      // drop the second dialog; it cannot be set for anything with a listener.
      const config = args.includes("--no-consent")
        ? { ...loaded, consent: { ...loaded.consent, mode: "none" as const } }
        : loaded;
      const core = buildCore(config, {
        stateDir: ensureStateDir(),
        only: [id],
      });
      const server = buildServer(id, core.capabilities[id]!, core.deps);
      const stop = () => void core.close().then(() => process.exit(0));
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      process.stdin.on("close", stop);
      await server.connect(new StdioServerTransport());
      return await new Promise<number>(() => {});
    }

    case "keys": {
      const config = loadConfig();
      for (const id of CAPABILITY_IDS) {
        const c = config.capabilities[id];
        if (c.enabled && c.key)
          console.log(`${displayName(config, id)}\t${c.key}`);
      }
      return 0;
    }

    case "status": {
      try {
        const state = (await (await control("/state.json")).json()) as {
          disabled: boolean;
          tunnel: string;
          grants: {
            id: string;
            server: string;
            purpose: string;
            calls: number;
          }[];
        };
        console.log(
          `remote control: ${state.disabled ? "OFF" : "on"} · tunnel: ${state.tunnel}`,
        );
        for (const g of state.grants)
          console.log(
            `  ${g.id}  ${g.server}  ${g.calls} calls  — ${g.purpose}`,
          );
        if (state.grants.length === 0) console.log("  nobody is in control");
        return 0;
      } catch {
        const off = new KillSwitch(ensureStateDir()).isDisabled();
        console.log(
          `the daemon is not running · remote control: ${off ? "OFF" : "on"}`,
        );
        return 1;
      }
    }

    case "disable": {
      // The file first: it holds even if the daemon is hung or down.
      new KillSwitch(ensureStateDir()).disable(
        "disabled from the command line",
      );
      await control("/disable").catch(() => undefined);
      console.log(
        "remote control is OFF. Every grant was ended; `strad-hostd enable` turns it back on.",
      );
      return 0;
    }

    case "enable": {
      new KillSwitch(ensureStateDir()).enable();
      await control("/enable").catch(() => undefined);
      console.log("remote control is on.");
      return 0;
    }

    case "kill": {
      const target = args[0];
      if (!target) {
        console.error(
          "kill needs a grant_id (from `strad-hostd status`) or --all",
        );
        return 1;
      }
      const res = await (target === "--all"
        ? control("/kill-all")
        : control("/kill", { grant: target }));
      console.log(
        res.status === 303 ? "killed." : `the daemon answered ${res.status}`,
      );
      return res.status === 303 ? 0 : 1;
    }

    default:
      console.log(USAGE);
      return command && command !== "help" && command !== "--help" ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
