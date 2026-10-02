// The strad fork delta for monarch-money's AUTH: Monarch's web app moved from
// `Authorization: Token …` to an HttpOnly session cookie, the token a human
// could copy out of DevTools stopped existing, and a session that expired
// silently left an agent blocked for eleven days on "Not authenticated".
//
// What these pin:
//   1. A cookie travels the way Monarch's web app sends it — Cookie,
//      X-CSRFToken, Origin, Referer, client-platform — and never as a token.
//   2. The credential is read from the LIVE environment on every request, with
//      cookie > token > stored precedence, so a refreshed cookie needs no restart.
//   3. A refusal is reported as WHICH credential failed and HOW to refresh it,
//      and a 403 is never mistaken for an MFA prompt.
//   4. Headless re-login is tried once on a refusal, answers 2FA from a TOTP
//      seed, pins the device id, and reports a CAPTCHA wall instead of looping.
//   5. A cookie is verified against Monarch before it is stored anywhere.
//
// No credential in this file is real.
import { describe, test, expect } from 'vitest';

import {
  authHeaders,
  csrfTokenFrom,
  cookieHint,
  mergeSetCookies,
  normaliseCookieHeader,
} from '../src/monarch-client/credentials.js';
import {
  createGraphQLTransport,
  MonarchAuthError,
} from '../src/monarch-client/graphql-transport.js';
import { MonarchAuthManager } from '../src/monarch-client/auth-manager.js';
import {
  login,
  MonarchCaptchaRequiredError,
  MonarchTotpRequiredError,
} from '../src/monarch-client/auth.js';
import { createMemorySessionStore } from '../src/monarch-client/session-store.js';
import { totpCode } from '../src/monarch-client/totp.js';
import { authErrorMessage } from '../src/tools/helpers.js';
import { createMCPServer } from '../src/server.js';
import { authTools } from '../src/tools/auth.js';
import { buildMonarchClient } from '../src/monarch-client/client.js';

const GQL = 'https://api.monarch.test/graphql';
const LOGIN = 'https://api.monarch.test/auth/login/';
const COOKIE = 'csrftoken=csrf-fake; sessionid=sess-fake; _ga=GA1.1.x';
const ME = { data: { me: { id: 'u1', email: 'me@example.com', name: 'Me' } } };

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (req: Seen) => {
  status: number;
  body: unknown;
  setCookie?: string[];
};

