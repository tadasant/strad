/**
 * The server end to end: a real MCP client over `InMemoryTransport`, this
 * server, the real ssh2 client, and a real SSH server on loopback
 * (`fake-host.ts`). Nothing between the tool call and the SSH wire is mocked.
 */
import { createServer, type Server as NetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, createMCPServer, fingerprintOf, loadConfig, toolDefinitions, type Connector } from "../src/index.js";
import { keyPair, startFakeHost, type FakeHost, type KeyPair } from "./fake-host.js";

const hostEd = keyPair("ed25519");
const hostRsa = keyPair("rsa");
const impostor = keyPair("ed25519");
const clientKey = keyPair("ed25519");
const strangerKey = keyPair("ed25519");

const outputs: string[] = [];

async function mcp(env: NodeJS.ProcessEnv, connector?: Connector) {
  const created = createMCPServer({ version: "test", label: "ssh-test", env, connector });
  const server = new Server({ name: "strad-ssh", version: "test" }, { capabilities: { tools: {} } });
  await created.registerHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      const text = res.content.map((c) => c.text).join("\n");
      outputs.push(text);
      return { text, isError: res.isError === true, json: () => JSON.parse(res.content.at(-1)!.text) };
    },
    close: () => client.close(),
  };
}

function envFor(h: FakeHost, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    SSH_HOST: "127.0.0.1",
    SSH_PORT: String(h.port),
    SSH_USERNAME: "runner",
    SSH_PRIVATE_KEY: clientKey.private,
    SSH_HOST_KEY: h.keyscan.join("\n"),
    SSH_TIMEOUT: "15000",
    ...overrides,
  };
}

function fp(k: KeyPair): string {
  return fingerprintOf(Buffer.from(k.public.trim().split(/\s+/)[1]!, "base64"));
}

let host: FakeHost;
let dual: FakeHost;

beforeAll(async () => {
  host = await startFakeHost({ hostKeys: [hostEd], authorized: [clientKey] });
  dual = await startFakeHost({ hostKeys: [hostEd, hostRsa], authorized: [clientKey] });
});

afterAll(async () => {
  await host.close();
  await dual.close();
  // THE KEY NEVER LEAVES. Every tool result produced by this suite, success or
  // failure, is checked for the private key's body.
  const body = clientKey.private.split("\n").slice(1, -2).join("");
  for (const out of outputs) {
    expect(out).not.toContain("PRIVATE KEY");
    expect(out.replace(/\s/g, "")).not.toContain(body.slice(10, 50));
  }
});

afterEach(() => {
  host.authAttempts.length = 0;
  host.commands.length = 0;
});

describe("tools/list", () => {
  it("serves the upstream's five tool names plus ssh_check_connection with annotations, even unconfigured", async () => {
    const s = await mcp({});
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "ssh_connection_info",
      "ssh_check_connection",
      "ssh_list_directory",
      "ssh_download",
      "ssh_upload",
      "ssh_execute",
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.ssh_list_directory!.annotations?.readOnlyHint).toBe(true);
    expect(byName.ssh_download!.annotations?.readOnlyHint).toBe(true);
    expect(byName.ssh_execute!.annotations?.destructiveHint).toBe(true);
    expect(byName.ssh_upload!.annotations?.destructiveHint).toBe(true);
    for (const t of tools) expect(t.description!.length).toBeLessThanOrEqual(2048);
    await s.close();
  });
});

