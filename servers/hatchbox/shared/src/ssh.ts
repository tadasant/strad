/**
 * The app's RUNTIME environment, read over one SSH exec against a pinned host.
 *
 * WHY SSH AT ALL. Hatchbox's API never returns an env var's value (its
 * `GET …/env_vars` is names only), so "what is DATABASE_URL in production" is
 * answered where the value is actually used: the running puma process's
 * `/proc/<pid>/environ` on the web server. This is the npm package's approach,
 * and the values it returns are every secret the app holds.
 *
 * WHAT CHANGED FROM UPSTREAM, which ran `ssh -o StrictHostKeyChecking=no -i
 * <path>` through a shell, twice, with the app name spliced into the command:
 *
 *   - THE HOST KEY IS PINNED (`host-key.ts`, vendored from strad's ssh server).
 *     A server presenting any other key is refused before the private key
 *     signs anything, so the app's secrets are never read off an impostor and
 *     the key is never offered to one.
 *   - THE KEY IS A VALUE, held in this process, never a file path.
 *   - ONE FIXED COMMAND. The only variable part is `HATCHBOX_APP_NAME`, which
 *     config.ts holds to `[A-Za-z0-9._-]`, escaped for the regex and inside
 *     single quotes. Nothing a CALLER sends reaches the command line.
 *   - THE MATCH IS PUMA'S OWN PROCESS TITLE. A puma master retitles itself
 *     `puma 6.4.2 (<bind>) [<tag>]`; its workers read `puma: cluster worker …`.
 *     So the pattern is anchored on `^puma <version>`, which no worker, no
 *     `tail -f …/puma.log`, no `bash -lc 'bundle exec puma'` wrapper and not
 *     the shell running this command matches — upstream's `puma.*app` matched
 *     all of them. The app name must stand alone in the title (bounded by
 *     anything but a letter, digit, `_` or `-`), so `blog` does not match
 *     `blog-staging`.
 *   - THE PID IS FOUND BY A MARKER, not by position, so a login banner the
 *     deploy user's shell prints first does not break the read.
 *   - OUTPUT IS BOUNDED as it arrives.
 */
import ssh2 from "ssh2";
import type { ConnectConfig } from "ssh2";
import type { SshConfig } from "./config.js";
import { ConfigError, SshReadError } from "./errors.js";
import { fingerprintOf, hostKeyAlgorithms, matchesPin } from "./host-key.js";

const { Client } = ssh2;

export const CONNECT_TIMEOUT_MS = 15_000;
export const EXEC_TIMEOUT_MS = 30_000;
/** A Rails app's whole environment is kilobytes; this is far past any real one. */
export const MAX_ENVIRON_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
/** The exit status the command uses for "no puma process". */
const NO_PROCESS_EXIT = 3;
/** The exit status the command uses for "found it, could not read its environ". */
const UNREADABLE_EXIT = 4;
/** Printed before the pid, so anything a shell prints first is skipped. */
export const PID_MARKER = "STRAD-HATCHBOX-PID ";

export interface EnvVar {
  name: string;
  value: string;
}

export interface EnvironRead {
  pid: number;
  vars: EnvVar[];
}

/** Opens a connection and reads the environment. Injected in tests. */
export type EnvironReader = (config: SshConfig) => Promise<EnvironRead>;

/**
 * The extended regex `pgrep -f` is given: a puma MASTER's title, and when an
 * app is named, that name standing alone somewhere in it (its tag, or a bind
 * path such as `/home/deploy/<app>/shared/tmp/sockets/puma.sock`).
 */
export function processPattern(appName?: string): string {
  const master = "^puma [0-9]";
  if (appName === undefined) return master;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(appName)) {
    throw new ConfigError("HATCHBOX_APP_NAME holds characters this server will not put in a command.");
  }
  const name = appName.replace(/\./g, "\\.");
  return `${master}.*[^A-Za-z0-9_-]${name}([^A-Za-z0-9_-]|$)`;
}

/**
 * The one command this server ever runs. The oldest matching process is the
 * puma master, which every worker forks from with the same environment.
 */
export function remoteCommand(appName?: string): string {
  const pattern = processPattern(appName);
  return (
    `pid=$(pgrep -o -f '${pattern}'); ` +
    `if [ -z "$pid" ]; then exit ${NO_PROCESS_EXIT}; fi; ` +
    `printf '${PID_MARKER}%s\\n' "$pid"; cat "/proc/$pid/environ" || exit ${UNREADABLE_EXIT}`
  );
}

