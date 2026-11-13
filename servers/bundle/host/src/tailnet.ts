/**
 * Tailnet egress for this bundle: a userspace `tailscaled`, supervised by the
 * host, joined to the tailnet as a tagged, pre-authorized, EPHEMERAL node.
 *
 * WHY A SIDECAR PROCESS AND NOT A SIDECAR CONTAINER. App Platform runs one
 * container per component and gives it no TUN device, so there is no
 * `tailscale0` for the kernel to route through and no second container to
 * share a network namespace with. `tailscaled --tun=userspace-networking` needs
 * neither: it is an ordinary process that terminates the tailnet in user space
 * and exposes it as a SOCKS5 listener on loopback. Nothing in the container
 * routes through it unless it dials that listener, and the only thing that
 * does is the `ssh` tree — for a host that resolves into Tailscale's ranges
 * (servers/ssh/shared/src/tailnet.ts).
 *
 * OFF UNLESS RENDERED ON. The renderer puts `STRAD_TAILNET_AUTHKEY` on a
 * component only when its bundle declares `tailnet:` in the strad config; with
 * no key this module starts nothing, sets nothing and the container is
 * byte-for-byte what it was.
 *
 * THE KEY IS NOT IN THE ENVIRONMENT NODE STARTS WITH. A conventional mount
 * reads the whole container environment (`slugEnvView`), and deleting a name
 * from `process.env` does not remove it from `/proc/<pid>/environ`, which every
 * server loaded into this process can read. So the image's entrypoint
 * (servers/bundle/scripts/boot.sh) moves the key into a 0600 file before Node
 * starts and passes its path as `STRAD_TAILNET_AUTHKEY_FILE`; this module reads
 * the file and deletes it. A bare `STRAD_TAILNET_AUTHKEY` is still honoured for
 * a host started some other way, with a warning, because then it IS in
 * `/proc`. The key reaches `tailscale up` through another 0600 file in a 0700
 * directory, removed as soon as `up` returns — never on a command line, where
 * `ps` would show it.
 *
 * NO INBOUND. `--shields-up` refuses every incoming tailnet connection at the
 * node, which matters more in userspace mode than in kernel mode: userspace
 * tailscaled forwards an accepted inbound connection to the same port on
 * loopback, where this bundle's internal listener is.
 *
 * ADMIN-SIDE REMOVAL STICKS. A node removed in the admin console, or logged
 * out by the control plane, keeps its daemon running and is reported `down`
 * by the status poll below; it is NOT re-joined, because re-joining would undo
 * the removal. A daemon that exits is restarted, and that mints a new node, so
 * revoking the OAuth client is what makes a cut-off survive a restart.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { log, logWarn } from "./log.js";

/** The variables the renderer sets on a component whose bundle declares `tailnet:`. */
export const TAILNET_ENV = {
  authKey: "STRAD_TAILNET_AUTHKEY",
  /** Set by the image's boot.sh: where it moved the key to. */
  authKeyFile: "STRAD_TAILNET_AUTHKEY_FILE",
  hostname: "STRAD_TAILNET_HOSTNAME",
  tags: "STRAD_TAILNET_TAGS",
  /** Set BY THIS HOST, for the ssh tree: where the SOCKS5 listener is. */
  socks5: "STRAD_TAILNET_SOCKS5",
} as const;

/** Loopback only. A port nothing else in the image binds. */
export const SOCKS5_LISTEN = "127.0.0.1:1055";

const TAG = /^tag:[a-z0-9][a-z0-9-]*$/;

export interface TailnetConfig {
  authKey: string;
  hostname: string;
  tags: string[];
}

/**
 * Read the tailnet configuration and REMOVE the key from the environment, so
 * nothing built after this can see it. Null when the component was not given a
 * key — the ordinary case, and the rollback.
 *
 * A key with no usable tag is refused rather than joined untagged: an
 * untagged node is owned by whoever minted the key and inherits THEIR access,
 * which on a tailnet with an allow-all grant is everything.
 */
