// The favorites read, and what an empty one is allowed to mean.
//
// `getBasket()` has refused to call an unreadable or anonymous basket an empty
// one since FORK.md #5 — the delta that exists because this server once told a
// user his 43-item cart was empty. `getFavorites()` had no such guard: it threw
// only when the URL was the sign-in form, and otherwise returned whatever
// `a.js-product-link` scraped, `[]` included.
//
// A signed-out /favorites does not always redirect. It can render a page with
// no product links on it, which scrapes to [] and reads back as "you have no
// favorites" against an account that has plenty — and it can equally render
// recommendation tiles, which scrape to a plausible list that is not the user's
// favorites at all. The login happens once at startup and nothing
// re-establishes it, so a lapsed session lands in exactly those two places.
//
// They run against the BUILT output with node:test — no browser, no login. The
// client is driven through `setSharedBrowserProvider`, the seam strad's
// collapsed bundle hands a browser through, so the real `getFavorites()` runs
// over a fake page. The in-page DOM scrape is the one part that is stubbed:
// `page.evaluate()` runs in a browser, so the fake answers for it, and what
// these tests pin is the truthfulness rule around the scrape rather than the
// selectors inside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoodEggsClient, setSharedBrowserProvider } from '../build/index.js';
import { renderPage } from './fixtures/page.mjs';

const POST_LOGIN_URL = 'https://www.goodeggs.com/home?recently-logged-in=true';
const FAVORITES_URL = 'https://www.goodeggs.com/favorites';
const SIGN_IN_URL = 'https://www.goodeggs.com/signin';

/**
 * A page carrying the store payload, in the shape Good Eggs really serves it —
 * `renderPage` is the shared fixture, copied from a live response, so these run
 * against production-shaped markup rather than a simplified stand-in.
 *
 * `session` is one of the three states the read distinguishes. `no-user-key` is
 * the third: a payload that parses and simply does not carry `user`, which is
 * `unknown` rather than `anonymous` — nobody said nobody was signed in.
 */
function pageHtml(session) {
  const storeData = {
    basket: { items: [], totals: { subtotal: 0 } },
    products: {},
  };
  if (session === 'signed-in') {
    storeData.user = { id: '5f00000000000000000000aa', email: 'someone@example.com' };
  } else if (session === 'anonymous') {
    storeData.user = null;
  }
  return renderPage(storeData);
}

/** A document with no `initReactRedux` payload in it at all. */
const NO_PAYLOAD_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

const A_FAVORITE = {
  url: 'https://www.goodeggs.com/sf/producer/product/5f00000000000000000000bb',
  name: 'Organic Dry-Farmed Early Girl Tomatoes',
  brand: 'Blue House Farm',
  price: '$5.99',
};

/**
 * A Playwright `Page` stand-in covering the calls `initialize()` and
 * `getFavorites()` make.
 *
 * The login always succeeds here — this file is about the read that follows.
 * `scraped` is what the in-page DOM scrape finds, which is the seam that
 * matters: an empty scrape is exactly what a signed-out favorites page yields.
 */
class FakePage {
  constructor({
    session = 'signed-in',
    scraped = [],
    html,
    contentThrows = false,
    landsAt = FAVORITES_URL,
    hydratedHtml,
  } = {}) {
    this.currentUrl = 'about:blank';
    this.session = session;
    this.scraped = scraped;
    this.html = html;
    this.contentThrows = contentThrows;
    this.landsAt = landsAt;
    this.hydratedHtml = hydratedHtml;
    /** Set once the login is done, so login and read can differ. */
    this.loggedIn = false;
    /** Every URL `goto` was asked for, so navigation itself is assertable. */
    this.visited = [];
    /**
     * Bumped by every `waitForTimeout`, and reset by every navigation. It is
     * what makes the TIMING of the session read observable: `content()` serves
     * `hydratedHtml` once the page has waited, so a read that happens after the
     * wait for React sees a different document than one that happens before it.
     */
    this.ticks = 0;
  }

  async goto(url) {
    this.visited.push(url);
    this.currentUrl = this.loggedIn ? this.landsAt : url;
    this.ticks = 0;
  }
  async waitForTimeout() {
    this.ticks++;
  }
  async fill() {}
  async click() {}
  async waitForURL() {
    this.currentUrl = POST_LOGIN_URL;
  }
  url() {
    return this.currentUrl;
  }
  isClosed() {
    return false;
  }
  async content() {
    if (!this.loggedIn) return pageHtml('signed-in');
    if (this.contentThrows) throw new Error('Execution context was destroyed');
    // Once the page has waited, React has had its chance to rewrite the
    // document out from under the payload.
    if (this.hydratedHtml !== undefined && this.ticks > 0) return this.hydratedHtml;
    if (this.html !== undefined) return this.html;
    return pageHtml(this.session);
  }
  /** The favorites scrape runs in the page; the fake answers for it. */
  async evaluate() {
    return this.scraped;
  }
}

/** Log in over `page`, then read favorites from it. */
async function favoritesFrom(page) {
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
    page.loggedIn = true;
    return await client.getFavorites();
  } finally {
    setSharedBrowserProvider(null);
  }
}

// ---------------------------------------------------------------------------
// A confirmed session: both answers are reportable
// ---------------------------------------------------------------------------