/** `NAME=value` records separated by NUL, as `/proc/<pid>/environ` holds them. */
export function parseEnviron(raw: Buffer): EnvVar[] {
  const out: EnvVar[] = [];
  for (const record of raw.toString("utf8").split("\0")) {
    const eq = record.indexOf("=");
    if (eq <= 0) continue;
    out.push({ name: record.slice(0, eq), value: record.slice(eq + 1) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The pid after the marker, and the environ bytes after its newline. */
export function splitPidOutput(raw: Buffer): { pid: number; environ: Buffer } | null {
  const at = raw.indexOf(PID_MARKER);
  if (at === -1) return null;
  const nl = raw.indexOf(0x0a, at);
  if (nl === -1) return null;
  const pid = Number(raw.subarray(at + PID_MARKER.length, nl).toString("ascii"));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, environ: raw.subarray(nl + 1) };
}

function target(c: SshConfig): string {
  return `${c.username}@${c.host}:${c.port}`;
}

/** The production reader: one connection, one exec, closed after. */
export const readEnviron: EnvironReader = (config) =>
  new Promise<EnvironRead>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let mismatch: string | null = null;
    let authenticated = false;
    const finish = (error: Error | null, value?: EnvironRead) => {
      if (settled) return;
      settled = true;
      clearTimeout(wall);
      client.end();
      if (error) reject(error);
      else resolve(value!);
    };
    const wall = setTimeout(
      () =>
        finish(
          new SshReadError(
            `${target(config)} did not finish reading the environment within ` +
              `${CONNECT_TIMEOUT_MS + EXEC_TIMEOUT_MS} ms.`,
          ),
        ),
      CONNECT_TIMEOUT_MS + EXEC_TIMEOUT_MS,
    );

    client.on("ready", () => {
      authenticated = true;
      client.exec(remoteCommand(config.appName), (err, stream) => {
        if (err) {
          finish(new SshReadError(`${target(config)} refused to run the command: ${err.message}.`));
          return;
        }
        const out: Buffer[] = [];
        let outBytes = 0;
        let errText = "";
        stream.on("data", (chunk: Buffer) => {
          if (settled) return;
          outBytes += chunk.length;
          if (outBytes > MAX_ENVIRON_BYTES) {
            finish(new SshReadError(`The environment read from ${target(config)} passed ${MAX_ENVIRON_BYTES} bytes; it was dropped.`));
            return;
          }
          out.push(chunk);
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          if (errText.length < MAX_STDERR_BYTES) errText += chunk.toString("utf8");
        });
        stream.on("close", (code: number | null | undefined) => {
          if (code === NO_PROCESS_EXIT) {
            finish(
              new SshReadError(
                `No puma process ${config.appName ? `for "${config.appName}" ` : ""}is running on ` +
                  `${config.host}. The app may be down or mid-deploy` +
                  (config.appName ? `, or HATCHBOX_APP_NAME does not match its process.` : `.`),
              ),
            );
            return;
          }
          const said = errText.trim().slice(0, 300);
          if (code === UNREADABLE_EXIT) {
            finish(
              new SshReadError(
                `Found puma on ${config.host} but could not read its environment` +
                  (said ? `: ${said}` : "") +
                  `. The process may have exited mid-read (a restart), or the ` +
                  `${config.username} user does not own it.`,
              ),
            );
            return;
          }
          if (code !== 0) {
            finish(
              new SshReadError(
                `Reading the environment on ${config.host} failed (` +
                  (code === undefined || code === null ? "no exit status" : `exit ${code}`) +
                  `)` +
                  (said ? `: ${said}` : "") +
                  `.`,
              ),
            );
            return;
          }
          const parsed = splitPidOutput(Buffer.concat(out));
          if (!parsed) {
            finish(new SshReadError(`${config.host} answered with output this server does not recognise.`));
            return;
          }
          finish(null, { pid: parsed.pid, vars: parseEnviron(parsed.environ) });
        });
      });
    });

    // A server that drops the connection without an error (an early sshd
    // disconnect) would otherwise hang the call until the wall timeout.
    client.on("close", () =>
      finish(new SshReadError(`${target(config)} closed the connection before the environment was read.`)),
    );

    client.on("error", (err: Error & { level?: string; code?: string }) => {
      if (mismatch) {
        finish(
          new SshReadError(
            `${target(config)} presented host key ${mismatch}, which is not ` +
              `HATCHBOX_SSH_HOST_KEY. Nothing was read and the private key was not ` +
              `used. If the server was rebuilt, a human verifies its new key and ` +
              `updates the pin; otherwise something else is answering at that address.`,
          ),
        );
        return;
      }
      if (err.level === "client-authentication") {
        finish(
          new SshReadError(
            `${target(config)} rejected HATCHBOX_SSH_PRIVATE_KEY. The host key matched, ` +
              `so this is the right server: the key's public half is not on its ` +
              `${config.username} user.`,
          ),
        );
        return;
      }
      const code = err.code ? ` (${err.code})` : "";
      finish(
        new SshReadError(
          `Could not ${authenticated ? "read from" : "connect to"} ${target(config)}: ${err.message}${code}.`,
        ),
      );
    });

    const algorithms = hostKeyAlgorithms(config.hostKeyPins);
    const connect: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      ...(config.passphrase === undefined ? {} : { passphrase: config.passphrase }),
      readyTimeout: CONNECT_TIMEOUT_MS,
      // No agent and no other auth method: the configured key, or nothing.
      agent: undefined,
      tryKeyboard: false,
      hostVerifier: (key: Buffer) => {
        if (matchesPin(config.hostKeyPins, key)) return true;
        mismatch = fingerprintOf(key);
        return false;
      },
      ...(algorithms ? { algorithms: { serverHostKey: algorithms as never } } : {}),
    };
    try {
      client.connect(connect);
    } catch (error) {
      finish(new SshReadError(`Could not connect to ${target(config)}: ${(error as Error).message}.`));
    }
  });