export function takeTailnetConfig(
  env: NodeJS.ProcessEnv = process.env,
): TailnetConfig | null {
  const authKey = readKey(env);
  // Whatever a slug's namespace said, the proxy address is this host's to set.
  delete env[TAILNET_ENV.socks5];
  if (!authKey) return null;
  const tags = (env[TAILNET_ENV.tags] ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const bad = tags.filter((t) => !TAG.test(t));
  if (tags.length === 0 || bad.length > 0) {
    logWarn(
      `tailnet: not joining — ${TAILNET_ENV.tags} must name at least one tag ` +
        `(tag:name), got ${bad.length > 0 ? bad.map((t) => JSON.stringify(t)).join(", ") : "none"}. ` +
        `An untagged node would carry the access of whoever minted the key.`,
    );
    return null;
  }
  const hostname = (env[TAILNET_ENV.hostname] ?? "").trim() || "strad-bundle";
  return { authKey, hostname, tags };
}

/** The key from boot.sh's file (deleted once read), else from the bare variable. Both names are removed. */
function readKey(env: NodeJS.ProcessEnv): string | undefined {
  const file = env[TAILNET_ENV.authKeyFile];
  const bare = env[TAILNET_ENV.authKey]?.trim();
  delete env[TAILNET_ENV.authKeyFile];
  delete env[TAILNET_ENV.authKey];
  if (file) {
    try {
      const key = readFileSync(file, "utf8").trim();
      return key || undefined;
    } catch (err) {
      logWarn(
        `tailnet: could not read the key boot.sh wrote (${(err as NodeJS.ErrnoException).code ?? "error"}); not joining`,
      );
      return undefined;
    } finally {
      rmSync(file, { force: true });
      try {
        rmSync(join(file, ".."), { recursive: true, force: true });
      } catch {
        // the directory is boot.sh's mktemp; leaving it empty is harmless
      }
    }
  }
  if (bare) {
    logWarn(
      `tailnet: the key arrived in ${TAILNET_ENV.authKey}, not through the image's boot.sh, ` +
        `so it stays readable in this process's /proc environ`,
    );
  }
  return bare || undefined;
}

/**
 * The auth key as `tailscale up` should read it. An OAuth client secret
 * (`tskey-client-…`) is a key FACTORY: `up` mints a node key from it, and the
 * query string is how it is told what kind — ephemeral, so a stopped container
 * leaves no node behind, and pre-authorized, so a redeploy needs no human. An
 * ordinary auth key carries those properties itself and is passed unchanged.
 */
export function authKeyForUp(authKey: string): string {
  if (!authKey.startsWith("tskey-client-") || authKey.includes("?"))
    return authKey;
  return `${authKey}?ephemeral=true&preauthorized=true`;
}

export function tailscaledArgs(stateDir: string, socket: string): string[] {
  return [
    "--tun=userspace-networking",
    // No state on disk: a restart is a new node, and the old one is removed
    // by the control plane because it is ephemeral.
    "--state=mem:",
    `--statedir=${stateDir}`,
    `--socket=${socket}`,
    `--socks5-server=${SOCKS5_LISTEN}`,
  ];
}

export function upArgs(
  config: TailnetConfig,
  keyFile: string,
  socket: string,
): string[] {
  return [
    `--socket=${socket}`,
    "up",
    `--auth-key=file:${keyFile}`,
    `--hostname=${config.hostname}`,
    `--advertise-tags=${config.tags.join(",")}`,
    "--shields-up",
    // Nothing here should change how the container resolves or routes: the
    // tailnet is reached through the SOCKS5 listener and nowhere else.
    "--accept-dns=false",
    "--accept-routes=false",
    "--timeout=60s",
  ];
}

const KEY_SHAPE = /tskey-[A-Za-z0-9_-]+(\?[^\s"']*)?/g;

/** Every auth-key-shaped token and the literal key, out of a line before it is logged. */
export function redactTailnet(text: string, authKey?: string): string {
  let out = text;
  if (authKey && authKey.length >= 8)
    out = out.split(authKey).join("[redacted]");
  return out.replace(KEY_SHAPE, "tskey-[redacted]");
}

export type TailnetState =
  | { state: "starting"; since: string; restarts: number }
  | { state: "up"; since: string; restarts: number }
  | { state: "down"; since: string; restarts: number; reason: string };

export interface SidecarOptions {
  tailscaled?: string;
  tailscale?: string;
  /** Delay before a restart, given the consecutive failures so far (1-based). */
  backoffMs?: (n: number) => number;
  /** How often a joined node's backend state is checked. */
  statusEveryMs?: number;
  /** The floor on a retry after the control plane refused the key. */
  refusedBackoffMs?: number;
  now?: () => Date;
}

/** The floor on a retry after the control plane refused the key. */
export const REFUSED_BACKOFF_MS = 10 * 60_000;

const defaultBackoff = (n: number): number =>
  Math.min(60_000, 1_000 * 2 ** Math.min(n - 1, 6));

/**
 * One supervised `tailscaled` and the `up` that joins it. A crash or a failed
 * join is retried with backoff, forever, and reported on `/healthz`; it never
 * takes the bundle down — the thirty-one mounts that do not use the tailnet
 * keep serving, and the ssh tree reports a tailnet host as unreachable.
 */
export class TailnetSidecar {
  private daemon: ChildProcess | null = null;
  private current: TailnetState;
  /** Every restart in this container's life, for `/healthz`. */
  private restarts = 0;
  /** Consecutive failures since the last successful join: what the backoff counts. */
  private failures = 0;
  private statusTimer: NodeJS.Timeout | null = null;
  private readonly statusEveryMs: number;
  private readonly refusedBackoffMs: number;
  private stopping = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly stateDir: string;
  private readonly socket: string;
  private readonly bins: { tailscaled: string; tailscale: string };
  private readonly backoff: (n: number) => number;
  private readonly now: () => Date;

  constructor(
    private readonly config: TailnetConfig,
    options: SidecarOptions = {},
  ) {
    this.bins = {
      tailscaled: options.tailscaled ?? "tailscaled",
      tailscale: options.tailscale ?? "tailscale",
    };
    this.backoff = options.backoffMs ?? defaultBackoff;
    this.statusEveryMs = options.statusEveryMs ?? 30_000;
    this.refusedBackoffMs = options.refusedBackoffMs ?? REFUSED_BACKOFF_MS;
    this.now = options.now ?? (() => new Date());
    this.stateDir = mkdtempSync(join(tmpdir(), "strad-tailnet-"));
    this.socket = join(this.stateDir, "tailscaled.sock");
    this.current = {
      state: "starting",
      since: this.now().toISOString(),
      restarts: 0,
    };
  }

  state(): TailnetState {
    return this.current;
  }

  private set(
    next: { state: "starting" | "up" } | { state: "down"; reason: string },
  ): void {
    this.current = {
      ...next,
      since: this.now().toISOString(),
      restarts: this.restarts,
    } as TailnetState;
  }

  start(): void {
    if (this.stopping) return;
    this.set({ state: "starting" });
    log(
      `tailnet: starting userspace tailscaled as ${this.config.hostname} ` +
        `(${this.config.tags.join(",")}), SOCKS5 on ${SOCKS5_LISTEN}`,
    );
    const daemon = spawn(
      this.bins.tailscaled,
      tailscaledArgs(this.stateDir, this.socket),
      {
        env: this.childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.daemon = daemon;
    this.pipeLines(daemon, "tailscaled");
    daemon.once("error", (err) =>
      this.fail(`tailscaled could not start: ${err.message}`),
    );
    daemon.once("exit", (code, signal) => {
      if (this.daemon !== daemon) return;
      this.daemon = null;
      this.fail(`tailscaled exited (${signal ?? `code ${code}`})`);
    });
    void this.join(daemon);
  }

  /** `tailscale up`, retried while tailscaled is still opening its socket. */
  private async join(daemon: ChildProcess): Promise<void> {
    for (let attempt = 1; attempt <= 20; attempt++) {
      if (this.stopping || this.daemon !== daemon) return;
      const result = await this.up();
      if (this.stopping || this.daemon !== daemon) return;
      if (result.ok) {
        this.failures = 0;
        this.set({ state: "up" });
        this.watch(daemon);
        log(
          `tailnet: joined as ${this.config.hostname}; tailnet hosts are reachable through ${SOCKS5_LISTEN}`,
        );
        return;
      }
      // The daemon answers its socket a moment after it starts; anything else
      // is a real refusal (a revoked or expired key, a tag the key may not
      // assign) and retrying it fast only spends the key's mint budget.
      if (
        !/failed to connect to local tailscaled|tailscaled\.sock/i.test(
          result.output,
        )
      ) {
        // A refusal by the control plane — revoked or expired key, a tag the
        // client may not mint — will not fix itself in a minute, and every
        // retry spends a mint. Wait long.
        this.fail(
          `tailscale up failed: ${result.output || "no output"}`,
          this.refusedBackoffMs,
        );
        daemon.kill("SIGTERM");
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.fail("tailscaled never opened its socket");
    daemon.kill("SIGTERM");
  }

  private up(): Promise<{ ok: boolean; output: string }> {
    const keyDir = mkdtempSync(join(this.stateDir, "key-"));
    const keyFile = join(keyDir, "authkey");
    writeFileSync(keyFile, authKeyForUp(this.config.authKey), { mode: 0o600 });
    return new Promise((resolve) => {
      const child = spawn(
        this.bins.tailscale,
        upArgs(this.config, keyFile, this.socket),
        {
          env: this.childEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      const take = (d: Buffer) => {
        if (output.length < 2000) output += d.toString();
      };
      child.stdout?.on("data", take);
      child.stderr?.on("data", take);
      let settled = false;
      const done = (ok: boolean, extra = "") => {
        if (settled) return;
        settled = true;
        rmSync(keyDir, { recursive: true, force: true });
        resolve({
          ok,
          output: redactTailnet(
            (output + extra).trim(),
            this.config.authKey,
          ).slice(0, 500),
        });
      };
      child.once("error", (err) => done(false, err.message));
      // `close`, not `exit`: `exit` can fire before the last of stderr is
      // read, and the output is what tells a slow socket from a refusal.
      child.once("close", (code) => done(code === 0));
    });
  }

  /**
   * While joined, ask tailscaled every `statusEveryMs` whether it still is. A
   * node removed or logged out by the control plane keeps a live daemon, so
   * the exit handler never sees it; this is what turns `/healthz` to `down`.
   * Reported only — never re-joined (see the module comment).
   */
  private watch(daemon: ChildProcess): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = setInterval(() => {
      if (this.stopping || this.daemon !== daemon) {
        if (this.statusTimer) clearInterval(this.statusTimer);
        this.statusTimer = null;
        return;
      }
      void this.backendState().then((backend) => {
        if (this.stopping || this.daemon !== daemon) return;
        if (backend === "Running") {
          if (this.current.state !== "up") {
            this.set({ state: "up" });
            log(`tailnet: backend is Running again`);
          }
        } else if (this.current.state === "up") {
          const reason = `tailnet backend is ${backend ?? "not answering"} (removed or logged out in the admin console, or its key expired)`;
          this.set({ state: "down", reason });
          logWarn(`tailnet: ${reason}; not re-joining`);
        }
      });
    }, this.statusEveryMs);
    this.statusTimer.unref();
  }

  private backendState(): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(
        this.bins.tailscale,
        [`--socket=${this.socket}`, "status", "--json"],
        {
          env: this.childEnv(),
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let out = "";
      child.stdout?.on("data", (d: Buffer) => {
        if (out.length < 1_000_000) out += d.toString();
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      timer.unref();
      child.once("error", () => resolve(null));
      child.once("close", () => {
        clearTimeout(timer);
        try {
          const state = (JSON.parse(out) as { BackendState?: unknown })
            .BackendState;
          resolve(typeof state === "string" ? state : null);
        } catch {
          resolve(null);
        }
      });
    });
  }

  private fail(reason: string, minDelayMs = 0): void {
    if (this.stopping) return;
    const clean = redactTailnet(reason, this.config.authKey);
    if (this.retryTimer) {
      this.set({ state: "down", reason: clean });
      return;
    }
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.restarts++;
    this.failures++;
    this.set({ state: "down", reason: clean });
    const delay = Math.max(minDelayMs, this.backoff(this.failures));
    logWarn(
      `tailnet: ${clean}; restarting in ${Math.round(delay / 1000)}s (restart ${this.restarts})`,
    );
    if (this.daemon) {
      const d = this.daemon;
      this.daemon = null;
      d.kill("SIGTERM");
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start();
    }, delay);
    this.retryTimer.unref();
  }

  /**
   * Leave the tailnet and stop. `logout` deletes an ephemeral node at once,
   * rather than when the control plane notices it has gone quiet. Bounded,
   * because App Platform does not wait long after SIGTERM.
   */
  async stop(timeoutMs = 3_000): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    const daemon = this.daemon;
    this.daemon = null;
    if (daemon && this.current.state === "up") {
      await new Promise<void>((resolve) => {
        const child = spawn(
          this.bins.tailscale,
          [`--socket=${this.socket}`, "logout"],
          {
            env: this.childEnv(),
            stdio: "ignore",
          },
        );
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, timeoutMs);
        timer.unref();
        child.once("error", () => resolve());
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    daemon?.kill("SIGTERM");
    rmSync(this.stateDir, { recursive: true, force: true });
  }

  /** Enough to run, and nothing a mount was given. */
  private childEnv(): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, HOME: this.stateDir };
  }

  private pipeLines(child: ChildProcess, name: string): void {
    const forward = (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim())
          log(`[${name}] ${redactTailnet(line, this.config.authKey)}`);
      }
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
  }
}

/**
 * Boot: take the configuration out of the environment and, when there is one,
 * start the sidecar and tell the ssh tree where its listener is. Returns null
 * — and starts nothing — on every component that was not rendered with
 * `tailnet:`.
 */
export function startTailnet(
  env: NodeJS.ProcessEnv = process.env,
  options: SidecarOptions = {},
): TailnetSidecar | null {
  const config = takeTailnetConfig(env);
  if (!config) return null;
  const sidecar = new TailnetSidecar(config, options);
  env[TAILNET_ENV.socks5] = SOCKS5_LISTEN;
  sidecar.start();
  return sidecar;
}
