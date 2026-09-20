import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";

import { GrantStore } from "../src/consent/grants.js";
import { clip, HeadTailBuffer } from "../src/shell/output.js";
import { ProcessManager } from "../src/shell/processes.js";
import { testConfig } from "./helpers.js";

const grants = new GrantStore({ idleMs: 600_000 });
const newGrant = () =>
  grants.create({
    capability: "shell",
    server: "s",
    purpose: "p",
    ttlMs: 600_000,
  });
const pm = new ProcessManager(
  testConfig({
    shell: {
      shell: "/bin/sh",
      defaultCwd: tmpdir(),
      maxConcurrent: 3,
      maxCapturedBytes: 4096,
    },
  }),
);
afterAll(() => pm.closeAll());

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("captured output", () => {
  it("keeps the head and the tail and counts what it dropped", () => {
    const b = new HeadTailBuffer(20);
    b.append("0123456789");
    b.append("abcdefghijklmnopqrstuvwxyz");
    expect(b.toString()).toBe(
      "0123456789\n[… 16 characters dropped by the daemon's capture limit …]\nqrstuvwxyz",
    );
    expect(b.totalChars).toBe(36);
  });

  it("clips a response to a budget from both ends", () => {
    expect(clip("short", 200)).toEqual({ text: "short", truncated: false });
    const c = clip("a".repeat(100) + "b".repeat(100), 20);
    expect(c.truncated).toBe(true);
    expect(c.text.startsWith("aaaaaaaaaa\n[… 180 characters omitted")).toBe(
      true,
    );
    expect(c.text.endsWith("bbbbbbbbbb")).toBe(true);
  });
});

describe("running commands", () => {
  it("captures stdout and stderr, the exit code, and the cwd", async () => {
    const c = pm.start(newGrant(), "echo out; echo err >&2; pwd; exit 2");
    await c.done;
    expect(c.status).toBe("exited");
    expect(c.exitCode).toBe(2);
    expect(c.output.toString()).toContain("out\n");
    expect(c.output.toString()).toContain("err\n");
    expect(c.cwd).toBe(tmpdir());
  });

  it("gives a command no stdin, so a prompt fails instead of hanging", async () => {
    const c = pm.start(newGrant(), 'read answer; echo "got:[$answer]"');
    await pm.wait(c, 5000);
    expect(c.status).toBe("exited");
    expect(c.output.toString()).toContain("got:[]");
  });

  it("keeps the daemon's own variables out of a command's environment", async () => {
    process.env.STRAD_HOSTD_SECRET_THING = "leak";
    const c = pm.start(newGrant(), "env | grep -c STRAD_HOSTD_ || true");
    await c.done;
    delete process.env.STRAD_HOSTD_SECRET_THING;
    expect(c.output.toString().trim()).toBe("0");
  });

  it("refuses a cwd that is not a directory", () => {
    expect(() => pm.start(newGrant(), "true", "/definitely/not/here")).toThrow(
      /not a directory/,
    );
  });

  it("returns from a wait while the command keeps running, then bounds its output", async () => {
    const c = pm.start(newGrant(), "yes 0123456789 | head -c 100000; sleep 30");
    await pm.wait(c, 400);
    expect(c.status).toBe("running");
    expect(c.output.toString().length).toBeLessThan(4300);
    expect(c.output.totalChars).toBe(100000);
    await pm.kill(c);
    expect(c.status).toBe("killed");
  });

  it("kills the whole process group, not just the shell", async () => {
    const c = pm.start(newGrant(), "sleep 60 & sleep 60 & wait");
    await pm.wait(c, 300);
    const children = execSync(`pgrep -g ${c.child!.pid}`)
      .toString()
      .trim()
      .split("\n")
      .map(Number);
    expect(children.length).toBeGreaterThanOrEqual(3);
    await pm.kill(c);
    await new Promise((r) => setTimeout(r, 100));
    expect(children.filter(alive)).toEqual([]);
  });

  it("ends when its SHELL exits, even if a background child still holds the output pipe", async () => {
    // Settling on pipe EOF left this "running" forever: it held a concurrency
    // slot, and kill_command and daemon shutdown both hung awaiting it.
    const marker = `hostd-bg-${process.pid}-${Date.now()}`;
    const c = pm.start(
      newGrant(),
      `sh -c 'exec -a ${marker} sleep 45' & echo started`,
    );
    const started = Date.now();
    await pm.wait(c, 5000);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(c.status).toBe("exited");
    expect(c.exitCode).toBe(0);
    expect(c.output.toString()).toContain("started");
    expect(pm.running()).toEqual([]);
    // The straggler went with the shell: nothing a command started outlives it.
    await new Promise((r) => setTimeout(r, 150));
    expect(
      // `[h]ostd…` cannot match the `sh -c` that carries this pattern.
      execSync(`pgrep -f "[h]${marker.slice(1)}" || true`)
        .toString()
        .trim(),
    ).toBe("");
  });

  it("does not hang kill or shutdown on a command whose pipe is held open", async () => {
    const c = pm.start(newGrant(), "(sleep 45 &) ; sleep 45");
    await pm.wait(c, 300);
    const killed = await Promise.race([
      pm.kill(c).then(() => "killed"),
      new Promise((r) => setTimeout(() => r("hung"), 4000)),
    ]);
    expect(killed).toBe("killed");
    expect(c.status).toBe("killed");
  });

  it("ENDING THE GRANT kills what it started — the owner's kill button", async () => {
    const grant = newGrant();
    const c = pm.start(grant, "sleep 60");
    const pid = c.child!.pid!;
    expect(alive(pid)).toBe(true);
    grants.end(grant.id, "killed");
    await c.done;
    expect(c.status).toBe("killed");
    expect(alive(pid)).toBe(false);
    expect(pm.list(grant.id)).toEqual([]);
  });

  it("shows a grant only its own commands", async () => {
    const mine = newGrant();
    const theirs = newGrant();
    const c = pm.start(theirs, "true");
    await c.done;
    expect(pm.get(mine.id, c.id)).toBeUndefined();
    expect(pm.get(theirs.id, c.id)).toBe(c);
  });

  it("caps concurrency", async () => {
    const g = newGrant();
    const started = [
      pm.start(g, "sleep 30"),
      pm.start(g, "sleep 30"),
      pm.start(g, "sleep 30"),
    ];
    expect(() => pm.start(g, "sleep 30")).toThrow(/already running/);
    await Promise.all(started.map((c) => pm.kill(c)));
  });
});
