import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import {
  REJECTION_FLOOR_MS,
  TokenRefreshError,
  UNAVAILABLE_BACKOFF_MS,
} from "../src/gateway/adapters/oauth-refresh.ts";
import { HttpServerAdapter } from "../src/gateway/adapters/http.ts";
import { probeToolSurfaces } from "../src/gateway/reachability.ts";
import { Registry, type RegistryOptions } from "../src/gateway/registry.ts";
import { createParameterWriteBack } from "../src/http/params.ts";
import { createApp } from "../src/http/app.ts";
import {
  sharedSecretProviders,
  type SecretProvider,
} from "../src/secrets/provider/index.ts";
import { startFakeOAuth, type FakeOAuth } from "./helpers/fake-oauth.ts";

/**
 * `remote-http` + `oauthRefresh:`, against a fake OAuth token endpoint and a fake
 * MCP upstream that only answers to a live bearer it issued.
 *
 * Nothing at the seam is mocked: strad's registry and adapter talk to a real
 * token endpoint over HTTP and to a real MCP server over Streamable HTTP, and
 * the first suite goes in through strad's own `/mcp` with a real MCP client.
 * What is controlled is the CLOCK — `Date` is faked (timers are not), so "the
 * access token expires" is a step the test takes rather than a sleep, and the
 * upstream judges expiry on the same clock strad does.
 *
 * There is no real Granola here. The fake is the shape the issue describes: a
 * refresh-token grant that issues short-lived bearers, optionally rotating the
 * refresh token on every use.
 */

const T0 = Date.parse("2026-09-11T12:00:00Z");
let now = T0;
const advance = (ms: number): void => {
  now += ms;
  vi.setSystemTime(now);
};

