// The login wait.
//
// These pin the fix for an outage in which EVERY authenticated tool call on the
// production `good-eggs` slug failed with
//
//   Login failed: page.waitForURL: Timeout 30000ms exceeded.
//   =========================== logs ===========================
//   waiting for navigation until "load"
//     navigated to "https://www.goodeggs.com/home?recently-logged-in=true"
//     "networkidle" event fired
//     "domcontentloaded" event fired
//   ============================================================
//
// The credentials were accepted and the post-login page rendered. Playwright
// logs those lifecycle lines only from the wait it enters AFTER the URL
// predicate has matched, so the wait was parked on the `load` event that page
// never fires — the default `waitUntil` for `waitForURL`, and the one
// navigation in this server that did not override it.
//
// They run against the TypeScript sources under vitest — no browser, no login. The
// client is driven through `setSharedBrowserProvider`, the seam strad's
// collapsed bundle hands a browser through, so `initialize()` runs for real
// over a fake page.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { GoodEggsClient, isPostSignInUrl, setSharedBrowserProvider } from '../src/index.js';

// The URL Good Eggs actually landed on during the outage.
const POST_LOGIN_URL = 'https://www.goodeggs.com/home?recently-logged-in=true';
const SIGN_IN_URL = 'https://www.goodeggs.com/signin';

const USERNAME = 'someone@example.com';
const PASSWORD = 'correct-horse-battery-staple';

// The verbatim production failure, so a test that expects it expects the real thing.
const PLAYWRIGHT_TIMEOUT_MESSAGE =
  'page.waitForURL: Timeout 30000ms exceeded.\n' +
  '=========================== logs ===========================\n' +
  'waiting for navigation until "load"\n' +
  `  navigated to "${POST_LOGIN_URL}"\n` +
  '  "networkidle" event fired\n' +
  '  "domcontentloaded" event fired\n' +
  '============================================================';

/**
 * A page in the shape Good Eggs renders (see basketState.ts).
 *
 * `session` picks what the payload says about who is signed in: a user object,
 * an explicit `null` (what an anonymous page carries), a payload with no `user`
 * key at all (a shape change), or no payload whatsoever (an error page).
 */
function pageHtml(session) {
  if (session === 'no-payload') return '<!doctype html><html><body>nothing here</body></html>';

  const storeData = { basket: { items: [], totals: { subtotal: 0 } }, products: {} };
  if (session === 'signed-in') storeData.user = { id: '5f00000000000000000000aa' };
  if (session === 'anonymous') storeData.user = null;
  // 'no-user-key' leaves `user` off entirely.

  return `<!doctype html><html><body><script>window._goodeggs.initReactRedux(window._goodeggs.entrypoint, ${JSON.stringify(
    { storeData }
  )});</script></body></html>`;
}

/**
 * A Playwright `Page` stand-in covering exactly the calls `initialize()` makes.
 *
 * `waitForURL` models the real one: it resolves only when the predicate matches
 * the URL the browser has landed on, and otherwise rejects with the production
 * timeout. `bouncesTo` moves the page again AFTER the wait resolved, which is
 * how a wait can succeed on a page that is not signed in.
 */
class FakePage {
  constructor({ landsAt, session = 'anonymous', bouncesTo = null, closed = false }) {
    this.currentUrl = 'about:blank';
    this.landsAt = landsAt;
    this.session = session;
    this.bouncesTo = bouncesTo;
    this.closed = closed;
    this.waitForUrlOptions = null;
    this.predicateResults = [];
    this.filled = [];
    this.clicked = [];
    this.contentReads = 0;
  }

  async goto(url) {
    this.currentUrl = url;
  }
  async waitForTimeout() {}
  async fill(selector, value) {
    this.filled.push([selector, value]);
  }
  async click(selector) {
    this.clicked.push(selector);
  }

  async waitForURL(predicate, options) {
    this.waitForUrlOptions = options;
    // The browser really does end up here either way — that is the whole point
    // of the incident: the navigation happened, the wait did not notice.
    this.currentUrl = this.landsAt;
    const matched = predicate(new URL(this.landsAt));
    this.predicateResults.push(matched);
    if (!matched) throw new Error(PLAYWRIGHT_TIMEOUT_MESSAGE);
    if (this.bouncesTo) this.currentUrl = this.bouncesTo;
  }

