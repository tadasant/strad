import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * install/install.sh and install/launchd.sh against a stand-in for launchd.
 *
 * The real launchd is `install/launchd-smoke.sh`, on the macOS runner in
 * `.github/workflows/hostd-ax.yml`. What this pins is the installer's own
 * decisions: which of the three paths a service takes, that nothing unloads the
 * daemon without something that will load it again, and what a failure reports.
 * Everything Mac-only is a stub on PATH, so the real script runs from a copy.
 */
// Every launchctl here is a Node start, and a re-run makes dozens of them.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const INSTALL = resolve(dirname(fileURLToPath(import.meta.url)), "../install");
const DAEMON = "com.strad.hostd";
const AX = "com.strad.hostd-ax";
const MESSAGES = "com.strad.hostd-messages";

/**
 * launchctl, with launchd's state as files in $FAKE_DIR. `teardown/<label>` is a
 * bootout still in progress: the service prints as loaded and a bootstrap fails
 * 5 until that many `print`s have passed, which is the race itself.
 */
const FAKE_LAUNCHCTL = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), { spawn } = require("child_process");
const dir = process.env.FAKE_DIR, args = process.argv.slice(2);
const file = (...p) => path.join(dir, ...p);
fs.appendFileSync(file("calls.log"), args.join(" ") + "\\n");
const label = (t) => t.split("/").pop();
const read = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };
const takeOne = (p) => {
  const n = Number(read(p) || 0);
  if (n > 0) fs.writeFileSync(p, String(n - 1));
  return n > 0;
};
const killInstaller = () => {
  const pgid = Number(read(file("installer.pgid")));
  if (pgid) try { process.kill(-pgid, "SIGKILL"); } catch {}
};
const bumpPid = (l) => fs.writeFileSync(file("pid", l), String(Number(read(file("pid", l)) || 100) + 1));
const finishTeardown = (l) => {
  fs.rmSync(file("teardown", l), { force: true });
  fs.rmSync(file("loaded", l), { force: true });
};
switch (args[0]) {
  case "print": {
    const l = label(args[1]);
    if (fs.existsSync(file("teardown", l)) && !takeOne(file("teardown", l))) finishTeardown(l);
    if (!fs.existsSync(file("loaded", l))) {
      console.error("Could not find service");
      process.exit(113);
    }
    console.log(l + " = {\\n\\tstate = running\\n\\tpid = " + (read(file("pid", l)) || "100") + "\\n}");
    break;
  }
  case "bootout": {
    const l = label(args[1]);
    if (l === read(file("kill-installer-on"))) killInstaller();
    if (!fs.existsSync(file("loaded", l))) process.exit(3);
    const prints = Number(read(file("teardown-prints")) || 0);
    if (prints > 0) {
      fs.writeFileSync(file("teardown", l), String(prints));
      process.exit(36);
    }
    finishTeardown(l);
    break;
  }
  case "bootstrap": {
    const text = fs.readFileSync(args[2], "utf8");
    const l = /<key>Label<\\/key><string>([^<]+)/.exec(text)[1];
    if (fs.existsSync(file("teardown", l)) || takeOne(file("bootstrap-fail", l))) {
      console.error("Bootstrap failed: 5: Input/output error");
      process.exit(5);
    }
    if (fs.existsSync(file("loaded", l))) process.exit(37);
    fs.writeFileSync(file("loaded", l), "");
    bumpPid(l);
    const program = /<key>ProgramArguments<\\/key>\\s*<array>([\\s\\S]*?)<\\/array>/.exec(text)[1];
    const argv = [...program.matchAll(/<string>([^<]*)/g)].map((m) => m[1]);
    if (argv.includes("reload")) {
      // A launchd job: no child of this process, and in no group of the caller's.
      const log = /<key>StandardOutPath<\\/key><string>([^<]+)/.exec(text)[1];
      const out = fs.openSync(log, "a");
      const job = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["ignore", out, out] });
      // Its own process group, so stopJobs() in the test can end the whole job.
      fs.appendFileSync(file("jobs"), job.pid + "\\n");
      job.unref();
    }
    break;
  }
  case "kickstart":
    if (label(args[2]) === read(file("kill-installer-on"))) killInstaller();
    if (takeOne(file("kickstart-fail", label(args[2])))) process.exit(150);
    bumpPid(label(args[2]));
    break;
  case "managername": console.log("Aqua"); break;
  case "print-disabled": console.log('\\t"' + read(file("disabled")) + '" => disabled'); break;
  case "error": console.log("Input/output error"); break;
  default: process.exit(64);
}
`;

const STUBS: Record<string, string> = {
  launchctl: FAKE_LAUNCHCTL,
  uname: `#!/bin/bash\necho Darwin\n`,
  npm: `#!/bin/bash\nexit 0\n`,
  sleep: `#!/bin/bash\necho "$1" >>"$FAKE_DIR/sleep.log"\n/bin/sleep 0.01\n`,
  swift: `#!/bin/bash
[ "$*" = "build --help" ] && exit 0
name="strad-hostd-$(basename "$PWD")"
[ -e "$FAKE_DIR/swift-fail-$name" ] && exit 1
mkdir -p .build/release
printf '#!/bin/bash\\nexit 0\\n' >".build/release/$name"
chmod +x ".build/release/$name"
`,
  // Serving is the app directory holding no "broken" marker, so a rollback heals it.
  curl: `#!/bin/bash\n[ ! -e "$STRAD_HOSTD_HOME/app/broken" ]\n`,
};

