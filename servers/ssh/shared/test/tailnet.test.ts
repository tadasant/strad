/**
 * Tailnet egress, end to end: a real MCP client, this server, the real ssh2
 * client, a SOCKS5 proxy standing in for tailscaled's userspace listener, and
 * the real SSH server on loopback behind it. The proxy records what it was
 * asked to reach, so each test can say whether the tailnet was used at all.
 */
import { createServer, connect as netConnect, type Server as NetServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMCPServer,
  isTailnetAddress,
  isTailnetName,
  loadConfig,
  parseProxyAddress,
  routeFor,
  socks5Connect,
  SocksReplyError,
  TAILNET_SOCKS5_ENV,
} from "../src/index.js";
import { keyPair, startFakeHost, type FakeHost } from "./fake-host.js";

const hostEd = keyPair("ed25519");
const clientKey = keyPair("ed25519");

interface FakeProxy {
  port: number;
  /** `address:port` of every CONNECT, in order. */
  requests: string[];
  /** Reply code to send instead of forwarding, when set. */
  refuseWith?: number;
  close(): Promise<void>;
}

function readExactly(sock: Socket, n: number, carry: { buf: Buffer }): Promise<Buffer> {
  return new Promise((resolve) => {
    const tryTake = () => {
      if (carry.buf.length >= n) {
        const out = carry.buf.subarray(0, n);
        carry.buf = carry.buf.subarray(n);
        sock.off("data", onData);
        resolve(out);
      }
    };
    const onData = (d: Buffer) => {
      carry.buf = Buffer.concat([carry.buf, d]);
      tryTake();
    };
    sock.on("data", onData);
    tryTake();
  });
}

