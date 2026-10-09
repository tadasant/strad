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

/** Where `strad-hostd-messages` listens, beside the other helper's socket. */
export function messagesSocketPath(config: Config, stateDir: string): string {
  return config.messages.socketPath ?? join(stateDir, "messages.sock");
}

/** One native helper: its name, its build directory, its LaunchAgent and its socket. */
export interface HelperSpec {
  /** The binary's name: `strad-hostd-ax`. */
  name: string;
  /** Its Swift package under `hostd/`: `ax`. */
  packageDir: string;
  /** Its LaunchAgent's label: `com.strad.hostd-ax`. */
  label: string;
  socketPath: string;
  /** Where to look for the binary when it has to be spawned, in order. */
  candidates: string[];
}

function candidatesFor(
  name: string,
  packageDir: string,
  configured: string | undefined,
  envVar: string,
  stateDir: string,
): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    ...(configured ? [configured] : []),
    ...(process.env[envVar] ? [process.env[envVar]!] : []),
    join(stateDir, "bin", name),
    // build/native/transport.js → ../../<package>/.build/release/<name>
    join(here, "..", "..", packageDir, ".build", "release", name),
    name,
  ];
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
  return candidatesFor(
    "strad-hostd-ax",
    "ax",
    config.native.binary,
    "STRAD_HOSTD_AX",
    stateDir,
  );
}

export function axHelperSpec(config: Config, stateDir: string): HelperSpec {
  return {
    name: "strad-hostd-ax",
    packageDir: "ax",
    label: "com.strad.hostd-ax",
    socketPath: helperSocketPath(config, stateDir),
    candidates: helperBinaryCandidates(config, stateDir),
  };
}

export function messagesHelperSpec(
  config: Config,
  stateDir: string,
): HelperSpec {
  return {
    name: "strad-hostd-messages",
    packageDir: "messages",
    label: "com.strad.hostd-messages",
    socketPath: messagesSocketPath(config, stateDir),
    candidates: candidatesFor(
      "strad-hostd-messages",
      "messages",
      config.messages.binary,
      "STRAD_HOSTD_MESSAGES",
      stateDir,
    ),
  };
}

function resolveBinary(candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (c.includes("/") ? existsSync(c) : true) return c;
  }
  return undefined;
}

/**
 * One connection to `strad-hostd-ax`, by whichever route is there. See
 * `nativeConnector`.
 */
export function helperConnector(
  config: Config,
  stateDir: string,
  log: (line: string) => void = () => {},
): () => Promise<Duplex> {
  return nativeConnector(config, axHelperSpec(config, stateDir), log);
}

/**
 * One connection to a native helper, by whichever route is there.
 *
 * The socket first: it means the helper is running as its own LaunchAgent,
 * which is the only arrangement under which macOS attributes its privacy
 * grants (Accessibility, Screen Recording, Full Disk Access) to the helper
 * rather than to `node`. Then, with no socket, spawn the binary as a child
 * over stdio — the local-run case, where the grants land on whatever launched
 * the MCP client (a terminal, usually) and that is the ordinary thing for a
 * command-line tool.
 */
export function nativeConnector(
  config: Config,
  spec: HelperSpec,
  log: (line: string) => void = () => {},
): () => Promise<Duplex> {
  const { name, socketPath, candidates, label } = spec;
  const agentPlist = join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${label}.plist`,
  );
  const notInstalled = `${name} is not installed: no socket at ${socketPath} and no binary at ${candidates.join(", ")}. Build it with \`cd hostd/${spec.packageDir} && swift build -c release\` (macOS only).`;

  return () =>
    new Promise<Duplex>((resolve, reject) => {
      // With the LaunchAgent installed the socket is the ONLY way in. The
      // agents start at login in no particular order, and a daemon that
      // spawned a private helper because the socket was not there yet would
      // keep it for good: two helpers, and grants attributed to `node`.
      const socketOnly =
        config.native.mode === "socket" ||
        (config.native.mode === "auto" && existsSync(agentPlist));
      if (config.native.mode !== "stdio" && existsSync(socketPath)) {
        const socket = netConnect(socketPath);
        socket.once("connect", () => resolve(socket));
        socket.once("error", (err) =>
          reject(
            new Error(
              `could not reach ${name} at ${socketPath} (${err.message}); is its LaunchAgent running? \`launchctl print gui/$(id -u)/${label}\``,
            ),
          ),
        );
        return;
      }
      if (socketOnly) {
        reject(
          new Error(
            `${name} is not listening at ${socketPath}; its LaunchAgent ${label} starts it at login (\`launchctl print gui/$(id -u)/${label}\`, and ~/Library/Logs/${label}.err.log). Re-run hostd/install/install.sh if it was never installed.`,
          ),
        );
        return;
      }
      const binary = resolveBinary(candidates);
      if (!binary) {
        reject(new Error(notInstalled));
        return;
      }
      const child = spawn(binary, ["--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.on("data", (d: Buffer) =>
        log(`[${spec.packageDir}] ${d.toString("utf8").trimEnd()}`),
      );
      let settled = false;
      child.once("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            err.code === "ENOENT" && !binary.includes("/")
              ? notInstalled
              : `could not start ${name} (${binary}): ${err.message}`,
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