/** A fetch that records every request and answers through `respond`. */
function fakeFetch(respond: Responder) {
  const seen: Seen[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k, v])
    );
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // leave as text
      }
    }
    const req = { url: String(url), headers, body };
    seen.push(req);
    const out = respond(req);
    const h = new Headers({ 'content-type': 'application/json' });
    for (const c of out.setCookie ?? []) h.append('set-cookie', c);
    return new Response(typeof out.body === 'string' ? out.body : JSON.stringify(out.body), {
      status: out.status,
      headers: h,
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

function manager(
  env: NodeJS.ProcessEnv,
  respond: Responder,
  extra: Partial<ConstructorParameters<typeof MonarchAuthManager>[0]> = {}
) {
  const f = fakeFetch(respond);
  const store = extra.sessionStore ?? createMemorySessionStore();
  const auth = new MonarchAuthManager({
    sessionStore: store,
    env,
    endpoint: GQL,
    loginEndpoint: LOGIN,
    fetchImpl: f.impl,
    ...extra,
  });
  return { auth, seen: f.seen, store };
}

describe('the cookie as a credential', () => {
  test('normalises what a DevTools copy actually looks like', () => {
    expect(normaliseCookieHeader(`Cookie: ${COOKIE}`)).toBe(COOKIE);
    expect(normaliseCookieHeader(`'${COOKIE}'`)).toBe(COOKIE);
    expect(normaliseCookieHeader(`  csrftoken=csrf-fake;\n sessionid=sess-fake; _ga=GA1.1.x `)).toBe(
      COOKIE
    );
    expect(normaliseCookieHeader('')).toBeNull();
    expect(normaliseCookieHeader('   ')).toBeNull();
    expect(normaliseCookieHeader(undefined)).toBeNull();
  });

  test('X-CSRFToken is the csrftoken cookie', () => {
    expect(csrfTokenFrom(COOKIE)).toBe('csrf-fake');
    expect(csrfTokenFrom('sessionid=x')).toBeUndefined();
  });

  test('a cookie travels as the web app sends it, and never as a token', () => {
    const h = authHeaders({ method: 'cookie', cookie: COOKIE }, 'dev-1');
    expect(h).toEqual({
      'client-platform': 'web',
      Cookie: COOKIE,
      'X-CSRFToken': 'csrf-fake',
      Origin: 'https://app.monarch.com',
      Referer: 'https://app.monarch.com/',
      'device-uuid': 'dev-1',
    });
    expect(h.Authorization).toBeUndefined();
  });

  test('a token travels as Authorization, with no cookie', () => {
    const h = authHeaders({ method: 'token', token: 'tok', source: 'env' });
    expect(h.Authorization).toBe('Token tok');
    expect(h.Cookie).toBeUndefined();
  });

  test('either observed session cookie name satisfies the hint; neither names the cookies, not values', () => {
    expect(cookieHint('sessionid=a')).toBeNull();
    expect(cookieHint('session_id=a')).toBeNull();
    const hint = cookieHint('_ga=secretish; csrftoken=zzz');
    expect(hint).toContain('_ga, csrftoken');
    expect(hint).not.toContain('secretish');
    expect(hint).not.toContain('zzz');
  });

  test('Set-Cookie folds in a rotated session and ignores cookies nobody sent', () => {
    expect(
      mergeSetCookies(COOKIE, ['sessionid=sess-new; Path=/; HttpOnly', 'tracking=1; Path=/'])
    ).toBe('csrftoken=csrf-fake; sessionid=sess-new; _ga=GA1.1.x');
    expect(mergeSetCookies(COOKIE, ['sessionid=sess-fake; Path=/'])).toBeNull();
    expect(mergeSetCookies(COOKIE, ['tracking=1'])).toBeNull();
    expect(mergeSetCookies(COOKIE, ['_ga=; Max-Age=0'])).toBe(
      'csrftoken=csrf-fake; sessionid=sess-fake'
    );
  });
});

describe('the transport', () => {
  test('a 401 or 403 is an auth error, never an MFA prompt', async () => {
    for (const status of [401, 403]) {
      const { impl } = fakeFetch(() => ({ status, body: { detail: 'Invalid token.' } }));
      const err = await createGraphQLTransport({
        endpoint: GQL,
        credential: { method: 'cookie', cookie: COOKIE },
        fetchImpl: impl,
      })
        .request({ query: '{ me { id } }' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MonarchAuthError);
      expect((err as MonarchAuthError).reason).toBe('rejected');
      expect((err as MonarchAuthError).status).toBe(status);
      expect((err as Error).message).not.toMatch(/mfa|otp|login script/i);
    }
  });

  test("Django's CSRF refusal is its own reason", async () => {
    const { impl } = fakeFetch(() => ({
      status: 403,
      body: '<h1>Forbidden (403)</h1><p>CSRF verification failed. Request aborted.</p>',
    }));
    const err = await createGraphQLTransport({
      endpoint: GQL,
      credential: { method: 'cookie', cookie: 'sessionid=x' },
      fetchImpl: impl,
    })
      .request({ query: '{ me { id } }' })
      .catch((e: unknown) => e);
    expect((err as MonarchAuthError).reason).toBe('csrf');
  });
});

describe('credential precedence, read live', () => {
  test('cookie > token > stored, re-read on every request', async () => {
    const env: NodeJS.ProcessEnv = {};
    const store = createMemorySessionStore({ token: 'stored-tok', obtainedAt: 'x' });
    const { auth, seen } = manager(env, () => ({ status: 200, body: ME }), { sessionStore: store });
    const t = auth.transport();

    await t.request({ query: '{ me { id } }' });
    expect(seen.at(-1)!.headers.Authorization).toBe('Token stored-tok');

    env.MONARCH_SESSION_TOKEN = 'env-tok';
    await t.request({ query: '{ me { id } }' });
    expect(seen.at(-1)!.headers.Authorization).toBe('Token env-tok');

    // A refreshed cookie lands in the environment (paramsRefresh, or
    // set_session_cookie) and the NEXT request uses it — no restart.
    env.MONARCH_COOKIE = COOKIE;
    await t.request({ query: '{ me { id } }' });
    expect(seen.at(-1)!.headers.Cookie).toBe(COOKIE);
    expect(seen.at(-1)!.headers.Authorization).toBeUndefined();
    expect((await auth.status()).source).toBe('MONARCH_COOKIE');
  });

  test('no credential and no login is a "missing" auth error', async () => {
    const { auth, seen } = manager({}, () => ({ status: 200, body: ME }));
    const err = await auth.transport().request({ query: '{ x }' }).catch((e: unknown) => e);
    expect((err as MonarchAuthError).reason).toBe('missing');
    expect(seen).toHaveLength(0);
  });
});

describe('a refusal says which credential and how to fix it', () => {
  test('an expired cookie names the cookie and the refresh steps', async () => {
    const { auth } = manager({ MONARCH_COOKIE: COOKIE }, () => ({ status: 401, body: {} }));
    const err = (await auth
      .transport()
      .request({ query: '{ x }' })
      .catch((e: unknown) => e)) as MonarchAuthError;
    expect(err.method).toBe('cookie');
    const msg = authErrorMessage(err);
    expect(msg).toMatch(/^Monarch cookie expired or was signed out \(Monarch answered 401\)\./);
    expect(msg).toContain('set_session_cookie');
    expect(msg).toContain('MONARCH_COOKIE');
    expect(msg).toContain('/ui/secrets');
    expect(msg).not.toContain('sess-fake');
  });

  test('a rejected token says to move to the cookie', () => {
    const err = new MonarchAuthError('x', 'rejected', 401);
    err.method = 'token';
    expect(authErrorMessage(err)).toMatch(/no longer exposes a token.*MONARCH_COOKIE/);
  });
});

describe('headless re-login', () => {
  const SEED = 'JBSWY3DPEHPK3PXP';
  const loginEnv = (): NodeJS.ProcessEnv => ({
    MONARCH_COOKIE: COOKIE,
    MONARCH_EMAIL: 'me@example.com',
    MONARCH_PASSWORD: 'pw',
    MONARCH_TOTP_SECRET: SEED,
    MONARCH_DEVICE_UUID: 'pinned-device',
  });

  test('a refused cookie triggers one login, and the request is retried with its token', async () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    const { auth, seen } = manager(
      loginEnv(),
      (req) => {
        if (req.url === LOGIN) return { status: 200, body: { token: 'minted' } };
        return req.headers.Authorization === 'Token minted'
          ? { status: 200, body: ME }
          : { status: 401, body: {} };
      },
      { now: () => now }
    );

    const data = await auth.transport().request<{ me: { id: string } }>({ query: '{ me { id } }' });
    expect(data.me.id).toBe('u1');

    const loginReq = seen.find((r) => r.url === LOGIN)!;
    expect(loginReq.headers['device-uuid']).toBe('pinned-device');
    expect((loginReq.body as Record<string, unknown>).totp).toBe(totpCode(SEED, new Date(now)));
    expect((loginReq.body as Record<string, unknown>).trusted_device).toBe(true);

    // The refused cookie is not re-sent while the environment still holds it.
    const before = seen.length;
    await auth.transport().request({ query: '{ me { id } }' });
    expect(seen.slice(before).map((r) => r.headers.Authorization)).toEqual(['Token minted']);
    expect((await auth.status()).source).toBe('login');
  });

  test('a CAPTCHA wall is reported, not looped on, and not retried inside the cooldown', async () => {
    let logins = 0;
    const { auth } = manager(loginEnv(), (req) => {
      if (req.url === LOGIN) {
        logins++;
        return {
          status: 403,
          body: { detail: 'CAPTCHA is required to proceed.', error_code: 'CAPTCHA_REQUIRED' },
        };
      }
      return { status: 401, body: {} };
    });

    const first = (await auth
      .transport()
      .request({ query: '{ x }' })
      .catch((e: unknown) => e)) as MonarchAuthError;
    expect(first.method).toBe('cookie');
    expect(first.loginFailure).toMatch(/CAPTCHA is required/);
    expect(authErrorMessage(first)).toMatch(/headless re-login .* did not succeed/);

    const second = (await auth
      .transport()
      .request({ query: '{ x }' })
      .catch((e: unknown) => e)) as MonarchAuthError;
    expect(second.loginFailure).toMatch(/not retried for another \d+ min/);
    expect(logins).toBe(1);
  });

  test('the login classifies CAPTCHA, the edge bot block, and MFA_REQUIRED', async () => {
    const run = (status: number, body: unknown) =>
      login(
        { email: 'e', password: 'p', deviceUuid: 'd' },
        { endpoint: LOGIN, fetchImpl: fakeFetch(() => ({ status, body })).impl }
      ).catch((e: unknown) => e);
    expect(await run(403, { error_code: 'CAPTCHA_REQUIRED', detail: 'CAPTCHA is required' })).toBeInstanceOf(
      MonarchCaptchaRequiredError
    );
    expect(await run(403, { You: 'Shall Not Pass' })).toBeInstanceOf(MonarchCaptchaRequiredError);
    expect(await run(403, { error_code: 'MFA_REQUIRED', detail: 'Multi-Factor Auth Required' })).toBeInstanceOf(
      MonarchTotpRequiredError
    );
  });

  test('a login answered with only a session cookie is still a login', async () => {
    const result = await login(
      { email: 'e', password: 'p', deviceUuid: 'd' },
      {
        endpoint: LOGIN,
        fetchImpl: fakeFetch(() => ({
          status: 200,
          body: {},
          setCookie: ['csrftoken=c1; Path=/', 'sessionid=s1; Path=/; HttpOnly'],
        })).impl,
      }
    );
    expect(result.token).toBeUndefined();
    expect(result.cookie).toBe('csrftoken=c1; sessionid=s1');
  });

  test('with no other credential, login runs before the first request', async () => {
    const env = loginEnv();
    delete env.MONARCH_COOKIE;
    const { auth, seen } = manager(env, (req) =>
      req.url === LOGIN ? { status: 200, body: { token: 'minted' } } : { status: 200, body: ME }
    );
    await auth.transport().request({ query: '{ me { id } }' });
    expect(seen.map((r) => r.url)).toEqual([LOGIN, GQL]);
  });
});

describe('set_session_cookie', () => {
  test('verifies first, then uses it, then persists it', async () => {
    const env: NodeJS.ProcessEnv = {};
    const persisted: string[] = [];
    const { auth, seen } = manager(
      env,
      (req) => (req.headers.Cookie === COOKIE ? { status: 200, body: ME } : { status: 401, body: {} }),
      { persistCookie: async (c) => void persisted.push(c), persistTarget: 'the store' }
    );

    const result = await auth.setCookie(`Cookie: ${COOKIE}`);
    expect(result.persisted).toBe(true);
    expect(result.me.email).toBe('me@example.com');
    expect(env.MONARCH_COOKIE).toBe(COOKIE);
    expect(persisted).toEqual([COOKIE]);
    expect(seen).toHaveLength(1);
  });

  test('a cookie Monarch refuses is stored nowhere', async () => {
    const env: NodeJS.ProcessEnv = { MONARCH_COOKIE: 'sessionid=old' };
    const persisted: string[] = [];
    const { auth } = manager(env, () => ({ status: 401, body: {} }), {
      persistCookie: async (c) => void persisted.push(c),
    });
    await expect(auth.setCookie('sessionid=bad; csrftoken=x')).rejects.toBeInstanceOf(MonarchAuthError);
    expect(env.MONARCH_COOKIE).toBe('sessionid=old');
    expect(persisted).toEqual([]);
  });

  test('a write-back failure is reported, and the cookie still serves this process', async () => {
    const env: NodeJS.ProcessEnv = {};
    const { auth } = manager(env, () => ({ status: 200, body: ME }), {
      persistCookie: async () => {
        throw new Error('core answered 403');
      },
    });
    const result = await auth.setCookie(COOKIE);
    expect(result.persisted).toBe(false);
    expect(result.persistNote).toContain('core answered 403');
    expect(env.MONARCH_COOKIE).toBe(COOKIE);
  });

  test('the tool never echoes the cookie and says whether it persisted', async () => {
    const env: NodeJS.ProcessEnv = {};
    const { auth } = manager(env, () => ({ status: 200, body: ME }));
    const tool = authTools(async () => {
      throw new Error('unused');
    }, createMemorySessionStore(), auth).find((t) => t.name === 'set_session_cookie')!;
    expect(tool.groups).toEqual(['manage']);
    const out = await tool.handler({ cookie: COOKIE });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain('authenticated as me@example.com');
    expect(out.content[0].text).toContain('lasts until the process restarts');
    expect(out.content[0].text).not.toContain('sess-fake');
  });

  test('a session Monarch re-issues is kept and persisted', async () => {
    const env: NodeJS.ProcessEnv = { MONARCH_COOKIE: COOKIE };
    const persisted: string[] = [];
    const { auth } = manager(
      env,
      () => ({ status: 200, body: ME, setCookie: ['sessionid=sess-rotated; Path=/; HttpOnly'] }),
      { persistCookie: async (c) => void persisted.push(c) }
    );
    await auth.transport().request({ query: '{ me { id } }' });
    const rotated = 'csrftoken=csrf-fake; sessionid=sess-rotated; _ga=GA1.1.x';
    expect(env.MONARCH_COOKIE).toBe(rotated);
    await new Promise((r) => setImmediate(r));
    expect(persisted).toEqual([rotated]);
  });
});

describe('check_authentication', () => {
  test('reports the method and source in use', async () => {
    const env: NodeJS.ProcessEnv = { MONARCH_COOKIE: COOKIE, MONARCH_SESSION_TOKEN: 'ignored' };
    const { auth } = manager(env, () => ({ status: 200, body: ME }));
    const tool = authTools(
      async () => buildMonarchClient({ auth, session: null, endpoint: GQL }),
      createMemorySessionStore(),
      auth
    ).find((t) => t.name === 'check_authentication')!;
    const out = JSON.parse((await tool.handler({})).content[0].text);
    expect(out).toMatchObject({
      authenticated: true,
      method: 'cookie',
      source: 'MONARCH_COOKIE',
      email: 'me@example.com',
      headlessLogin: false,
      cookiePersistence: false,
    });
  });

  test('createMCPServer exposes the one auth manager its tools share', () => {
    const created = createMCPServer({ version: 't', sessionStore: createMemorySessionStore(), env: {} });
    expect(created.auth).toBeInstanceOf(MonarchAuthManager);
  });
});

describe('TOTP', () => {
  test('matches the RFC 6238 SHA-1 test vectors', () => {
    // RFC 6238 Appendix B: the ASCII seed "12345678901234567890", 8 digits.
    const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totpCode(seed, new Date(59_000), 30, 8)).toBe('94287082');
    expect(totpCode(seed, new Date(1_111_111_109_000), 30, 8)).toBe('07081804');
    expect(totpCode(seed, new Date(2_000_000_000_000), 30, 8)).toBe('69279037');
  });

  test('accepts the otpauth:// URI and a spaced lowercase seed', () => {
    const at = new Date(1_700_000_000_000);
    const code = totpCode('JBSWY3DPEHPK3PXP', at);
    expect(totpCode('otpauth://totp/Monarch:me?secret=JBSWY3DPEHPK3PXP&issuer=Monarch', at)).toBe(code);
    expect(totpCode('jbsw y3dp ehpk 3pxp', at)).toBe(code);
  });

  test('a bad seed is reported by shape, never by content', () => {
    expect(() => totpCode('not-base32!!')).toThrow(/^MONARCH_TOTP_SECRET is not a base32 seed$/);
  });
});
