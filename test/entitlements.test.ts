import { describe, expect, it } from "vitest";
import type { Principal } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import {
  entitledServers,
  parseServersParam,
  resolveSelection,
} from "../src/gateway/entitlements.ts";

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin:   { servers: ["*"] }
  limited: { servers: [alpha] }
  stale:   { servers: [alpha, beta] }
servers:
  - slug: alpha
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin, limited, stale]
  - slug: beta
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
  - slug: gamma
    kind: builtin
    module: "./servers/echo.js"
    enabled: false
    entitlements: [admin]
`);

const principal = (roles: string[]): Principal => ({
  kind: "system-token",
  id: "test",
  label: "test",
  roles,
});

describe("entitledServers", () => {
  it("expands * to every enabled server", () => {
    expect([...entitledServers(principal(["admin"]), CONFIG)].sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("never includes a disabled server", () => {
    expect(entitledServers(principal(["admin"]), CONFIG).has("gamma")).toBe(
      false,
    );
  });

  it("grants nothing for an unknown role", () => {
    expect(entitledServers(principal(["nope"]), CONFIG).size).toBe(0);
  });

  it("grants nothing for no roles", () => {
    expect(entitledServers(principal([]), CONFIG).size).toBe(0);
  });

  it("requires BOTH directions to agree", () => {
    // `stale` names beta, but beta only lists `admin` under entitlements.
    // The role naming the server is not enough.
    const got = entitledServers(principal(["stale"]), CONFIG);
    expect([...got]).toEqual(["alpha"]);
  });

  it("does not treat inherited Object properties as configured roles", () => {
    // A token record carrying role "__proto__" or "constructor" must resolve to
    // nothing, not to Object.prototype (which would throw on role.servers).
    for (const evil of ["__proto__", "constructor", "toString"]) {
      expect(() => entitledServers(principal([evil]), CONFIG)).not.toThrow();
      expect(entitledServers(principal([evil]), CONFIG).size).toBe(0);
    }
  });
});

describe("resolveSelection — the query proposes, the token disposes", () => {
  const entitled = new Set(["alpha", "beta"]);

  it("defaults to everything entitled when ?servers= is absent", () => {
    const got = resolveSelection([], entitled, CONFIG);
    expect(got).toEqual({ ok: true, selected: ["alpha", "beta"] });
  });

  it("narrows to the requested subset", () => {
    const got = resolveSelection(["alpha"], entitled, CONFIG);
    expect(got).toEqual({ ok: true, selected: ["alpha"] });
  });

  it("CANNOT widen beyond entitlement", () => {
    // The whole ballgame: asking for a server you aren't entitled to must not
    // grant it, and must not silently drop it either.
    const got = resolveSelection(["alpha", "beta"], new Set(["alpha"]), CONFIG);
    expect(got.ok).toBe(false);
    if (got.ok) throw new Error("unreachable");
    expect(got.unavailable).toEqual([{ slug: "beta", status: "not_entitled" }]);
  });

  it("reports an unknown server as not_configured", () => {
    const got = resolveSelection(["nosuch"], entitled, CONFIG);
    expect(got.ok).toBe(false);
    if (got.ok) throw new Error("unreachable");
    expect(got.unavailable[0]).toMatchObject({
      slug: "nosuch",
      status: "not_configured",
    });
  });

  it("reports a configured-but-disabled server as disabled", () => {
    const got = resolveSelection(["gamma"], entitled, CONFIG);
    expect(got.ok).toBe(false);
    if (got.ok) throw new Error("unreachable");
    expect(got.unavailable[0]).toMatchObject({
      slug: "gamma",
      status: "disabled",
    });
  });

  it("includes an authorize_url when a public URL is known", () => {
    const got = resolveSelection(
      ["nosuch"],
      entitled,
      CONFIG,
      "https://s.example/",
    );
    if (got.ok) throw new Error("unreachable");
    expect(got.unavailable[0]?.authorize_url).toBe(
      "https://s.example/ui/nosuch",
    );
  });
});

describe("parseServersParam", () => {
  it("splits, trims and dedupes", () => {
    expect(parseServersParam("a, b ,a,,c")).toEqual(["a", "b", "c"]);
  });

  it("treats an absent param as no request", () => {
    expect(parseServersParam(undefined)).toEqual([]);
  });

  it("handles express's repeated-param array form", () => {
    expect(parseServersParam(["a,b", "c"])).toEqual(["a", "b", "c"]);
  });
});
