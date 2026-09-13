import type { Server } from "node:http";
import type { Response as ExpressResponse } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import type { GoogleIdentity, PendingAuth } from "../src/auth/google.ts";
import {
  consoleSessionsFromEnv,
  issueSessionCookie,
  principalFromSession,
  renewSessionIfDue,
  sessionDeadline,
  sessionWindows,
  SESSION_COOKIE,
  type ConsoleSessionPayload,
  type SessionWindows,
} from "../src/auth/session.ts";
import { parseConfig } from "../src/config/load.ts";
import type { StradConfig } from "../src/config/schema.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp, type ConsoleOAuthProvider } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import { googleSession } from "../src/ui/console-auth.ts";

/**
 * The console session slides (#46): a cookie past half its window is re-issued
 * with a fresh `exp` and the SAME sign-in time, and an absolute cap counted from
 * that sign-in refuses it however recently it was renewed.
 *
 * The cap is the thing to be paranoid about. Renewal is what lets a stolen
 * cookie that keeps being used keep itself alive, so every way a payload could
 * arrive without a usable sign-in time — tampered, legacy, malformed — has to
 * land on "capped" or "refused", never on "uncapped".
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);

function config(session = ""): StradConfig {
  return parseConfig(`
version: 1
gateway: { name: strad, env: test, publicUrl: "https://strad.example.com" }
auth:
  staticTokens: { enabled: true }
  google:
    enabled: true
    hostedDomain: tadasant.com
    roles: [admin]
${session}
roles:
  admin: { servers: ["*"] }
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`);
}

/** No `session:` block: the defaults, 48h sliding and 7d absolute. */
const DEFAULT_CONFIG = config();
const DEFAULTS = sessionWindows(DEFAULT_CONFIG);

const ENV: NodeJS.ProcessEnv = {
  STRAD_TOKENS: "[]",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret-for-renewal-tests",
};
const sessions = consoleSessionsFromEnv(ENV)!;

const IDENTITY: GoogleIdentity = {
  sub: "1029384756",
  email: "tadas@tadasant.com",
  hd: "tadasant.com",
  name: "Tadas",
};

/** A session signed in at `authAt` and last (re-)sealed at `iat`. */
function payload(
  over: Partial<ConsoleSessionPayload> & { iat: number },
): ConsoleSessionPayload {
  return {
    v: 1,
    sub: IDENTITY.sub,
    email: IDENTITY.email,
    hd: IDENTITY.hd,
    name: IDENTITY.name,
    authAt: over.iat,
    exp: over.iat + DEFAULTS.slidingMs,
    ...over,
  };
}

/** The payload a sealed cookie value carries. Signed, not encrypted. */
function decode(value: string): ConsoleSessionPayload {
  const body = value.slice(0, value.lastIndexOf("."));
  return JSON.parse(
    Buffer.from(body, "base64url").toString("utf8"),
  ) as ConsoleSessionPayload;
}

/** A stand-in for express's `res.cookie`, recording what would be sent. */
function recorder(): {
  res: ExpressResponse;
  cookies: { name: string; value: string; maxAge?: number }[];
} {
  const cookies: { name: string; value: string; maxAge?: number }[] = [];
  const res = {
    cookie(name: string, value: string, opts: { maxAge?: number }) {
      cookies.push({ name, value, maxAge: opts.maxAge });
      return res;
    },
  } as unknown as ExpressResponse;
  return { res, cookies };
}

function renew(
  p: ConsoleSessionPayload,
  windows: SessionWindows = DEFAULTS,
  now = NOW,
) {
  const { res, cookies } = recorder();
  const renewed = renewSessionIfDue(res, sessions.session, p, windows, {}, now);
  return { renewed, cookies };
}

// --- the config field ------------------------------------------------------