test('favorites are returned when the page confirms the session', async () => {
  const page = new FakePage({ session: 'signed-in', scraped: [A_FAVORITE] });

  assert.deepEqual(await favoritesFrom(page), [A_FAVORITE]);
  // And it read the favorites page to get them.
  assert.ok(
    page.visited.includes(FAVORITES_URL),
    `never navigated to ${FAVORITES_URL}: ${JSON.stringify(page.visited)}`
  );
});

test('a confirmed session with nothing favorited really is empty', async () => {
  // The one case where "you have no favorites" is a true sentence, and it must
  // keep working — an over-eager guard here would be its own kind of wrong.
  const page = new FakePage({ session: 'signed-in', scraped: [] });

  assert.deepEqual(await favoritesFrom(page), []);
});

// ---------------------------------------------------------------------------
// A page that states nobody is signed in: nothing on it is this account's
// ---------------------------------------------------------------------------

test('an anonymous favorites page with no items is UNKNOWN, not empty', async () => {
  // The regression. A lapsed session renders a favorites page with no product
  // links on it; the old code returned [] and the tool said "you have none".
  const page = new FakePage({ session: 'anonymous', scraped: [] });

  await assert.rejects(favoritesFrom(page), (error) => {
    assert.match(error.message, /UNKNOWN, not empty/);
    assert.match(error.message, /nobody is signed in/);
    return true;
  });
});

test('an anonymous page is refused even when it renders product tiles', async () => {
  // A signed-out /favorites can still draw recommendations. Handing those back
  // as the user's favorites is the same false sentence with a plausible list
  // attached, which is worse than the empty one, not better.
  const page = new FakePage({ session: 'anonymous', scraped: [A_FAVORITE] });

  await assert.rejects(favoritesFrom(page), /not yours/);
});

// ---------------------------------------------------------------------------
// A page with no payload at all: "could not tell" is not "none"
// ---------------------------------------------------------------------------

test('no payload and no items is UNKNOWN, not empty', async () => {
  const page = new FakePage({ scraped: [], html: NO_PAYLOAD_HTML });

  await assert.rejects(favoritesFrom(page), (error) => {
    assert.match(error.message, /UNKNOWN, not empty/);
    assert.match(error.message, /no usable session payload/);
    return true;
  });
});

test('no payload but items on the page returns the items', async () => {
  // Products drawn on a page Good Eggs served without its usual payload are
  // still products. Only the answer that has nothing in it needs a session
  // behind it.
  const page = new FakePage({ scraped: [A_FAVORITE], html: NO_PAYLOAD_HTML });

  assert.deepEqual(await favoritesFrom(page), [A_FAVORITE]);
});

test('a content() read that throws mid-navigation is unknown, not anonymous', async () => {
  // "Execution context was destroyed" is a fact about timing, not about the
  // session — so it must not be reported as a signed-out page, and with items
  // on the page it must not fail the read either.
  const page = new FakePage({ contentThrows: true, scraped: [A_FAVORITE] });

  assert.deepEqual(await favoritesFrom(page), [A_FAVORITE]);
});

test('a content() read that throws with nothing scraped is UNKNOWN', async () => {
  const page = new FakePage({ contentThrows: true, scraped: [] });

  await assert.rejects(favoritesFrom(page), /UNKNOWN, not empty/);
});

// ---------------------------------------------------------------------------
// A payload that parses but never says: nobody claimed nobody is signed in
// ---------------------------------------------------------------------------

test('a payload with no user key at all is unknown, not anonymous', async () => {
  // The distinction `signedInFromPage` draws and this read depends on: a
  // payload whose shape this tree does not recognise has not TOLD us the
  // session is gone, so items on the page are still returned.
  const page = new FakePage({ session: 'no-user-key', scraped: [A_FAVORITE] });

  assert.deepEqual(await favoritesFrom(page), [A_FAVORITE]);
});

test('a payload with no user key and nothing scraped is UNKNOWN', async () => {
  const page = new FakePage({ session: 'no-user-key', scraped: [] });

  await assert.rejects(favoritesFrom(page), /no usable session payload/);
});

// ---------------------------------------------------------------------------
// When the session is read, not just what it says
// ---------------------------------------------------------------------------

test('the session is read from the served document, before React hydrates', async () => {
  // The ordering claim in FORK.md #7, pinned. This page is signed in as served
  // and payload-less once it has waited — exactly what a framework that drops
  // its state script after hydrating looks like. The read has to happen at
  // tick 0, or a signed-in account with genuinely zero favorites hard-errors.
  const page = new FakePage({
    session: 'signed-in',
    scraped: [],
    hydratedHtml: NO_PAYLOAD_HTML,
  });

  assert.deepEqual(await favoritesFrom(page), []);
  // And the page really did wait afterwards, so the fixture is not vacuous.
  assert.ok(page.ticks > 0, 'the favorites read never waited for React');
});

// ---------------------------------------------------------------------------
// The pre-existing sign-in guard still fires
// ---------------------------------------------------------------------------

test('a favorites page that redirected to the sign-in form still says so', async () => {
  const page = new FakePage({ landsAt: SIGN_IN_URL, session: 'anonymous', scraped: [] });

  await assert.rejects(favoritesFrom(page), /Not logged in\. Cannot access favorites\./);
});
