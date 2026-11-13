import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SOCKS5_LISTEN,
  TAILNET_ENV,
  TailnetSidecar,
  authKeyForUp,
  redactTailnet,
  startTailnet,
  tailscaledArgs,
  takeTailnetConfig,
  upArgs,
} from "../src/tailnet.js";

/**
 * The tailnet sidecar. The real `tailscaled` cannot run in CI (it would join
 * a real tailnet), so the supervision is driven against two shell scripts that
 * stand in for `tailscaled` and `tailscale` and record how they were called.
 * What these tests pin is strad's half: the key never reaches the environment
 * a mount reads, never reaches a command line, and a failure restarts the
 * sidecar without taking anything else down.
 */

const KEY = "tskey-client-kAbCdEf123CNTRL-SECRETsecretSECRETsecret";

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet() {
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("takeTailnetConfig", () => {
  it("is null, and leaves the environment alone, when the component was not given a key", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    expect(takeTailnetConfig(env)).toBeNull();
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("takes the key OUT of the environment, so no mount built afterwards can read it", () => {
    const env: NodeJS.ProcessEnv = {
      [TAILNET_ENV.authKey]: KEY,
      [TAILNET_ENV.tags]: "tag:strad",
      [TAILNET_ENV.hostname]: "strad-prod-bundle",
    };
    expect(takeTailnetConfig(env)).toEqual({
      authKey: KEY,
      hostname: "strad-prod-bundle",
      tags: ["tag:strad"],
    });
    expect(env).not.toHaveProperty(TAILNET_ENV.authKey);
  });

  it("refuses to join untagged, and still removes the key", () => {
    quiet();
    for (const tags of [undefined, "", "strad", "tag:strad,admin"]) {
      const env: NodeJS.ProcessEnv = {
        [TAILNET_ENV.authKey]: KEY,
        [TAILNET_ENV.tags]: tags,
      };
      expect(takeTailnetConfig(env), String(tags)).toBeNull();
      expect(env).not.toHaveProperty(TAILNET_ENV.authKey);
    }
  });

  it("reads the key from the file boot.sh wrote, and deletes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "boot-key-"));
    const file = join(dir, "authkey");
    writeFileSync(file, KEY, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      [TAILNET_ENV.authKeyFile]: file,
      [TAILNET_ENV.tags]: "tag:strad",
    };
    expect(takeTailnetConfig(env)?.authKey).toBe(KEY);
    expect(existsSync(file)).toBe(false);
    expect(env).not.toHaveProperty(TAILNET_ENV.authKeyFile);
  });

  it("still takes a bare key, and warns that it stays in /proc", () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation(
      (l: string) => void lines.push(l),
    );
    const env: NodeJS.ProcessEnv = {
      [TAILNET_ENV.authKey]: KEY,
      [TAILNET_ENV.tags]: "tag:strad",
    };
    expect(takeTailnetConfig(env)?.authKey).toBe(KEY);
    expect(lines.join("\n")).toContain("/proc");
    expect(lines.join("\n")).not.toContain("SECRET");
  });

  it("drops a proxy address it did not set", () => {
    const env: NodeJS.ProcessEnv = { [TAILNET_ENV.socks5]: "203.0.113.9:1080" };
    takeTailnetConfig(env);
    expect(env).not.toHaveProperty(TAILNET_ENV.socks5);
  });
});

describe("the tailscale command lines", () => {
  it("asks an OAuth client for an ephemeral, pre-authorized node, and passes an ordinary key unchanged", () => {
    expect(authKeyForUp(KEY)).toBe(`${KEY}?ephemeral=true&preauthorized=true`);
    expect(authKeyForUp(`${KEY}?ephemeral=false`)).toBe(
      `${KEY}?ephemeral=false`,
    );
    expect(authKeyForUp("tskey-auth-kXYZ-abc")).toBe("tskey-auth-kXYZ-abc");
  });

  it("runs userspace, in memory, with SOCKS5 on loopback only", () => {
    expect(tailscaledArgs("/s", "/s/sock")).toEqual([
      "--tun=userspace-networking",
      "--state=mem:",
      "--statedir=/s",
      "--socket=/s/sock",
      `--socks5-server=${SOCKS5_LISTEN}`,
    ]);
    expect(SOCKS5_LISTEN.startsWith("127.0.0.1:")).toBe(true);
  });

  it("joins tagged, shields up, without taking the tailnet's DNS or routes, and reads the key from a file", () => {
    const args = upArgs(
      { authKey: KEY, hostname: "strad-prod-bundle", tags: ["tag:strad"] },
      "/k/authkey",
      "/s/sock",
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "up",
        "--auth-key=file:/k/authkey",
        "--advertise-tags=tag:strad",
        "--hostname=strad-prod-bundle",
        "--shields-up",
        "--accept-dns=false",
        "--accept-routes=false",
      ]),
    );
    expect(args.join(" ")).not.toContain("tskey-");
  });

  it("redacts any auth-key-shaped token, and the literal key", () => {
    expect(redactTailnet(`using ${KEY}?ephemeral=true now`)).toBe(
      "using tskey-[redacted] now",
    );
    expect(redactTailnet("key=abcdefgh-literal", "abcdefgh-literal")).toBe(
      "key=[redacted]",
    );
  });
});

