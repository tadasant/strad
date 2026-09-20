import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { KillSwitch } from "../src/killswitch.js";
import { TunnelSupervisor } from "../src/tunnel.js";
import { testConfig, tmpState } from "./helpers.js";

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end)
    await new Promise((r) => setTimeout(r, 25));
  return cond();
};

describe("the supervised tunnel", () => {
  it("runs cloudflared with its OWN config, and the kill switch takes the hostname dark", async () => {
    const dir = tmpState();
    const argsFile = join(dir, "args");
    const pidFile = join(dir, "pid");
    const fake = join(dir, "cloudflared");
    writeFileSync(
      fake,
      `#!/bin/sh\necho "$@" > ${argsFile}\necho $$ > ${pidFile}\nexec sleep 60\n`,
    );
    chmodSync(fake, 0o755);

    const killSwitch = new KillSwitch(dir);
    const sup = new TunnelSupervisor(
      testConfig({
        tunnel: { enabled: true, binary: fake, configPath: "/x/hostd.yml" },
      }),
      killSwitch,
    );
    sup.start();
    expect(await until(() => existsSync(pidFile))).toBe(true);
    expect(readFileSync(argsFile, "utf8").trim()).toBe(
      "--no-autoupdate --config /x/hostd.yml tunnel run",
    );
    expect(sup.state).toBe("running");
    const pid = Number(readFileSync(pidFile, "utf8"));

    killSwitch.disable();
    sup.reconcile();
    expect(sup.state).toBe("stopped-by-kill-switch");
    expect(
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);

    killSwitch.enable();
    writeFileSync(pidFile, "");
    await until(() => (sup.reconcile(), sup.state === "running"));
    expect(sup.state).toBe("running");
    sup.stop();
  });

  it("says so when cloudflared is not installed, and does not spin", async () => {
    const lines: string[] = [];
    const sup = new TunnelSupervisor(
      testConfig({
        tunnel: {
          enabled: true,
          binary: "/nonexistent/cloudflared",
          configPath: "/x.yml",
        },
      }),
      new KillSwitch(tmpState()),
      (l) => lines.push(l),
    );
    sup.start();
    expect(await until(() => sup.state === "missing-binary")).toBe(true);
    expect(lines.join("\n")).toMatch(/brew install cloudflared/);
    sup.stop();
  });

  it("is off unless configured", () => {
    const sup = new TunnelSupervisor(testConfig(), new KillSwitch(tmpState()));
    sup.start();
    expect(sup.state).toBe("off");
  });
});
