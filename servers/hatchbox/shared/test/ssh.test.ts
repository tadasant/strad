/**
 * The REAL SSH reader against a real SSH server on loopback, which executes the
 * command this server sends with the local `sh` — so `pgrep`, the `[p]uma`
 * pattern and `/proc/<pid>/environ` all run for real, against fake puma
 * processes holding known environments.
 */
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMCPServer, parseEnviron, PID_MARKER, processPattern, remoteCommand, splitPidOutput } from "../src/index.js";
import { keyPair, startFakeHost, startFakePuma, type FakeHost } from "./fake-host.js";

const hostKey = keyPair();
const clientKey = keyPair();
const strangerKey = keyPair();

let host: FakeHost;
const pumas: ChildProcess[] = [];

const passKey = keyPair("ed25519", "correct horse");

beforeAll(async () => {
  host = await startFakeHost({ hostKey, authorized: [clientKey, passKey] });
  // Decoys first, so each is OLDER than the real masters: an unanchored
  // `puma.*blog` would pick one of them.
  pumas.push(await startFakePuma("x", { APP: "tail" }, "tail -f /home/deploy/blog/shared/log/puma.log"));
  pumas.push(await startFakePuma("x", { APP: "wrapper" }, "bash -lc cd /home/deploy/blog && bundle exec puma"));
  pumas.push(await startFakePuma("x", { APP: "worker" }, "puma: cluster worker 0: 1234 [blog]"));
  pumas.push(await startFakePuma("blog-staging", { APP: "blog-staging" }));
  // `shop` before `blog`, so it is the oldest MASTER: the one an unnamed read picks.
  pumas.push(await startFakePuma("shop", { RAILS_ENV: "production", APP: "shop", SECRET_KEY_BASE: "shop-skb" }));
  pumas.push(await startFakePuma("blog", { RAILS_ENV: "production", APP: "blog", DATABASE_URL: "postgres://u:p@db/blog=x" }));
});

afterAll(async () => {
  for (const p of pumas) p.kill("SIGKILL");
  await host.close();
});

function env(overrides: Record<string, string> = {}) {
  return {
    HATCHBOX_APP_ID: "8540",
    HATCHBOX_SSH_HOST: "127.0.0.1",
    HATCHBOX_SSH_PORT: String(host.port),
    HATCHBOX_SSH_PRIVATE_KEY: clientKey.private,
    HATCHBOX_SSH_HOST_KEY: host.keyscan,
    ...overrides,
  };
}

async function call(e: Record<string, string>, name: string, args: Record<string, unknown> = {}) {
  const created = createMCPServer({ version: "t", env: e });
  const server = new Server({ name: "s", version: "t" }, { capabilities: { tools: {} } });
  await created.registerHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "t" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { text: r.content[0]!.text, isError: r.isError === true };
  } finally {
    await client.close();
  }
}

describe("the remote command", () => {
  it("is fixed, single-quoted, and anchored on a puma master's title", () => {
    expect(processPattern()).toBe("^puma [0-9]");
    expect(processPattern("my.app")).toBe("^puma [0-9].*[^A-Za-z0-9_-]my\\.app([^A-Za-z0-9_-]|$)");
    const cmd = remoteCommand("blog");
    expect(cmd).toContain(`pgrep -o -f '${processPattern("blog")}'`);
    expect(cmd).toContain('cat "/proc/$pid/environ" || exit 4');
  });

  it("finds the pid after its marker, past anything a login shell printed", () => {
    const raw = Buffer.from(`rbenv: shims loaded\n${PID_MARKER}4242\nA=1\0B=2\0`);
    const out = splitPidOutput(raw)!;
    expect(out.pid).toBe(4242);
    expect(parseEnviron(out.environ)).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "2" },
    ]);
    expect(splitPidOutput(Buffer.from("4242\nA=1"))).toBeNull();
  });

  it("refuses an app name with shell or regex syntax in it", () => {
    expect(() => processPattern("a'b")).toThrow();
    expect(() => processPattern("a b")).toThrow();
  });

  it("parses NUL-separated records, keeping = inside values", () => {
    expect(parseEnviron(Buffer.from("B=2\0A=x=y\0junk\0\0"))).toEqual([
      { name: "A", value: "x=y" },
      { name: "B", value: "2" },
    ]);
  });
});

