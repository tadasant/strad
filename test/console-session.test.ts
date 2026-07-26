import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import type { GoogleIdentity, PendingAuth } from "../src/auth/google.ts";
import {
  consoleSessionsFromEnv,
  principalFromSession,
  sanitizeNext,
  Sealer,
  SESSION_TTL_MS,
  sessionKeyProblem,
  stateMatches,
  type ConsoleSessionPayload,
} from "../src/auth/session.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import {
  createApp,
  resolveConsoleAuth,
  type ConsoleOAuthProvider,
} from "../src/http/app.ts";

/**
 * Google sign-in as a first-class console credential.
 *
 * The thing under test is the primitive that did not exist: a verified Google
 * identity becoming a SESSION that `requireConsoleUi` accepts. A real round-trip
 * needs accounts.google.com, so the provider is stubbed at the one boundary that
 * talks to Google — everything downstream of `completeAuth()` is the real code
 * path: the real callback route, the real signed cookie, the real gate.
 *
 * Two invariants are load-bearing and easy to regress:
 *   1. The dev bypass keeps working alongside Google. Staging depends on it, and
 *      removing it is a separate change.
 *   2. `auth.google.enabled` without usable credentials must NOT turn the honest
 *      401 into a redirect into a flow that cannot complete.
 */

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test, publicUrl: "https://strad.example.com" }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
  google:
    enabled: true
    hostedDomain: tadasant.com
    roles: [admin]