describe("auth.google.session", () => {
  it("defaults to 48 hours sliding and 7 days absolute", () => {
    expect(DEFAULT_CONFIG.auth.google?.session).toEqual({
      slidingTtlSeconds: 172800,
      absoluteTtlSeconds: 604800,
    });
    expect(DEFAULTS).toEqual({ slidingMs: 2 * DAY, absoluteMs: 7 * DAY });
  });

  it("refuses a cap shorter than one cookie", () => {
    expect(() =>
      config(
        "    session: { slidingTtlSeconds: 7200, absoluteTtlSeconds: 3600 }",
      ),
    ).toThrow(/auth\.google\.session\.absoluteTtlSeconds: .*at least/);
  });

  it("refuses a cap past 30 days, so config cannot mint a permanent credential", () => {
    expect(() =>
      config("    session: { absoluteTtlSeconds: 2592001 }"),
    ).toThrow(/absoluteTtlSeconds/);
    // Milliseconds written where seconds belong trip the same ceiling.
    expect(() =>
      config("    session: { slidingTtlSeconds: 43200000 }"),
    ).toThrow(/slidingTtlSeconds/);
  });

  it("fills in the default for whichever clock a partial block leaves out", () => {
    expect(
      sessionWindows(config("    session: { slidingTtlSeconds: 3600 }")),
    ).toEqual({ slidingMs: HOUR, absoluteMs: 7 * DAY });
    expect(
      sessionWindows(config("    session: { absoluteTtlSeconds: 259200 }")),
    ).toEqual({ slidingMs: 2 * DAY, absoluteMs: 3 * DAY });
    // A sliding window past the DEFAULT cap, with the cap left unset, is refused
    // and the message says what the cap defaulted to.
    expect(() => config("    session: { slidingTtlSeconds: 691200 }")).toThrow(
      /defaults to 604800/,
    );
  });

  it("refuses a window under a minute — hours written as seconds", () => {
    expect(() => config("    session: { slidingTtlSeconds: 12 }")).toThrow(
      /slidingTtlSeconds/,
    );
  });
});

// --- minting ---------------------------------------------------------------

describe("the callback's cookie", () => {
  it("records the sign-in, and lives one sliding window", () => {
    const { res, cookies } = recorder();
    issueSessionCookie(res, sessions.session, IDENTITY, DEFAULTS, {}, NOW);

    expect(cookies).toHaveLength(1);
    const [c] = cookies;
    expect(c?.name).toBe(SESSION_COOKIE);
    expect(c?.maxAge).toBe(2 * DAY);
    expect(decode(c?.value ?? "")).toMatchObject({
      iat: NOW,
      authAt: NOW,
      exp: NOW + 2 * DAY,
    });
  });
});

// --- renewal ---------------------------------------------------------------

describe("renewal", () => {
  it("re-issues a cookie past half its window, with the sign-in time unchanged", () => {
    const signedIn = NOW - 3 * DAY;
    // Last renewed 25 hours ago, so 23 of its 48 hours are left.
    const p = payload({ iat: NOW - 25 * HOUR, authAt: signedIn });
    expect(principalFromSession(p, DEFAULT_CONFIG, NOW)).not.toBeNull();

    const { renewed, cookies } = renew(p);
    expect(renewed).toBe(true);
    expect(cookies).toHaveLength(1);
    const next = decode(cookies[0]?.value ?? "");
    expect(next.authAt).toBe(signedIn);
    expect(next.iat).toBe(NOW);
    expect(next.exp).toBe(NOW + 2 * DAY);
    expect(cookies[0]?.maxAge).toBe(2 * DAY);
    // The identity is copied forward, and nothing else rides along.
    expect(next).toEqual({
      v: 1,
      sub: IDENTITY.sub,
      email: IDENTITY.email,
      hd: IDENTITY.hd,
      name: IDENTITY.name,
      iat: NOW,
      authAt: signedIn,
      exp: NOW + 2 * DAY,
    });
    // …and what it issued is a session the key accepts.
    expect(
      sessions.session.unseal<ConsoleSessionPayload>(cookies[0]?.value, NOW),
    ).toEqual(next);
  });

  it("does not re-issue a cookie younger than half its window", () => {
    for (const age of [0, 1 * HOUR, 23 * HOUR, 24 * HOUR]) {
      const { renewed, cookies } = renew(payload({ iat: NOW - age }));
      expect(renewed, `${age / HOUR}h old`).toBe(false);
      expect(cookies, `${age / HOUR}h old`).toHaveLength(0);
    }
  });

  it("never renews past the absolute cap, and stops re-sending once it cannot extend", () => {
    const signedIn = NOW - 6 * DAY;
    // 30 hours into its window, with 18 hours left and the cap 24 hours away.
    const p = payload({ iat: NOW - 30 * HOUR, authAt: signedIn });
    const { cookies } = renew(p);
    const next = decode(cookies[0]?.value ?? "");
    expect(next.exp).toBe(signedIn + 7 * DAY);
    expect(cookies[0]?.maxAge).toBe(DAY);

    // That cookie is already as long-lived as the cap allows. Past half of what
    // is left, renewing again would only re-send the same `exp`.
    const again = renew(next, DEFAULTS, NOW + 20 * HOUR);
    expect(again.renewed).toBe(false);
    expect(again.cookies).toHaveLength(0);
  });

  it("will not renew a session that is no longer live", () => {
    const capped = payload({
      iat: NOW - 30 * HOUR,
      authAt: NOW - 7 * DAY - 1,
    });
    expect(renew(capped).renewed).toBe(false);
  });
});