/** A minimal SOCKS5 CONNECT proxy that forwards EVERY target to `forwardPort` on loopback. */
async function startFakeProxy(forwardPort: () => number): Promise<FakeProxy> {
  const sockets = new Set<Socket>();
  const proxy: FakeProxy = { port: 0, requests: [], close: async () => {} };
  const server: NetServer = createServer(async (client) => {
    sockets.add(client);
    client.on("error", () => {});
    const carry = { buf: Buffer.alloc(0) };
    const greet = await readExactly(client, 2, carry);
    await readExactly(client, greet[1]!, carry);
    client.write(Buffer.from([0x05, 0x00]));
    const head = await readExactly(client, 4, carry);
    let address: string;
    if (head[3] === 0x01) address = [...(await readExactly(client, 4, carry))].join(".");
    else if (head[3] === 0x03) {
      const len = (await readExactly(client, 1, carry))[0]!;
      address = (await readExactly(client, len, carry)).toString("utf8");
    } else {
      const b = await readExactly(client, 16, carry);
      address = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(":");
    }
    const port = (await readExactly(client, 2, carry)).readUInt16BE(0);
    proxy.requests.push(`${address}:${port}`);
    if (proxy.refuseWith !== undefined) {
      client.end(Buffer.from([0x05, proxy.refuseWith, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      return;
    }
    const upstream = netConnect(forwardPort(), "127.0.0.1", () => {
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      if (carry.buf.length) upstream.write(carry.buf);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  proxy.port = (server.address() as AddressInfo).port;
  proxy.close = () =>
    new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    });
  return proxy;
}

async function mcp(env: NodeJS.ProcessEnv) {
  const created = createMCPServer({ version: "test", label: "ssh-tailnet-test", env });
  const server = new Server({ name: "strad-ssh", version: "test" }, { capabilities: { tools: {} } });
  await created.registerHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
    },
    close: () => client.close(),
  };
}

let host: FakeHost;
let proxy: FakeProxy;

beforeAll(async () => {
  host = await startFakeHost({ hostKeys: [hostEd], authorized: [clientKey] });
  proxy = await startFakeProxy(() => host.port);
});

afterAll(async () => {
  await proxy.close();
  await host.close();
});

afterEach(() => {
  proxy.requests.length = 0;
  proxy.refuseWith = undefined;
  host.commands.length = 0;
});

/** Zimmer staging's tailnet address, as its public DNS name resolves today. */
const TAILNET_IP = "100.117.117.31";

function envFor(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    SSH_HOST: TAILNET_IP,
    SSH_PORT: "2222",
    SSH_USERNAME: "runner",
    SSH_PRIVATE_KEY: clientKey.private,
    SSH_HOST_KEY: host.keyscan.join("\n"),
    SSH_TIMEOUT: "5000",
    [TAILNET_SOCKS5_ENV]: `127.0.0.1:${proxy.port}`,
    ...overrides,
  };
}

describe("which hosts are tailnet hosts", () => {
  it("is the CGNAT range Tailscale assigns from and its IPv6 prefix, and nothing else", () => {
    for (const ip of ["100.64.0.1", "100.117.117.31", "100.120.55.4", "100.127.255.254", "fd7a:115c:a1e0::9101:b06b", "FD7A:115C:A1E0:ab12::1", "::ffff:100.117.117.31"]) {
      expect(isTailnetAddress(ip), ip).toBe(true);
    }
    for (const ip of ["100.63.255.255", "100.128.0.0", "10.0.0.1", "127.0.0.1", "8.8.8.8", "fd7a:115c:a1e1::1", "::1", "not-an-ip"]) {
      expect(isTailnetAddress(ip), ip).toBe(false);
    }
    expect(isTailnetName("zimmer-staging.tail52556f.ts.net")).toBe(true);
    expect(isTailnetName("staging.zimmer.tadasant.com")).toBe(false);
  });

  it("routes by where the host RESOLVES, so a public name that points into the tailnet goes through it", async () => {
    const lookup = (map: Record<string, string>) => async (h: string) => {
      if (!(h in map)) throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
      return [{ address: map[h]! }];
    };
    const dns = lookup({ "staging.zimmer.tadasant.com": TAILNET_IP, "ci.example.com": "203.0.113.7" });
    expect(await routeFor({ host: "staging.zimmer.tadasant.com" }, dns)).toEqual({ kind: "tailnet", address: TAILNET_IP });
    expect(await routeFor({ host: "ci.example.com" }, dns)).toEqual({ kind: "direct" });
    expect(await routeFor({ host: "gone.example.com" }, dns)).toEqual({ kind: "direct" });
    const never = () => new Promise<Array<{ address: string }>>(() => {});
    expect(await routeFor({ host: "slow.example.com", connectTimeoutMs: 50 }, never)).toEqual({ kind: "direct" });
    expect(await routeFor({ host: "203.0.113.7" }, dns)).toEqual({ kind: "direct" });
    expect(await routeFor({ host: "zimmer-staging.tail52556f.ts.net." }, dns)).toEqual({
      kind: "tailnet",
      address: "zimmer-staging.tail52556f.ts.net",
    });
  });

  it("takes the proxy address only in host:port form, and from the variable the bundle host sets", () => {
    expect(parseProxyAddress("127.0.0.1:1055")).toEqual({ host: "127.0.0.1", port: 1055 });
    expect(parseProxyAddress("[::1]:1055")).toEqual({ host: "::1", port: 1055 });
    for (const bad of [undefined, "", "1055", "127.0.0.1", "127.0.0.1:0", "127.0.0.1:99999", "socks5://127.0.0.1:1055"]) {
      expect(parseProxyAddress(bad), String(bad)).toBeUndefined();
    }
    expect(loadConfig(envFor()).tailnetProxy).toEqual({ host: "127.0.0.1", port: proxy.port });
    expect(loadConfig(envFor({ [TAILNET_SOCKS5_ENV]: undefined })).tailnetProxy).toBeUndefined();
  });
});

describe("a tailnet host", () => {
  it("is reached through the sidecar's SOCKS5 listener, with the pin still enforced", async () => {
    const s = await mcp(envFor());
    const r = await s.call("ssh_execute", { command: "echo over-the-tailnet" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("over-the-tailnet");
    expect(proxy.requests).toEqual([`${TAILNET_IP}:2222`]);
    await s.close();
  });

  it("refuses a host behind the tailnet that presents an unpinned key", async () => {
    const other = keyPair("ed25519");
    const s = await mcp(envFor({ SSH_HOST_KEY: other.public }));
    const r = await s.call("ssh_execute", { command: "echo should-not-run" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("REFUSED");
    expect(host.commands).toEqual([]);
    await s.close();
  });

  it("says the container has no tailnet egress — without dialing anything — when the sidecar is not configured", async () => {
    const s = await mcp(envFor({ [TAILNET_SOCKS5_ENV]: undefined }));
    const r = await s.call("ssh_execute", { command: "echo nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no tailnet egress");
    expect(r.text).toContain("tailnet:");
    expect(proxy.requests).toEqual([]);
    expect(JSON.parse((await s.call("ssh_check_connection")).text)).toMatchObject({ status: "not_configured" });
    await s.close();
  });

  it("is UNREACHABLE when the tailnet cannot reach it (peer offline, or the ACL does not allow it)", async () => {
    proxy.refuseWith = 0x01;
    const s = await mcp(envFor({ SSH_UNREACHABLE_HINT: "Deploy staging brings it back." }));
    const r = await s.call("ssh_execute", { command: "echo nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("UNREACHABLE");
    expect(r.text).toContain("tailnet policy");
    expect(r.text).toContain("Deploy staging brings it back.");
    expect(JSON.parse((await s.call("ssh_check_connection")).text)).toMatchObject({ status: "unreachable" });
    await s.close();
  });

  it("says the sidecar is down, not the host, when nothing listens at the proxy address", async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const s = await mcp(envFor({ [TAILNET_SOCKS5_ENV]: `127.0.0.1:${port}` }));
    const r = await s.call("ssh_execute", { command: "echo nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("tailnet sidecar");
    expect(r.text).not.toContain("UNREACHABLE");
    expect(JSON.parse((await s.call("ssh_check_connection")).text)).toMatchObject({ status: "connect_failed" });
    await s.close();
  });
});

describe("a public host", () => {
  it("dials direct even when the container has tailnet egress", async () => {
    const s = await mcp(envFor({ SSH_HOST: "127.0.0.1", SSH_PORT: String(host.port) }));
    const r = await s.call("ssh_execute", { command: "echo direct" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("direct");
    expect(proxy.requests).toEqual([]);
    await s.close();
  });
});

describe("socks5Connect", () => {
  it("hands ssh2 the bytes that arrived in the same segment as the reply", async () => {
    const server = createServer((c) => {
      c.once("data", () => {
        c.write(Buffer.from([0x05, 0x00]));
        c.once("data", () => {
          c.write(Buffer.concat([Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 22]), Buffer.from("SSH-2.0-x\r\n")]));
        });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const sock = await socks5Connect({ host: "127.0.0.1", port: (server.address() as AddressInfo).port }, TAILNET_IP, 22, 2000);
    // Handed over PAUSED, as ssh2 expects: it attaches its listener, then resumes.
    expect(sock.isPaused()).toBe(true);
    const first = new Promise<string>((r) => sock.once("data", (d: Buffer) => r(d.toString())));
    sock.resume();
    expect(await first).toBe("SSH-2.0-x\r\n");
    sock.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("reports the proxy's refusal code", async () => {
    proxy.refuseWith = 0x05;
    await expect(socks5Connect({ host: "127.0.0.1", port: proxy.port }, TAILNET_IP, 2222, 2000)).rejects.toBeInstanceOf(SocksReplyError);
  });
});
