import { describe, expect, it } from "vitest";
import {
  networkOf,
  principalAttr,
  reachPrincipalAttr,
  SourceNetworks,
} from "../src/telemetry/principal.ts";

describe("principalAttr: a bounded caller label", () => {
  it("names a static token by its pubid and nothing else", () => {
    expect(principalAttr({ kind: "system-token", id: "a1b2c3d4" })).toBe(
      "token:a1b2c3d4",
    );
  });

  it("never exports a person's Google subject: a human is their kind", () => {
    expect(principalAttr({ kind: "mcp-oauth", id: "1234" })).toBe("oauth");
    expect(principalAttr({ kind: "google", id: "1234" })).toBe("google");
  });

  it("drops ids that have no ceiling: a console token is one value", () => {
    expect(principalAttr({ kind: "console-token", id: "jti-1" })).toBe(
      "console-token",
    );
    expect(principalAttr({ kind: "console-token", id: "jti-2" })).toBe(
      "console-token",
    );
    expect(principalAttr({ kind: "console-bypass", id: "dev-bypass" })).toBe(
      "console-bypass",
    );
  });

  it("names a flow-through caller by its source slug", () => {
    expect(reachPrincipalAttr("sheets-writer")).toBe("reach:sheets-writer");
  });
});

describe("networkOf", () => {
  it("folds IPv4 to its /24", () => {
    expect(networkOf("203.0.113.7")).toBe("203.0.113.0/24");
    expect(networkOf("203.0.113.250")).toBe("203.0.113.0/24");
    expect(networkOf("203.0.114.7")).toBe("203.0.114.0/24");
  });

  it("unwraps an IPv4-mapped IPv6 address", () => {
    expect(networkOf("::ffff:203.0.113.7")).toBe("203.0.113.0/24");
  });

  it("folds IPv6 to its /48, whatever the spelling", () => {
    expect(networkOf("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
    expect(networkOf("2001:0DB8:ABCD:0099:0:0:0:2")).toBe("2001:db8:abcd::/48");
    expect(networkOf("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(networkOf("::1")).toBe("0:0:0::/48");
    expect(networkOf("fe80::1%eth0")).toBe("fe80:0:0::/48");
    expect(networkOf("64:ff9b::203.0.113.7")).toBe("64:ff9b:0::/48");
  });

  it("refuses anything that is not an address", () => {
    expect(networkOf(undefined)).toBeNull();
    expect(networkOf("")).toBeNull();
    expect(networkOf("not-an-ip")).toBeNull();
    expect(networkOf("1.2.3")).toBeNull();
  });
});

describe("SourceNetworks", () => {
  it("counts distinct networks, not addresses", () => {
    const t = new SourceNetworks();
    t.record("token:a", "203.0.113.1", 0);
    t.record("token:a", "203.0.113.2", 0);
    t.record("token:a", "198.51.100.1", 0);
    t.record("token:b", "203.0.113.1", 0);
    expect(t.counts(0)).toEqual(
      new Map([
        ["token:a", 2],
        ["token:b", 1],
      ]),
    );
  });

  it("forgets a network once it is older than the window, and reads 0", () => {
    const t = new SourceNetworks(1000);
    t.record("token:a", "203.0.113.1", 0);
    t.record("token:a", "198.51.100.1", 500);
    expect(t.counts(1000).get("token:a")).toBe(2);
    expect(t.counts(1001).get("token:a")).toBe(1);
    // Seen again: it is fresh again.
    t.record("token:a", "198.51.100.9", 1400);
    expect(t.counts(2000).get("token:a")).toBe(1);
    expect(t.counts(2401).get("token:a")).toBe(0);
  });

  it("saturates at the cap, so an attacker's addresses cannot grow memory", () => {
    const t = new SourceNetworks(60_000, 4);
    for (let i = 0; i < 100; i++) t.record("token:a", `10.0.${i}.1`, i);
    expect(t.counts(100).get("token:a")).toBe(4);
  });

  it("ignores an unparseable address rather than counting it", () => {
    const t = new SourceNetworks();
    t.record("token:a", undefined, 0);
    t.record("token:a", "garbage", 0);
    expect(t.counts(0).get("token:a")).toBeUndefined();
  });
});