// --- the absolute cap ------------------------------------------------------

describe("the absolute cap", () => {
  it("refuses a session past it even though it was renewed an hour ago", () => {
    const p = payload({ iat: NOW - HOUR, authAt: NOW - 7 * DAY - 1000 });
    // The cookie's own `exp` is 47 hours out: the sealer alone would take it.
    expect(sessions.session.unseal(sessions.session.seal(p), NOW)).toEqual(p);
    expect(principalFromSession(p, DEFAULT_CONFIG, NOW)).toBeNull();
    // One millisecond inside the cap, the same cookie is a session.
    expect(
      principalFromSession(
        { ...p, authAt: NOW - 7 * DAY + 1 },
        DEFAULT_CONFIG,
        NOW,
      ),
    ).not.toBeNull();
  });

  it("holds across every renewal a cookie in constant use could get", () => {
    // A thief who uses the cookie every hour, from sign-in onwards.
    const { res, cookies } = recorder();
    issueSessionCookie(res, sessions.session, IDENTITY, DEFAULTS, {}, NOW);
    let current = decode(cookies[0]?.value ?? "");
    let lastLive = NOW;
    for (let t = NOW; t < NOW + 30 * DAY; t += HOUR) {
      if (!principalFromSession(current, DEFAULT_CONFIG, t)) break;
      lastLive = t;
      const r = renew(current, DEFAULTS, t);
      if (r.renewed) current = decode(r.cookies[0]?.value ?? "");
    }
    expect(current.authAt).toBe(NOW);
    expect(lastLive).toBeLessThan(NOW + 7 * DAY);
    expect(lastLive).toBeGreaterThanOrEqual(NOW + 7 * DAY - HOUR);
  });
});

// --- payloads that could try to dodge it -----------------------------------

describe("a tampered or legacy payload cannot get around the cap", () => {
  it("a sign-in time edited into the cookie breaks its MAC", () => {
    const sealed = sessions.session.seal(
      payload({ iat: NOW - HOUR, authAt: NOW - 8 * DAY }),
    );
    const [, mac] = sealed.split(".") as [string, string];
    const edited = Buffer.from(
      JSON.stringify(payload({ iat: NOW - HOUR, authAt: NOW })),
      "utf8",
    ).toString("base64url");
    expect(sessions.session.unseal(`${edited}.${mac}`, NOW)).toBeNull();
  });

  it("a legacy cookie with no sign-in time is bounded from its iat, never left uncapped", () => {
    const legacy = payload({ iat: NOW - 8 * DAY, exp: NOW + HOUR });
    delete legacy.authAt;
    // A finite deadline measured from `iat`: the missing field is not a bypass.
    expect(sessionDeadline(legacy, DEFAULTS)).toBe(legacy.iat + 2 * DAY);
    // And the CAP term counts from `iat` too — isolated by a window long enough
    // that the cap, not the window, is what binds.
    expect(
      sessionDeadline(
        { ...legacy, exp: legacy.iat + 30 * DAY },
        { slidingMs: 30 * DAY, absoluteMs: 7 * DAY },
      ),
    ).toBe(legacy.iat + 7 * DAY);
    expect(principalFromSession(legacy, DEFAULT_CONFIG, NOW)).toBeNull();
    expect(renew(legacy).renewed).toBe(false);
  });

  it("a live legacy cookie renews onto the new shape, keeping iat as its sign-in", () => {
    // A 12-hour cookie with no `authAt` — the pre-renewal shape — 7 hours in.
    const legacy = payload({ iat: NOW - 7 * HOUR, exp: NOW + 5 * HOUR });
    delete legacy.authAt;
    expect(principalFromSession(legacy, DEFAULT_CONFIG, NOW)).not.toBeNull();

    const { renewed, cookies } = renew(legacy);
    expect(renewed).toBe(true);
    const next = decode(cookies[0]?.value ?? "");
    expect(next.authAt).toBe(NOW - 7 * HOUR);
    expect(next.exp).toBe(NOW + 2 * DAY);
  });

  it("a sign-in time that is not a number is refused, not read as legacy", () => {
    // NaN does not survive JSON (it seals as null), so it is checked unsealed.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = { ...payload({ iat: NOW - HOUR }), authAt: bad };
      expect(sessionDeadline(p, DEFAULTS), String(bad)).toBeNull();
      expect(renew(p).renewed, String(bad)).toBe(false);
    }
    for (const authAt of [null, "0", {}] as unknown[]) {
      const p = {
        ...payload({ iat: NOW - HOUR }),
        authAt,
      } as unknown as ConsoleSessionPayload;
      // A round-trip through JSON is what a real cookie goes through.
      const sealed = sessions.session.unseal<ConsoleSessionPayload>(
        sessions.session.seal(p),
        NOW,
      );
      expect(sealed, String(authAt)).not.toBeNull();
      expect(sessionDeadline(sealed!, DEFAULTS), String(authAt)).toBeNull();
      expect(
        principalFromSession(sealed!, DEFAULT_CONFIG, NOW),
        String(authAt),
      ).toBeNull();
      expect(renew(sealed!).renewed, String(authAt)).toBe(false);
    }
  });

  it("a sign-in later than the cookie's own iat is refused, since renewal never produces one", () => {
    const p = payload({ iat: NOW - 30 * HOUR, authAt: NOW + 30 * DAY });
    expect(principalFromSession(p, DEFAULT_CONFIG, NOW)).toBeNull();
    expect(renew(p).renewed).toBe(false);
  });

  it("a payload with no iat at all is refused", () => {
    const p = payload({ iat: NOW - HOUR });
    delete (p as Partial<ConsoleSessionPayload>).iat;
    delete p.authAt;
    expect(principalFromSession(p, DEFAULT_CONFIG, NOW)).toBeNull();
  });
});

