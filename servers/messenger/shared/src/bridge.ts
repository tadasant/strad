/**
 * The bridge's lifecycle: restore the state, run the Go process, snapshot the
 * state back, and give it up cleanly.
 *
 * WHAT IS PERSISTED, AND WHY AS ONE FILE. The Go process keeps everything in
 * one SQLite file: the Messenger session, the encryption keys of the device it
 * registered, the chats, and the message buffer. App Platform has no disk that
 * survives a deploy, so that file is copied (SQLite's own `VACUUM INTO`, a
 * consistent read) every `snapshotIntervalMs`, gzipped, sealed with
 * AES-256-GCM under MESSENGER_STATE_ENCRYPTION_KEY, and written to
 * `{prefix}/bridge.db.sealed` in strad's shared state bucket — only when it
 * changed. At boot the newest copy is restored before the process starts.
 *
 * WHAT A STALE COPY COSTS. The encryption state moves with every encrypted
 * message, so a crash (not a deploy: SIGTERM snapshots) loses up to one
 * interval of it. whatsmeow asks the sender's device to re-send what it cannot
 * decrypt, so the usual cost is a delay, not a lost message; a message that
 * stays undecryptable arrives as a placeholder row of type "notice".
 *
 * ONE WRITER. An App Platform deploy runs the new container beside the old one
 * for a while, and two processes on one Messenger device kick each other off
 * and race to write the state. The newest process claims the lease
 * (`{prefix}/lease.json`); every snapshot write is conditional on the
 * generation this process last wrote, and a process that loses the lease stops
 * its child and stops writing.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import type { MessengerConfig } from "./config.js";
import { errMessage, logInfo, logWarning } from "./logging.js";
import { BridgeError, DEFAULT_BINARY, startSidecar, type Sidecar, type SidecarOptions } from "./sidecar.js";
import { Lease, open, PreconditionFailed, seal, type BlobStore, type SealFormat } from "./state-store.js";

export const SEAL_FORMAT: SealFormat = {
  magic: "MSG1",
  what: "a sealed Messenger bridge snapshot",
  keyVariable: "MESSENGER_STATE_ENCRYPTION_KEY",
  recovery:
    "Restore the key that wrote it, or delete the object and log in again with messenger_login_start.",
};

export class SupersededError extends Error {
  constructor() {
    super(
      "Another strad process has taken over this Messenger account (a deploy " +
        "replaced this container). This one has stopped; the new one answers.",
    );
    this.name = "SupersededError";
  }
}

export type SidecarStarter = (options: SidecarOptions) => Promise<Sidecar>;

export interface BridgeOptions {
  config: MessengerConfig;
  blobs: BlobStore;
  /** The command that runs the Go bridge. Tests run a fake under node. */
  command?: string;
  args?: string[];
  startSidecar?: SidecarStarter;
  snapshotIntervalMs?: number;
  restartBaseMs?: number;
}

export class MessengerBridge {
  private readonly config: MessengerConfig;
  private readonly blobs: BlobStore;
  private readonly lease: Lease;
  private readonly snapshotName: string;
  private readonly options: BridgeOptions;