beforeEach(() => {
  now = T0;
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A secret provider over a map a test can change — a store a human re-seeds. */
function memoryProvider(values: Record<string, string>): SecretProvider & {
  values: Record<string, string>;
} {
  return {
    name: "memory",
    values,
    get: async (name) => values[name] ?? null,
    invalidate: () => {},
  };
}

async function fake(
  options: Parameters<typeof startFakeOAuth>[0] = {},
): Promise<FakeOAuth> {
  const f = await startFakeOAuth(options);
  cleanup.push(() => f.close());
  return f;
}

function oauthServer(
  slug: string,
  url: string,
  tokenUrl: string,
  variable: string,
): string {
  return `
  - slug: ${slug}
    kind: remote-http
    url: "${url}"
    entitlements: [admin]
    oauthRefresh:
      tokenUrl: "${tokenUrl}"
      clientId: strad-test-client
      refreshToken: "\${${variable}}"`;
}

function configOf(servers: string): ReturnType<typeof parseConfig> {
  return parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:${servers}
`);
}

async function registryOf(
  servers: string,
  provider: SecretProvider,
  writeBack?: RegistryOptions["writeBack"],
): Promise<Registry> {
  const registry = await Registry.build({
    config: configOf(servers),
    secrets: sharedSecretProviders(provider),
    mode: "core",
    env: {},
    writeBack,
  });
  cleanup.push(() => registry.close());
  return registry;
}

async function whoami(registry: Registry, slug: string): Promise<string> {
  const res = await registry.get(slug)!.callTool("whoami", {});
  const block = res.content[0] as { type: string; text: string };
  return block.text;
}

describe("end to end through /mcp: mint, expire, refresh", () => {
  it("mints on the first call, refreshes when the token expires, and the upstream call succeeds with the new token", async () => {
    const oauth = await fake({ expiresIn: 3600 });
    oauth.grant("rt-alice-seed", "alice");
    const config = configOf(
      oauthServer(
        "granola",
        oauth.mcpUrl("alice"),
        oauth.tokenUrl,
        "GRANOLA_REFRESH_TOKEN",
      ),
    );
    const provider = memoryProvider({ GRANOLA_REFRESH_TOKEN: "rt-alice-seed" });
    const token = mintToken({ env: "test", label: "admin", roles: ["admin"] });
    const env: NodeJS.ProcessEnv = {
      STRAD_TOKENS: JSON.stringify([token.record]),
    };
    const registry = await Registry.build({
      config,
      secrets: sharedSecretProviders(provider),
      mode: "core",
      env,
    });
    cleanup.push(() => registry.close());
    const app = createApp({
      config,
      registry,
      tokenStore: tokenStoreFromConfig(config, env),
      mode: "core",
      env,
    });
    const strad: HttpServer = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    cleanup.push(
      () =>
        new Promise<void>((r) => {
          strad.closeAllConnections();
          strad.close(() => r());
        }),
    );
    const port = (strad.address() as { port: number }).port;
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp?servers=granola`),
        {
          requestInit: {
            headers: { authorization: `Bearer ${token.plaintext}` },
          },
        },
      ),
    );
    cleanup.push(() => client.close().catch(() => {}));

    const call = async () => {
      const res = await client.callTool({ name: "granola__whoami" });
      return (res.content as { text: string }[])[0]!.text;
    };

    // 1. Initial mint.
    expect(await call()).toBe("alice");
    expect(oauth.tokenRequests).toHaveLength(1);
    expect(oauth.tokenRequests[0]).toMatchObject({
      grantType: "refresh_token",
      refreshToken: "rt-alice-seed",
      clientId: "strad-test-client",
    });
    const [first] = oauth.issued();
    expect(
      oauth.seen.every((s) => s.bearer === first && s.status === 200),
    ).toBe(true);

    // 2. Inside its lifetime, the held token is reused: no second exchange.
    advance(30 * 60_000);
    expect(await call()).toBe("alice");
    expect(oauth.tokenRequests).toHaveLength(1);

    // 3. The access token expires — at the upstream as well as for strad.
    advance(31 * 60_000);
    const before = oauth.seen.length;

    // 4. Refresh, and the upstream call succeeds with the NEW token.
    expect(await call()).toBe("alice");
    expect(oauth.tokenRequests).toHaveLength(2);
    const second = oauth.issued()[1]!;
    expect(second).not.toBe(first);
    const after = oauth.seen.slice(before);
    expect(after.length).toBeGreaterThan(0);
    // Refreshed BEFORE use: the expired token never reached the upstream.
    expect(after.every((s) => s.bearer === second && s.status === 200)).toBe(
      true,
    );
  });
});