  url() {
    return this.currentUrl;
  }
  isClosed() {
    return this.closed;
  }
  async content() {
    this.contentReads += 1;
    if (this.closed) throw new Error('Target page, context or browser has been closed');
    return pageHtml(this.session);
  }
}

/** Run `initialize()` against a fake browser serving `page`. */
async function loginWith(page) {
  const browser = {
    newContext: async () => ({
      newPage: async () => page,
      close: async () => {},
    }),
  };
  setSharedBrowserProvider(async () => browser);
  try {
    const client = new GoodEggsClient({
      username: USERNAME,
      password: PASSWORD,
      headless: true,
      timeout: 30000,
    });
    await client.initialize();
  } finally {
    setSharedBrowserProvider(null);
  }
}

// ---------------------------------------------------------------------------
// The URL predicate
// ---------------------------------------------------------------------------

test('isPostSignInUrl matches the URL Good Eggs actually lands on after login', () => {
  assert.equal(isPostSignInUrl(POST_LOGIN_URL), true);
  // The query string is noise; the path is the signal.
  assert.equal(isPostSignInUrl('https://www.goodeggs.com/home'), true);
  assert.equal(isPostSignInUrl('https://www.goodeggs.com/home?recently-logged-in=true#top'), true);
});

test('isPostSignInUrl matches the other places a login can land', () => {
  for (const url of [
    'https://www.goodeggs.com/',
    'https://www.goodeggs.com',
    'https://www.goodeggs.com/basket',
    'https://www.goodeggs.com/account/favorites',
    'https://www.goodeggs.com/sf/producer/product/5f00000000000000000000aa',
    // A landing page whose path merely starts with the letters is not the form.
    'https://www.goodeggs.com/signing-up-for-delivery',
  ]) {
    assert.equal(isPostSignInUrl(url), true, url);
  }
});

test('isPostSignInUrl rejects the sign-in form, however it is spelled', () => {
  for (const url of [
    SIGN_IN_URL,
    'https://www.goodeggs.com/signin/',
    'https://www.goodeggs.com/signin?next=%2Fbasket',
    'https://www.goodeggs.com/Signin',
    'https://www.goodeggs.com/signin/reset-password',
    'https://www.goodeggs.com/sign-in',
    'https://www.goodeggs.com/login?next=%2Fhome',
    // Percent-encoded, which a literal comparison would wave through.
    'https://www.goodeggs.com/%73ignin',
  ]) {
    assert.equal(isPostSignInUrl(url), false, url);
  }
});

test('isPostSignInUrl rejects anything that is not a Good Eggs page', () => {
  for (const url of [
    'about:blank',
    'not a url',
    'https://evil.example.com/home',
    // A login still bouncing through a third party has not arrived yet.
    'https://accounts.example.com/oauth/authorize?client_id=goodeggs',
    // Lookalike hosts are not Good Eggs.
    'https://www.goodeggs.com.evil.example/home',
  ]) {
    assert.equal(isPostSignInUrl(url), false, url);
  }
});

test('isPostSignInUrl accepts a URL object as well as a string', () => {
  assert.equal(isPostSignInUrl(new URL(POST_LOGIN_URL)), true);
  assert.equal(isPostSignInUrl(new URL(SIGN_IN_URL)), false);
});

// ---------------------------------------------------------------------------
// The wait itself
// ---------------------------------------------------------------------------

test('the post-login wait does not wait for "load"', async () => {
  // The regression, pinned directly: `waitForURL` defaults to `waitUntil:
  // 'load'`, which the post-login Good Eggs page never fires.
  const page = new FakePage({ landsAt: POST_LOGIN_URL, session: 'signed-in' });
  await loginWith(page);

  assert.equal(page.waitForUrlOptions?.waitUntil, 'domcontentloaded');
  assert.equal(page.waitForUrlOptions?.timeout, 30000);
  // And the predicate it was given accepts the real landing URL.
  assert.deepEqual(page.predicateResults, [true]);
  assert.deepEqual(page.clicked, ['button:has-text("Sign In")']);
});

test('the credentials are typed into the email and password fields', async () => {
  const page = new FakePage({ landsAt: POST_LOGIN_URL, session: 'signed-in' });
  await loginWith(page);

  assert.deepEqual(page.filled, [
    ['input[name="email"], input[type="email"]', USERNAME],
    ['input[name="password"], input[type="password"]', PASSWORD],
  ]);
});