  private sidecar?: Sidecar;
  private dataDir?: string;
  private starting?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private closing = false;
  private restarts = 0;
  private generation: string | null = null;
  private lastHash?: string;
  private snapshotting?: Promise<void>;
  /** Wall-clock ms of the last snapshot that reached the bucket. */
  lastSavedAt?: number;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.config = options.config;
    this.blobs = options.blobs;
    this.lease = new Lease(this.blobs, `${this.config.prefix}/lease.json`);
    this.snapshotName = `${this.config.prefix}/bridge.db.sealed`;
  }

  get superseded(): boolean {
    return this.lease.superseded;
  }

  /** Idempotent: every tool call awaits it. */
  start(): Promise<void> {
    if (this.lease.superseded) return Promise.reject(new SupersededError());
    if (!this.starting) {
      this.starting = this.boot().catch((err: unknown) => {
        this.starting = undefined;
        throw err;
      });
    }
    return this.starting;
  }

  private async boot(): Promise<void> {
    await this.lease.claim();
    this.dataDir = await mkdtemp(join(tmpdir(), "strad-messenger-"));
    await this.restore();
    await this.spawn();
    const interval = this.options.snapshotIntervalMs ?? 60_000;
    this.timer = setInterval(() => {
      void this.snapshot().catch((err: unknown) => logWarning(`snapshot failed: ${errMessage(err)}`));
    }, interval);
    this.timer.unref();
  }

  private async restore(): Promise<void> {
    const found = await this.blobs.read(this.snapshotName);
    if (!found) {
      logInfo("no saved state: starting logged out");
      return;
    }
    const plain = gunzipSync(open(this.config.encryptionKey, this.snapshotName, found.data, SEAL_FORMAT));
    await writeFile(join(this.dataDir!, "bridge.db"), plain, { mode: 0o600 });
    this.generation = found.generation;
    this.lastHash = createHash("sha256").update(plain).digest("hex");
    logInfo(`restored saved state (${plain.length} bytes)`);
  }

  private async spawn(): Promise<void> {
    const starter = this.options.startSidecar ?? startSidecar;
    this.sidecar = await starter({
      command: this.options.command ?? DEFAULT_BINARY,
      args: this.options.args ?? [],
      dataDir: this.dataDir!,
      bufferMaxAgeDays: this.config.bufferMaxAgeDays,
      ...(this.config.proxy ? { proxy: this.config.proxy } : {}),
      onEvent: (event) => {
        if (event.event === "login_complete") {
          void this.snapshot().catch((err: unknown) => logWarning(`snapshot after login failed: ${errMessage(err)}`));
        }
      },
      onExit: (code) => this.onExit(code),
    });
    this.restarts = 0;
  }

  private onExit(code: number | null): void {
    this.sidecar = undefined;
    if (this.closing || this.lease.superseded || !this.dataDir) return;
    const delay = Math.min(60_000, (this.options.restartBaseMs ?? 1000) * 2 ** this.restarts++);
    logWarning(`bridge process exited (${code}); restarting in ${delay} ms`);
    setTimeout(() => {
      if (this.closing || this.sidecar) return;
      void this.spawn().catch((err: unknown) => {
        logWarning(`bridge restart failed: ${errMessage(err)}`);
        this.onExit(null);
      });
    }, delay).unref();
  }

  /** The running child, starting everything on first use. */
  async client(): Promise<Sidecar> {
    await this.start();
    if (this.lease.superseded) throw new SupersededError();
    if (!this.sidecar) {
      throw new BridgeError("the Messenger bridge process is restarting; retry in a few seconds");
    }
    return this.sidecar;
  }

  /** Copy, seal and upload the database if it changed. Serialised. */
  snapshot(): Promise<void> {
    const run = (this.snapshotting ?? Promise.resolve()).then(() => this.snapshotOnce());
    this.snapshotting = run.catch(() => {});
    return run;
  }

  private async snapshotOnce(): Promise<void> {
    if (!this.sidecar || !this.dataDir || this.lease.superseded) return;
    // Forced: one small read a minute is what makes an old container stop
    // within one interval of a new one starting, rather than at its next write.
    if (!(await this.lease.check(true))) {
      await this.giveUp();
      return;
    }
    const path = join(this.dataDir, "snapshot.db");
    await this.sidecar.request("POST", "/snapshot", { path });
    const plain = await readFile(path);
    await rm(path, { force: true });
    const hash = createHash("sha256").update(plain).digest("hex");
    if (hash === this.lastHash) return;
    const sealed = seal(this.config.encryptionKey, this.snapshotName, gzipSync(plain), SEAL_FORMAT);
    try {
      this.generation = await this.blobs.write(this.snapshotName, sealed, this.generation);
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err;
      // Someone else wrote it. If that someone holds the lease, stop; if the
      // lease is still ours (a write we never saw acknowledged), take it back.
      if (!(await this.lease.check(true))) {
        await this.giveUp();
        return;
      }
      this.generation = await this.blobs.write(this.snapshotName, sealed);
    }
    this.lastHash = hash;
    this.lastSavedAt = Date.now();
  }

  private async giveUp(): Promise<void> {
    logWarning("lease lost to a newer process: stopping this one's Messenger connection");
    const sidecar = this.sidecar;
    this.sidecar = undefined;
    await sidecar?.stop();
  }

  /**
   * Log out at Meta, then delete everything: the local database, the saved
   * snapshot, and the process holding them. A fresh, logged-out process takes
   * its place.
   */
  async logout(): Promise<{ logged_out: number }> {
    const sidecar = await this.client();
    const result = await sidecar.request<{ logged_out: number }>("POST", "/logout");
    this.closing = true;
    try {
      await sidecar.stop();
      this.sidecar = undefined;
      await rm(this.dataDir!, { recursive: true, force: true });
      this.dataDir = await mkdtemp(join(tmpdir(), "strad-messenger-"));
      await this.blobs.delete(this.snapshotName);
      this.generation = null;
      this.lastHash = undefined;
      this.lastSavedAt = undefined;
    } finally {
      this.closing = false;
    }
    await this.spawn();
    return result;
  }

  /** SIGTERM: a last snapshot, then stop the child. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    try {
      await this.snapshot();
    } catch (err) {
      logWarning(`final snapshot failed: ${errMessage(err)}`);
    }
    this.closing = true;
    await this.sidecar?.stop();
    this.sidecar = undefined;
    if (this.dataDir) await rm(this.dataDir, { recursive: true, force: true });
  }
}