describe("refresh on a 401, and no stampede", () => {
  it("a revoked token is refused once, re-minted once, and the call is retried and succeeds", async () => {
    const oauth = await fake({ expiresIn: null });
    oauth.grant("rt-alice", "alice");
    const registry = await registryOf(
      oauthServer("granola", oauth.mcpUrl("alice"), oauth.tokenUrl, "RT"),
      memoryProvider({ RT: "rt-alice" }),
    );

    expect(await whoami(registry, "granola")).toBe("alice");
    const [first] = oauth.issued();
    // No `expires_in`: strad keeps it until the upstream says no.
    advance(REJECTION_FLOOR_MS + 1_000);
    oauth.revoke(first!);

    expect(await whoami(registry, "granola")).toBe("alice");
    expect(oauth.tokenRequests).toHaveLength(2);
    expect(oauth.seen.filter((s) => s.status === 401)).toEqual([
      expect.objectContaining({ bearer: first }),
    ]);
  });

  it("a 401 on the HANDSHAKE — a held token refused by a fresh connection — is reported, re-minted, and retried", async () => {
    const oauth = await fake({ expiresIn: null });
    oauth.grant("rt-alice", "alice");
    const registry = await registryOf(
      oauthServer("granola", oauth.mcpUrl("alice"), oauth.tokenUrl, "RT"),
      memoryProvider({ RT: "rt-alice" }),
    );
    expect(await whoami(registry, "granola")).toBe("alice");
    const [first] = oauth.issued();
    advance(REJECTION_FLOOR_MS + 1_000);
    oauth.revoke(first!);
    // The cached connection goes away (a dropped socket), so the next call
    // must handshake — and the handshake is what carries the dead token.
    (
      registry.get("granola") as unknown as { retireCurrent(): void }
    ).retireCurrent();

    expect(await whoami(registry, "granola")).toBe("alice");
    expect(oauth.tokenRequests).toHaveLength(2);
    expect(oauth.seen.filter((s) => s.status === 401)).toEqual([
      expect.objectContaining({ bearer: first }),
    ]);
  });

  it("twenty concurrent calls on a cold server share ONE token exchange", async () => {
    const oauth = await fake();
    oauth.grant("rt-alice", "alice");
    const registry = await registryOf(
      oauthServer("granola", oauth.mcpUrl("alice"), oauth.tokenUrl, "RT"),
      memoryProvider({ RT: "rt-alice" }),
    );

    oauth.hold();
    const calls = Array.from({ length: 20 }, () => whoami(registry, "granola"));
    await oauth.arrived(1);
    // Give every caller time to reach the minter and find the exchange in flight.
    await new Promise((r) => setTimeout(r, 50));
    oauth.release();

    expect(await Promise.all(calls)).toEqual(Array(20).fill("alice"));
    expect(oauth.tokenRequests).toHaveLength(1);
  });

  it("a burst of 401s on one stale token costs one refresh, not one per request", async () => {
    const oauth = await fake({ expiresIn: null });
    oauth.grant("rt-alice", "alice");
    const registry = await registryOf(
      oauthServer("granola", oauth.mcpUrl("alice"), oauth.tokenUrl, "RT"),
      memoryProvider({ RT: "rt-alice" }),
    );
    expect(await whoami(registry, "granola")).toBe("alice");
    advance(REJECTION_FLOOR_MS + 1_000);
    oauth.revoke(oauth.issued()[0]!);

    const calls = Array.from({ length: 10 }, () => whoami(registry, "granola"));
    expect(await Promise.all(calls)).toEqual(Array(10).fill("alice"));
    expect(oauth.tokenRequests).toHaveLength(2);
  });

  it("a proactive refresh under concurrency is one exchange too", async () => {
    const oauth = await fake({ expiresIn: 600 });
    oauth.grant("rt-alice", "alice");
    const registry = await registryOf(
      oauthServer("granola", oauth.mcpUrl("alice"), oauth.tokenUrl, "RT"),
      memoryProvider({ RT: "rt-alice" }),
    );
    expect(await whoami(registry, "granola")).toBe("alice");
    advance(601_000);

    const calls = Array.from({ length: 15 }, () => whoami(registry, "granola"));
    expect(await Promise.all(calls)).toEqual(Array(15).fill("alice"));
    expect(oauth.tokenRequests).toHaveLength(2);
    expect(oauth.seen.filter((s) => s.status === 401)).toHaveLength(0);
  });
});

