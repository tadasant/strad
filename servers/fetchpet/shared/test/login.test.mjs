// Login tests for the Fetch Pet server.
//
// These run against the BUILT output (../build) with node:test — no browser, no
// real Fetch Pet account. They pin the two things that took this server down in
// staging and prod (strad#28):
//
//   1. The selectors match the login form Fetch actually serves. The form uses
//      floating labels, so the fields carry `type` and nothing else — the DOM
//      recorded in LIVE_LOGIN_FORM below is the one captured from the live page
//      in that issue.
//   2. A failed login is retried on the next tool call. It used to be cached for
//      the life of the container, so one bad boot disabled the server until a
//      redeploy.
//
// The browser is a fake: a small DOM of attribute bags, a locator that WAITS for
// them and a `$` that does not. That difference is the bug — the old code probed
// with the non-waiting `$` and, when the React tree had not rendered yet, fell
// through to a waiting fill on a selector that could never match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  EMAIL_FIELD_SELECTOR,
  PASSWORD_FIELD_SELECTOR,
  fillLoginField,
  FetchPetClient,
  createMCPServer,
  setSharedBrowserProvider,
} from '../build/index.js';

// ---------------------------------------------------------------------------
// A DOM small enough to reason about, and a matcher for the selector subset we
// ship: `tag`, `#id`, `[attr="v"]`, `[attr*="v" i]`. Anything else (Playwright's
// `:has-text()`) matches nothing, which is what a CSS engine would do with it.
// ---------------------------------------------------------------------------

function matchesOne(selector, el) {
  const sel = selector.trim();
  if (sel.includes(':')) return false; // :has-text() and friends — not CSS
  const tagMatch = sel.match(/^[a-z]+/);
  if (tagMatch && el.tag !== tagMatch[0]) return false;
  const idMatch = sel.match(/#([\w-]+)/);
  if (idMatch && el.attrs.id !== idMatch[1]) return false;
  for (const attr of sel.matchAll(/\[([\w-]+)(\*?)=["']([^"']*)["'](\s+i)?\]/g)) {
    const [, name, star, want, insensitive] = attr;
    const have = el.attrs[name];
    if (have === undefined || have === null) return false;
    const a = insensitive ? have.toLowerCase() : have;
    const b = insensitive ? want.toLowerCase() : want;
    if (star ? !a.includes(b) : a !== b) return false;
  }
  return true;
}

const matches = (selector, el) => selector.split(',').some((s) => matchesOne(s, el));

/** What https://my.fetchpet.com/login serves today, recorded in strad#28. */
const LIVE_LOGIN_FORM = [
  { tag: 'input', attrs: { type: 'email' }, name: 'email' },
  { tag: 'input', attrs: { type: 'password' }, name: 'password' },
  { tag: 'button', attrs: { type: 'submit' }, name: 'submit' },
];

/** The shape the old selectors were written for: placeholders, no floating labels. */
const PLACEHOLDER_LOGIN_FORM = [
  { tag: 'input', attrs: { type: 'text', placeholder: 'Email address' }, name: 'email' },
  { tag: 'input', attrs: { type: 'password', placeholder: 'Password' }, name: 'password' },
  { tag: 'button', attrs: { type: 'submit' }, name: 'submit' },
];

/** The selector pair the server timed out on for every boot in strad#28. */
const STALE_EMAIL_SELECTOR = 'input[placeholder*="email" i], input[autocomplete="email"]';

test('the email selector matches the field Fetch actually renders', () => {
  const hits = LIVE_LOGIN_FORM.filter((el) => matches(EMAIL_FIELD_SELECTOR, el));
  assert.deepEqual(
    hits.map((el) => el.name),
    ['email'],
    'the union must match the floating-label <input type="email"> and nothing else'
  );
});

test('the password selector matches the field Fetch actually renders', () => {
  const hits = LIVE_LOGIN_FORM.filter((el) => matches(PASSWORD_FIELD_SELECTOR, el));
  assert.deepEqual(
    hits.map((el) => el.name),
    ['password']
  );
});

test('the stale placeholder-only selector matches nothing on that form', () => {
  // The regression witness: this is what the server waited 30s for, every boot.
  assert.equal(
    LIVE_LOGIN_FORM.some((el) => matches(STALE_EMAIL_SELECTOR, el)),
    false
  );
});

test('widening did not drop the placeholder form it used to match', () => {
  assert.deepEqual(
    PLACEHOLDER_LOGIN_FORM.filter((el) => matches(EMAIL_FIELD_SELECTOR, el)).map((el) => el.name),
    ['email']
  );
  assert.deepEqual(
    PLACEHOLDER_LOGIN_FORM.filter((el) => matches(PASSWORD_FIELD_SELECTOR, el)).map(
      (el) => el.name
    ),
    ['password']
  );
});

// ---------------------------------------------------------------------------
// The fake browser
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
  }
  first() {
    return this;
  }
  async waitFor({ timeout = 5000 } = {}) {
    this.page.waited.push(this.selector);
    const deadline = Date.now() + timeout;
    for (;;) {
      if (this.page.query(this.selector).length > 0) return;
      if (Date.now() >= deadline) {
        // The shape Playwright reports, so the assertions read like the logs.
        throw new Error(
          `page.fill: Timeout ${timeout}ms exceeded.\n  - waiting for locator('${this.selector}')`
        );
      }
      await sleep(2);
    }
  }
  async fill(value) {
    const el = this.page.query(this.selector)[0];
    if (!el) throw new Error(`fill: no element matches ${this.selector}`);
    this.page.filled.push({ field: el.name, value });
  }
}