let root: string;
let fake: string;
let here: string;
let home: string;
let state: string;
let bin: string;

const env = () => ({
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  HOME: home,
  FAKE_DIR: fake,
  STRAD_HOSTD_HOME: state,
});

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const plist = (label: string) =>
  join(home, "Library/LaunchAgents", `${label}.plist`);
const calls = () =>
  readFileSync(join(fake, "calls.log"), "utf8").trim().split("\n");
const mutating = () =>
  calls().filter((c) => /^(bootout|bootstrap|kickstart)/.test(c));
const sleeps = () =>
  existsSync(join(fake, "sleep.log"))
    ? readFileSync(join(fake, "sleep.log"), "utf8").trim().split("\n")
    : [];
const loaded = (label: string) => existsSync(join(fake, "loaded", label));
const resetCalls = () => {
  writeFileSync(join(fake, "calls.log"), "");
  writeFileSync(join(fake, "sleep.log"), "");
};

function run(
  args: string[],
  command = "install/install.sh",
): Promise<{ code: number | null; signal: string | null; output: string }> {
  return new Promise((done) => {
    const child = spawn("bash", [join(here, command), ...args], {
      cwd: here,
      env: env(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(join(fake, "installer.pgid"), String(child.pid));
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code, signal) => done({ code, signal, output }));
  });
}

function sourced(script: string) {
  return new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn(
      "bash",
      ["-c", `. "${here}/install/launchd.sh"; ${script}`],
      { env: env(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => done({ code, output }));
  });
}

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!check() && Date.now() - start < ms)
    await new Promise((r) => setTimeout(r, 20));
  return check();
}

const SIGN = ["--sign-identity", "strad-hostd-ax"];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "hostd-install-"));
  fake = join(root, "launchd");
  here = join(root, "hostd");
  home = join(root, "home");
  state = join(home, ".strad-hostd");
  bin = join(root, "bin");
  for (const d of [
    join(fake, "loaded"),
    join(fake, "teardown"),
    join(fake, "bootstrap-fail"),
    join(fake, "kickstart-fail"),
    join(fake, "pid"),
    join(here, "install"),
    join(here, "ax"),
    join(here, "messages"),
    join(here, "extension"),
    bin,
    state,
  ])
    mkdirSync(d, { recursive: true });
  for (const f of readdirSync(INSTALL))
    copyFileSync(join(INSTALL, f), join(here, "install", f));
  for (const [name, text] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  // The real signing script needs a keychain. This one records what it is asked.
  writeFileSync(
    join(here, "install/sign-helper.sh"),
    `#!/bin/bash\n[ -e "$FAKE_DIR/sign-fail" ] && exit 1\nshift\necho "$*" >>"$FAKE_DIR/sign.log"\n`,
  );
  write(join(here, "build/cli.js"), "process.exit(0);\n");
  write(join(here, "package.json"), "{}\n");
  write(join(here, "package-lock.json"), "{}\n");
  write(join(state, "config.json"), "{}\n");
  writeFileSync(join(fake, "calls.log"), "");
  // The machine the failed rollout left behind starts from a first install.
  const first = await run(SIGN);
  expect(first.output).toContain("Running. Status page");
  expect(first.code).toBe(0);
  resetCalls();
});

/**
 * A one-shot the fake launchd started outlives the launchctl that started it
 * and, like a real one, the installer too: a helper whose bootstrap launchd keeps
 * refusing leaves one making its own pass of retries, writing calls.log,
 * sleep.log, its reload log and its result file into this test's tree until it
 * finishes. So the test ends it, and waits for the group to be gone before
 * deleting that tree.
 */