describe("a failed refresh is this server's failure alone", () => {
  it("a dead refresh token fails the slug in strad's words, degrades it, and leaves a static-header sibling working", async () => {
    const oauth = await fake();
    // `bob` is a STATIC-header remote-http: a bearer minted once, by hand.
    oauth.grant("rt-bob", "bob");
    const minted = (await (
      await fetch(oauth.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&refresh_token=rt-bob&client_id=x",
      })
    ).json()) as { access_token: string };
    const staticRequests = oauth.tokenRequests.length;

    const provider = memoryProvider({
      GRANOLA_REFRESH_TOKEN: "rt-never-granted",
      BOB_TOKEN: minted.access_token,
    });
    const registry = await registryOf(
      oauthServer(
        "granola",
        oauth.mcpUrl("alice"),
        oauth.tokenUrl,
        "GRANOLA_REFRESH_TOKEN",
      ) +
        `
  - slug: bob
    kind: remote-http
    url: "${oauth.mcpUrl("bob")}"
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${BOB_TOKEN}"`,
      provider,
    );

    const failure = await registry
      .get("granola")!
      .callTool("whoami", {})
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(failure).toBeInstanceOf(TokenRefreshError);
    const message = (failure as Error).message;
    expect(message).toContain('server "granola"');
    expect(message).toContain("${GRANOLA_REFRESH_TOKEN}");
    expect(message).toContain("invalid_grant");
    // Neither the token nor the endpoint's own prose.
    expect(message).not.toContain("rt-never-granted");
    expect(message).not.toContain("is dead");

    // The static-header sibling is untouched, and asks no token endpoint.
    expect(await whoami(registry, "bob")).toBe("bob");
    expect(oauth.tokenRequests.length - staticRequests).toBe(1);
    expect(oauth.seen.find((s) => s.path === "bob")?.bearer).toBe(
      minted.access_token,
    );

    // The reachability probe marks exactly one slug degraded.
    const probe = await probeToolSurfaces({ registry });
    expect(probe.snapshot.degraded).toEqual(["granola"]);
    expect(probe.failures.get("granola")).toContain("invalid_grant");

    // The refusal is remembered: the probe and a retry did not ask again.
    await expect(whoami(registry, "granola")).rejects.toThrow(/invalid_grant/);
    expect(oauth.tokenRequests.length - staticRequests).toBe(1);

    // A human re-seeds. The backoff belonged to the dead token, so the very
    // next call mints from the new one.
    oauth.grant("rt-alice-fresh", "alice");
    provider.values.GRANOLA_REFRESH_TOKEN = "rt-alice-fresh";
    expect(await whoami(registry, "granola")).toBe("alice");
    const healed = await probeToolSurfaces({ registry });
    expect(healed.snapshot.degraded).toEqual([]);
  });

  it("an unavailable token endpoint: a still-valid token rides through, and the retry waits for the backoff", async () => {
    const oauth = await fake({ expiresIn: 3600 });
    oauth.grant("rt-alice", "alice");
    const registry = await registryOf(
      oauthServer("granola", oauth.mcpUrl("alice"), oauth.tokenUrl, "RT"),
      memoryProvider({ RT: "rt-alice" }),
    );
    expect(await whoami(registry, "granola")).toBe("alice");
    const [first] = oauth.issued();

    // Past the refresh point, short of expiry, and the endpoint is down.
    advance(3600_000 - 30_000);
    oauth.failNext(1, { status: 503 });
    expect(await whoami(registry, "granola")).toBe("alice");
    expect(oauth.tokenRequests).toHaveLength(2);
    expect(oauth.seen.at(-1)?.bearer).toBe(first);

    // Inside the backoff, the endpoint is not asked again.
    expect(await whoami(registry, "granola")).toBe("alice");
    expect(oauth.tokenRequests).toHaveLength(2);

    advance(UNAVAILABLE_BACKOFF_MS + 1_000);
    expect(await whoami(registry, "granola")).toBe("alice");
    expect(oauth.tokenRequests).toHaveLength(3);
    expect(oauth.seen.at(-1)?.bearer).toBe(oauth.issued()[1]);
  });

  it("an unavailable token endpoint with no usable token fails as unavailable, not refused", async () => {
    const oauth = await fake();
    oauth.grant("rt-alice", "alice");
    const registry = await registryOf(
      oauthServer("granola", oauth.mcpUrl("alice"), oauth.tokenUrl, "RT"),
      memoryProvider({ RT: "rt-alice" }),
    );
    oauth.failNext(1, { status: 502 });
    const err = await whoami(registry, "granola").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TokenRefreshError);
    expect((err as TokenRefreshError).failure).toBe("unavailable");
    expect((err as TokenRefreshError).telemetryKind).toBe(
      "upstream_unavailable",
    );
    advance(UNAVAILABLE_BACKOFF_MS + 1_000);
    expect(await whoami(registry, "granola")).toBe("alice");
  });
});