class FakePage {
  constructor(form) {
    this.form = form; // a live reference; tests re-render by assigning .elements
    this.currentUrl = 'https://my.fetchpet.com/login';
    this.filled = [];
    this.waited = [];
    this.probed = [];
    this.clicked = [];
    this.closed = false;
  }
  query(selector) {
    return this.form.elements.filter((el) => matches(selector, el));
  }
  setDefaultTimeout() {}
  locator(selector) {
    return new FakeLocator(this, selector);
  }
  /** Non-waiting, exactly like Playwright's: null when the tree has not rendered. */
  async $(selector) {
    this.probed.push(selector);
    const el = this.query(selector)[0];
    if (!el) return null;
    return {
      fill: async (value) => this.filled.push({ field: el.name, value }),
      click: async () => this.clicked.push(el.name),
      textContent: async () => el.text ?? '',
    };
  }
  async $$() {
    return [];
  }
  async goto(url) {
    this.currentUrl = url;
  }
  async waitForTimeout() {}
  async waitForSelector() {
    return null;
  }
  /** Stands in for the post-sign-in navigation. */
  async waitForFunction() {
    this.currentUrl = 'https://my.fetchpet.com/';
  }
  async evaluate() {
    return [];
  }
  url() {
    return this.currentUrl;
  }
  async screenshot() {}
  on() {}
  off() {}
}

class FakeBrowser {
  constructor(form) {
    this.form = form;
    this.pages = [];
    this.contextsOpened = 0;
    this.contextsClosed = 0;
  }
  async newContext() {
    this.contextsOpened += 1;
    return {
      newPage: async () => {
        const page = new FakePage(this.form);
        this.pages.push(page);
        return page;
      },
      close: async () => {
        this.contextsClosed += 1;
      },
    };
  }
}

const CONFIG = () => ({
  username: 'agent@example.com',
  password: 'hunter2',
  headless: true,
  timeout: 300,
  downloadDir: mkdtempSync(join(tmpdir(), 'fetchpet-test-')),
});

// ---------------------------------------------------------------------------
// fillLoginField waits
// ---------------------------------------------------------------------------

test('fillLoginField waits for a field the SPA has not rendered yet', async () => {
  const form = { elements: [] };
  const page = new FakePage(form);
  setTimeout(() => {
    form.elements = LIVE_LOGIN_FORM;
  }, 30);

  await fillLoginField(page, EMAIL_FIELD_SELECTOR, 'agent@example.com', 2000);

  assert.deepEqual(page.filled, [{ field: 'email', value: 'agent@example.com' }]);
  assert.deepEqual(page.waited, [EMAIL_FIELD_SELECTOR]);
  assert.deepEqual(page.probed, [], 'no non-waiting probe may decide which field to fill');
});