/** Two scripts standing in for the binaries. `up` behaviour is chosen per test. */
function fakeBinaries(up: "ok" | "refuse" | "slow-socket") {
  const dir = mkdtempSync(join(tmpdir(), "fake-tailscale-"));
  const record = join(dir, "calls");
  const keyCopy = join(dir, "key-seen");
  const daemon = join(dir, "tailscaled");
  writeFileSync(
    daemon,
    `#!/bin/sh\necho "tailscaled $*" >> ${record}\necho "env AUTHKEY=\${STRAD_TAILNET_AUTHKEY:-unset}" >> ${record}\necho "logtail: started"\ntrap 'exit 0' TERM\nwhile true; do sleep 0.05; done\n`,
  );
  const cli = join(dir, "tailscale");
  const upBody =
    up === "ok"
      ? `cat "\${keyfile}" > ${keyCopy}; exit 0`
      : up === "refuse"
        ? `echo "backend error: invalid key: ${KEY} is expired" >&2; exit 1`
        : `if [ ! -f ${dir}/second ]; then touch ${dir}/second; echo "failed to connect to local tailscaled; it doesn't appear to be running" >&2; exit 1; fi; exit 0`;
  const backend = join(dir, "backend");
  writeFileSync(backend, "Running");
  writeFileSync(
    cli,
    `#!/bin/sh\necho "tailscale $*" >> ${record}\nkeyfile=""\nfor a in "$@"; do case "$a" in --auth-key=file:*) keyfile="\${a#--auth-key=file:}";; esac; done\ncase "$*" in *" up "*) ${upBody};; *logout*) echo logout >> ${record}; exit 0;; *status*) printf '{"BackendState":"%s"}' "$(cat ${backend})"; exit 0;; esac\n`,
  );
  chmodSync(daemon, 0o755);
  chmodSync(cli, 0o755);
  return {
    tailscaled: daemon,
    tailscale: cli,
    calls: () => (existsSync(record) ? readFileSync(record, "utf8") : ""),
    keySeen: () => (existsSync(keyCopy) ? readFileSync(keyCopy, "utf8") : null),
    setBackend: (state: string) => writeFileSync(backend, state),
  };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("TailnetSidecar", () => {
  const config = { authKey: KEY, hostname: "strad-test", tags: ["tag:strad"] };

  it("starts tailscaled, joins with the key from a file, reports up, and logs out on stop", async () => {
    quiet();
    const fake = fakeBinaries("ok");
    const sidecar = new TailnetSidecar(config, fake);
    sidecar.start();
    await until(() => sidecar.state().state === "up");
    expect(fake.keySeen()).toBe(`${KEY}?ephemeral=true&preauthorized=true`);
    // On no command line, and not in tailscaled's environment.
    expect(fake.calls()).not.toContain("tskey-");
    expect(fake.calls()).toContain("env AUTHKEY=unset");
    await sidecar.stop();
    expect(fake.calls()).toContain("logout");
  });

  it("retries `up` while tailscaled is still opening its socket", async () => {
    quiet();
    const fake = fakeBinaries("slow-socket");
    const sidecar = new TailnetSidecar(config, fake);
    sidecar.start();
    await until(() => sidecar.state().state === "up");
    expect(sidecar.state(), fake.calls()).toMatchObject({ restarts: 0 });
    await sidecar.stop();
  });

  it("reports a refused key as down, with the key redacted, and restarts with backoff", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation(
      (l: string) => void lines.push(l),
    );
    const fake = fakeBinaries("refuse");
    const sidecar = new TailnetSidecar(config, {
      ...fake,
      backoffMs: () => 50,
      refusedBackoffMs: 0,
    });
    sidecar.start();
    await until(() => sidecar.state().restarts >= 2);
    const state = sidecar.state();
    if (state.state === "down") expect(state.reason).toContain("[redacted]");
    expect(JSON.stringify(state)).not.toContain("SECRET");
    expect(lines.join("\n")).not.toContain("SECRETsecret");
    await sidecar.stop();
  });

  it("restarts tailscaled when it dies", async () => {
    quiet();
    const fake = fakeBinaries("ok");
    const sidecar = new TailnetSidecar(config, {
      ...fake,
      backoffMs: () => 50,
    });
    sidecar.start();
    await until(() => sidecar.state().state === "up");
    // Kill the daemon out from under the supervisor.
    (
      sidecar as unknown as { daemon: { kill: (s: string) => void } }
    ).daemon.kill("SIGKILL");
    await until(
      () => sidecar.state().restarts === 1 && sidecar.state().state === "up",
    );
    await sidecar.stop();
  });
});