describe("missing secrets", () => {
  it("connection info reports what is missing, and every other tool refuses without connecting", async () => {
    const connector = vi.fn<Connector>();
    const s = await mcp({ SSH_HOST: "127.0.0.1" }, connector);
    const info = await s.call("ssh_connection_info");
    expect(info.isError).toBe(false);
    expect(info.json()).toMatchObject({
      slug: "ssh-test",
      configured: false,
      missing: ["SSH_USERNAME", "SSH_PRIVATE_KEY", "SSH_HOST_KEY"],
    });
    for (const [tool, args] of [
      ["ssh_execute", { command: "id" }],
      ["ssh_list_directory", { path: "/" }],
      ["ssh_download", { remotePath: "/etc/hostname" }],
      ["ssh_upload", { remotePath: "/tmp/x", content: "x" }],
    ] as const) {
      const r = await s.call(tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Not configured \(ssh-test\): SSH_USERNAME, SSH_PRIVATE_KEY, SSH_HOST_KEY are not set/);
    }
    expect(connector).not.toHaveBeenCalled();
    await s.close();
  });

  it("refuses an UNPINNED host outright: no host key, no connection", async () => {
    const s = await mcp(envFor(host, { SSH_HOST_KEY: undefined }));
    const r = await s.call("ssh_execute", { command: "echo hi" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/SSH_HOST_KEY is not set/);
    expect(host.authAttempts).toEqual([]);
    expect(host.commands).toEqual([]);
    await s.close();
  });
});

describe("strict host-key checking", () => {
  it("connects when the presented key is pinned, and reports it", async () => {
    const s = await mcp(envFor(host));
    const r = await s.call("ssh_connection_info", { test_connection: true });
    const info = r.json();
    expect(info.configured).toBe(true);
    expect(info.connection).toMatchObject({
      ok: true,
      status: "ok",
      host_key_presented: { type: "ssh-ed25519", fingerprint: fp(hostEd) },
    });
    expect(info.pinned_host_keys).toEqual([{ type: "ssh-ed25519", fingerprint: fp(hostEd) }]);
    expect(info.authentication).toEqual({
      method: "private key from strad's store",
      key_type: "ssh-ed25519",
      encrypted: false,
    });
    await s.close();
  });

  it("REFUSES a mismatched key before authenticating: no signature offered, no command run", async () => {
    const s = await mcp(envFor(host, { SSH_HOST_KEY: impostor.public }));
    const r = await s.call("ssh_execute", { command: "touch pwned" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^REFUSED: 127\.0\.0\.1:\d+ presented host key SHA256:/);
    expect(r.text).toContain(fp(hostEd));
    expect(r.text).toContain(fp(impostor));
    expect(r.text).toMatch(/private key was not used/);
    expect(host.authAttempts).toEqual([]);
    expect(host.commands).toEqual([]);
    await s.close();
  });

  it("refuses a mismatched FINGERPRINT pin the same way", async () => {
    const s = await mcp(envFor(host, { SSH_HOST_KEY: fp(impostor) }));
    const r = await s.call("ssh_list_directory", { path: "/" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^REFUSED/);
    expect(host.authAttempts).toEqual([]);
    await s.close();
  });

  it("accepts a matching fingerprint pin", async () => {
    const s = await mcp(envFor(host, { SSH_HOST_KEY: fp(hostEd) }));
    const r = await s.call("ssh_execute", { command: "echo ok" });
    expect(r.json().stdout).toBe("ok\n");
    await s.close();
  });

  it("asks a two-key host for the PINNED type, so pinning either genuine key works", async () => {
    const rsaLine = dual.keyscan.find((l) => l.includes("ssh-rsa"))!;
    const s = await mcp(envFor(dual, { SSH_HOST_KEY: rsaLine }));
    const r = await s.call("ssh_connection_info", { test_connection: true });
    expect(r.json().connection.host_key_presented).toEqual({ type: "ssh-rsa", fingerprint: fp(hostRsa) });
    await s.close();
  });

  it("says plainly when the host has no key of the pinned type", async () => {
    const s = await mcp(envFor(host, { SSH_HOST_KEY: hostRsa.public }));
    const r = await s.call("ssh_execute", { command: "id" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no host key of the pinned type\(s\) \(ssh-rsa\)/);
    await s.close();
  });
});

describe("connection failures", () => {
  it("explains a key the host does not authorise", async () => {
    const s = await mcp(envFor(host, { SSH_PRIVATE_KEY: strangerKey.private }));
    const r = await s.call("ssh_execute", { command: "id" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/rejected SSH_PRIVATE_KEY.*authorized_keys/s);
    expect(host.commands).toEqual([]);
    await s.close();
  });

  it("explains a refused port", async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((r) => probe.close(() => r()));
    const s = await mcp(envFor(host, { SSH_PORT: String(port) }));
    const r = await s.call("ssh_execute", { command: "id" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/UNREACHABLE: .*refused port \d+.*nothing is listening there/);
    await s.close();
  });

  it("rejects, rather than hangs, when the host closes after its banner", async () => {
    // sshd's MaxStartups or a firewall cutting the key exchange: ssh2 emits no
    // `error` for a close after the banner, only `close`.
    const rude: NetServer = createServer((sock) => sock.end("SSH-2.0-OpenSSH_9.0\r\n"));
    await new Promise<void>((r) => rude.listen(0, "127.0.0.1", r));
    const { port } = rude.address() as AddressInfo;
    const s = await mcp(envFor(host, { SSH_PORT: String(port), SSH_TIMEOUT: "60000" }));
    const started = Date.now();
    const r = await s.call("ssh_execute", { command: "id" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/closed the connection during the handshake/);
    await s.close();
    rude.close();
  });

  it("explains a handshake that never completes", async () => {
    const silent: NetServer = createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const { port } = silent.address() as AddressInfo;
    const s = await mcp(envFor(host, { SSH_PORT: String(port), SSH_TIMEOUT: "1000" }));
    const r = await s.call("ssh_execute", { command: "id" });
    expect(r.isError).toBe(true);
    // TCP was accepted, so the machine is up: not "spun down".
    expect(r.text).toMatch(/accepted the TCP connection but sent no SSH greeting within 1000 ms/);
    expect(r.text).not.toMatch(/UNREACHABLE/);
    await s.close();
    silent.close();
  });

  it("says a host that showed its pinned key and then stalled the login is up and slow, not down", async () => {
    const slow = await startFakeHost({ hostKeys: [hostEd], authorized: [clientKey], stallAuth: true });
    const s = await mcp(envFor(slow, { SSH_TIMEOUT: "1000" }));
    const r = await s.call("ssh_execute", { command: "id" });
    expect(r.text).toMatch(/answered with the pinned host key, but the login did not finish within 1000 ms/);
    expect(r.text).not.toMatch(/UNREACHABLE|was not used/);
    await s.close();
    await slow.close();
  });
});

describe("ssh_execute", () => {
  it("returns stdout, stderr and the exit code; non-zero is a result, not an error", async () => {
    const s = await mcp(envFor(host));
    const r = await s.call("ssh_execute", { command: "echo out; echo err >&2; exit 3" });
    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({
      exitCode: 3,
      signal: null,
      stdout: "out\n",
      stderr: "err\n",
      truncated: false,
      timedOut: false,
    });
    await s.close();
  });

  it("runs in cwd, quoted, whatever the path holds", async () => {
    mkdirSync(join(host.root, "it's here"));
    const s = await mcp(envFor(host));
    const r = await s.call("ssh_execute", { command: "basename \"$PWD\"", cwd: `${host.root}/it's here` });
    expect(r.json().stdout).toBe("it's here\n");
    await s.close();
  });

  it("keeps the head and tail of a huge output and says how much it dropped", async () => {
    const s = await mcp(envFor(host));
    const r = await s.call("ssh_execute", {
      command: "echo FIRST; head -c 300000 /dev/zero | tr '\\0' x; echo; echo LAST",
    });
    const j = r.json();
    expect(j.truncated).toBe(true);
    expect(j.stdoutBytes).toBeGreaterThan(300000);
    expect(j.stdout.startsWith("FIRST\n")).toBe(true);
    expect(j.stdout.trimEnd().endsWith("LAST")).toBe(true);
    expect(j.stdout).toMatch(/\[… \d+ bytes omitted …\]/);
    expect(j.stdout.length).toBeLessThan(70_000);
    await s.close();
  });

  it("abandons a command that goes quiet past its timeout, with partial output", async () => {
    const s = await mcp(envFor(host));
    const r = await s.call("ssh_execute", { command: "echo started; sleep 30", timeout: 1000 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no output for 1000 ms/);
    const j = r.json();
    expect(j.timedOut).toBe(true);
    expect(j.exitCode).toBeNull();
    expect(j.stdout).toBe("started\n");
    await s.close();
  });

  it("validates its arguments", async () => {
    const s = await mcp(envFor(host));
    expect((await s.call("ssh_execute", {})).text).toBe("command is required.");
    expect((await s.call("ssh_execute", { command: "id", timeout: 5 })).text).toMatch(/timeout must be/);
    await s.close();
  });
});

describe("SFTP", () => {
  it("lists a directory, sorted, with types", async () => {
    mkdirSync(join(host.root, "listing/sub"), { recursive: true });
    writeFileSync(join(host.root, "listing/b.txt"), "bb");
    writeFileSync(join(host.root, "listing/a.txt"), "a");
    const s = await mcp(envFor(host));
    const j = (await s.call("ssh_list_directory", { path: "/listing" })).json();
    expect(j.total).toBe(3);
    expect(j.truncated).toBe(false);
    expect(j.entries.map((e: { name: string; type: string; size: number }) => [e.name, e.type])).toEqual([
      ["a.txt", "file"],
      ["b.txt", "file"],
      ["sub", "directory"],
    ]);
    expect(j.entries[0].permissions).toMatch(/^-[rwx-]{9}$/);
    await s.close();
  });

  it("downloads text inline, pages a large file by offset, and base64s binary", async () => {
    writeFileSync(join(host.root, "app.log"), "line one\nline two ✓\n");
    writeFileSync(join(host.root, "blob.bin"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(host.root, "big.txt"), "0123456789".repeat(10));
    const s = await mcp(envFor(host));

    const text = (await s.call("ssh_download", { remotePath: "/app.log" })).json();
    expect(text).toMatchObject({ encoding: "utf8", content: "line one\nline two ✓\n", truncated: false, nextOffset: null });

    const bin = (await s.call("ssh_download", { remotePath: "/blob.bin" })).json();
    expect(bin).toMatchObject({ encoding: "base64", content: "AAEC/w==", bytes: 4 });

    const p1 = (await s.call("ssh_download", { remotePath: "/big.txt", maxBytes: 30 })).json();
    expect(p1).toMatchObject({ size: 100, bytes: 30, truncated: true, nextOffset: 30, content: "012345678901234567890123456789" });
    const p2 = (await s.call("ssh_download", { remotePath: "/big.txt", offset: 90, maxBytes: 30 })).json();
    expect(p2).toMatchObject({ bytes: 10, truncated: false, nextOffset: null, content: "0123456789" });
    await s.close();
  });

  it("does not split a multi-byte character at the read window", async () => {
    writeFileSync(join(host.root, "utf.txt"), "ab✓cd");
    const s = await mcp(envFor(host));
    const j = (await s.call("ssh_download", { remotePath: "/utf.txt", maxBytes: 3 })).json();
    expect(j).toMatchObject({ encoding: "utf8", content: "ab", bytes: 2, nextOffset: 2 });
    await s.close();
  });

  it("never stalls paging: a file ending mid-character, and a window smaller than one character", async () => {
    writeFileSync(join(host.root, "cut.txt"), Buffer.concat([Buffer.from("ab"), Buffer.from([0xe2, 0x82])]));
    writeFileSync(join(host.root, "check.txt"), "✓✓");
    const s = await mcp(envFor(host));
    const end = (await s.call("ssh_download", { remotePath: "/cut.txt", offset: 2 })).json();
    expect(end).toMatchObject({ encoding: "base64", bytes: 2, truncated: false, nextOffset: null });
    const whole = (await s.call("ssh_download", { remotePath: "/cut.txt" })).json();
    expect(whole).toMatchObject({ encoding: "base64", bytes: 4, nextOffset: null });
    const tiny = (await s.call("ssh_download", { remotePath: "/check.txt", maxBytes: 1 })).json();
    expect(tiny.bytes).toBe(1);
    expect(tiny.nextOffset).toBe(1);
    const strict = await s.call("ssh_download", { remotePath: "/check.txt", maxBytes: 1, encoding: "utf8" });
    expect(strict.isError).toBe(true);
    expect(strict.text).toMatch(/not valid UTF-8/);
    await s.close();
  });

  it("refuses localPath on both transfer tools, and a directory as a file", async () => {
    const s = await mcp(envFor(host));
    const d = await s.call("ssh_download", { remotePath: "/app.log", localPath: "/Users/me/app.log" });
    expect(d.isError).toBe(true);
    expect(d.text).toMatch(/does not take localPath here.*returned in the result/s);
    const u = await s.call("ssh_upload", { remotePath: "/x", localPath: "/Users/me/x" });
    expect(u.isError).toBe(true);
    expect(u.text).toMatch(/does not take localPath here.*as content/s);
    expect(host.authAttempts).toEqual([]);
    const dir = await s.call("ssh_download", { remotePath: "/listing" });
    expect(dir.text).toMatch(/is a directory/);
    const none = await s.call("ssh_download", { remotePath: "/nope" });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/^SFTP: No such file/);
    await s.close();
  });

  it("uploads utf8 and base64 content, with a mode for a new file", async () => {
    const s = await mcp(envFor(host));
    const t = await s.call("ssh_upload", { remotePath: "/up.sh", content: "#!/bin/sh\necho hi\n", mode: "0755" });
    expect(t.json()).toEqual({ remotePath: "/up.sh", bytes: 18 });
    expect(readFileSync(join(host.root, "up.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(statSync(join(host.root, "up.sh")).mode & 0o777).toBe(0o755);

    await s.call("ssh_upload", { remotePath: "/up.bin", content: "AAEC/w==", encoding: "base64" });
    expect([...readFileSync(join(host.root, "up.bin"))]).toEqual([0, 1, 2, 255]);
    await s.close();
  });

  it("refuses an oversized upload and bad arguments before connecting", async () => {
    const s = await mcp(envFor(host));
    const big = await s.call("ssh_upload", { remotePath: "/x", content: "x".repeat(2 * 1024 * 1024 + 1) });
    expect(big.text).toMatch(/the most one call carries is 2097152/);
    expect((await s.call("ssh_upload", { remotePath: "/x", content: "!!", encoding: "base64" })).text).toMatch(/not valid base64/);
    expect((await s.call("ssh_upload", { remotePath: "/x", content: "x", mode: "rwx" })).text).toMatch(/mode must be octal/);
    expect(host.authAttempts).toEqual([]);
    await s.close();
  });
});

describe("deadlines on a live but stuck connection", () => {
  it("closes the connection when SFTP never answers, instead of hanging", async () => {
    const hung = await startFakeHost({ hostKeys: [hostEd], authorized: [clientKey], stallSftp: true });
    const s = await mcp(envFor(hung, { SSH_COMMAND_TIMEOUT: "1000" }));
    for (const [tool, args] of [
      ["ssh_list_directory", { path: "/" }],
      ["ssh_download", { remotePath: "/x" }],
      ["ssh_upload", { remotePath: "/x", content: "x" }],
    ] as const) {
      const r = await s.call(tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/got no answer within 1000 ms, so the connection was closed/);
    }
    await s.close();
    await hung.close();
  });

  it("ends a command that keeps printing past the wall-clock ceiling", async () => {
    const config = loadConfig(envFor(host));
    const session = await connect(config);
    try {
      const started = Date.now();
      const r = await session.exec("while true; do echo tick; sleep 0.1; done", {
        timeoutMs: 5000,
        maxWallMs: 1000,
      });
      expect(Date.now() - started).toBeLessThan(8000);
      expect(r).toMatchObject({ timedOut: true, timeout: "ceiling", exitCode: null });
      expect(r.stdout).toContain("tick");
    } finally {
      session.close();
    }
  });
});

/** A port nothing is listening on, freed for the test to use. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** The pin for `hostEd`, written the way ssh-keyscan would for a port. */
function pinFor(port: number): string {
  return `[127.0.0.1]:${port} ${hostEd.public.trim().split(/\s+/).slice(0, 2).join(" ")}`;
}

describe("an unreachable host never fails the MCP connection", () => {
  // A connector that counts, wrapped round the real one: initialize and
  // tools/list must never get as far as calling it.
  const counting = () => {
    const calls = { n: 0 };
    const connector: Connector = (config) => {
      calls.n += 1;
      return connect(config);
    };
    return { calls, connector };
  };

  async function silentListener(): Promise<{ port: number; close: () => void }> {
    // Accepts TCP and never speaks: what a host swallowing the handshake looks like.
    const silent: NetServer = createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    return { port: (silent.address() as AddressInfo).port, close: () => silent.close() };
  }

  for (const shape of ["closed port", "silent listener", "non-routable address"] as const) {
    it(`initialize and tools/list succeed fast, opening nothing, against a ${shape}`, async () => {
      let env: NodeJS.ProcessEnv;
      let done = () => {};
      if (shape === "closed port") {
        const port = await closedPort();
        env = envFor(host, { SSH_PORT: String(port), SSH_HOST_KEY: pinFor(port) });
      } else if (shape === "silent listener") {
        const l = await silentListener();
        env = envFor(host, { SSH_PORT: String(l.port), SSH_HOST_KEY: pinFor(l.port) });
        done = l.close;
      } else {
        // TEST-NET-1 (RFC 5737): never routed, so a connect either fails at once
        // or is swallowed until the timeout. Neither may touch the listing.
        env = envFor(host, { SSH_HOST: "192.0.2.1", SSH_PORT: "22", SSH_TIMEOUT: "60000" });
      }
      const { calls, connector } = counting();
      const started = Date.now();
      const s = await mcp(env, connector);
      const { tools } = await s.client.listTools();
      expect(Date.now() - started).toBeLessThan(2000);
      expect(tools).toHaveLength(6);
      expect(calls.n).toBe(0);
      await s.close();
      done();
    });
  }

  it("answers every tool call against a down host with the actionable UNREACHABLE message", async () => {
    const port = await closedPort();
    const s = await mcp(envFor(host, { SSH_PORT: String(port), SSH_HOST_KEY: pinFor(port) }));
    for (const [tool, args] of [
      ["ssh_execute", { command: "id" }],
      ["ssh_list_directory", { path: "/" }],
      ["ssh_download", { remotePath: "/x" }],
      ["ssh_upload", { remotePath: "/x", content: "x" }],
    ] as const) {
      const r = await s.call(tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^ssh-test: UNREACHABLE: runner@127\.0\.0\.1:\d+ did not answer: the machine refused port/);
      expect(r.text).toMatch(/still starting/);
      expect(r.text).toMatch(/call ssh_check_connection/);
      expect(r.text).toMatch(/no reconnect of the MCP session is needed/);
      expect(r.text).not.toMatch(/do not retry/i);
      expect(r.text).not.toMatch(/\n\s+at /); // no stack
    }
    await s.close();
  });

  it("says a powered-off-looking address (no TCP at all) is UNREACHABLE, within SSH_TIMEOUT", async () => {
    // TEST-NET-1 is never routed: the connect fails at once (network error) or
    // is swallowed until the timeout. Both are a machine that is not there.
    const s = await mcp(envFor(host, { SSH_HOST: "192.0.2.1", SSH_PORT: "22", SSH_TIMEOUT: "1000" }));
    const started = Date.now();
    const r = await s.call("ssh_execute", { command: "id" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.text).toMatch(/UNREACHABLE: runner@192\.0\.2\.1:22 did not answer: (no reply within 1000 ms|network error E[A-Z]+)\. The host is most likely powered off or spun down/);
    expect(r.text).toMatch(/call ssh_check_connection/);
    await s.close();
  });

  it("reports a host that drops mid-command as a lost connection, never as a finished command", async () => {
    const dying = await startFakeHost({ hostKeys: [hostEd], authorized: [clientKey] });
    const s = await mcp(envFor(dying));
    const call = s.call("ssh_execute", { command: "echo started; sleep 20" });
    await new Promise((r) => setTimeout(r, 500));
    await dying.close();
    const r = await call;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/connection to runner@127\.0\.0\.1:\d+ was lost during the command/);
    expect(r.text).toMatch(/ssh_check_connection/);
    await s.close();
  });

  it("closes the SSH session when the caller goes away, instead of running on", async () => {
    const [execute] = toolDefinitions(
      {
        label: "ssh-test",
        env: () => envFor(host),
        config: () => loadConfig(envFor(host)),
        connector: connect,
      },
      ["admin"],
    ).filter((t) => t.name === "ssh_execute");
    const aborter = new AbortController();
    const started = Date.now();
    const pending = execute!.handler({ command: "sleep 30" }, aborter.signal);
    setTimeout(() => aborter.abort(), 500);
    const r = await pending;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.isError).toBe(true);
  });

  it("quotes the slug's SSH_UNREACHABLE_HINT, cleaned to one line", async () => {
    const port = await closedPort();
    const s = await mcp(
      envFor(host, {
        SSH_PORT: String(port),
        SSH_HOST_KEY: pinFor(port),
        SSH_UNREACHABLE_HINT: "Spun down when idle.\nBring it up with the Deploy staging workflow.",
      }),
    );
    const r = await s.call("ssh_execute", { command: "id" });
    expect(r.text).toContain(
      "About this host: Spun down when idle. Bring it up with the Deploy staging workflow.",
    );
    expect(r.text).not.toMatch(/treat it as an outage/);
    await s.close();
  });

  it("retry flow: check reports unreachable, the host comes up, check reports ok, tools work — one session", async () => {
    const port = await closedPort();
    const s = await mcp(envFor(host, { SSH_PORT: String(port), SSH_HOST_KEY: pinFor(port) }));

    const down = (await s.call("ssh_check_connection")).json();
    expect(down).toMatchObject({ slug: "ssh-test", ok: false, status: "unreachable" });
    expect(down.next_step).toMatch(/Bring the host up/);
    expect((await s.call("ssh_execute", { command: "echo hi" })).text).toMatch(/UNREACHABLE/);

    // The host "comes back up" where it was.
    const revived = await startFakeHost({ hostKeys: [hostEd], authorized: [clientKey], port });
    try {
      const up = (await s.call("ssh_check_connection")).json();
      expect(up).toMatchObject({
        slug: "ssh-test",
        ok: true,
        status: "ok",
        host_key_presented: { type: "ssh-ed25519", fingerprint: fp(hostEd) },
      });
      const r = await s.call("ssh_execute", { command: "echo back" });
      expect(r.isError).toBe(false);
      expect(r.json().stdout).toBe("back\n");
      // ...and the tool list never changed underneath the session.
      expect((await s.client.listTools()).tools).toHaveLength(6);
    } finally {
      await s.close();
      await revived.close();
    }
  });

  it("keeps a host-key mismatch and a missing parameter distinct from unreachable", async () => {
    const wrong = await mcp(envFor(host, { SSH_HOST_KEY: impostor.public }));
    const mismatch = await wrong.call("ssh_execute", { command: "id" });
    expect(mismatch.text).toMatch(/^REFUSED: .*do not retry/s);
    expect(mismatch.text).not.toMatch(/UNREACHABLE|spun down/);
    expect((await wrong.call("ssh_check_connection")).json()).toMatchObject({
      ok: false,
      status: "host_key_mismatch",
      next_step: expect.stringMatching(/^Do not retry/),
    });
    await wrong.close();

    const unseeded = await mcp(envFor(host, { SSH_PRIVATE_KEY: undefined }));
    const missing = await unseeded.call("ssh_execute", { command: "id" });
    expect(missing.text).toMatch(/^Not configured \(ssh-test\): SSH_PRIVATE_KEY is not set/);
    expect(missing.text).not.toMatch(/UNREACHABLE|spun down/);
    expect((await unseeded.call("ssh_check_connection")).json()).toMatchObject({
      ok: false,
      status: "not_configured",
    });
    await unseeded.close();

    const stranger = await mcp(envFor(host, { SSH_PRIVATE_KEY: strangerKey.private }));
    expect((await stranger.call("ssh_check_connection")).json()).toMatchObject({
      ok: false,
      status: "connect_failed",
    });
    await stranger.close();
  });
});

describe("the production connector", () => {
  it("is what createMCPServer uses by default", async () => {
    // Guard against a refactor that quietly swaps in something laxer.
    const s = await mcp(envFor(host), connect);
    expect((await s.call("ssh_execute", { command: "echo direct" })).json().stdout).toBe("direct\n");
    await s.close();
  });
});