async function stopJobs() {
  const jobs = join(fake, "jobs");
  if (!existsSync(jobs)) return;
  const groups = readFileSync(jobs, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(Number);
  // A group that has exited may have handed its pgid on. Where /proc exists,
  // only a group whose leader still carries this test's FAKE_DIR is signalled.
  const ours = (pgid: number) => {
    if (!existsSync("/proc")) return true;
    try {
      return readFileSync(`/proc/${pgid}/environ`, "utf8")
        .split("\0")
        .includes(`FAKE_DIR=${fake}`);
    } catch {
      return false;
    }
  };
  const alive = (pgid: number) => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const mine = groups.filter(ours);
  for (const pgid of mine)
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  await until(() => !mine.some(alive), 5_000);
}

afterEach(async () => {
  await stopJobs();
  // The wait above is bounded, not exact. If a group outlives it, the retries
  // give its last write a moment rather than failing on the first ENOTEMPTY.
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

describe("a re-run on a machine that has strad-hostd", () => {
  it("restarts every loaded service in place, unloading nothing, the daemon last", async () => {
    const { code, output } = await run(SIGN);
    expect(code).toBe(0);
    expect(output).not.toContain("error:");
    expect(mutating()).toEqual(
      [AX, MESSAGES, DAEMON].map(
        (l) => `kickstart -k gui/${process.getuid!()}/${l}`,
      ),
    );
  });

  it("keeps the signing identity and each helper's identifier", async () => {
    await run(SIGN);
    expect(
      readFileSync(join(fake, "sign.log"), "utf8").trim().split("\n").slice(-2),
    ).toEqual([
      "--identity strad-hostd-ax",
      `--identity strad-hostd-ax --identifier ${MESSAGES}`,
    ]);
  });

  it("loads a service that is not loaded, as the failed rollout left the helper", async () => {
    rmSync(join(fake, "loaded", AX));
    const { code } = await run(SIGN);
    expect(code).toBe(0);
    expect(mutating()[0]).toBe(
      `bootstrap gui/${process.getuid!()} ${plist(AX)}`,
    );
    expect(loaded(AX)).toBe(true);
  });
});

describe("launchd_bootstrap", () => {
  it("retries a refused bootstrap with backoff", async () => {
    rmSync(join(fake, "loaded", AX));
    writeFileSync(join(fake, "bootstrap-fail", AX), "3");
    const { code, output } = await sourced(
      `launchd_bootstrap ${AX} "${plist(AX)}"`,
    );
    expect(code).toBe(0);
    expect(sleeps()).toEqual(["1", "2", "4"]);
    expect(output).toContain(`launchctl bootstrap ${AX}: exit 5`);
    expect(loaded(AX)).toBe(true);
  });

  it("prints what proves the cause when it gives up", async () => {
    rmSync(join(fake, "loaded", AX));
    writeFileSync(join(fake, "bootstrap-fail", AX), "100");
    writeFileSync(join(fake, "disabled"), AX);
    const { code, output } = await sourced(
      `launchd_bootstrap ${AX} "${plist(AX)}"`,
    );
    expect(code).toBe(1);
    expect(sleeps()).toEqual(["1", "2", "4", "8", "16"]);
    expect(output).toContain(`launchd diagnostics: ${AX}, last exit 5`);
    expect(output).toContain("Input/output error");
    expect(output).toContain("manager of this process: Aqua");
    expect(output).toContain(`"${AX}" => disabled`);
    expect(output).toContain(
      `launchctl print gui/${process.getuid!()}/${AX}: exit 113`,
    );
    expect(output).toContain(plist(AX));
  });
});

describe("launchd_bootout", () => {
  it("waits for a slow teardown to finish", async () => {
    writeFileSync(join(fake, "teardown-prints"), "4");
    const { code, output } = await sourced(`launchd_bootout ${AX}`);
    expect(code).toBe(0);
    expect(output).toContain(`launchctl bootout ${AX}: exit 36`);
    expect(loaded(AX)).toBe(false);
    expect(sleeps()).toEqual(["1", "1", "1", "1"]);
  });

  it("gives up at its bound and says so", async () => {
    writeFileSync(join(fake, "teardown-prints"), "1000");
    const { code, output } = await sourced(`launchd_bootout ${AX}`);
    expect(code).toBe(1);
    expect(sleeps()).toHaveLength(30);
    expect(output).toContain("still loaded 30 seconds after bootout");
  });
});

describe("a helper that fails", () => {
  it("still restarts the daemon, then exits non-zero naming the helper", async () => {
    rmSync(join(fake, "loaded", AX));
    writeFileSync(join(fake, "bootstrap-fail", AX), "100");
    const { code, output } = await run(SIGN);
    expect(code).toBe(1);
    expect(mutating()).toContain(
      `kickstart -k gui/${process.getuid!()}/${DAEMON}`,
    );
    expect(mutating()).toContain(
      `kickstart -k gui/${process.getuid!()}/${MESSAGES}`,
    );
    expect(output).toContain(`launchd diagnostics: ${AX}`);
    expect(output.slice(output.lastIndexOf("did not finish"))).toContain(AX);
  });

  it("reports before the daemon restart, which may be the last thing it does", async () => {
    rmSync(join(fake, "loaded", AX));
    writeFileSync(join(fake, "bootstrap-fail", AX), "100");
    const { output } = await run(SIGN);
    expect(output.indexOf("Failed so far")).toBeGreaterThan(-1);
    expect(output.indexOf("Failed so far")).toBeLessThan(
      output.indexOf(`Installing the LaunchAgent ${DAEMON}\n`),
    );
  });

  it.each([
    ["a build", "swift-fail-strad-hostd-ax"],
    ["signing", "sign-fail"],
  ])("does not let %s stop the daemon step", async (_what, marker) => {
    writeFileSync(join(fake, marker), "");
    const { code, output } = await run(SIGN);
    expect(code).toBe(1);
    expect(mutating()).toContain(
      `kickstart -k gui/${process.getuid!()}/${DAEMON}`,
    );
    expect(output).toContain(`${AX} was not installed`);
  });
});

describe("a loaded service whose plist changed", () => {
  const changeDaemonPlist = () =>
    writeFileSync(plist(DAEMON), readFileSync(plist(DAEMON), "utf8") + "\n");

  it("is replaced by the one-shot, which waits out the teardown", async () => {
    changeDaemonPlist();
    writeFileSync(join(fake, "teardown-prints"), "3");
    const { code, output } = await run(SIGN);
    expect(code).toBe(0);
    const m = mutating();
    const reload = `${DAEMON}.reload`;
    expect(
      m.indexOf(`bootout gui/${process.getuid!()}/${DAEMON}`),
    ).toBeGreaterThan(m.findIndex((c) => c.endsWith(`${reload}.plist`)));
    expect(m.at(-1)).toBe(`bootout gui/${process.getuid!()}/${reload}`);
    expect(loaded(DAEMON)).toBe(true);
    expect(loaded(reload)).toBe(false);
    expect(output).toContain(`launchctl bootout ${DAEMON}: exit 36`);
    expect(readFileSync(plist(DAEMON), "utf8").endsWith("</plist>\n")).toBe(
      true,
    );
    expect(readFileSync(plist(DAEMON), "utf8").endsWith("\n\n")).toBe(false);
  });

  it("is left running and untouched when the one-shot cannot load", async () => {
    changeDaemonPlist();
    writeFileSync(join(fake, "bootstrap-fail", `${DAEMON}.reload`), "100");
    const { code, output } = await run(SIGN);
    expect(code).toBe(1);
    expect(mutating()).not.toContain(
      `bootout gui/${process.getuid!()}/${DAEMON}`,
    );
    expect(loaded(DAEMON)).toBe(true);
    expect(output).toContain(
      `${DAEMON} was left loaded, running what it last started`,
    );
    expect(output).toContain(`launchd diagnostics: ${DAEMON}.reload`);
    expect(output.slice(output.lastIndexOf("did not finish"))).toContain(
      `${DAEMON} is not confirmed running the new build`,
    );
  });

  it("comes back when the installer dies with the daemon it restarted", async () => {
    changeDaemonPlist();
    // What a run_command that never left the daemon's process group gets.
    writeFileSync(join(fake, "kill-installer-on"), DAEMON);
    const { signal, output } = await run(SIGN);
    expect(signal).toBe("SIGKILL");
    expect(output).not.toContain("Running. Status page");
    const result = join(state, "reload", `${DAEMON}.result`);
    expect(
      await until(
        () => existsSync(result) && readFileSync(result, "utf8") === "ok\n",
      ),
    ).toBe(true);
    expect(loaded(DAEMON)).toBe(true);
    expect(readFileSync(plist(DAEMON), "utf8").endsWith("</plist>\n")).toBe(
      true,
    );
  });

  it("keeps the one-shot's work when launchd re-runs it after a failure", async () => {
    changeDaemonPlist();
    const dir = join(state, "reload");
    write(join(dir, `${DAEMON}.plist`), readFileSync(plist(DAEMON), "utf8"));
    writeFileSync(join(fake, "bootstrap-fail", DAEMON), "12");
    const once = () =>
      run(["reload", DAEMON, plist(DAEMON), dir], "install/launchd.sh");
    expect((await once()).code).toBe(1);
    expect(loaded(DAEMON)).toBe(false);
    expect(readFileSync(join(dir, `${DAEMON}.result`), "utf8")).toBe(
      "failed\n",
    );
    expect((await once()).code).toBe(0);
    expect(loaded(DAEMON)).toBe(true);
    expect(calls().filter((c) => c.startsWith("bootout"))).toHaveLength(1);
    expect(readFileSync(join(dir, `${DAEMON}.result`), "utf8")).toBe("ok\n");
  });
});

describe("the daemon restart", () => {
  it("leaves the service loaded when the installer dies on it", async () => {
    writeFileSync(join(fake, "kill-installer-on"), DAEMON);
    const { signal } = await run(SIGN);
    expect(signal).toBe("SIGKILL");
    expect(loaded(DAEMON)).toBe(true);
    expect(mutating()).not.toContain(
      `bootout gui/${process.getuid!()}/${DAEMON}`,
    );
  });

  it("reports a kickstart launchd refused, and leaves it loaded", async () => {
    writeFileSync(join(fake, "kickstart-fail", DAEMON), "1");
    const { code, output } = await run(SIGN);
    expect(code).toBe(1);
    expect(loaded(DAEMON)).toBe(true);
    expect(output).toContain(`launchctl kickstart ${DAEMON}: exit 150`);
    expect(output).toContain(`launchd diagnostics: ${DAEMON}, last exit 150`);
  });

  it("rolls back to the previous build when the new one does not serve", async () => {
    write(join(here, "build/broken"), "");
    // The stub looks at the top of the app directory; the marker ships in it.
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/bash\n[ ! -e "$STRAD_HOSTD_HOME/app/build/broken" ]\n`,
    );
    const { code, output } = await run(SIGN);
    expect(code).toBe(1);
    expect(output).toContain("Rolling back to the previous build");
    expect(mutating().filter((c) => c.endsWith(`/${DAEMON}`))).toHaveLength(2);
    expect(existsSync(join(state, "app/build/broken"))).toBe(false);
    expect(existsSync(join(state, "app.failed/build/broken"))).toBe(true);
    expect(output.slice(output.lastIndexOf("did not finish"))).toContain(
      "was rolled back",
    );
  });

  it("says so when there is nothing to roll back to", async () => {
    rmSync(join(state, "app"), { recursive: true });
    writeFileSync(join(bin, "curl"), `#!/bin/bash\nexit 7\n`);
    const { code, output } = await run(SIGN);
    expect(code).toBe(1);
    expect(output).toContain("no previous build to roll back to");
  });
});

describe("what must hold across runs", () => {
  const change = (label: string) =>
    writeFileSync(plist(label), readFileSync(plist(label), "utf8") + "\n");
  const reloadDir = () => join(state, "reload");

  it("stops before the swap when the new build cannot load", async () => {
    writeFileSync(join(here, "build/cli.js"), "process.exit(3);\n");
    write(join(state, "app/kept"), "");
    const { code, output } = await run(SIGN);
    expect(code).toBe(1);
    expect(output).toContain("the new build does not load");
    expect(existsSync(join(state, "app/kept"))).toBe(true);
    expect(mutating()).toEqual([]);
  });

  it("never lets a build that did not serve replace the previous one", async () => {
    // The run before this one was killed by its own restart.
    rmSync(join(state, "app/.served"));
    write(join(state, "app.previous/good"), "");
    const { code } = await run(SIGN);
    expect(code).toBe(0);
    expect(existsSync(join(state, "app.previous/good"))).toBe(true);
    expect(existsSync(join(state, "app/.served"))).toBe(true);
  });

  it("does not take the old daemon's answer for the new one", async () => {
    // launchd never moves to a new pid: the only process answering is the old.
    writeFileSync(
      join(bin, "launchctl"),
      readFileSync(join(bin, "launchctl"), "utf8").replace(
        "bumpPid(label(args[2]));",
        "",
      ),
    );
    const { code, output } = await run(SIGN);
    expect(code).toBe(1);
    expect(output).toContain("the daemon is not answering");
  });

  it("refuses to unload a disabled service", async () => {
    change(DAEMON);
    writeFileSync(join(fake, "disabled"), DAEMON);
    const { code, output } = await run(SIGN);
    expect(code).toBe(1);
    expect(output).toContain(`${DAEMON} is disabled`);
    expect(mutating().filter((c) => c.startsWith("bootout"))).toEqual([]);
    expect(loaded(DAEMON)).toBe(true);
  });

  it("refuses a plist that does not lint", async () => {
    change(DAEMON);
    writeFileSync(join(bin, "plutil"), `#!/bin/bash\nexit 1\n`);
    chmodSync(join(bin, "plutil"), 0o755);
    const { code, output } = await run(SIGN);
    expect(code).toBe(1);
    expect(output).toContain(`the rendered plist for ${DAEMON} does not lint`);
    expect(mutating().filter((c) => c.startsWith("bootout"))).toEqual([]);
  });

  it("puts the old plist back when launchd refuses the new one", async () => {
    const dir = reloadDir();
    const before = readFileSync(plist(DAEMON), "utf8");
    write(join(dir, `${DAEMON}.plist`), before + "<!-- new -->\n");
    writeFileSync(join(fake, "bootstrap-fail", DAEMON), "6");
    const { code } = await run(
      ["reload", DAEMON, plist(DAEMON), dir],
      "install/launchd.sh",
    );
    expect(code).toBe(0);
    expect(readFileSync(join(dir, `${DAEMON}.result`), "utf8")).toBe(
      "restored\n",
    );
    expect(readFileSync(plist(DAEMON), "utf8")).toBe(before);
    expect(loaded(DAEMON)).toBe(true);
  });

  it("leaves a retrier behind when a service will not load", async () => {
    rmSync(join(fake, "loaded", AX));
    writeFileSync(join(fake, "bootstrap-fail", AX), "100");
    const { output } = await run(SIGN);
    expect(loaded(`${AX}.reload`)).toBe(true);
    expect(output).toContain(`${AX} is not loaded; launchd keeps retrying`);
  });

  it("stops a retrying one-shot before rendering over it", async () => {
    writeFileSync(join(fake, "loaded", `${AX}.reload`), "");
    const { code } = await run(SIGN);
    expect(code).toBe(0);
    const m = mutating();
    expect(m[0]).toBe(`bootout gui/${process.getuid!()}/${AX}.reload`);
  });

  it("runs one install at a time, and reclaims a dead run's lock", async () => {
    write(join(state, "install.lock/pid"), String(process.pid));
    const refused = await run(SIGN);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("another install is running");
    writeFileSync(join(state, "install.lock/pid"), "4000000");
    expect((await run(SIGN)).code).toBe(0);
    expect(existsSync(join(state, "install.lock"))).toBe(false);
  });

  it("does not let a tunnel failure stop the daemon step", async () => {
    writeFileSync(join(bin, "cloudflared"), `#!/bin/bash\nexit 1\n`);
    chmodSync(join(bin, "cloudflared"), 0o755);
    write(join(home, ".cloudflared/cert.pem"), "");
    const { code, output } = await run([
      ...SIGN,
      "--hostname",
      "h.example.com",
    ]);
    expect(code).toBe(1);
    expect(mutating()).toContain(
      `kickstart -k gui/${process.getuid!()}/${DAEMON}`,
    );
    expect(output.slice(output.lastIndexOf("did not finish"))).toContain(
      "tunnel for h.example.com",
    );
  });

  it("signs with no identity when it is given none", async () => {
    expect((await run([])).code).toBe(0);
    expect(
      readFileSync(join(fake, "sign.log"), "utf8").trim().split("\n").slice(-2),
    ).toEqual(["", `--identifier ${MESSAGES}`]);
  });
});

describe("uninstall.sh", () => {
  it("stops a one-shot before the service it would load back", async () => {
    writeFileSync(join(fake, "loaded", `${DAEMON}.reload`), "");
    const { code } = await run([], "install/uninstall.sh");
    expect(code).toBe(0);
    const out = calls().filter((c) => c.startsWith("bootout"));
    expect(
      out.indexOf(`bootout gui/${process.getuid!()}/${DAEMON}.reload`),
    ).toBe(0);
    expect(existsSync(join(state, "reload"))).toBe(false);
    expect(existsSync(join(state, "app.previous"))).toBe(false);
  });
});