// --- configured clocks -----------------------------------------------------

describe("the configured TTLs are honoured", () => {
  const SHORT = config(
    "    session: { slidingTtlSeconds: 3600, absoluteTtlSeconds: 10800 }",
  );
  const short = sessionWindows(SHORT);

  it("mints one configured window", () => {
    expect(short).toEqual({ slidingMs: HOUR, absoluteMs: 3 * HOUR });
    const { res, cookies } = recorder();
    issueSessionCookie(res, sessions.session, IDENTITY, short, {}, NOW);
    expect(cookies[0]?.maxAge).toBe(HOUR);
    expect(decode(cookies[0]?.value ?? "").exp).toBe(NOW + HOUR);
  });

  it("renews past half the configured window, not half the default", () => {
    const at = (age: number) =>
      payload({ iat: NOW - age, authAt: NOW - age, exp: NOW - age + HOUR });
    expect(renew(at(29 * 60 * 1000), short).renewed).toBe(false);
    const { renewed, cookies } = renew(at(31 * 60 * 1000), short);
    expect(renewed).toBe(true);
    expect(cookies[0]?.maxAge).toBe(HOUR);
  });

  it("caps at the configured absolute lifetime", () => {
    const p = payload({
      iat: NOW - 10 * 60 * 1000,
      authAt: NOW - 3 * HOUR - 1,
      exp: NOW + 50 * 60 * 1000,
    });
    expect(principalFromSession(p, SHORT, NOW)).toBeNull();
    expect(principalFromSession(p, DEFAULT_CONFIG, NOW)).not.toBeNull();
  });

  it("applies a shortened window to cookies already issued", () => {
    // Minted under the 48-hour default, read after the config moved to 1 hour.
    const p = payload({ iat: NOW - 2 * HOUR });
    expect(principalFromSession(p, DEFAULT_CONFIG, NOW)).not.toBeNull();
    expect(principalFromSession(p, SHORT, NOW)).toBeNull();
    // And one still inside the new window renews onto it, not onto the old one.
    const young = payload({ iat: NOW - 40 * 60 * 1000 });
    const { cookies } = renew(young, short);
    expect(cookies[0]?.maxAge).toBe(HOUR);
  });

  it("equal clocks are a fixed session: nothing ever extends it", () => {
    const FIXED = sessionWindows(
      config(
        "    session: { slidingTtlSeconds: 43200, absoluteTtlSeconds: 43200 }",
      ),
    );
    const p = payload({
      iat: NOW - 11 * HOUR,
      authAt: NOW - 11 * HOUR,
      exp: NOW + HOUR,
    });
    expect(renew(p, FIXED).renewed).toBe(false);
  });
});

// --- through the real Express app ------------------------------------------