test('fillLoginField reports the whole union when the form never appears', async () => {
  const page = new FakePage({ elements: [] });
  await assert.rejects(() => fillLoginField(page, EMAIL_FIELD_SELECTOR, 'x', 40), (err) => {
    assert.match(err.message, /Timeout 40ms exceeded/);
    assert.match(err.message, /input\[type="email"\]/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// initialize() over the fake browser
// ---------------------------------------------------------------------------

test('initialize logs in against the live form shape, rendered late', async () => {
  const form = { elements: [] };
  const browser = new FakeBrowser(form);
  setSharedBrowserProvider(async () => browser);
  setTimeout(() => {
    form.elements = LIVE_LOGIN_FORM;
  }, 30);

  try {
    const client = new FetchPetClient(CONFIG());
    await client.initialize();

    assert.deepEqual(browser.pages[0].filled, [
      { field: 'email', value: 'agent@example.com' },
      { field: 'password', value: 'hunter2' },
    ]);
    assert.deepEqual(browser.pages[0].clicked, ['submit']);
    // A shared browser belongs to the host: close our context, never its browser.
    await client.close();
    assert.equal(browser.contextsClosed, 1);
  } finally {
    setSharedBrowserProvider(null);
  }
});

test('initialize fails when no login form is served', async () => {
  const browser = new FakeBrowser({ elements: [] });
  setSharedBrowserProvider(async () => browser);
  try {
    const client = new FetchPetClient(CONFIG());
    await assert.rejects(() => client.initialize(), /Timeout 300ms exceeded/);
  } finally {
    setSharedBrowserProvider(null);
  }
});

// ---------------------------------------------------------------------------
// A failed login is retried on the next tool call
// ---------------------------------------------------------------------------

class FakeServer {
  constructor() {
    this.handlers = new Map();
  }
  setRequestHandler(schema, handler) {
    this.handlers.set(schema, handler);
  }
  call(schema, request) {
    return this.handlers.get(schema)(request);
  }
}

/** Boot a factory against the fake browser, with credentials in the env. */
async function bootFetchpet(form) {
  process.env.FETCHPET_USERNAME = 'agent@example.com';
  process.env.FETCHPET_PASSWORD = 'hunter2';
  process.env.TIMEOUT = '300';
  process.env.FETCHPET_DOWNLOAD_DIR = mkdtempSync(join(tmpdir(), 'fetchpet-test-'));

  const browser = new FakeBrowser(form);
  setSharedBrowserProvider(async () => browser);

  const created = createMCPServer({ version: 'test' });
  const server = new FakeServer();
  await created.registerHandlers(server);
  return { created, server, browser };
}

const getClaims = (server) =>
  server.call(CallToolRequestSchema, {
    params: { name: 'get_claims', arguments: {} },
  });

test('a boot-time login failure is retried on the next tool call', async () => {
  const form = { elements: [] }; // Fetch serves a form we cannot fill
  const { created, server, browser } = await bootFetchpet(form);
  const failures = [];
  const recoveries = [];

  try {
    created.startBackgroundLogin(
      (error) => failures.push(error.message),
      () => recoveries.push('recovered')
    );

    // The boot attempt fails, and says so once.
    const failed = await getClaims(server);
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /Login failed/);
    assert.match(failed.content[0].text, /retry the call/);
    assert.equal(failures.length, 1);
    // The half-initialized client is not left holding a context on the login page.
    assert.equal(browser.contextsClosed, 1);

    // Fetch fixes its form (or the container stops thrashing) — no redeploy.
    form.elements = LIVE_LOGIN_FORM;

    const recovered = await getClaims(server);
    assert.equal(recovered.isError, undefined);
    assert.equal(recoveries.length, 1, 'the host is told the mount is no longer degraded');
    assert.equal(browser.contextsOpened, 2, 'the retry logged in on a FRESH context');
  } finally {
    await created.cleanup();
    setSharedBrowserProvider(null);
  }
});

test('a missing credential is reported and retried, not thrown at the host', async () => {
  // createClient() throws rather than rejects when the env is incomplete. Every
  // failure has to leave through the same door, or a host that starts the login
  // before checking its own env gets an exception where it expected a callback.
  const form = { elements: LIVE_LOGIN_FORM };
  const { created, server, browser } = await bootFetchpet(form);
  const failures = [];

  try {
    delete process.env.FETCHPET_PASSWORD;
    created.startBackgroundLogin((error) => failures.push(error.message));

    assert.equal(failures.length, 1);
    assert.match(failures[0], /FETCHPET_USERNAME and FETCHPET_PASSWORD/);
    assert.equal(browser.contextsOpened, 0, 'no browser is opened without credentials');

    // The credential arrives (a restart with the secret plumbed, say).
    process.env.FETCHPET_PASSWORD = 'hunter2';
    const recovered = await getClaims(server);
    assert.equal(recovered.isError, undefined);
    assert.equal(browser.contextsOpened, 1);
  } finally {
    process.env.FETCHPET_PASSWORD = 'hunter2';
    await created.cleanup();
    setSharedBrowserProvider(null);
  }
});

test('concurrent tool calls share one login attempt', async () => {
  const form = { elements: LIVE_LOGIN_FORM };
  const { created, server, browser } = await bootFetchpet(form);

  try {
    created.startBackgroundLogin(() => {});
    const [a, b, c] = await Promise.all([
      getClaims(server),
      getClaims(server),
      getClaims(server),
    ]);
    for (const result of [a, b, c]) assert.equal(result.isError, undefined);
    assert.equal(browser.contextsOpened, 1, 'one login, not one per call');
  } finally {
    await created.cleanup();
    setSharedBrowserProvider(null);
  }
});
