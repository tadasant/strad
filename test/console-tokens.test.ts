import http, { type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ConsoleTokenStore,
  consoleTokenLoginStatus,
  MAX_RECORDS,
  TOKEN_SESSION_COOKIE,
  TOKEN_SESSION_TTL_MS,
  TOKEN_TTL_MS,
} from "../src/auth/console-tokens.ts";
import { tokenStoreFromConfig, type Principal } from "../src/auth/index.ts";
import {
  consoleSessionsFromEnv,
  SESSION_COOKIE,
  type ConsoleSessionPayload,
} from "../src/auth/session.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import type { StradConfig } from "../src/config/schema.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * The console login token, end to end: mint → exchange → cookie → /ui.
 *
 * Every assertion below goes through real sockets, the real routes, the real
 * gate and the real store — the one substitution is the store's CLOCK, so
 * expiry can be tested without waiting ten minutes.
 *
 * The deployment under test is STAGING-SHAPED on purpose: `NODE_ENV=production`
 * with both dev-auth acknowledgements, a live bypass, and `gateway.env: staging`.
 * That is the environment token login exists for, and the one a naive
 * `NODE_ENV === "production"` guard would have blinded.
 *
 * The case the issue gate named as the main risk is `concurrent exchanges`: a
 * compare-and-set that is not actually atomic makes the token replayable, and
 * nothing visibly breaks when it is. It is raced over real sockets here.
 */

const BOOTSTRAP = "bootstrap-secret-for-token-tests";
const SESSION_SECRET = "console-session-secret-0123456789";

const staticAdmin = mintToken({
  env: "staging",
  label: "ci",
  roles: ["admin"],
});

const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  ALLOW_DEV_AUTH: "true",
  ALLOW_DEV_AUTH_IN_PRODUCTION: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  CONSOLE_SESSION_SECRET: SESSION_SECRET,
  STRAD_TOKENS: JSON.stringify([staticAdmin.record]),
};

function config(env: string, enabled: boolean): StradConfig {
  return parseConfig(`
version: 1
gateway: { name: strad, env: ${env} }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin, echo-only] }
  consoleTokenLogin: { enabled: ${enabled} }
  google:
    enabled: true
    hostedDomain: tadasant.com
    roles: [echo-only]
roles:
  admin: { servers: ["*"] }
  echo-only: { servers: [echo] }
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin, echo-only]
`);
}

const STAGING = config("staging", true);

let clock = Date.now();
const store = new ConsoleTokenStore({ now: () => clock });