describe("principal isolation", () => {
  it("two slugs on one token endpoint and one client id never carry each other's token", async () => {
    const oauth = await fake({ expiresIn: 600 });
    oauth.grant("rt-alice", "alice");
    oauth.grant("rt-bob", "bob");
    const registry = await registryOf(
      oauthServer("alice", oauth.mcpUrl("alice"), oauth.tokenUrl, "ALICE_RT") +
        oauthServer("bob", oauth.mcpUrl("bob"), oauth.tokenUrl, "BOB_RT"),
      memoryProvider({ ALICE_RT: "rt-alice", BOB_RT: "rt-bob" }),
    );

    const round = () =>
      Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 === 0
            ? whoami(registry, "alice").then((p) => ["alice", p])
            : whoami(registry, "bob").then((p) => ["bob", p]),
        ),
      );

    // A cold round, then a round across a proactive refresh of both.
    const cold = await round();
    advance(601_000);
    const warm = await round();

    for (const [slug, principal] of [...cold, ...warm]) {
      expect(principal).toBe(slug);
    }
    // The upstream judges each bearer against the principal its path names, so
    // one crossed token anywhere would show up here as a 401.
    expect(oauth.seen.filter((s) => s.status === 401)).toEqual([]);
    for (const s of oauth.seen) expect(s.principal).toBe(s.path);
    // Two principals, two lineages, two refreshes each.
    expect(oauth.tokenRequests.map((r) => r.refreshToken).sort()).toEqual([
      "rt-alice",
      "rt-alice",
      "rt-bob",
      "rt-bob",
    ]);
  });

  it("re-seeding a slug to another account drops every token held for the old one", async () => {
    const oauth = await fake({ expiresIn: 3600 });
    oauth.grant("rt-alice", "alice");
    oauth.grant("rt-carol", "carol");
    const provider = memoryProvider({ RT: "rt-alice" });
    const registry = await registryOf(
      oauthServer("granola", oauth.mcpUrl("any"), oauth.tokenUrl, "RT"),
      provider,
    );
    expect(await whoami(registry, "granola")).toBe("alice");

    // alice's token has 59 minutes left. It must not be sent again.
    provider.values.RT = "rt-carol";
    const mark = oauth.seen.length;
    expect(await whoami(registry, "granola")).toBe("carol");
    expect(await whoami(registry, "granola")).toBe("carol");
    expect(oauth.seen.slice(mark).map((s) => s.principal)).not.toContain(
      "alice",
    );
    expect(oauth.tokenRequests.map((r) => r.refreshToken)).toEqual([
      "rt-alice",
      "rt-carol",
    ]);
  });

  it("an exchange in flight for the old account is never installed after a re-seed", async () => {
    const oauth = await fake();
    oauth.grant("rt-alice", "alice");
    oauth.grant("rt-carol", "carol");
    const provider = memoryProvider({ RT: "rt-alice" });
    const registry = await registryOf(
      oauthServer("granola", oauth.mcpUrl("any"), oauth.tokenUrl, "RT"),
      provider,
    );

    oauth.hold();
    const early = whoami(registry, "granola");
    await oauth.arrived(1);
    // The account changes while alice's exchange is still out.
    provider.values.RT = "rt-carol";
    const late = whoami(registry, "granola");
    await oauth.arrived(2);
    oauth.release();

    expect(await late).toBe("carol");
    // The caller that started before the re-seed is answered for the account
    // that is current, not the one it started under.
    expect(await early).toBe("carol");
    expect(oauth.seen.map((s) => s.principal)).not.toContain("alice");
  });

  it("the adapter never builds a connection from a credential a newer one has replaced", async () => {
    // The straggler race, below the minter: a resolution that began before a
    // re-seed returns after it, and finds no connection cached. Without the
    // guard it builds one from the OLD credential under a fingerprint that
    // reads "current", and every later call reuses it.
    const oauth = await fake({ expiresIn: null });
    oauth.grant("rt-alice", "alice");
    oauth.grant("rt-carol", "carol");
    const mint = async (rt: string) => {
      const res = await fetch(oauth.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=refresh_token&refresh_token=${rt}&client_id=x`,
      });
      return ((await res.json()) as { access_token: string }).access_token;
    };
    const alice = await mint("rt-alice");
    const carol = await mint("rt-carol");

    let current = alice;
    let gate: Promise<void> | null = null;
    const adapter = new HttpServerAdapter({
      slug: "granola",
      kind: "remote-http",
      endpoint: async () => {
        const bearer = current;
        if (gate) {
          const held = gate;
          gate = null;
          await held;
        }
        return {
          url: oauth.mcpUrl("any"),
          headers: { authorization: `Bearer ${bearer}` },
        };
      },
      timeoutMs: 5_000,
    });
    cleanup.push(() => adapter.close());
    const who = async () =>
      ((await adapter.callTool("whoami", {})).content[0] as { text: string })
        .text;

    expect(await who()).toBe("alice");

    // X resolves alice and is held there.
    let releaseX = (): void => {};
    gate = new Promise((r) => {
      releaseX = r;
    });
    const x = who();
    await new Promise((r) => setTimeout(r, 20));

    // The account changes; Y resolves carol, rotates, and completes.
    current = carol;
    expect(await who()).toBe("carol");
    // Y's connection goes away (a dropped socket), so X finds nothing cached.
    await (adapter as unknown as { retireCurrent(): void }).retireCurrent();

    const mark = oauth.seen.length;
    releaseX();
    expect(await x).toBe("carol");
    expect(await who()).toBe("carol");
    expect(oauth.seen.slice(mark).map((s) => s.principal)).not.toContain(
      "alice",
    );
  });
});

describe("refresh-token rotation", () => {
  it("a rotated refresh token is written back, read back as the same lineage, and spent by the next refresh — across a restart too", async () => {
    const oauth = await fake({ expiresIn: 600, rotate: true });
    oauth.grant("rt-seed", "alice");
    const provider = memoryProvider({ RT: "rt-seed" });
    const writes: { slug: string; variable: string; value: string }[] = [];
    const writeBack: RegistryOptions["writeBack"] = async (
      slug,
      variable,
      value,
    ) => {
      writes.push({ slug, variable, value });
      provider.values[variable] = value;
    };
    const servers = oauthServer(
      "granola",
      oauth.mcpUrl("alice"),
      oauth.tokenUrl,
      "RT",
    );
    const registry = await registryOf(servers, provider, writeBack);

    expect(await whoami(registry, "granola")).toBe("alice");
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const [firstRotation] = oauth.liveRefreshTokens();
    expect(writes[0]).toEqual({
      slug: "granola",
      variable: "RT",
      value: firstRotation,
    });

    // The store now hands back the rotated value. That is this lineage
    // continuing, not a re-seed: no exchange, and the held token is kept.
    expect(await whoami(registry, "granola")).toBe("alice");
    expect(oauth.tokenRequests).toHaveLength(1);

    // Expire. The next exchange spends the ROTATED token — the seed is dead.
    advance(601_000);
    expect(await whoami(registry, "granola")).toBe("alice");
    expect(oauth.tokenRequests.map((r) => r.refreshToken)).toEqual([
      "rt-seed",
      firstRotation,
    ]);
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.value).toBe(oauth.liveRefreshTokens()[0]);

    // A restart: a brand-new registry, reading only what the store holds.
    const restarted = await registryOf(servers, provider, writeBack);
    expect(await whoami(restarted, "granola")).toBe("alice");
    expect(oauth.tokenRequests.at(-1)?.refreshToken).toBe(writes[1]!.value);
  });

  it("with nowhere to write (the env provider), each rotation is refused aloud, held in memory, and a restart reads a dead token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const oauth = await fake({ expiresIn: 600, rotate: true });
    oauth.grant("rt-seed", "alice");
    const provider = memoryProvider({ RT: "rt-seed" });
    const servers = oauthServer(
      "granola",
      oauth.mcpUrl("alice"),
      oauth.tokenUrl,
      "RT",
    );
    // The write-back core really wires, over a config whose provider is `env`.
    const writeBack = createParameterWriteBack({
      config: configOf(servers),
      env: {},
      secrets: {},
    });
    const registry = await registryOf(servers, provider, writeBack);

    expect(await whoami(registry, "granola")).toBe("alice");
    advance(601_000);
    // In-process the lineage survives: the second exchange spends the rotation.
    expect(await whoami(registry, "granola")).toBe("alice");
    expect(oauth.tokenRequests[1]!.refreshToken).not.toBe("rt-seed");
    await vi.waitFor(() => {
      const refused = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("gateway.secrets.provider is env"));
      expect(refused).toHaveLength(2);
    });

    // After a restart strad reads the seed again, which the provider killed.
    const restarted = await registryOf(servers, provider);
    await expect(whoami(restarted, "granola")).rejects.toThrow(/invalid_grant/);
  });
});

describe("static headers are unchanged", () => {
  it("a remote-http with a static Authorization header sends it verbatim and never touches a token endpoint", async () => {
    const oauth = await fake();
    oauth.grant("rt-bob", "bob");
    const res = await fetch(oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=rt-bob&client_id=x",
    });
    const { access_token } = (await res.json()) as { access_token: string };
    const registry = await registryOf(
      `
  - slug: bob
    kind: remote-http
    url: "${oauth.mcpUrl("bob")}"
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${BOB_TOKEN}"`,
      memoryProvider({ BOB_TOKEN: access_token }),
    );
    expect(await whoami(registry, "bob")).toBe("bob");
    expect(await whoami(registry, "bob")).toBe("bob");
    expect(oauth.tokenRequests).toHaveLength(1); // the one this test made
    expect(new Set(oauth.seen.map((s) => s.bearer))).toEqual(
      new Set([access_token]),
    );

    // And a 401 on it is the ordinary upstream failure it always was: no
    // minter, no retry, one refusal on the wire.
    oauth.revoke(access_token);
    const mark = oauth.seen.length;
    await expect(whoami(registry, "bob")).rejects.toThrow(
      /upstream MCP server/,
    );
    expect(oauth.seen.slice(mark).filter((s) => s.status === 401)).toHaveLength(
      1,
    );
    expect(oauth.tokenRequests).toHaveLength(1);
  });
});

