import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import type { Config } from "../config.js";

/** Where the helper's LaunchAgent listens: the state directory, mode 0600. */
export function helperSocketPath(config: Config, stateDir: string): string {
  return config.native.socketPath ?? join(stateDir, "ax.sock");
}

/**
 * The helper binary to spawn, for the stdio case. Looked for in the order a
 * person is likely to have put it: the install's copy in the state directory,
 * the package's own `swift build` output, then PATH.
 */
export function helperBinaryCandidates(
  config: Config,
  stateDir: string,
): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    ...(config.native.binary ? [config.native.binary] : []),
    ...(process.env.STRAD_HOSTD_AX ? [process.env.STRAD_HOSTD_AX] : []),
    join(stateDir, "bin", "strad-hostd-ax"),
    // build/native/transport.js → ../../ax/.build/release/strad-hostd-ax
    join(here, "..", "..", "ax", ".build", "release", "strad-hostd-ax"),
    "strad-hostd-ax",
  ];
}

function resolveBinary(candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (c.includes("/") ? existsSync(c) : true) return c;
  }
  return undefined;
}

/**
 * One connection to the helper, by whichever route is there.
 *
 * The socket first: it means the helper is running as its own LaunchAgent,
 * which is the only arrangement under which macOS attributes the Accessibility
 * and Screen Recording grants to the helper rather than to `node`. Then, with
 * no socket, spawn the binary as a child over stdio — the local-run case, where
 * the grants land on whatever launched the MCP client (a terminal, usually)
 * and that is the ordinary thing for a command-line tool.
 */
export function helperConnector(
  config: Config,
  stateDir: string,
  log: (line: string) => void = () => {},
): () => Promise<Duplex> {
  const socketPath = helperSocketPath(config, stateDir);
  const candidates = helperBinaryCandidates(config, stateDir);
  const agentPlist = join(
    homedir(),
    "Library",
    "LaunchAgents",
    "com.strad.hostd-ax.plist",
  );

  return () =>
    new Promise<Duplex>((resolve, reject) => {
      // With the LaunchAgent installed the socket is the ONLY way in. Both
      // agents start at login in no particular order, and a daemon that spawned
      // a private helper because the socket was not there yet would keep it for
      // good: two helpers, two menu-bar items, and grants attributed to `node`.
      const socketOnly =
        config.native.mode === "socket" ||
        (config.native.mode === "auto" && existsSync(agentPlist));
      if (config.native.mode !== "stdio" && existsSync(socketPath)) {
        const socket = netConnect(socketPath);
        socket.once("connect", () => resolve(socket));
        socket.once("error", (err) =>
          reject(
            new Error(
              `could not reach strad-hostd-ax at ${socketPath} (${err.message}); is its LaunchAgent running? \`launchctl print gui/$(id -u)/com.strad.hostd-ax\``,
            ),
          ),
        );
        return;
      }
      if (socketOnly) {
        reject(
          new Error(
            `strad-hostd-ax is not listening at ${socketPath} yet; its LaunchAgent com.strad.hostd-ax starts it at login (\`launchctl print gui/$(id -u)/com.strad.hostd-ax\`, and ~/Library/Logs/com.strad.hostd-ax.err.log)`,
          ),
        );
        return;
      }
      const binary = resolveBinary(candidates);
      if (!binary) {
        reject(
          new Error(
            `strad-hostd-ax is not installed: no socket at ${socketPath} and no binary at ${candidates.join(", ")}. Build it with \`cd hostd/ax && swift build -c release\` (macOS only).`,
          ),
        );
        return;
      }
      const child = spawn(binary, ["--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.on("data", (d: Buffer) =>
        log(`[ax] ${d.toString("utf8").trimEnd()}`),
      );
      let settled = false;
      child.once("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            err.code === "ENOENT" && !binary.includes("/")
              ? `strad-hostd-ax is not installed: no socket at ${socketPath} and no binary at ${candidates.join(", ")}. Build it with \`cd hostd/ax && swift build -c release\` (macOS only).`
              : `could not start strad-hostd-ax (${binary}): ${err.message}`,
          ),
        );
      });
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        const stream = Duplex.from({
          readable: child.stdout,
          writable: child.stdin,
        });
        const end = () => stream.destroy();
        child.once("exit", end);
        stream.once("close", () => {
          child.removeListener("exit", end);
          if (child.exitCode === null) child.kill("SIGTERM");
        });
        resolve(stream);
      });
    });
}