describe("TailnetSidecar after joining", () => {
  const config = { authKey: KEY, hostname: "strad-test", tags: ["tag:strad"] };

  it("reports down when the control plane drops the node, does NOT re-join, and reports up when it is back", async () => {
    quiet();
    const fake = fakeBinaries("ok");
    const sidecar = new TailnetSidecar(config, {
      ...fake,
      statusEveryMs: 30,
      backoffMs: () => 50,
    });
    sidecar.start();
    await until(() => sidecar.state().state === "up");
    fake.setBackend("NeedsLogin");
    await until(() => sidecar.state().state === "down");
    const down = sidecar.state();
    expect(down.state === "down" && down.reason).toContain("NeedsLogin");
    await new Promise((r) => setTimeout(r, 200));
    // Still one join: a removal in the admin console is not undone from here.
    expect(fake.calls().match(/ up /g)?.length).toBe(1);
    expect(sidecar.state().restarts).toBe(0);
    fake.setBackend("Running");
    await until(() => sidecar.state().state === "up");
    await sidecar.stop();
  });

  it("waits the long refusal floor after the control plane refuses the key", async () => {
    quiet();
    const fake = fakeBinaries("refuse");
    const sidecar = new TailnetSidecar(config, {
      ...fake,
      backoffMs: () => 10,
      refusedBackoffMs: 60_000,
    });
    sidecar.start();
    await until(() => sidecar.state().state === "down");
    await new Promise((r) => setTimeout(r, 300));
    expect(sidecar.state().restarts).toBe(1);
    await sidecar.stop();
  });

  it("resets the backoff after a successful join", async () => {
    quiet();
    const fake = fakeBinaries("ok");
    const delays: number[] = [];
    const sidecar = new TailnetSidecar(config, {
      ...fake,
      backoffMs: (n) => {
        delays.push(n);
        return 20;
      },
    });
    sidecar.start();
    for (let i = 1; i <= 2; i++) {
      await until(
        () =>
          sidecar.state().state === "up" && sidecar.state().restarts === i - 1,
      );
      (
        sidecar as unknown as { daemon: { kill: (s: string) => void } }
      ).daemon.kill("SIGKILL");
      await until(() => sidecar.state().restarts === i);
    }
    expect(delays).toEqual([1, 1]);
    await sidecar.stop();
  });
});

describe("boot.sh", () => {
  it("moves the key into a 0600 file and starts node WITHOUT it in the environment", () => {
    const bin = mkdtempSync(join(tmpdir(), "fake-node-"));
    writeFileSync(
      join(bin, "node"),
      `#!/bin/sh\necho "bare=\${STRAD_TAILNET_AUTHKEY:-unset}"\necho "file=$(cat "$STRAD_TAILNET_AUTHKEY_FILE")"\necho "mode=$(stat -c %a "$STRAD_TAILNET_AUTHKEY_FILE")"\necho "args=$*"\n`,
    );
    chmodSync(join(bin, "node"), 0o755);
    const script = join(__dirname, "..", "..", "scripts", "boot.sh");
    const out = execFileSync("sh", [script], {
      env: { PATH: `${bin}:/usr/bin:/bin`, STRAD_TAILNET_AUTHKEY: KEY },
      encoding: "utf8",
    });
    expect(out).toContain("bare=unset");
    expect(out).toContain(`file=${KEY}`);
    expect(out).toContain("mode=600");
    expect(out).toContain(
      "args=--import /app/host/otel/instrument.mjs /app/host/dist/index.js",
    );

    const plain = execFileSync("sh", [script], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    expect(plain).toContain("bare=unset");
    expect(plain).toContain("file=");
  });
});

describe("startTailnet", () => {
  it("starts nothing and sets nothing when the component has no tailnet", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(startTailnet(env)).toBeNull();
    expect(env).toEqual({});
  });

  it("tells the ssh tree where the listener is, and only after removing the key", async () => {
    quiet();
    const fake = fakeBinaries("ok");
    const env: NodeJS.ProcessEnv = {
      [TAILNET_ENV.authKey]: KEY,
      [TAILNET_ENV.tags]: "tag:strad",
    };
    const sidecar = startTailnet(env, fake);
    expect(env).toEqual({
      [TAILNET_ENV.tags]: "tag:strad",
      [TAILNET_ENV.socks5]: SOCKS5_LISTEN,
    });
    await sidecar!.stop();
  });
});
