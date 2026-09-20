import { spawn, type ChildProcess } from "node:child_process";

import type { Config } from "./config.js";
import type { KillSwitch } from "./killswitch.js";

export type TunnelState =
  | "off"
  | "running"
  | "stopped-by-kill-switch"
  | "restarting"
  | "missing-binary";

/**
 * `cloudflared`, supervised as a child — which is what makes this "turn it on
 * and forget it": ONE LaunchAgent starts the daemon and the daemon starts the
 * tunnel, so there is no second job to install, no ordering between the two, and
 * no tunnel left serving a hostname whose daemon has died.
 *
 * It is a tunnel of its OWN, with its own config file, not another `ingress:`
 * line in the machine's `~/.cloudflared/config.yml`. launchd runs one
 * `com.cloudflare.cloudflared` job per machine, and a kill switch that stopped
 * THAT would take every other tunnelled server on the machine down with it. With
 * its own process, disabling remote control makes this hostname go dark — strad
 * reports the slug `offline` — and leaves the rest alone.
 */
export class TunnelSupervisor {
  private child?: ChildProcess;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;
  state: TunnelState = "off";

  constructor(
    private readonly config: Config,
    private readonly killSwitch: KillSwitch,
    private readonly log: (line: string) => void = () => {},
  ) {}

  start(): void {
    if (!this.config.tunnel.enabled) return;
    this.reconcile();
    // The switch is a file anyone may touch; follow it.
    this.poll = setInterval(() => this.reconcile(), 2000);
    this.poll.unref();
  }

  /** Bring the child into line with the kill switch. */
  reconcile(): void {
    if (this.stopping || !this.config.tunnel.enabled) return;
    if (this.killSwitch.isDisabled()) {
      if (this.child) {
        this.log("kill switch is on: stopping the tunnel");
        this.child.kill("SIGTERM");
      }
      clearTimeout(this.timer);
      this.timer = undefined;
      this.state = "stopped-by-kill-switch";
      return;
    }
    if (!this.child && !this.timer && this.state !== "missing-binary")
      this.spawn();
  }

  private spawn(): void {
    const { binary, configPath } = this.config.tunnel;
    const child = spawn(
      binary,
      ["--no-autoupdate", "--config", configPath!, "tunnel", "run"],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    this.child = child;
    this.state = "running";
    child.stderr?.on("data", (d: Buffer) =>
      this.log(d.toString("utf8").trimEnd()),
    );
    child.on("error", (err: NodeJS.ErrnoException) => {
      this.child = undefined;
      if (err.code === "ENOENT") {
        this.state = "missing-binary";
        this.log(
          `cloudflared not found at "${binary}" — install it (brew install cloudflared) or set tunnel.binary`,
        );
      }
    });
    child.on("exit", (code) => {
      this.child = undefined;
      if (
        this.stopping ||
        this.state === "missing-binary" ||
        this.killSwitch.isDisabled()
      )
        return;
      this.state = "restarting";
      this.log(`cloudflared exited (${code}); restarting in 5s`);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.reconcile();
      }, 5000);
      this.timer.unref();
    });
  }

  stop(): void {
    this.stopping = true;
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.child?.kill("SIGTERM");
    this.state = "off";
  }
}
