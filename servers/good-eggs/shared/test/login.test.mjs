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
// only logs those lifecycle lines once the URL predicate has already matched,
// so the wait was parked on the `load` event that page never fires — the
// default `waitUntil` for `waitForURL`, and the one navigation in the server
// that did not override it.
//
// They run against the BUILT output with node:test — no browser, no login. The
// client is driven through `setSharedBrowserProvider`, the seam strad's
// collapsed bundle hands a browser through, so `initialize()` runs for real
// over a fake page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoodEggsClient, isPostSignInUrl, setSharedBrowserProvider } from '../build/index.js';

// The URL Good Eggs actually landed on during the outage.
const POST_LOGIN_URL = 'https://www.goodeggs.com/home?recently-logged-in=true';
const SIGN_IN_URL = 'https://www.goodeggs.com/signin';

// The verbatim production failure, so a test that expects it expects the real thing.
const PLAYWRIGHT_TIMEOUT_MESSAGE =
  'page.waitForURL: Timeout 30000ms exceeded.\n' +
  '=========================== logs ===========================\n' +
  'waiting for navigation until "load"\n' +
  `  navigated to "${POST_LOGIN_URL}"\n` +
  '  "networkidle" event fired\n' +
  '  "domcontentloaded" event fired\n' +
  '============================================================';

// A page whose payload carries a signed-in user, in the shape Good Eggs renders
// into every page (see basketState.ts).
function pageHtml({ signedIn }) {
  const storeData = {
    basket: { items: [], totals: { subtotal: 0 } },
    products: {},
    user: signedIn ? { id: '5f00000000000000000000aa', email: 'someone@example.com' } : null,
  };
  return `<!doctype html><html><body><script>window._goodeggs.initReactRedux(window._goodeggs.entrypoint, ${JSON.stringify(
    { storeData }
  )});</script></body></html>`;
}

/**
 * A Playwright `Page` stand-in covering exactly the calls `initialize()` makes.
 *
 * `waitForURL` is the interesting one: it records the options it was given, and
 * either resolves (having "navigated" to `landsAt`) or rejects with the real
 * production timeout, per `waitBehaviour`.
 */
class FakePage {
  constructor({ landsAt, waitBehaviour = 'resolve', signedIn = false }) {
    this.currentUrl = 'about:blank';
    this.landsAt = landsAt;
    this.waitBehaviour = waitBehaviour;
    this.signedIn = signedIn;
    this.waitForUrlOptions = null;
    this.predicateResults = [];
    this.filled = [];
    this.clicked = [];
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
    this.predicateResults.push(predicate(new URL(this.landsAt)));
    if (this.waitBehaviour === 'reject') throw new Error(PLAYWRIGHT_TIMEOUT_MESSAGE);
  }

  url() {
    return this.currentUrl;
  }
  async content() {
    return pageHtml({ signedIn: this.signedIn });
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
      username: 'someone@example.com',
      password: 'hunter2',
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
  const page = new FakePage({ landsAt: POST_LOGIN_URL });
  await loginWith(page);

  assert.equal(page.waitForUrlOptions?.waitUntil, 'domcontentloaded');
  assert.equal(page.waitForUrlOptions?.timeout, 30000);
  // And the predicate it was given accepts the real landing URL.
  assert.deepEqual(page.predicateResults, [true]);
  assert.deepEqual(page.clicked, ['button:has-text("Sign In")']);
});

test('a wait that times out on a page that did land is a successful login', async () => {
  // The production failure, reproduced: the navigation happened, the wait threw
  // anyway. Where the browser IS decides, not how the wait ended.
  const page = new FakePage({ landsAt: POST_LOGIN_URL, waitBehaviour: 'reject' });
  await loginWith(page);
  assert.equal(page.url(), POST_LOGIN_URL);
});

test('a wait that times out still on the sign-in form is a failed login', async () => {
  const page = new FakePage({ landsAt: SIGN_IN_URL, waitBehaviour: 'reject', signedIn: false });
  await assert.rejects(loginWith(page), (error) => {
    assert.match(error.message, /Login failed/);
    assert.match(error.message, /Check your credentials/);
    // The Playwright detail is kept — it is what diagnosed this outage.
    assert.match(error.message, /Timeout 30000ms exceeded/);
    return true;
  });
});

test('a page whose payload reports a signed-in user is a successful login', async () => {
  // Good Eggs could sign a session in without navigating anywhere. Its own
  // state payload is the second opinion, and it outranks the URL.
  const page = new FakePage({ landsAt: SIGN_IN_URL, waitBehaviour: 'reject', signedIn: true });
  await loginWith(page);
});