async function listen(cfg: StradConfig, tokens?: ConsoleTokenStore) {
  const registry = await Registry.build({
    config: cfg,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env: ENV,
  });
  const app = createApp({
    config: cfg,
    registry,
    tokenStore: tokenStoreFromConfig(cfg, ENV),
    mode: "core",
    env: ENV,
    // No Google client: sign-in cannot complete, so the gate answers its 401
    // wall rather than redirecting. A Google SESSION still verifies — the key
    // is CONSOLE_SESSION_SECRET — which is what the Google-minter case needs.
    googleProvider: null,
    consoleTokens: tokens,
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = srv.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return { srv, url: `http://127.0.0.1:${addr.port}` };
}

let staging: { srv: Server; url: string };
let base: string;

beforeAll(async () => {
  staging = await listen(STAGING, store);
  base = staging.url;
});

afterAll(() => {
  staging?.srv.close();
});

beforeEach(() => {
  clock = Date.now();
});

// --- helpers ---------------------------------------------------------------

const BEARER = { authorization: `Bearer ${BOOTSTRAP}` };

async function mint(
  body?: unknown,
  headers: Record<string, string> = BEARER,
): Promise<Response> {
  return fetch(`${base}/console/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function mintOk(body?: unknown): Promise<{ token: string; jti: string }> {
  const res = await mint(body);
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; jti: string };
}

async function exchange(token: unknown, path = "/console/token-login") {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

function sessionSetCookie(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${TOKEN_SESSION_COOKIE}=`));
}

/** The `Cookie` request header a browser would send back. */
function cookieOf(res: Response): string {
  const set = sessionSetCookie(res);
  if (!set) throw new Error("no session cookie was set");
  return set.split(";")[0] ?? "";
}

async function signedIn(): Promise<string> {
  const { token } = await mintOk();
  const res = await exchange(token);
  expect(res.status).toBe(200);
  return cookieOf(res);
}

async function ui(cookie?: string, path = "/ui") {
  return fetch(`${base}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
}

async function revoke(jti: string, headers: Record<string, string> = BEARER) {
  return fetch(`${base}/console/tokens/${jti}/revoke`, {
    method: "POST",
    headers,
  });
}

// --- the happy path --------------------------------------------------------

describe("mint → exchange → cookie → console", () => {
  it("opens the console with the exchanged cookie, and only with it", async () => {
    expect((await ui()).status).toBe(401);

    const minted = await mint();
    expect(minted.status).toBe(201);
    expect(minted.headers.get("cache-control")).toBe("no-store");
    const body = (await minted.json()) as Record<string, unknown>;
    expect(body.token).toMatch(/^[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(String(body.token).startsWith(`${String(body.jti)}.`)).toBe(true);
    expect(body.roles).toEqual(["admin", "echo-only"]);
    expect(body.sessionTtlSeconds).toBe(1800);
    expect(body.mintedBy).toBe("console dev bypass");

    const res = await exchange(body.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const exchanged = (await res.json()) as { roles: string[]; jti: string };
    expect(exchanged.jti).toBe(body.jti);
    expect(exchanged.roles).toEqual(["admin", "echo-only"]);

    const page = await ui(cookieOf(res));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`token ${String(body.jti)}`);
    // The landing page and the playground sit behind the same gate.
    expect((await ui(cookieOf(res), "/")).status).toBe(200);
  });

  it("reports the session on GET /console, as an actor would check it", async () => {
    const cookie = await signedIn();
    const res = await fetch(`${base}/console`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.via).toBe("token-login");
    expect(body.roles).toEqual(["admin", "echo-only"]);
    expect(Date.parse(String(body.expiresAt))).toBeGreaterThan(clock);
  });

  it("sets an HttpOnly, SameSite=Lax, Secure, Path=/ cookie whose Max-Age is the session's life", async () => {
    const { token } = await mintOk();
    const res = await exchange(token);
    const set = sessionSetCookie(res) ?? "";
    expect(set).toMatch(/; HttpOnly/);
    expect(set).toMatch(/; SameSite=Lax/);
    expect(set).toMatch(/; Secure/);
    expect(set).toMatch(/; Path=\//);
    expect(set).toMatch(/; Max-Age=1800(;|$)/);

    // The server's expiry is the same 1800s, counted from the exchange.
    const { expiresAt } = (await res.json()) as { expiresAt: string };
    expect(Date.parse(expiresAt) - clock).toBe(TOKEN_SESSION_TTL_MS);
  });

  it("refuses a form body, so a cross-site form cannot plant a session", async () => {
    const { token } = await mintOk();
    const bodies: [string, string][] = [
      [
        "application/x-www-form-urlencoded",
        new URLSearchParams({ token }).toString(),
      ],
      ["text/plain", JSON.stringify({ token })],
    ];
    for (const [type, body] of bodies) {
      const res = await fetch(`${base}/console/token-login`, {
        method: "POST",
        headers: { "content-type": type },
        body,
      });
      expect(res.status, type).toBe(415);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    // Neither of those spent it.
    expect((await exchange(token)).status).toBe(200);
  });

  it("accepts a stale token cookie beside a live one", async () => {
    const stale = await signedIn();
    const live = await signedIn();
    const [name, value] = stale.split("=") as [string, string];
    const [sid] = value.split(".");
    const forged = `${name}=${sid}.${"D".repeat(43)}`;
    expect((await ui(`${forged}; ${live}`)).status).toBe(200);
  });
});

// --- look, don't touch -----------------------------------------------------

describe("a token session can look at the console and cannot act through it", () => {
  const ACTING = [
    // Minting an /mcp token is the widest of them: a standing credential for
    // the agent door, handed out from a 30-minute look-only session.
    "/tokens/mint",
    "/tokens/revoke",
    "/tokens/forget",
    "/ui/echo/create",
    "/ui/echo/rotate",
    "/ui/echo/note",
    "/ui/echo/reveal",
    "/ui/echo/delete",
    "/ui/echo/connect",
  ];

  it.each(ACTING)("refuses POST %s with 403", async (path) => {
    const cookie = await signedIn();
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "variable=ADMIN_BOOTSTRAP_TOKEN&value=x",
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/can view the console but not act/);
  });

  it("refuses a playground tool call, and still lists tools", async () => {
    const cookie = await signedIn();
    const headers = { cookie, "content-type": "application/json" };
    const call = await fetch(`${base}/playground/echo/tools/call`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: "echo", arguments: { text: "x" } }),
    });
    expect(call.status).toBe(403);
    expect(await call.json()).toMatchObject({ ok: false });

    const list = await fetch(`${base}/playground/echo/tools/list`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(list.status).toBe(200);
  });

  it("lets it re-read the store, which reads nothing back", async () => {
    const cookie = await signedIn();
    const res = await fetch(`${base}/ui/echo/refresh`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("lets a standing credential outrank a token session in the same request", async () => {
    // A browser that used the bypass and then exchanged a token holds both;
    // it must not be demoted to the look-only one.
    const cookie = await signedIn();
    const res = await fetch(`${base}/ui/echo/reveal`, {
      method: "POST",
      headers: {
        ...BEARER,
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "variable=NOPE",
      redirect: "manual",
    });
    expect(res.status).not.toBe(403);
    const status = await fetch(`${base}/console`, {
      headers: { ...BEARER, cookie },
    });
    expect(((await status.json()) as { via: string }).via).toBe("dev-bypass");
  });

  it("lets a standing credential call a playground tool", async () => {
    const res = await fetch(`${base}/playground/echo/tools/call`, {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: JSON.stringify({ tool: "echo", arguments: { text: "x" } }),
    });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("does not refuse a standing credential on the same routes", async () => {
    for (const path of ACTING) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          ...BEARER,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "variable=NOPE&value=x",
        redirect: "manual",
      });
      expect(res.status, path).not.toBe(403);
      expect(res.status, path).not.toBe(401);
    }
  });
});

// --- single use ------------------------------------------------------------

describe("single use", () => {
  it("refuses a replay of a consumed token with 409 and sets no cookie", async () => {
    const { token } = await mintOk();
    expect((await exchange(token)).status).toBe(200);

    const replay = await exchange(token);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: "token_consumed" });
    expect(replay.headers.getSetCookie()).toEqual([]);
  });

  it("lets exactly one of many concurrent exchanges of one token win", async () => {
    // The sockets are opened FIRST, so the N exchanges land on N already-open
    // connections in the same instant. `fetch` alone staggers its connects by
    // milliseconds, and a race it cannot lose is not a test: an `await` put
    // inside the compare-and-set passed that version of this case.
    const N = 25;
    const agent = new http.Agent({ keepAlive: true, maxSockets: N });
    try {
      await Promise.all(
        Array.from({ length: N }, () => raw(agent, "GET", "/healthz")),
      );
      const { token } = await mintOk();
      const body = JSON.stringify({ token });
      const results = await Promise.all(
        Array.from({ length: N }, () =>
          raw(agent, "POST", "/console/token-login", body),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(N - 1);
      // And exactly one of them was handed a session.
      const withCookie = results.filter((r) =>
        r.setCookie.some((c) => c.startsWith(`${TOKEN_SESSION_COOKIE}=`)),
      );
      expect(withCookie).toHaveLength(1);
    } finally {
      agent.destroy();
    }
  });

  it("serialises a same-turn double exchange in the store itself", () => {
    // The HTTP race above depends on the event loop interleaving sockets. This
    // pins the property it rests on: exchange() is synchronous, so two calls
    // are ordered and the second sees the first's write.
    const s = new ConsoleTokenStore();
    const { token } = s.mint(principal(["admin"]), ["admin"]);
    const first = s.exchange(token);
    const second = s.exchange(token);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: "token_consumed" });
    // Not a promise: an `await` inside would make the token replayable.
    expect(first).not.toBeInstanceOf(Promise);
  });
});

// --- revoke ----------------------------------------------------------------

describe("revoke", () => {
  it("kills a token before it is exchanged, and is idempotent", async () => {
    const { token, jti } = await mintOk();

    const first = await revoke(jti);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      jti,
      status: "revoked",
      sessionEnded: false,
    });
    const again = await revoke(jti);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      jti,
      status: "revoked",
      sessionEnded: false,
    });

    const res = await exchange(token);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "token_revoked" });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("leaves a consumed token consumed, and ends the session it opened", async () => {
    const { token, jti } = await mintOk();
    const cookie = cookieOf(await exchange(token));
    expect((await ui(cookie)).status).toBe(200);

    const res = await revoke(jti);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jti,
      status: "consumed",
      sessionEnded: true,
    });
    expect((await ui(cookie)).status).toBe(401);
    // Idempotent on this side too.
    expect(await (await revoke(jti)).json()).toEqual({
      jti,
      status: "consumed",
      sessionEnded: false,
    });
  });

  it("answers 404 for a jti it does not hold rather than claiming a revocation", async () => {
    const res = await revoke("0123456789abcdef");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_token" });
    expect((await revoke("not-a-jti")).status).toBe(404);
  });

  it("takes a standing credential", async () => {
    const { jti } = await mintOk();
    expect((await revoke(jti, {})).status).toBe(401);
    const cookie = await signedIn();
    expect((await revoke(jti, { cookie })).status).toBe(401);
  });

  it("takes the token itself, so the actor that sees the tripwire can act on it", async () => {
    const { token, jti } = await mintOk();
    // Somebody else spends it first.
    const thief = cookieOf(await exchange(token));
    const tripped = await exchange(token);
    expect(tripped.status).toBe(409);

    // The actor holds only the token, and revokes with it.
    const res = await fetch(`${base}/console/tokens/${jti}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jti,
      status: "consumed",
      sessionEnded: true,
    });
    expect((await ui(thief)).status).toBe(401);
  });

  it("will not revoke by possession of a different token, or a wrong secret", async () => {
    const a = await mintOk();
    const b = await mintOk();
    for (const token of [b.token, `${a.jti}.${"E".repeat(43)}`]) {
      const res = await fetch(`${base}/console/tokens/${a.jti}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(401);
    }
    expect((await exchange(a.token)).status).toBe(200);
  });

  it("takes a Google session, as JSON only", async () => {
    const { jti } = await mintOk();
    const cookie = googleCookie();
    expect((await revoke(jti, { cookie })).status).toBe(415);
    const res = await revoke(jti, {
      cookie,
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
  });
});

// --- expiry ----------------------------------------------------------------

describe("expiry", () => {
  it("refuses a token past its ten minutes, and sets no cookie", async () => {
    const { token } = await mintOk();
    clock += TOKEN_TTL_MS + 1;
    const res = await exchange(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "token_expired" });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("exchanges a token just inside its window", async () => {
    const { token } = await mintOk();
    clock += TOKEN_TTL_MS - 1;
    expect((await exchange(token)).status).toBe(200);
  });

  it("ends the session at its absolute expiry", async () => {
    const cookie = await signedIn();
    clock += TOKEN_SESSION_TTL_MS - 1;
    expect((await ui(cookie)).status).toBe(200);
    clock += 1;
    expect((await ui(cookie)).status).toBe(401);
  });
});

// --- garbage ---------------------------------------------------------------

describe("unknown and garbled tokens", () => {
  it.each([
    ["garbage", "not-a-token"],
    ["an empty jti", ".abc"],
    ["a short secret", "0123456789abcdef.short"],
    ["an unknown but well-formed token", `0123456789abcdef.${"A".repeat(43)}`],
    ["the bootstrap token itself", BOOTSTRAP],
    ["a static /mcp token", staticAdmin.plaintext],
  ])("refuses %s with 401 and no cookie", async (_label, token) => {
    const res = await exchange(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("refuses a real jti with the wrong secret, without burning the token", async () => {
    const { token, jti } = await mintOk();
    const wrong = await exchange(`${jti}.${"B".repeat(43)}`);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: "invalid_token" });
    // Somebody who knows only the public half cannot spend the token.
    expect((await exchange(token)).status).toBe(200);
  });

  it("refuses a missing or non-string token with 400", async () => {
    for (const token of [undefined, "", 42, ["x"]]) {
      const res = await exchange(token);
      expect(res.status, JSON.stringify(token)).toBe(400);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  it("does not accept a forged or stale session cookie", async () => {
    const cookie = await signedIn();
    const [name, value] = cookie.split("=") as [string, string];
    const [sid] = value.split(".");
    expect((await ui(`${name}=${sid}.${"C".repeat(43)}`)).status).toBe(401);
    expect((await ui(`${name}=garbage`)).status).toBe(401);
  });
});

// --- the query string ------------------------------------------------------

describe("a token in the query string", () => {
  it("is refused before the body is read, sets no cookie, and burns the token", async () => {
    const { token } = await mintOk();
    const res = await fetch(
      `${base}/console/token-login?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "token_in_query" });
    expect(res.headers.getSetCookie()).toEqual([]);

    // It has been in a URL, so it is dead even when presented properly.
    const after = await exchange(token);
    expect(after.status).toBe(409);
    expect(await after.json()).toMatchObject({ error: "token_revoked" });
  });

  it.each([
    ["a GET", "GET", undefined],
    ["a malformed JSON body", "POST", "{not json"],
  ])("burns it on %s too", async (_label, method, body) => {
    const { token } = await mintOk();
    const res = await fetch(
      `${base}/console/token-login?token=${encodeURIComponent(token)}`,
      { method, headers: { "content-type": "application/json" }, body },
    );
    expect(res.status).toBe(400);
    expect((await exchange(token)).status).toBe(409);
  });

  it("burns every copy of a repeated parameter", async () => {
    const { token } = await mintOk();
    const q = encodeURIComponent(token);
    const res = await fetch(
      `${base}/console/token-login?token=${q}&token=${q}`,
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(400);
    expect((await exchange(token)).status).toBe(409);
  });

  it.each([
    [
      "an object-form parameter",
      (t: string) => `/console/token-login?token[a]=${t}`,
    ],
    [
      "a parameter of another name",
      (t: string) => `/console/token-login?t=${t}`,
    ],
    ["a path segment", (t: string) => `/console/token-login/${t}`],
    [
      "the revoke route's query",
      (t: string) => `/console/tokens/${t.slice(0, 16)}/revoke?token=${t}`,
    ],
    ["/mcp", (t: string) => `/mcp?token=${t}`],
    ["a login URL", (t: string) => `/console/login?token=${t}`],
    ["a percent-encoded dot", (t: string) => `/ui?x=${t.replace(".", "%2E")}`],
  ])("burns it in %s, wherever the URL points", async (_label, url) => {
    const { token } = await mintOk();
    await fetch(`${base}${url(token)}`, { method: "POST", redirect: "manual" });
    expect(await (await exchange(token)).json()).toMatchObject({
      error: "token_revoked",
    });
  });

  it("does not claim to burn a token that was already consumed", async () => {
    const { token } = await mintOk();
    expect((await exchange(token)).status).toBe(200);
    const res = await fetch(
      `${base}/console/token-login?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
    expect(((await res.json()) as { message: string }).message).toMatch(
      /already been exchanged or revoked/,
    );
    // Still consumed — the tripwire keeps saying so.
    expect(await (await exchange(token)).json()).toMatchObject({
      error: "token_consumed",
    });
  });

  it.each(["/ui", "/console", "/"])(
    "does not open %s as `?token=`, and burns the token there too",
    async (path) => {
      const { token } = await mintOk();
      const res = await ui(
        undefined,
        `${path}?token=${encodeURIComponent(token)}`,
      );
      expect(res.status).toBe(401);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect((await exchange(token)).status).toBe(409);
    },
  );
});

// --- authority ------------------------------------------------------------

describe("authority rides in the record", () => {
  it("narrows to a subset of the minter's roles on request", async () => {
    const { token } = await mintOk({ roles: ["echo-only"] });
    const res = await exchange(token);
    const cookie = cookieOf(res);
    const status = await fetch(`${base}/console`, { headers: { cookie } });
    expect(((await status.json()) as { roles: string[] }).roles).toEqual([
      "echo-only",
    ]);
  });

  it("refuses a role the minter does not hold", async () => {
    const res = await mint({ roles: ["admin", "root"] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "roles_exceed_minter" });
    expect((await mint({ roles: [] })).status).toBe(400);
    expect((await mint({ roles: "admin" })).status).toBe(400);
  });

  it("gives a Google minter's token the Google roles, and no more", async () => {
    const google = { cookie: googleCookie() };

    const res = await mint({}, google);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { roles: string[]; token: string };
    expect(body.roles).toEqual(["echo-only"]);
    expect((await mint({ roles: ["admin"] }, google)).status).toBe(403);
  });

  it("will not mint for a cookie without a JSON body, which a cross-origin page cannot send", async () => {
    const res = await fetch(`${base}/console/tokens`, {
      method: "POST",
      headers: { cookie: googleCookie() },
    });
    expect(res.status).toBe(415);
    const form = await fetch(`${base}/console/tokens`, {
      method: "POST",
      headers: {
        cookie: googleCookie(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "roles=echo-only",
    });
    expect(form.status).toBe(415);
  });

  it("refuses a misspelled or non-object body rather than minting the full roles", async () => {
    const typo = await mint({ role: ["echo-only"] });
    expect(typo.status).toBe(400);
    expect(await typo.json()).toMatchObject({ error: "unknown_field" });
    expect((await mint(["echo-only"])).status).toBe(400);
    const form = await fetch(`${base}/console/tokens`, {
      method: "POST",
      headers: {
        ...BEARER,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "roles=echo-only",
    });
    expect(form.status).toBe(415);
  });

  it("will not let a token session mint", async () => {
    const cookie = await signedIn();
    const res = await mint(undefined, { cookie });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: "standing_credential_required",
    });
  });

  it("will not mint without a credential, or from a query string", async () => {
    expect((await mint(undefined, {})).status).toBe(401);
    const res = await fetch(`${base}/console/tokens?token=${BOOTSTRAP}`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
    expect(
      (await mint(undefined, { authorization: "Bearer wrong" })).status,
    ).toBe(401);
  });

  it("bounds how many records one process holds, with a 429", async () => {
    let now = Date.now();
    const tokens = new ConsoleTokenStore({ now: () => now });
    const { srv, url } = await listen(STAGING, tokens);
    try {
      const post = () =>
        fetch(`${url}/console/tokens`, { method: "POST", headers: BEARER });
      for (let i = 0; i < MAX_RECORDS; i++)
        expect((await post()).status).toBe(201);
      const full = await post();
      expect(full.status).toBe(429);
      expect(await full.json()).toMatchObject({ error: "too_many_tokens" });
      // Expired records are forgotten, and the room comes back.
      now += TOKEN_TTL_MS + 1;
      expect((await post()).status).toBe(201);
    } finally {
      srv.close();
    }
  });
});

// --- sign-out --------------------------------------------------------------

describe("sign-out", () => {
  it("ends the session on the server, so a copy of the cookie dies too", async () => {
    const cookie = await signedIn();
    const out = await fetch(`${base}/console/logout`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(out.status).toBe(302);
    // The browser was told to drop it…
    expect(
      out.headers
        .getSetCookie()
        .some((c) => c.startsWith(`${TOKEN_SESSION_COOKIE}=;`)),
    ).toBe(true);
    // …and a copy kept elsewhere no longer opens anything.
    expect((await ui(cookie)).status).toBe(401);
  });
});

// --- hard-off in production ------------------------------------------------

describe("hard-off in production", () => {
  it.each([
    ["gateway.env: prod", "prod", true],
    ["gateway.env: production", "production", true],
    ["an env name nobody allowlisted (prd)", "prd", true],
    ["a padded staging", '" staging "', true],
    ["the flag off, on staging", "staging", false],
  ])("404s all three routes under %s", async (_label, env, enabled) => {
    const cfg = config(env, enabled);
    expect(consoleTokenLoginStatus(cfg).active).toBe(false);
    const { srv, url } = await listen(cfg, new ConsoleTokenStore());
    try {
      const auth = { authorization: `Bearer ${BOOTSTRAP}` };
      for (const path of [
        "/console/tokens",
        "/console/token-login",
        "/console/tokens/0123456789abcdef/revoke",
      ]) {
        const res = await fetch(`${url}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({ token: "x" }),
        });
        expect(res.status, path).toBe(404);
        expect(res.headers.getSetCookie()).toEqual([]);
      }
    } finally {
      srv.close();
    }
  });

  it("ignores a token session cookie where token login is off", async () => {
    // Belt and braces: even a store handed to the app is not consulted by the
    // gate on a deployment where the feature is off.
    const tokens = new ConsoleTokenStore();
    const { token } = tokens.mint(principal(["admin"]), ["admin"]);
    const result = tokens.exchange(token);
    if (!result.ok) throw new Error("exchange failed");
    const { srv, url } = await listen(config("prod", true), tokens);
    try {
      const res = await fetch(`${url}/ui`, {
        headers: { cookie: `${TOKEN_SESSION_COOKIE}=${result.cookie}` },
        redirect: "manual",
      });
      expect(res.status).toBe(401);
    } finally {
      srv.close();
    }
  });

  it("is decided by gateway.env, not NODE_ENV — staging runs NODE_ENV=production", () => {
    expect(ENV.NODE_ENV).toBe("production");
    expect(consoleTokenLoginStatus(STAGING)).toEqual({
      active: true,
      reason: "active",
    });
    for (const env of ["dev", "local", "test", "staging"]) {
      expect(consoleTokenLoginStatus(config(env, true)).active, env).toBe(true);
    }
  });

  it("defaults off in a config that never mentions it", () => {
    const cfg = parseConfig(
      "version: 1\ngateway: { env: staging }\nauth: {}\n",
    );
    expect(cfg.auth.consoleTokenLogin.enabled).toBe(false);
    expect(consoleTokenLoginStatus(cfg).active).toBe(false);
  });
});

