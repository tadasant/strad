import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The full disable: a FILE, because a file is the one switch every door can
 * throw. The status page writes it, `strad-hostd disable` writes it, and
 * `touch ~/.strad-hostd/DISABLED` works from a terminal with the daemon hung.
 * It survives a restart, which a flag in memory would not — a machine its owner
 * turned off stays off across a reboot.
 *
 * It is read on every request rather than cached: one `stat` is cheaper than an
 * argument about staleness on the path that decides whether a remote shell runs.
 */
export class KillSwitch {
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, "DISABLED");
  }

  get path(): string {
    return this.file;
  }

  isDisabled(): boolean {
    return existsSync(this.file);
  }

  disable(reason = "disabled by owner"): void {
    writeFileSync(this.file, `${new Date().toISOString()} ${reason}\n`, {
      mode: 0o600,
    });
  }

  enable(): void {
    rmSync(this.file, { force: true });
  }
}