roles:
  admin: { servers: ["*"] }
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`);

const BOOTSTRAP = "bootstrap-secret-xyz";
const CLIENT_SECRET = "google-client-secret-abc";

const IDENTITY: GoogleIdentity = {
  sub: "1029384756",
  email: "tadas@tadasant.com",
  hd: "tadasant.com",
  name: "Tadas",
};

/**
 * The stub. `beginAuth()` mints the same shape the real provider does;
 * `completeAuth()` stands in for "Google verified this ID token and the `hd`
 * claim matched", which is what src/auth/google.ts asserts before returning.
 */
class FakeGoogle implements ConsoleOAuthProvider {
  identity: GoogleIdentity = IDENTITY;
  failWith: Error | null = null;
  lastVerifier: string | null = null;
  private n = 0;

  beginAuth(): PendingAuth {
    const state = `state-${++this.n}`;
    const codeVerifier = `verifier-${this.n}`;
    return {
      state,
      codeVerifier,
      url: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    };
  }

  async completeAuth(_code: string, codeVerifier: string) {
    this.lastVerifier = codeVerifier;
    if (this.failWith) throw this.failWith;
    return this.identity;
  }
}

// --- pure units ------------------------------------------------------------

describe("Sealer", () => {
  const s = new Sealer("ikm", "info.a");

  it("round-trips a payload", () => {
    const token = s.seal({ v: 1, hello: "world", exp: Date.now() + 1000 });
    expect(s.unseal<{ v: 1; hello: string; exp: number }>(token)?.hello).toBe(
      "world",
    );
  });

  it("refuses a payload of another version, sealed or not", () => {
    // The version tag is what stops a future v2 being read as a v1 under the
    // same key. It only earns its place if unseal enforces it.
    expect(s.unseal(s.seal({ v: 2, exp: Date.now() + 1000 }))).toBeNull();
    expect(s.unseal(s.seal({ exp: Date.now() + 1000 }))).toBeNull();
  });

  it("rejects a tampered payload", () => {
    // A fixed expiry, so the sealed body — and with it the MAC — is identical on
    // every run, and no assertion below can pass because the payload expired
    // rather than because the MAC failed.
    const exp = 4_102_444_800_000; // 2100-01-01
    const token = s.seal({ v: 1, role: "viewer", exp });
    const [body, mac] = token.split(".") as [string, string];
    // The control: every token below differs from this valid one by exactly the
    // tamper, so a null can only be the tamper.
    expect(s.unseal(token)).not.toBeNull();
    const forged = Buffer.from(
      JSON.stringify({ v: 1, role: "admin", exp }),
      "utf8",
    ).toString("base64url");
    // Tamper at the BYTE level. The MAC is a 32-byte digest in 43 base64url
    // characters, so the last character carries only 4 significant bits: it is
    // one of 16 values, and its two low bits are dropped on decode. Rewriting
    // only that character to a constant is a no-op one run in sixteen — whenever
    // the genuine MAC already ends in that character, it rebuilds the valid
    // token. Flipping every byte is unconditional.
    const tampered = Buffer.from(
      Buffer.from(mac, "base64url").map((b) => b ^ 0xff),
    ).toString("base64url");
    expect(s.unseal(`${forged}.${mac}`)).toBeNull();
    expect(s.unseal(`${body}.${tampered}`)).toBeNull();
    expect(s.unseal("garbage")).toBeNull();
    expect(s.unseal(undefined)).toBeNull();
  });

  it("rejects an expired payload", () => {
    expect(s.unseal(s.seal({ v: 1, exp: Date.now() - 1 }))).toBeNull();
  });

  it("rejects a payload sealed under a different key or a different purpose", () => {
    const other = new Sealer("ikm", "info.b");
    const otherIkm = new Sealer("different", "info.a");
    const token = s.seal({ v: 1, exp: Date.now() + 1000 });
    expect(other.unseal(token)).toBeNull();
    expect(otherIkm.unseal(token)).toBeNull();
  });
});

describe("consoleSessionsFromEnv", () => {
  it("is null with no key material, so the gate cannot offer a broken sign-in", () => {
    expect(consoleSessionsFromEnv({})).toBeNull();
  });

  it("refuses a key short enough to brute-force, rather than signing with it", () => {
    // The payload format is public in session.ts, so a weak key is a forgery
    // oracle. Failing closed is the only safe answer.
    expect(
      consoleSessionsFromEnv({ CONSOLE_SESSION_SECRET: "dev" }),
    ).toBeNull();
    expect(sessionKeyProblem({ CONSOLE_SESSION_SECRET: "dev" })).toContain(
      "forgeable",
    );
    // A real Google client secret (GOCSPX- + 28 chars) clears the floor.
    expect(
      consoleSessionsFromEnv({
        GOOGLE_CLIENT_SECRET: "GOCSPX-0123456789abcdefghijklmnop",
      }),
    ).not.toBeNull();
    expect(sessionKeyProblem(ENV)).toBeNull();
  });

  it("derives from GOOGLE_CLIENT_SECRET, and CONSOLE_SESSION_SECRET overrides it", () => {
    const a = consoleSessionsFromEnv({ GOOGLE_CLIENT_SECRET: CLIENT_SECRET });
    const b = consoleSessionsFromEnv({
      GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      CONSOLE_SESSION_SECRET: "an-explicitly-rotated-console-key",
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const token = a!.session.seal({ v: 1, exp: Date.now() + 1000 });
    // Rotating the key invalidates every session — the kill switch.
    expect(b!.session.unseal(token)).toBeNull();
  });
});

describe("principalFromSession", () => {
  const base: ConsoleSessionPayload = {
    v: 1,
    sub: "sub-1",
    email: "tadas@tadasant.com",
    hd: "tadasant.com",
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
  };

  it("maps a verified identity to the roles from config, not from the cookie", () => {
    const p = principalFromSession(base, CONFIG);
    expect(p).toEqual({
      kind: "google",
      id: "sub-1",
      label: "tadas@tadasant.com",
      roles: ["admin"],
    });
  });

  it("rejects a session whose hd is not the configured Workspace", () => {
    expect(
      principalFromSession({ ...base, hd: "evil.com" }, CONFIG),
    ).toBeNull();
  });
});

describe("sanitizeNext", () => {
  it("keeps same-origin paths and refuses everything else", () => {
    expect(sanitizeNext("/ui/secrets")).toBe("/ui/secrets");
    expect(sanitizeNext("/ui?x=1")).toBe("/ui?x=1");
    expect(sanitizeNext("//evil.example/x")).toBe("/ui");
    expect(sanitizeNext("https://evil.example")).toBe("/ui");
    expect(sanitizeNext("/\\evil.example")).toBe("/ui");
    expect(sanitizeNext("/ui\r\nSet-Cookie: x=1")).toBe("/ui");
    // A browser strips TAB while parsing, so this would resolve as
    // "//evil.example" — the guard must not lean on Express escaping it.
    expect(sanitizeNext("/\t/evil.example")).toBe("/ui");
    expect(sanitizeNext("/ui\f")).toBe("/ui");
    expect(sanitizeNext(undefined)).toBe("/ui");
    expect(sanitizeNext(42)).toBe("/ui");
  });
});

describe("stateMatches", () => {
  it("is exact and refuses empties", () => {
    expect(stateMatches("abc", "abc")).toBe(true);
    expect(stateMatches("abc", "abd")).toBe(false);
    expect(stateMatches("abc", "abcd")).toBe(false);
    expect(stateMatches("", "")).toBe(false);
  });
});

describe("resolveConsoleAuth", () => {
  const opts = { config: CONFIG } as Parameters<typeof resolveConsoleAuth>[0];

  it("prints the exact redirect URI to register, which is the one thing the process cannot check", () => {
    const lines: string[] = [];
    const auth = resolveConsoleAuth(
      opts,
      { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: CLIENT_SECRET },
      (m) => lines.push(m),
    );
    expect(auth.ready).toBe(true);
    expect(auth.redirectUri).toBe(
      "https://strad.example.com/console/oauth/callback",
    );
    expect(lines.join("\n")).toContain(auth.redirectUri);
  });

  it("is not ready, and says why, when the OAuth client is not seeded", () => {
    const lines: string[] = [];
    const auth = resolveConsoleAuth(opts, {}, (m) => lines.push(m));
    expect(auth.ready).toBe(false);
    expect(lines.join("\n")).toContain("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET");
  });

  it("is not ready, and says why, when there is no session key", () => {
    const lines: string[] = [];
    const auth = resolveConsoleAuth(
      { ...opts, googleProvider: new FakeGoogle() },
      {},
      (m) => lines.push(m),
    );
    expect(auth.ready).toBe(false);
    expect(lines.join("\n")).toContain("CONSOLE_SESSION_SECRET");
  });
});

// --- through the real Express app ------------------------------------------

const ENV: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  STRAD_TOKENS: "[]",
};

const google = new FakeGoogle();

let server: Server;
let baseUrl: string;
/** The same app with auth.google.enabled but no OAuth client credentials. */
let unconfigured: Server;
let unconfiguredUrl: string;

async function listen(
  app: ReturnType<typeof createApp>,
): Promise<[Server, string]> {
  const s = await new Promise<Server>((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
  const addr = s.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return [s, `http://127.0.0.1:${addr.port}`];
}