// --- telemetry -------------------------------------------------------------

describe("the tripwire is an event, and only for a real token", () => {
  it("reports a replay of a verified token, and not a garbled one", async () => {
    const lines: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation((l) => {
      lines.push(String(l));
    });
    const out = vi.spyOn(console, "log").mockImplementation((l) => {
      lines.push(String(l));
    });
    try {
      const { token } = await mintOk();
      await exchange(token);
      await exchange(token);
      await exchange("garbage");
      const burnt = await mintOk();
      await fetch(`${base}/ui?token=${burnt.token}`, { redirect: "manual" });
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
    const events = lines
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const names = events.map((e) => e.evt);
    expect(names).toContain("console.token_minted");
    expect(names).toContain("console.token_exchanged");
    const tripped = events.filter(
      (e) => e.evt === "console.token_exchange_failed",
    );
    expect(tripped).toHaveLength(2);
    expect(tripped[0]).toMatchObject({ state: "token_consumed" });
    expect(tripped[1]).toMatchObject({ state: "burned_in_query" });
    expect(
      events.find((e) => e.evt === "console.token_login_refused"),
    ).toMatchObject({ reason: "invalid_token" });
    // Nothing carries the secret half.
    expect(lines.join("\n")).not.toMatch(/\.[A-Za-z0-9_-]{43}/);
  });
});

// --- /mcp is a different door ---------------------------------------------

describe("/mcp is unaffected", () => {
  it("refuses the login token and the session cookie", async () => {
    const { token } = await mintOk();
    const asBearer = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(asBearer.status).toBe(401);

    const cookie = await signedIn();
    const asCookie = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(asCookie.status).toBe(401);
  });

  it("still serves a static system token, with a session cookie riding along", async () => {
    const cookie = await signedIn();
    const transport = new StreamableHTTPClientTransport(
      new URL(`${base}/mcp`),
      {
        requestInit: {
          headers: { authorization: `Bearer ${staticAdmin.plaintext}`, cookie },
        },
      },
    );
    const client = new Client(
      { name: "t", version: "1" },
      { capabilities: {} },
    );
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.name.startsWith("echo__"))).toBe(true);
    await client.close();
  });
});

/** One request over `agent`, so a test decides which sockets carry it. */
function raw(
  agent: http.Agent,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path}`,
      {
        method,
        agent,
        headers: body ? { "content-type": "application/json" } : {},
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            setCookie: res.headers["set-cookie"] ?? [],
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** A sealed Google session cookie for a verified tadasant.com identity. */
function googleCookie(): string {
  const sealer = consoleSessionsFromEnv(ENV)?.session;
  if (!sealer) throw new Error("no session key");
  const payload: ConsoleSessionPayload = {
    v: 1,
    sub: "42",
    email: "tadas@tadasant.com",
    hd: "tadasant.com",
    iat: Date.now(),
    exp: Date.now() + 60_000,
  };
  return `${SESSION_COOKIE}=${sealer.seal(payload)}`;
}

function principal(roles: string[]): Principal {
  return { kind: "console-bypass", id: "dev-bypass", label: "bypass", roles };
}