test('a wait that times out on a page that did sign in is a successful login', async () => {
  // The production failure, reproduced: the page's payload carries a user, and
  // the predicate matches — so the ONLY thing that can have failed is the
  // lifecycle wait. Modelled by a predicate that matches while the wait throws.
  const page = new FakePage({ landsAt: POST_LOGIN_URL, session: 'signed-in' });
  page.waitForURL = async function (predicate, options) {
    this.waitForUrlOptions = options;
    this.currentUrl = this.landsAt;
    this.predicateResults.push(predicate(new URL(this.landsAt)));
    throw new Error(PLAYWRIGHT_TIMEOUT_MESSAGE);
  };

  await loginWith(page);
  assert.equal(page.url(), POST_LOGIN_URL);
});

test('a page with no payload at all is judged on the URL alone', async () => {
  // An error page, or a markup change: the payload says nothing either way, so
  // the landing URL is what is left. It must not fail a login on its own.
  const page = new FakePage({ landsAt: POST_LOGIN_URL, session: 'no-payload' });
  await loginWith(page);
  assert.ok(page.contentReads > 0, 'the payload should have been consulted');
});

test('a payload with no user key at all is unknown, not anonymous', async () => {
  // A shape change must not take the whole server down; `unknown` defers to the
  // URL, exactly as an absent payload does.
  const page = new FakePage({ landsAt: POST_LOGIN_URL, session: 'no-user-key' });
  await loginWith(page);
});

test('an anonymous payload is a failed login even on a URL that looks like an arrival', async () => {
  // The trap this guards: if Good Eggs renames the form to a path the predicate
  // does not know, the wait returns instantly ON THE FORM and the URL check
  // waves it through. The page's own payload is what still says "nobody is
  // signed in" — and `get_favorites` answering [] from an anonymous session is
  // the confident-wrong-answer class this fork exists to prevent.
  const page = new FakePage({ landsAt: 'https://www.goodeggs.com/account/signin', session: 'anonymous' });
  await assert.rejects(loginWith(page), (error) => {
    assert.match(error.message, /not signed in/);
    assert.match(error.message, /goodeggs\.com\/account\/signin/);
    return true;
  });
});

test('a wait that times out on the sign-in form is a failed login', async () => {
  const page = new FakePage({ landsAt: SIGN_IN_URL, session: 'anonymous' });
  await assert.rejects(loginWith(page), (error) => {
    assert.match(error.message, /not signed in/);
    assert.match(error.message, /Check GOOD_EGGS_USERNAME/);
    // The Playwright detail is kept — it is what diagnosed this outage.
    assert.match(error.message, /Timeout 30000ms exceeded/);
    return true;
  });
});

test('a wait that succeeds but bounces back to the form is a failed login', async () => {
  // No wait error at all, so the message carries no Playwright detail: the page
  // simply is not signed in by the time anyone looks.
  const page = new FakePage({
    landsAt: POST_LOGIN_URL,
    bouncesTo: 'https://www.goodeggs.com/signin?error=auth',
    session: 'anonymous',
  });
  await assert.rejects(loginWith(page), (error) => {
    assert.match(error.message, /not signed in/);
    assert.doesNotMatch(error.message, /The wait ended with/);
    return true;
  });
});

test('a page that closed mid-login is a failed login, not a successful one', async () => {
  // `page.url()` is a cached client-side read that answers happily for a page
  // that no longer exists. A Chromium killed mid-login (this container shares
  // one) would otherwise report the URL it died on as a sign-in, and the mount
  // would come up healthy and fail every call.
  const page = new FakePage({ landsAt: POST_LOGIN_URL, session: 'signed-in', closed: true });
  page.waitForURL = async function () {
    this.currentUrl = this.landsAt;
    throw new Error('page.waitForURL: Target page, context or browser has been closed');
  };

  await assert.rejects(loginWith(page), (error) => {
    assert.match(error.message, /closed before sign-in could be confirmed/);
    return true;
  });
});

test('a failed login never puts the password or the query string in its error', async () => {
  // This message becomes the bundle's per-mount `degraded` string and the body
  // of every tool error the mount then returns.
  const page = new FakePage({
    landsAt: 'https://www.goodeggs.com/signin?email=someone%40example.com',
    session: 'anonymous',
  });
  await assert.rejects(loginWith(page), (error) => {
    assert.doesNotMatch(error.message, new RegExp(PASSWORD));
    assert.doesNotMatch(error.message, /email=/);
    return true;
  });
});
