/**
 * Tailnet egress: which hosts are only reachable over a Tailscale tailnet, and
 * the SOCKS5 dial that reaches them through the bundle's `tailscaled`.
 *
 * The bundle host runs `tailscaled` in userspace-networking mode when its
 * component was rendered with a `tailnet:` block (App Platform gives a
 * container no TUN device, so there is no tailnet interface for the kernel to
 * route through). The only way into the tailnet is the SOCKS5 listener that
 * `tailscaled` opens on loopback, and the host hands its address to this tree
 * as `STRAD_TAILNET_SOCKS5`. Nothing else in the bundle is pointed at it.
 *
 * The route is decided by the ADDRESS, not by a per-slug flag: a host that
 * resolves into Tailscale's ranges cannot be reached any other way, and one
 * that does not resolve there never touches the tailnet. So a public host
 * keeps dialing direct exactly as before, and an operator cannot send a
 * public host's traffic through the tailnet by mistake.
 */
import { isIP, Socket, connect as netConnect } from "node:net";

/** The variable the bundle host sets when the tailnet is up: `host:port` of tailscaled's SOCKS5 listener. */
export const TAILNET_SOCKS5_ENV = "STRAD_TAILNET_SOCKS5";

export interface ProxyAddress {
  host: string;
  port: number;
}

/**
 * `host:port`, `[v6]:port`, or undefined when unset. A malformed value is
 * treated as unset and reported by the caller as "no tailnet egress" — it is
 * written by the bundle host, never by a human, so it can only be malformed
 * if the host and this tree disagree, and failing toward "direct only" keeps a
 * public host working.
 */
export function parseProxyAddress(
  raw: string | undefined,
): ProxyAddress | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(text);
  if (!m) return undefined;
  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: (m[1] ?? m[2])!, port };
}

/**
 * Whether an IP address is a Tailscale node address: IPv4 in the CGNAT range
 * Tailscale assigns from (100.64.0.0/10), or IPv6 in Tailscale's ULA prefix
 * (fd7a:115c:a1e0::/48). Neither is routable on the public internet, so a
 * host that resolves to one is reachable over the tailnet or not at all.
 */
export function isTailnetAddress(address: string): boolean {
  // An IPv4-mapped IPv6 address (`::ffff:100.64.1.2`) is the IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isTailnetAddress(mapped[1]!);
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 100 && b >= 64 && b <= 127;
  }
  if (family === 6) {
    return /^fd7a:115c:a1e0(:|$)/i.test(expandV6Prefix(address));
  }
  return false;
}

/** The first three hextets of an IPv6 address, zero-padding-free and lowercased. */
function expandV6Prefix(address: string): string {
  const lower = address.toLowerCase();
  const [head = "", tail] = lower.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill =
    tail === undefined
      ? []
      : Array(Math.max(0, 8 - left.length - right.length)).fill("0");
  return [...left, ...fill, ...right]
    .slice(0, 3)
    .map((h) => h.replace(/^0+(?=.)/, ""))
    .join(":");
}

/** MagicDNS names: `<node>.<tailnet>.ts.net`. Only tailscaled can resolve them. */
export function isTailnetName(host: string): boolean {
  return /\.ts\.net\.?$/i.test(host);
}

/** SOCKS5 reply codes (RFC 1928 §6), for the message. */
const SOCKS_REPLIES: Record<number, string> = {
  1: "general failure",
  2: "connection not allowed by ruleset",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

/** The proxy answered and refused the CONNECT: the tailnet could not reach the target. */
export class SocksReplyError extends Error {
  constructor(readonly reply: number) {
    super(
      `tailnet proxy reply ${reply} (${SOCKS_REPLIES[reply] ?? "unknown"})`,
    );
    this.name = "SocksReplyError";
  }
}

/** Nothing is listening at the proxy address: the sidecar is down or still starting. */
export class SocksProxyDownError extends Error {
  constructor(readonly code: string | undefined) {
    super(`tailnet proxy is not accepting connections (${code ?? "closed"})`);
    this.name = "SocksProxyDownError";
  }
}

/** The proxy did not finish the CONNECT in time. */
export class SocksTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`tailnet proxy did not connect within ${timeoutMs} ms`);
    this.name = "SocksTimeoutError";
  }
}

