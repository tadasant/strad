import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import type { Config } from "../config.js";
import type { Grant } from "../consent/grants.js";
import { HeadTailBuffer } from "./output.js";

export type CommandStatus = "running" | "exited" | "killed" | "timed_out";

export interface CommandRecord {
  id: string;
  grantId: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  status: CommandStatus;
  exitCode?: number | null;
  signal?: string | null;
  output: HeadTailBuffer;
  child?: ChildProcess;
  done: Promise<void>;
}

const MAX_FINISHED_PER_GRANT = 50;

/** Variables that are the daemon's own and no business of a command's. */
const SCRUBBED_ENV = /^STRAD_HOSTD_/;

export function defaultShell(platform = process.platform): string {
  if (platform === "darwin") return "/bin/zsh";
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/**
 * Runs commands and owns their lifetimes.
 *
 * Every command is its own PROCESS GROUP (`detached`), so a kill reaches the
 * pipeline and the grandchildren rather than the shell that started them. Every
 * command belongs to the grant that started it and dies with that grant — that
 * is the whole of what the owner's kill button means for this capability.
 *
 * A command gets no stdin. Anything that stops to ask a question — `sudo`, an
 * ssh host-key prompt — reads EOF and fails, which is the right answer for a
 * caller that is not at the keyboard.
 */
export class ProcessManager {
  private readonly commands = new Map<string, CommandRecord>();
  private readonly watched = new WeakSet<AbortSignal>();
  private seq = 0;

  constructor(private readonly config: Config) {}

  resolveCwd(cwd?: string): string {
    const base = this.config.shell.defaultCwd ?? homedir();
    if (!cwd) return base;
    const expanded =
      cwd === "~"
        ? homedir()
        : cwd.startsWith("~/")
          ? resolve(homedir(), cwd.slice(2))
          : cwd;
    return isAbsolute(expanded) ? expanded : resolve(base, expanded);
  }

  start(grant: Grant, command: string, cwdInput?: string): CommandRecord {
    const running = [...this.commands.values()].filter(
      (c) => c.status === "running",
    ).length;
    if (running >= this.config.shell.maxConcurrent) {
      throw new Error(
        `${running} commands are already running on this machine (the limit is ${this.config.shell.maxConcurrent}); wait for one or kill one`,
      );
    }
    const cwd = this.resolveCwd(cwdInput);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`cwd is not a directory on this machine: ${cwd}`);
    }

    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!SCRUBBED_ENV.test(k)) env[k] = v;
    }

    const shell = this.config.shell.shell ?? defaultShell();
    const child = spawn(shell, ["-lc", command], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = new HeadTailBuffer(this.config.shell.maxCapturedBytes);
    let finish!: () => void;
    const record: CommandRecord = {
      id: `c${++this.seq}`,
      grantId: grant.id,
      command,
      cwd,
      startedAt: Date.now(),
      status: "running",
      output,
      child,
      done: new Promise<void>((r) => (finish = r)),
    };
    this.commands.set(record.id, record);

    child.stdout?.on("data", (d: Buffer) => output.append(d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => output.append(d.toString("utf8")));

    const ceiling = setTimeout(() => {
      if (record.status !== "running") return;
      record.status = "timed_out";
      this.signalGroup(record, "SIGKILL");
    }, this.config.shell.maxRuntimeSeconds * 1000);
    ceiling.unref();

    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (record.endedAt) return;
      clearTimeout(ceiling);
      record.endedAt = Date.now();
      record.exitCode = code;
      record.signal = signal;
      if (record.status === "running") record.status = "exited";
      record.child = undefined;
      this.prune(grant.id);
      finish();
    };
    child.on("error", (err) => {
      output.append(`\n[failed to start: ${err.message}]\n`);
      settle(null, null);
    });
    child.on("close", settle);

    if (!this.watched.has(grant.signal)) {
      this.watched.add(grant.signal);
      grant.signal.addEventListener("abort", () => this.killGrant(grant.id), {
        once: true,
      });
    }
    return record;
  }

  get(grantId: string, id: string): CommandRecord | undefined {
    const c = this.commands.get(id);
    return c && c.grantId === grantId ? c : undefined;
  }

  list(grantId: string): CommandRecord[] {
    return [...this.commands.values()].filter((c) => c.grantId === grantId);
  }

  /** Every running command, across grants — the status page's view. */
  running(): CommandRecord[] {
    return [...this.commands.values()].filter((c) => c.status === "running");
  }

  async wait(record: CommandRecord, ms: number): Promise<void> {
    if (record.endedAt) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      record.done,
      new Promise<void>((r) => {
        timer = setTimeout(r, ms);
      }),
    ]);
    clearTimeout(timer);
  }

  async kill(record: CommandRecord): Promise<void> {
    if (record.status !== "running") return;
    record.status = "killed";
    this.signalGroup(record, "SIGTERM");
    await this.wait(record, 2000);
    if (!record.endedAt) this.signalGroup(record, "SIGKILL");
    await record.done;
  }

  /** The grant ended: everything it started stops, and its records go. */
  private killGrant(grantId: string): void {
    for (const c of this.list(grantId)) {
      if (c.status === "running") {
        c.status = "killed";
        this.signalGroup(c, "SIGKILL");
      }
      void c.done.then(() => this.commands.delete(c.id));
    }
  }

  async closeAll(): Promise<void> {
    const live = this.running();
    for (const c of live) {
      c.status = "killed";
      this.signalGroup(c, "SIGKILL");
    }
    await Promise.all(live.map((c) => c.done));
  }

  private signalGroup(record: CommandRecord, signal: NodeJS.Signals): void {
    const pid = record.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        record.child?.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  private prune(grantId: string): void {
    const finished = this.list(grantId).filter((c) => c.status !== "running");
    for (const c of finished.slice(
      0,
      Math.max(0, finished.length - MAX_FINISHED_PER_GRANT),
    )) {
      this.commands.delete(c.id);
    }
  }
}