class FakeGoogle implements ConsoleOAuthProvider {
  private n = 0;
  beginAuth(): PendingAuth {
    const state = `state-${++this.n}`;
    return {
      state,
      codeVerifier: `verifier-${this.n}`,
      url: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    };
  }
  async completeAuth() {
    return IDENTITY;
  }
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp({
    config: DEFAULT_CONFIG,
    registry: await Registry.build({
      config: DEFAULT_CONFIG,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: ENV,
    }),
    tokenStore: tokenStoreFromConfig(DEFAULT_CONFIG, ENV),
    mode: "core",
    env: ENV,
    googleProvider: new FakeGoogle(),
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

/** A cookie the running app's key sealed, as a request `Cookie` header. */
function cookieHeader(p: ConsoleSessionPayload): string {
  return `${SESSION_COOKIE}=${sessions.session.seal(p)}`;
}

function sessionSetCookie(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
}

function valueOf(setCookie: string): string {
  return (setCookie.split(";")[0] ?? "").slice(SESSION_COOKIE.length + 1);
}

describe("the console gate renews on an ordinary request", () => {
  it("answers a half-spent session's page with a fresh Set-Cookie, and the same sign-in", async () => {
    const now = Date.now();
    const signedIn = now - 3 * DAY;
    const res = await fetch(`${baseUrl}/connectors`, {
      headers: {
        cookie: cookieHeader(
          payload({ iat: now - 25 * HOUR, authAt: signedIn }),
        ),
      },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("tadas@tadasant.com");

    const set = sessionSetCookie(res) ?? "";
    expect(set).toContain("Max-Age=172800");
    expect(set).toContain("Path=/");
    expect(set.toLowerCase()).toContain("httponly");
    expect(set.toLowerCase()).toContain("samesite=lax");
    const next = decode(valueOf(set));
    expect(next.authAt).toBe(signedIn);
    expect(next.iat).toBeGreaterThanOrEqual(now);

    // The renewed cookie is a session, and a young one: no second renewal.
    const again = await fetch(`${baseUrl}/ui/echo`, {
      headers: { cookie: `${SESSION_COOKIE}=${valueOf(set)}` },
      redirect: "manual",
    });
    expect(again.status).toBe(200);
    expect(sessionSetCookie(again)).toBeUndefined();
  });

  it("sends no Set-Cookie for a session younger than half its window", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie: cookieHeader(payload({ iat: Date.now() - HOUR })) },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it("sends a session past the cap back through Google, however recently it was renewed", async () => {
    const now = Date.now();
    const res = await fetch(`${baseUrl}/connectors`, {
      headers: {
        cookie: cookieHeader(
          payload({ iat: now - 25 * HOUR, authAt: now - 7 * DAY - 1000 }),
        ),
      },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/console/login");
    expect(sessionSetCookie(res)).toBeUndefined();

    // /console reads the same session through the same cap.
    const status = await fetch(`${baseUrl}/console`, {
      headers: {
        cookie: cookieHeader(
          payload({ iat: now - HOUR, authAt: now - 7 * DAY - 1000 }),
        ),
      },
      redirect: "manual",
    });
    expect(status.status).toBe(302);
    expect(status.headers.get("location")).toContain("accounts.google.com");
  });

  it("renews a legacy cookie onto the new shape, taking its iat as the sign-in", async () => {
    const now = Date.now();
    const legacy = payload({ iat: now - 7 * HOUR, exp: now + 5 * HOUR });
    delete legacy.authAt;
    const res = await fetch(`${baseUrl}/connectors`, {
      headers: { cookie: cookieHeader(legacy) },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(decode(valueOf(sessionSetCookie(res) ?? "")).authAt).toBe(
      legacy.iat,
    );
  });

  it("renews with Secure under NODE_ENV=production, the same flags as sign-in", () => {
    const { res, cookies } = recorder();
    const flags: Record<string, unknown>[] = [];
    const spy = {
      cookie(name: string, value: string, opts: Record<string, unknown>) {
        flags.push(opts);
        return res.cookie(name, value, opts);
      },
    } as unknown as ExpressResponse;
    const renewed = renewSessionIfDue(
      spy,
      sessions.session,
      payload({ iat: NOW - 25 * HOUR }),
      DEFAULTS,
      { NODE_ENV: "production" },
      NOW,
    );
    expect(renewed).toBe(true);
    expect(cookies).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
    });
  });

  it("does not let a capped cookie shadow a live one beside it", () => {
    const now = Date.now();
    const header = [
      cookieHeader(payload({ iat: now - HOUR, authAt: now - 8 * DAY })),
      cookieHeader(payload({ iat: now - HOUR, authAt: now - HOUR })),
    ].join("; ");
    const found = googleSession(header, sessions, DEFAULT_CONFIG, now);
    expect(found?.payload.authAt).toBe(now - HOUR);
  });
});