/**
 * Open a TCP stream to `target:port` through a SOCKS5 proxy (no auth, CONNECT),
 * resolving to the connected socket once the proxy reports success. The
 * socket is then an ordinary byte stream to the target, which is what ssh2's
 * `sock` option takes.
 *
 * The proxy is loopback in the same container, so no credential is offered:
 * tailscaled's listener takes none, and anything that could reach loopback
 * here could already read the process environment.
 */
export function socks5Connect(
  proxy: ProxyAddress,
  target: string,
  port: number,
  timeoutMs: number,
  dial: (p: ProxyAddress) => Socket = (p) =>
    netConnect({ host: p.host, port: p.port }),
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const sock = dial(proxy);
    let stage: "greeting" | "connect" | "done" = "greeting";
    let buf = Buffer.alloc(0);
    let tcpUp = false;

    const fail = (err: Error) => {
      if (stage === "done") return;
      stage = "done";
      clearTimeout(timer);
      sock.removeAllListeners("data");
      sock.destroy();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new SocksTimeoutError(timeoutMs)),
      timeoutMs,
    );

    sock.once("connect", () => {
      tcpUp = true;
      // VER 5, one method, NO AUTHENTICATION.
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    sock.on("error", (err: Error & { code?: string }) => {
      if (stage === "done") return;
      fail(tcpUp ? err : new SocksProxyDownError(err.code));
    });
    sock.once("close", () => {
      if (stage === "done") return;
      fail(tcpUp ? new SocksReplyError(1) : new SocksProxyDownError(undefined));
    });
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          fail(new Error(`tailnet proxy refused the no-auth SOCKS5 greeting`));
          return;
        }
        buf = buf.subarray(2);
        stage = "connect";
        sock.write(connectRequest(target, port));
      }
      if (stage === "connect") {
        if (buf.length < 5) return;
        if (buf[0] !== 0x05) {
          fail(new Error(`tailnet proxy sent a malformed SOCKS5 reply`));
          return;
        }
        if (buf[1] !== 0x00) {
          fail(new SocksReplyError(buf[1]!));
          return;
        }
        const atyp = buf[3];
        const addrLen =
          atyp === 0x01
            ? 4
            : atyp === 0x04
              ? 16
              : atyp === 0x03
                ? 1 + buf[4]!
                : -1;
        if (addrLen < 0) {
          fail(new Error(`tailnet proxy sent a malformed SOCKS5 reply`));
          return;
        }
        const total = 4 + addrLen + 2;
        if (buf.length < total) return;
        stage = "done";
        clearTimeout(timer);
        sock.removeAllListeners("data");
        sock.removeAllListeners("error");
        sock.removeAllListeners("close");
        // Paused before the hand-off: ssh2 attaches its own `data` listener and
        // resumes, and a flowing socket with no listener drops bytes.
        sock.pause();
        // Anything past the reply is already the target's first bytes (an SSH
        // banner can arrive in the same segment); put it back for ssh2.
        const rest = buf.subarray(total);
        if (rest.length > 0) sock.unshift(rest);
        resolve(sock);
      }
    });
  });
}

function connectRequest(target: string, port: number): Buffer {
  const portBytes = Buffer.from([port >> 8, port & 0xff]);
  const family = isIP(target);
  if (family === 4) {
    return Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x01]),
      Buffer.from(target.split(".").map(Number)),
      portBytes,
    ]);
  }
  if (family === 6) {
    const groups = expandV6(target);
    const bytes = Buffer.alloc(16);
    groups.forEach((g, i) => bytes.writeUInt16BE(parseInt(g, 16), i * 2));
    return Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x04]),
      bytes,
      portBytes,
    ]);
  }
  const name = Buffer.from(target, "utf8");
  if (name.length > 255)
    throw new Error(`host name too long for SOCKS5: ${target.slice(0, 40)}…`);
  return Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
    name,
    portBytes,
  ]);
}

function expandV6(address: string): string[] {
  const [head = "", tail] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill =
    tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right];
}