describe("reading the running environment over SSH", () => {
  it("reads the named app's puma, not its neighbour's", async () => {
    const r = await call(env({ HATCHBOX_APP_NAME: "blog" }), "getEnvVars");
    expect(r.isError, r.text).toBe(false);
    const out = JSON.parse(r.text);
    expect(out.env_vars).toEqual({
      APP: "blog",
      DATABASE_URL: "postgres://u:p@db/blog=x",
      RAILS_ENV: "production",
    });
    expect(out.pid).toBe(pumas[pumas.length - 1]!.pid);
  });

  it("reads the oldest puma MASTER when no app is named — not a log tail, a wrapper or a worker", async () => {
    const r = await call(env(), "getEnvVar", { name: "APP" });
    expect(JSON.parse(r.text)).toEqual({ name: "APP", found: true, value: "blog-staging" });
  });

  it("does not take blog-staging for blog, nor the reverse", async () => {
    const blog = await call(env({ HATCHBOX_APP_NAME: "blog" }), "getEnvVar", { name: "APP" });
    expect(JSON.parse(blog.text).value).toBe("blog");
    const staging = await call(env({ HATCHBOX_APP_NAME: "blog-staging" }), "getEnvVar", { name: "APP" });
    expect(JSON.parse(staging.text).value).toBe("blog-staging");
  });

  it("logs in with an encrypted key and its passphrase, and names the passphrase when it is missing", async () => {
    const ok = await call(
      env({ HATCHBOX_SSH_PRIVATE_KEY: passKey.private, HATCHBOX_SSH_PASSPHRASE: "correct horse", HATCHBOX_APP_NAME: "shop" }),
      "getEnvVar",
      { name: "APP" },
    );
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.text).not.toContain("correct horse");
    const missing = await call(env({ HATCHBOX_SSH_PRIVATE_KEY: passKey.private }), "getEnvVars");
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("HATCHBOX_SSH_PASSPHRASE");
  });

  it("says so when no puma matches", async () => {
    const r = await call(env({ HATCHBOX_APP_NAME: "nonesuch" }), "getEnvVars");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No puma process for "nonesuch"/);
  });

  it("accepts a SHA256 fingerprint pin", async () => {
    const { fingerprintOf } = await import("../src/host-key.js");
    const blob = Buffer.from(hostKey.public.trim().split(/\s+/)[1]!, "base64");
    const r = await call(env({ HATCHBOX_SSH_HOST_KEY: fingerprintOf(blob) }), "getEnvVar", { name: "APP" });
    expect(r.isError, r.text).toBe(false);
  });

  it("refuses a host presenting any other key BEFORE the private key is offered", async () => {
    const before = host.authAttempts.length;
    const other = `ssh-ed25519 ${keyPair().public.trim().split(/\s+/)[1]}`;
    const r = await call(env({ HATCHBOX_SSH_HOST_KEY: other }), "getEnvVars");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/presented host key SHA256:.*not HATCHBOX_SSH_HOST_KEY/);
    expect(host.authAttempts.slice(before)).toEqual([]);
  });

  it("says the key was rejected when the server does not know it", async () => {
    const r = await call(env({ HATCHBOX_SSH_PRIVATE_KEY: strangerKey.private }), "getEnvVars");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/rejected HATCHBOX_SSH_PRIVATE_KEY/);
  });

  it("never puts the private key in a result or an error", async () => {
    const ok = await call(env(), "getEnvVars");
    const bad = await call(env({ HATCHBOX_SSH_HOST_KEY: `ssh-ed25519 ${keyPair().public.split(/\s+/)[1]}` }), "getEnvVars");
    const body = clientKey.private.split("\n").filter((l) => l && !l.startsWith("-----"))[0]!;
    for (const r of [ok, bad]) expect(r.text).not.toContain(body);
  });

  it("sends exactly the fixed command — no caller input reaches it", async () => {
    const before = host.commands.length;
    await call(env({ HATCHBOX_APP_NAME: "blog" }), "getEnvVar", { name: "RAILS_ENV" });
    expect(host.commands.slice(before)).toEqual([remoteCommand("blog")]);
  });

  it("reports a host that does not answer", async () => {
    const r = await call(env({ HATCHBOX_SSH_PORT: "1" }), "getEnvVars");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Could not connect to deploy@127\.0\.0\.1:1/);
  });
});