beforeAll(async () => {
  const registry = await Registry.build({
    config: CONFIG,
    secrets: new EnvSecretProvider({}),
    mode: "core",
    env: ENV,
  });
  [server, baseUrl] = await listen(
    createApp({
      config: CONFIG,
      registry,
      tokenStore: tokenStoreFromConfig(CONFIG, ENV),
      mode: "core",
      env: ENV,
      googleProvider: google,
    }),
  );

  const bareEnv: NodeJS.ProcessEnv = { STRAD_TOKENS: "[]" };
  [unconfigured, unconfiguredUrl] = await listen(
    createApp({
      config: CONFIG,
      registry: await Registry.build({
        config: CONFIG,
        secrets: new EnvSecretProvider({}),
        mode: "core",
        env: bareEnv,
      }),
      tokenStore: tokenStoreFromConfig(CONFIG, bareEnv),
      mode: "core",
      env: bareEnv,
      googleProvider: null,
    }),
  );
});

afterAll(() => {
  server?.close();
  unconfigured?.close();
});

/** Every Set-Cookie on a response, joined as a request `Cookie` header. */
function cookieJar(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter((c) => !c.endsWith("=")) // a cleared cookie
    .join("; ");
}

function setCookieFor(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

/** Drive a full login and return the session cookie header. */
async function signIn(next = "/ui"): Promise<{
  cookie: string;
  callback: Response;
}> {
  const begin = await fetch(
    `${baseUrl}/console/login?next=${encodeURIComponent(next)}`,
    { redirect: "manual" },
  );
  const tx = cookieJar(begin);
  const state = new URL(begin.headers.get("location") ?? "").searchParams.get(
    "state",
  );

  const callback = await fetch(
    `${baseUrl}/console/oauth/callback?code=auth-code&state=${state}`,
    { redirect: "manual", headers: { cookie: tx } },
  );
  return { cookie: cookieJar(callback), callback };
}

describe("beginning a Google login", () => {
  it("the gate redirects an unauthenticated /ui request into the login, preserving the page", async () => {
    const res = await fetch(`${baseUrl}/ui/echo?prefix=a`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/console/login?next=%2Fui%2Fecho%3Fprefix%3Da",
    );
  });

  it("stores the PKCE verifier and state in a signed, HttpOnly, short-lived cookie — not on the server", async () => {
    const res = await fetch(`${baseUrl}/console/login?next=/ui/secrets`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("accounts.google.com");

    const tx = setCookieFor(res, "strad_oauth_tx") ?? "";
    expect(tx.toLowerCase()).toContain("httponly");
    expect(tx.toLowerCase()).toContain("samesite=lax");
    expect(tx).toContain("Path=/console");
    // Ten minutes, so an abandoned login cleans itself up.
    expect(tx).toContain("Max-Age=600");
    // The verifier must not be readable — it is sealed, not plaintext.
    expect(tx).not.toContain("verifier-");
  });
});

describe("the callback mints a session", () => {
  it("verifies, sets a signed session cookie, and redirects to the requested page", async () => {
    const { cookie, callback } = await signIn("/ui/secrets");

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/ui/secrets");
    // The exchange used the verifier from the cookie, not a server-side map.
    expect(google.lastVerifier).toMatch(/^verifier-/);

    const session = setCookieFor(callback, "strad_console_session") ?? "";
    expect(session.toLowerCase()).toContain("httponly");
    expect(session.toLowerCase()).toContain("samesite=lax");
    expect(session).toContain("Path=/");
    expect(session).toContain("Max-Age=43200");
    // The transaction is spent, whatever happened.
    expect(setCookieFor(callback, "strad_oauth_tx")).toBeTruthy();
    expect(cookie).toContain("strad_console_session=");

    // …and it is JSON no longer.
    expect(callback.headers.get("content-type") ?? "").not.toContain("json");
  });

  it("sets Secure under NODE_ENV=production", async () => {
    const prodEnv = { ...ENV, NODE_ENV: "production" };
    const app = createApp({
      config: CONFIG,
      registry: await Registry.build({
        config: CONFIG,
        secrets: new EnvSecretProvider({}),
        mode: "core",
        env: prodEnv,
      }),
      tokenStore: tokenStoreFromConfig(CONFIG, prodEnv),
      mode: "core",
      env: prodEnv,
      googleProvider: new FakeGoogle(),
    });
    const [srv, url] = await listen(app);
    try {
      const begin = await fetch(`${url}/console/login`, { redirect: "manual" });
      expect(setCookieFor(begin, "strad_oauth_tx")).toContain("Secure");
    } finally {
      srv.close();
    }
  });

  it("treats a malformed cookie as no cookie, not as a 500", async () => {
    // `decodeURIComponent` throws on a stray `%`, and the gate reads cookies on
    // every request — an undecodable one must be a sign-in wall, not a crash.
    for (const cookie of [
      "strad_console_session=abc%",
      "strad_oauth_tx=%E0%A4%A",
      "strad_console=%",
    ]) {
      const res = await fetch(`${baseUrl}/ui`, {
        headers: { cookie },
        redirect: "manual",
      });
      expect(res.status, cookie).toBe(302);
      expect(res.headers.get("location")).toContain("/console/login");
    }
  });

  it("refuses a callback with no transaction cookie (stale tab, or CSRF)", async () => {
    const res = await fetch(
      `${baseUrl}/console/oauth/callback?code=c&state=state-999`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_state" });
    expect(setCookieFor(res, "strad_console_session")).toBeUndefined();
  });

  it("refuses a callback whose state is not the one this browser began", async () => {
    const begin = await fetch(`${baseUrl}/console/login`, {
      redirect: "manual",
    });
    const res = await fetch(
      `${baseUrl}/console/oauth/callback?code=c&state=attacker-state`,
      { redirect: "manual", headers: { cookie: cookieJar(begin) } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "state_mismatch" });
    expect(setCookieFor(res, "strad_console_session")).toBeUndefined();
  });

  it("issues nothing when Google rejects the identity", async () => {
    const { AuthError } = await import("../src/auth/google.ts");
    google.failWith = new AuthError(
      "account is not a member of the tadasant.com Google Workspace",
    );
    try {
      const { callback } = await signIn();
      expect(callback.status).toBe(403);
      expect(setCookieFor(callback, "strad_console_session")).toBeUndefined();
    } finally {
      google.failWith = null;
    }
  });

  it("spends the transaction cookie, so a browser cannot re-enter the flow", async () => {
    // Precisely what this buys: the SERVER tells the browser to drop the
    // cookie, so a stale tab cannot re-run the exchange. It is not a server-side
    // one-shot — a script that kept the value can present it again, and what
    // stops that replay is Google's authorization code being single-use.
    const begin = await fetch(`${baseUrl}/console/login`, {
      redirect: "manual",
    });
    const tx = cookieJar(begin);
    const state = new URL(begin.headers.get("location") ?? "").searchParams.get(
      "state",
    );
    const url = `${baseUrl}/console/oauth/callback?code=c&state=${state}`;

    const first = await fetch(url, {
      redirect: "manual",
      headers: { cookie: tx },
    });
    expect(first.status).toBe(302);
    const cleared = setCookieFor(first, "strad_oauth_tx") ?? "";
    expect(cleared).toContain("strad_oauth_tx=;");
    expect(cleared).toContain("Expires=Thu, 01 Jan 1970");
    // Which is to say: the browser that followed that instruction has nothing
    // left to replay with.
    expect(cookieJar(first)).not.toContain("strad_oauth_tx=");
  });
});

describe("the session is a first-class console principal", () => {
  it("reaches /ui and /ui/secrets, labelled with the Google identity", async () => {
    const { cookie } = await signIn();
    for (const path of ["/", "/ui", "/ui/echo"]) {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { cookie },
        redirect: "manual",
      });
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain("tadas@tadasant.com");
    }
  });

  it("/console reports the Google session rather than looping back through consent", async () => {
    const { cookie } = await signIn();
    const res = await fetch(`${baseUrl}/console`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      signedInAs: "tadas@tadasant.com",
      via: "google",
      hd: "tadasant.com",
      roles: ["admin"],
    });
  });

  it("a forged or tampered session cookie is not a session", async () => {
    const { cookie } = await signIn();
    const value = cookie.split("strad_console_session=")[1] ?? "";
    const [body, mac] = value.split(".") as [string, string];

    const forgedBody = Buffer.from(
      JSON.stringify({
        v: 1,
        sub: "x",
        email: "attacker@evil.com",
        hd: "tadasant.com",
        iat: Date.now(),
        exp: Date.now() + SESSION_TTL_MS,
      }),
      "utf8",
    ).toString("base64url");

    for (const forged of [
      `${forgedBody}.${mac}`,
      `${body}.${"A".repeat(mac.length)}`,
      "not-even-close",
    ]) {
      const res = await fetch(`${baseUrl}/ui`, {
        headers: { cookie: `strad_console_session=${forged}` },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/console/login");
    }
  });

  it("an expired session is not a session", async () => {
    const sessions = consoleSessionsFromEnv(ENV)!;
    const expired = sessions.session.seal({
      v: 1,
      sub: "sub",
      email: "tadas@tadasant.com",
      hd: "tadasant.com",
      iat: Date.now() - SESSION_TTL_MS - 1000,
      exp: Date.now() - 1000,
    });
    const res = await fetch(`${baseUrl}/ui`, {
      headers: { cookie: `strad_console_session=${expired}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
  });

  it("a session for another Workspace is not a session here", async () => {
    const sessions = consoleSessionsFromEnv(ENV)!;
    const wrongHd = sessions.session.seal({
      v: 1,
      sub: "sub",
      email: "someone@evil.com",
      hd: "evil.com",
      iat: Date.now(),
      exp: Date.now() + SESSION_TTL_MS,
    });
    const res = await fetch(`${baseUrl}/ui`, {
      headers: { cookie: `strad_console_session=${wrongHd}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
  });

  it("an OAuth transaction cookie cannot be replayed as a session", async () => {
    const begin = await fetch(`${baseUrl}/console/login`, {
      redirect: "manual",
    });
    const tx =
      (setCookieFor(begin, "strad_oauth_tx") ?? "").split(";")[0] ?? "";
    const value = tx.split("=").slice(1).join("=");
    const res = await fetch(`${baseUrl}/ui`, {
      headers: { cookie: `strad_console_session=${value}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
  });

  it("signs out of BOTH credentials, not just the Google one", async () => {
    // A human who entered with the bootstrap token — which is everyone on
    // staging today — must not be left signed in by "sign out".
    const { cookie } = await signIn();
    const bypass = await fetch(`${baseUrl}/ui?token=${BOOTSTRAP}`, {
      redirect: "manual",
    });
    const both = `${cookie}; ${cookieJar(bypass)}`;

    const out = await fetch(`${baseUrl}/console/logout`, {
      headers: { cookie: both },
      redirect: "manual",
    });
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("/");
    expect(setCookieFor(out, "strad_console_session")).toContain(
      "strad_console_session=;",
    );
    expect(setCookieFor(out, "strad_console")).toContain("strad_console=;");

    // And the jar the browser is left holding opens nothing.
    const after = await fetch(`${baseUrl}/ui`, {
      headers: { cookie: cookieJar(out) },
      redirect: "manual",
    });
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toContain("/console/login");
  });

  it("a shadowing duplicate cookie cannot lock a signed-in human out", async () => {
    // Anything holding a sibling subdomain can set Domain=.strad.tadasant.com
    // with a longer Path, and RFC 6265 sends that one FIRST. Reading only the
    // first value would turn that into a lockout.
    const { cookie } = await signIn();
    const res = await fetch(`${baseUrl}/ui`, {
      headers: { cookie: `strad_console_session=garbage; ${cookie}` },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("tadas@tadasant.com");
  });
});

describe("the dev bypass still works alongside Google", () => {
  it("accepts the bootstrap token and still moves it into a cookie", async () => {
    const res = await fetch(`${baseUrl}/ui?token=${BOOTSTRAP}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ui");
    expect(setCookieFor(res, "strad_console")).toBeTruthy();

    const page = await fetch(`${baseUrl}/ui`, {
      headers: { cookie: cookieJar(res) },
      redirect: "manual",
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("console dev bypass");
  });

  it("still answers /console with the bypass warning", async () => {
    const res = await fetch(`${baseUrl}/console?token=${BOOTSTRAP}`);
    expect(await res.json()).toMatchObject({ via: "dev-bypass" });
  });
});

describe("auth.google.enabled without credentials", () => {
  it("keeps the honest 401 instead of redirecting into a flow that cannot complete", async () => {
    const res = await fetch(`${unconfiguredUrl}/ui`, { redirect: "manual" });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Sign in required");
  });

  it("404s the login and the callback rather than pretending", async () => {
    for (const path of ["/console/login", "/console/oauth/callback"]) {
      const res = await fetch(`${unconfiguredUrl}${path}`, {
        redirect: "manual",
      });
      expect(res.status, path).toBe(404);
    }
  });
});
