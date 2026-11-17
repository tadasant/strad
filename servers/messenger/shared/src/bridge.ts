/**
 * The bridge's lifecycle: restore the state, run the Go process, snapshot the
 * state back, and hand it over cleanly.
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
 * ONE WRITER, AND A HANDOFF. An App Platform deploy runs the new container
 * beside the old one until the old one gets SIGTERM, and two processes on one
 * Messenger device kick each other off and race to write the state. So a new
 * process does not take over while the lease (`{prefix}/lease.json`) is held
 * by a live one: it waits until the holder RELEASES it — which the old
 * container does on SIGTERM, right after its final snapshot — or until the
 * holder's heartbeat goes stale, or `handoffWaitMs` passes. Then it claims the
 * lease and restores, so it starts from everything the old one saw. Every
 * snapshot write is conditional on the generation this process last wrote,
 * and a process that finds the lease gone stops its child and stops writing;
 * it takes the lease back if the holder later goes stale.
 *
 * WHAT A STALE COPY COSTS. A crash (not a deploy) loses up to one interval of
 * encryption state. whatsmeow asks the sender's device to re-send what it
 * cannot decrypt, so the usual cost is a delay; a message that stays
 * undecryptable arrives as a placeholder.
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
  /** How long a new process waits for a live holder to release the lease. */
  handoffWaitMs?: number;
  handoffPollMs?: number;
  /** A holder whose heartbeat is older than this is dead. */
  staleLeaseMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MessengerBridge {
  private readonly config: MessengerConfig;
  private readonly blobs: BlobStore;
  private readonly lease: Lease;
  private readonly leaseName: string;
  private readonly snapshotName: string;
  private readonly options: BridgeOptions;
  private readonly interval: number;

  private sidecar?: Sidecar;
  private dataDir?: string;
  private starting?: Promise<void>;
  private booted = false;
  private timer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private closing = false;
  private closed = false;
  private restarts = 0;
  private generation: string | null = null;
  private lastHash?: string;
  /** Snapshot, logout, reclaim and close run one at a time, in order. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Wall-clock ms of the last snapshot that reached the bucket. */
  lastSavedAt?: number;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.config = options.config;
    this.blobs = options.blobs;
    this.leaseName = `${this.config.prefix}/lease.json`;
    this.lease = new Lease(this.blobs, this.leaseName);
    this.snapshotName = `${this.config.prefix}/bridge.db.sealed`;
    this.interval = options.snapshotIntervalMs ?? 60_000;
  }

  get superseded(): boolean {
    return this.lease.superseded;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Idempotent: every tool call awaits it. */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new BridgeError("the Messenger bridge is shutting down"));
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
    await this.waitForHandoff();
    await this.lease.claim();
    this.dataDir = await mkdtemp(join(tmpdir(), "strad-messenger-"));
    try {
      await this.restore();
      await this.spawn();
    } catch (err) {
      // The next tool call boots again from scratch, with a directory of its own.
      await rm(this.dataDir, { recursive: true, force: true });
      this.dataDir = undefined;
      throw err;
    }
    this.booted = true;
    this.timer = setInterval(() => {
      void this.maintain().catch((err: unknown) => logWarning(`maintenance failed: ${errMessage(err)}`));
    }, this.interval);
    this.timer.unref();
  }

  /** Wait while another live process holds the lease, so it can hand over. */
  private async waitForHandoff(): Promise<void> {
    const deadline = Date.now() + (this.options.handoffWaitMs ?? 5 * 60_000);
    const stale = this.options.staleLeaseMs ?? 5 * this.interval;
    let logged = false;
    for (;;) {
      const held = await this.readLease();
      if (
        !held.owner ||
        held.owner === this.lease.instanceId || // ours, from a boot that failed
        held.heartbeatAt === undefined ||
        Date.now() - held.heartbeatAt > stale
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        logWarning("the previous process never released the Messenger lease; taking it over");
        return;
      }
      if (!logged) {
        logInfo("waiting for the previous process to hand the Messenger account over");
        logged = true;
      }
      await sleep(this.options.handoffPollMs ?? 5000);
    }
  }

  private async readLease(): Promise<{ owner?: string; heartbeatAt?: number; generation?: string }> {
    const found = await this.blobs.read(this.leaseName);
    if (!found) return {};
    try {
      const body = JSON.parse(found.data.toString("utf8")) as { owner?: unknown; heartbeat_at?: unknown };
      return {
        ...(typeof body.owner === "string" ? { owner: body.owner } : {}),
        ...(typeof body.heartbeat_at === "number" ? { heartbeatAt: body.heartbeat_at } : {}),
        generation: found.generation,
      };
    } catch {
      return { generation: found.generation };
    }
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
    let current: Sidecar | undefined;
    current = await starter({
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
      // Only a child that STARTED is this handler's to restart; one that dies
      // before listening rejects `starter`, and its caller decides.
      onExit: (code) => {
        if (current !== undefined && this.sidecar === current) {
          this.sidecar = undefined;
          logWarning(`bridge process exited (${code})`);
          this.scheduleRestart();
        }
      },
    });
    this.sidecar = current;
    this.restarts = 0;
  }

  /** The one place a restart is scheduled: at most one pending at a time. */
  private scheduleRestart(): void {
    if (this.restartTimer || this.closing || this.closed || this.lease.superseded || !this.booted) return;
    const delay = Math.min(60_000, (this.options.restartBaseMs ?? 1000) * 2 ** this.restarts++);
    logWarning(`restarting the bridge process in ${delay} ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.closing || this.closed || this.sidecar || this.lease.superseded) return;
      void this.spawn().catch((err: unknown) => {
        logWarning(`bridge restart failed: ${errMessage(err)}`);
        this.scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref();
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

  /** The timer's work: a snapshot, or, once superseded, a reclaim attempt. */
  maintain(): Promise<void> {
    return this.lease.superseded ? this.serial(() => this.reclaim()) : this.snapshot();
  }

  /** Copy, seal and upload the database if it changed. Serialised. */
  snapshot(): Promise<void> {
    return this.serial(() => this.snapshotOnce());
  }

  private async snapshotOnce(): Promise<void> {
    if (!this.sidecar || !this.dataDir || this.lease.superseded) return;
    // Forced: one small read a minute is what makes an old container stop
    // within one interval of a new one taking over, rather than at its next
    // write — and it is the heartbeat a waiting successor watches.
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
   * Superseded, and the holder has gone quiet (it died, or a deploy rolled
   * back): take the lease back and start again from the newest snapshot.
   */
  private async reclaim(): Promise<void> {
    if (!this.lease.superseded || this.closed) return;
    if (!(await this.lease.reclaimIfStale(this.options.staleLeaseMs ?? 5 * this.interval))) return;
    logInfo("the Messenger lease holder went quiet; taking the account back");
    if (this.dataDir) await rm(this.dataDir, { recursive: true, force: true });
    this.dataDir = await mkdtemp(join(tmpdir(), "strad-messenger-"));
    this.generation = null;
    this.lastHash = undefined;
    await this.restore();
    await this.spawn();
  }

  /**
   * Log out at Meta, then delete everything: the local database, the saved
   * snapshot, and the process holding them. A fresh, logged-out process takes
   * its place. Serialised with snapshots, so none can put the deleted state
   * back.
   */
  async logout(): Promise<{ logged_out: number }> {
    await this.client();
    return this.serial(async () => {
      const sidecar = this.sidecar;
      if (!sidecar) throw new BridgeError("the Messenger bridge process is restarting; retry in a few seconds");
      const result = await sidecar.request<{ logged_out: number }>("POST", "/logout");
      this.closing = true;
      try {
        this.sidecar = undefined;
        await sidecar.stop();
        await rm(this.dataDir!, { recursive: true, force: true });
        this.dataDir = await mkdtemp(join(tmpdir(), "strad-messenger-"));
        await this.blobs.delete(this.snapshotName);
        this.generation = null;
        this.lastHash = undefined;
        this.lastSavedAt = undefined;
      } finally {
        this.closing = false;
        try {
          await this.spawn();
        } catch (err) {
          logWarning(`bridge start after logout failed: ${errMessage(err)}`);
          this.scheduleRestart();
        }
      }
      return result;
    });
  }

  /** SIGTERM: a last snapshot, stop the child, and hand the lease over. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    await this.serial(async () => {
      try {
        await this.snapshotOnce();
      } catch (err) {
        logWarning(`final snapshot failed: ${errMessage(err)}`);
      }
      this.closing = true;
      const sidecar = this.sidecar;
      this.sidecar = undefined;
      await sidecar?.stop();
      if (this.booted && !this.lease.superseded) await this.release();
      if (this.dataDir) await rm(this.dataDir, { recursive: true, force: true });
    });
  }

  /** Clear the lease if it is still ours, so a waiting successor starts now. */
  private async release(): Promise<void> {
    try {
      const held = await this.readLease();
      if (held.owner !== this.lease.instanceId) return;
      await this.blobs.write(this.leaseName, Buffer.from("{}"), held.generation ?? null);
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) logWarning(`lease release failed: ${errMessage(err)}`);
    }
  }
}