describe("no token leaves the process", () => {
  it("across a mint, a rotation, a refusal and an outage, no refresh or access token reaches stdout, stderr or an error", async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(capture);
    }
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const oauth = await fake({ expiresIn: 600, rotate: true });
    oauth.grant("rt-canary-seed", "alice");
    const provider = memoryProvider({
      RT: "rt-canary-seed",
      DEAD: "rt-canary-dead",
    });
    const registry = await registryOf(
      oauthServer("granola", oauth.mcpUrl("alice"), oauth.tokenUrl, "RT") +
        oauthServer("dead", oauth.mcpUrl("alice"), oauth.tokenUrl, "DEAD"),
      provider,
    );

    const errors: string[] = [];
    const attempt = (slug: string) =>
      whoami(registry, slug).catch((err: unknown) => {
        errors.push(String((err as Error).message), String(err));
        return null;
      });

    await attempt("granola");
    await attempt("dead");
    advance(601_000);
    oauth.failNext(1, {
      status: 400,
      body: { error: "invalid_grant", error_description: "rt-canary-seed" },
    });
    await attempt("granola");
    // An outage, once the refusal's backoff has passed.
    advance(61_000);
    oauth.failNext(1, { status: 503, body: { detail: "rt-canary-seed" } });
    await attempt("granola");
    await probeToolSurfaces({ registry });

    const secrets = [
      "rt-canary-seed",
      "rt-canary-dead",
      ...oauth.liveRefreshTokens(),
      ...oauth.issued(),
    ];
    expect(errors.length).toBeGreaterThan(0);
    const everything = [...lines, ...errors].join("\n");
    for (const secret of secrets) expect(everything).not.toContain(secret);
  });
});
