import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createRegisterTools } from './tools.js';
import { withBrowserTelemetry } from './telemetry.js';
import {
  basketSnapshotFromHtml,
  extractStoreData,
  productNameFromHtml,
  type BasketSnapshot,
} from './basketState.js';
import {
  findPastOrder,
  parseOrderDateQuery,
  pastOrderItemsFromStoreData,
  pastOrdersFromStoreData,
  type PastOrdersStoreData,
} from './pastOrders.js';
import {
  getKitchenNutritionSource,
  groceryNutritionFromHtml,
  type GroceryNutrition,
} from './nutrition.js';
import type {
  GoodEggsConfig,
  GroceryItem,
  GroceryDetails,
  PastOrder,
  CartResult,
  CartItem,
} from './types.js';

const BASE_URL = 'https://www.goodeggs.com';

// How long to wait (ms) for a dynamically-rendered control (add button, favorite
// control) to appear before giving up. Capped against the configured timeout.
const ELEMENT_WAIT_TIMEOUT_MS = 10_000;

// A Good Eggs product id is a 24-character Mongo-style hex string. Removal
// interpolates one into a CSS selector, so it is validated against this first.
const PRODUCT_ID_PATTERN = /^[0-9a-f]{24}$/i;

// The remove control, in either basket layout. The card layout's quantity pill
// decrements and becomes the trash button at quantity 1; the summary layout has
// a "Remove" control (and, failing that, a quantity <select> with a 0 option).
const REMOVE_CONTROL_SELECTOR =
  '[data-testid="qty-trash"], [data-testid="qty-decrement"], .quantity-pill__btn--left, ' +
  'button[aria-label*="remove" i], .summary-item__remove, [class*="remove-button"]';

// Ceiling on remove clicks for one call. A decrement-per-click control on a
// large line would otherwise spend a second per unit inside a single tool call.
const MAX_REMOVE_CLICKS = 15;

// The paths Good Eggs serves the sign-in form on. A page under one of these is
// a page nobody is logged in on; anywhere else is somewhere the site sent us
// after it accepted the credentials.
const SIGN_IN_PATHS = ['/signin', '/sign-in', '/login'];

/**
 * Whether `url` is a page reached AFTER the sign-in form — which, on Good Eggs,
 * means anywhere on goodeggs.com that is not the sign-in form itself.
 *
 * Deliberately a PATH test. Good Eggs picks where to land you post-login and
 * has moved it: `/home?recently-logged-in=true` is where it lands as of
 * 2026-08-28, and the page you came from is where it landed before. Query
 * strings, fragments, trailing slashes and casing say nothing about whether the
 * login took, so none of them participate; an exact-URL predicate would turn the
 * next such change into a 30-second timeout that takes every tool on the server
 * down with it.
 *
 * Leaving the form is necessary and NOT sufficient, which is why this is only
 * half of what `waitForSignIn` decides on: the form could be renamed to a path
 * this does not know, and then a rejected credential sits on a URL that passes
 * here. The page's own payload is the other half.
 */
export function isPostSignInUrl(url: string | URL): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return false;
  }

  // A `data:` or `about:` URL is not a Good Eggs page, and neither is another
  // site's: a login still bouncing through one has not arrived yet.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host !== 'goodeggs.com' && !host.endsWith('.goodeggs.com')) return false;

  // Percent-encoding is decoded first: `/%73ignin` is the form, spelled to
  // evade a literal comparison. Trailing slashes and casing are presentation.
  let path = parsed.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape decodes to nothing useful; compare what we were given.
  }
  path = path.toLowerCase().replace(/\/+$/, '') || '/';
  return !SIGN_IN_PATHS.some((signIn) => path === signIn || path.startsWith(`${signIn}/`));
}

/**
 * A URL reduced to the part worth putting in an error message: origin and path,
 * no query and no fragment. Both are upstream-authored, and this message ends up
 * in the bundle's `degraded` string and in every tool error it produces.
 */
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<unparseable url>';
  }
}

/** What a page's own state payload says about who is signed in, if anything. */
type SignedInSignal = 'signed-in' | 'anonymous' | 'unknown';

/**
 * Read the session off the page's `storeData` payload.
 *
 * `user` is the slice the store always carries: an object when somebody is
 * signed in, and `null` on an anonymous page — the same signal
 * `basketSnapshotFromHtml` refuses an anonymous basket on (FORK.md #5).
 *
 * A payload that carries no `user` key AT ALL is `unknown`, not `anonymous`.
 * That distinction is the difference between this being a safety net and being
 * a second way to break the server: refusing a basket read on a payload nobody
 * recognises is cheap, and refusing a LOGIN on one takes every tool down.
 * So a shape change, an error page and a page that ships no payload all leave
 * the verdict to the URL.
 */
async function signedInFromPage(page: import('playwright').Page): Promise<SignedInSignal> {
  let storeData: ReturnType<typeof extractStoreData>;
  try {
    storeData = extractStoreData(await page.content());
  } catch {
    return 'unknown';
  }
  if (!storeData || storeData.user === undefined) return 'unknown';
  return storeData.user === null ? 'anonymous' : 'signed-in';
}

// The fallback add control. Good Eggs renders it as a <button> whose label
// varies in casing ("ADD TO BASKET", "Add to Cart") and occasionally as a
// role="button" element, so every spelling is matched case-insensitively.
// `visible=true` filters the WHOLE list before Playwright picks a match:
// `waitForSelector(..., { state: 'visible' })` judges only the FIRST element
// the selector resolves to, so a hidden duplicate earlier in the document
// would otherwise hold the wait to its timeout beside a visible button.
export const ADD_BUTTON_SELECTOR =
  'button:has-text("add to basket"), button:has-text("add to cart"), ' +
  '[role="button"]:has-text("add to basket"), [role="button"]:has-text("add to cart") ' +
  '>> visible=true';

// The endpoint Good Eggs' own "Add to basket" button posts to, from the product
// page: `{ productId, quantity, shouldSubscribe }`. `quantity` is the line's
// new TOTAL, not an increment — posting 1 for a line already at 1 leaves it at
// 1 — so the add is idempotent, and posting less than the line holds would
// REMOVE units. FORK.md #13.
export const BASKET_UPDATE_PATH = '/api/basket/update-item';

/** What Good Eggs answered a basket update with. */
export type BasketUpdateOutcome =
  | { accepted: true; quantity: number }
  | { accepted: false; reason: string };

/**
 * Read the answer to a `POST /api/basket/update-item`. Accepted means a 2xx
 * whose `basketItem` names the product and carries a numeric quantity; any
 * other answer is a refusal, with the reason Good Eggs gave when it gave one
 * (`{"error":{"message":"Product could not be added to basket"}}` on a 500).
 */
export function parseBasketUpdateResponse(
  status: number,
  body: string,
  productId: string
): BasketUpdateOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const root = record(parsed);
  if (status >= 200 && status < 300) {
    const item = record(root?.basketItem);
    const product = record(item?.product);
    const quantity = item?.quantity;
    if (product?.id === productId && typeof quantity === 'number') {
      return { accepted: true, quantity };
    }
    return {
      accepted: false,
      reason: `Good Eggs answered the basket update with HTTP ${status} but no basket line for this product`,
    };
  }
  const message = record(root?.error)?.message;
  const said = typeof message === 'string' && message.trim() ? `: ${message.trim().slice(0, 200)}` : '';
  return { accepted: false, reason: `Good Eggs refused the basket update with HTTP ${status}${said}` };
}

/**
 * Extract the stable product id (the trailing path segment) from a Good Eggs
 * product URL. Good Eggs URLs look like
 * `/<producer>/<product-slug>/<product-id>`, and the id is the only part that
 * stays constant across producer/slug renames, so it's the reliable join key
 * when reconciling a requested item against the cart.
 */
export function extractProductId(url: string): string {
  const withoutQueryOrHash = url.split(/[?#]/)[0];
  // Strip the protocol so the host isn't mistaken for a path segment.
  const withoutProtocol = withoutQueryOrHash.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const segments = withoutProtocol.split('/').filter((segment) => segment.length > 0);
  // A real product id needs a path beyond the host; the first segment is the
  // host (e.g. www.goodeggs.com) for absolute URLs.
  if (segments.length <= 1) return '';
  return segments[segments.length - 1] || '';
}

/**
 * Find the cart item that corresponds to a product URL, matching on the stable
 * product id (the trailing path segment), which is invariant across
 * producer/slug renames. The id is a long Mongo-style hex string, so an exact
 * id-to-id comparison is the reliable join key.
 */
export function findCartItemForUrl(
  cartItems: CartItem[],
  groceryUrl: string
): CartItem | undefined {
  const productId = extractProductId(groceryUrl);
  if (!productId) return undefined;
  // `productId` is read off the basket payload and survives a product whose
  // presentation data (and therefore whose url) the page didn't ship; fall back
  // to the url only for items that predate it.
  return cartItems.find(
    (item) => (item.productId || extractProductId(item.url)) === productId
  );
}

export interface ReconcileAddParams {
  groceryUrl: string;
  requestedQuantity: number;
  itemName: string;
  /** Quantity of this item already in the cart BEFORE the add was attempted. */
  priorQuantity: number;
  /**
   * Whether `priorQuantity` was actually measured. When false the before/after
   * delta is not available, so a present item cannot be credited to this call.
   */
  priorQuantityKnown: boolean;
  /** Cart contents read back AFTER the add was attempted. */
  cartItems: CartItem[];
  /**
   * Whether the add was sent: Good Eggs accepted the basket update, or the
   * fallback add button was found and clicked.
   */
  addSent: boolean;
  /**
   * Why the add was not sent, when it was not. It goes into the failure
   * message, so a failed add says what went wrong instead of guessing.
   */
  addFailure?: string;
  /**
   * Whether the after-read actually succeeded. When false, `cartItems` is not
   * evidence of anything and no outcome may be asserted from it.
   */
  cartReadable: boolean;
}

/**
 * Decide the true outcome of an add-to-cart attempt by reconciling what we tried
 * to do against the actual cart contents read back afterward.
 *
 * This exists because what the add reported and the server-side cart state can
 * disagree: an add that was accepted can still leave nothing in the basket
 * because, e.g., a delivery day still needs to be selected, and an add that
 * looked unsent can have landed. The cart is the source of truth.
 *
 * Success is judged by a BEFORE/AFTER delta, not just the after-snapshot: an
 * item that was already in the cart must not be misreported as a fresh add when
 * this attempt changed nothing.
 */
export function reconcileAddResult(params: ReconcileAddParams): CartResult {
  const {
    groceryUrl,
    requestedQuantity,
    itemName,
    priorQuantity,
    cartItems,
    addSent,
    addFailure,
    cartReadable,
    priorQuantityKnown,
  } = params;
  const notSent = addFailure ?? 'the add-to-cart button was not found';

  // The basket could not be read back. Nothing here is evidence, so say that
  // instead of picking an outcome. Reporting an unread basket as "the add did
  // not take effect" is what invited re-adds and produced duplicates.
  if (!cartReadable) {
    const name = itemName && itemName !== 'Unknown item' ? itemName : 'the item';
    // `success: false` here means "not observed to have succeeded", not "failed";
    // `verified: false` is what says which. `quantity` is omitted rather than
    // set to 0, because a 0 would be indistinguishable from a measured absence.
    return {
      success: false,
      verified: false,
      message: addSent
        ? `Sent the add for ${name}, but the basket could not be read back, so the result is ` +
          `UNVERIFIED. Do not re-add it without checking the cart first — a blind retry is how ` +
          `duplicates happen.`
        : `The add for ${name} was not sent (${notSent}) and the basket could not be read ` +
          `back, so the result is UNVERIFIED. Check the cart before retrying.`,
      itemName,
    };
  }

  const match = findCartItemForUrl(cartItems, groceryUrl);
  const cartQuantity = match?.quantity ?? 0;
  const displayName = itemName && itemName !== 'Unknown item' ? itemName : match?.name || itemName;
  const delta = cartQuantity - priorQuantity;

  // The before-read failed, so there is no delta to reason from. Report the
  // cart quantity that IS known and decline to credit it to this call.
  if (!priorQuantityKnown) {
    if (cartQuantity > 0) {
      return {
        // Verified in the sense this flag carries: the basket WAS read, so the
        // quantity is measured. What is unknown is attribution, and the message
        // is where that is said.
        success: true,
        verified: true,
        message:
          `${displayName} is in your cart at quantity ${cartQuantity}. The basket could not be ` +
          `read before this add, so whether this call is what put it there is unknown.`,
        itemName: displayName,
        quantity: cartQuantity,
      };
    }
    return {
      success: false,
      verified: true,
      message: addSent
        ? `Sent the add for ${displayName}, but it is not in your cart afterward. The add did ` +
          `not take effect (a delivery day may need to be selected, or the item may be ` +
          `unavailable).`
        : `The add for ${displayName} was not sent (${notSent}), and it is not in your cart. ` +
          `The add did not succeed.`,
      itemName: displayName,
      quantity: 0,
    };
  }

  // The cart quantity went up: this attempt demonstrably added the item.
  if (delta > 0) {
    if (cartQuantity >= requestedQuantity) {
      return {
        success: true,
        verified: true,
        message: addSent
          ? `Successfully added ${displayName} to cart (cart now has ${cartQuantity}).`
          : `The add was not sent (${notSent}), but the cart quantity for ` +
            `${displayName} increased to ${cartQuantity}. The add succeeded.`,
        itemName: displayName,
        quantity: cartQuantity,
      };
    }
    return {
      success: true,
      verified: true,
      message:
        `Partially added: ${displayName} is now in your cart at quantity ${cartQuantity}, ` +
        `below the requested ${requestedQuantity}. You may need to adjust the quantity.`,
      itemName: displayName,
      quantity: cartQuantity,
    };
  }

  // No increase observed. If the item was already in the cart at or above the
  // requested quantity, the goal is satisfied even though this attempt added
  // nothing — report that honestly rather than claiming a fresh add happened.
  if (cartQuantity > 0 && priorQuantity >= requestedQuantity) {
    return {
      success: true,
      verified: true,
      message:
        `${displayName} is already in your cart at quantity ${cartQuantity}, which meets the ` +
        `requested ${requestedQuantity}; no additional units were added.`,
      itemName: displayName,
      quantity: cartQuantity,
    };
  }

  // The cart is short of the request and this attempt did not increase it.
  if (cartQuantity > 0) {
    return {
      success: false,
      verified: true,
      message: addSent
        ? `Sent the add for ${displayName}, but the cart quantity did not change (still ` +
          `${cartQuantity}, below the requested ${requestedQuantity}). The add did not take ` +
          `effect (a delivery day may need to be selected).`
        : `The add for ${displayName} was not sent (${notSent}) and its cart quantity did ` +
          `not change (still ${cartQuantity}, below the requested ${requestedQuantity}). The ` +
          `add did not take effect.`,
      itemName: displayName,
      quantity: cartQuantity,
    };
  }

  return {
    success: false,
    verified: true,
    message: addSent
      ? `Sent the add for ${displayName}, but it does not appear in your cart afterward. ` +
        `The add did not take effect (a delivery day may need to be selected, or the item may be unavailable).`
      : `The add for ${displayName} was not sent (${notSent}), and it is not in your cart. ` +
        `The add did not succeed.`,
    itemName: displayName,
    quantity: 0,
  };
}

/**
 * Run an operation that navigates/reads the page, retrying once if it throws.
 * Stale-element and "execution context was destroyed" errors happen when Good
 * Eggs re-renders mid-interaction; a single reload-and-retry clears them.
 */
export async function withNavigationRetry<T>(
  operation: () => Promise<T>,
  onRetry: () => Promise<void>
): Promise<T> {
  try {
    return await operation();
  } catch {
    await onRetry();
    return await operation();
  }
}

/**
 * Minimal surface of a Playwright Page needed to wait for an element. Declaring
 * it here keeps the waiting helper unit-testable with a plain fake instead of a
 * full browser.
 */
export interface WaitablePage {
  waitForSelector(
    selector: string,
    options?: { timeout?: number; state?: 'visible' | 'attached' }
  ): Promise<unknown>;
}

/**
 * Wait for an element to become visible, returning its handle or null on
 * timeout instead of throwing. Replaces synchronous `page.$()` null-checks that
 * miss controls which render a beat after `domcontentloaded`.
 */
export async function waitForElement(
  page: WaitablePage,
  selector: string,
  timeout: number
): Promise<unknown | null> {
  try {
    return (await page.waitForSelector(selector, { timeout, state: 'visible' })) ?? null;
  } catch {
    return null;
  }
}

/**
 * Good Eggs client interface
 * Defines all methods for interacting with the Good Eggs grocery store
 */
export interface IGoodEggsClient {
  /**
   * Initialize the browser and log in to Good Eggs
   * Must be called before using other methods
   */
  initialize(): Promise<void>;

  /**
   * Search for groceries
   */
  searchGroceries(query: string): Promise<GroceryItem[]>;

  /**
   * Get user's favorite items
   */
  getFavorites(): Promise<GroceryItem[]>;

  /**
   * Get detailed information about a specific grocery item
   */
  getGroceryDetails(groceryUrl: string): Promise<GroceryDetails>;

  /**
   * Nutrition and photo URLs for a product — what Good Eggs publishes, with an
   * explicit status when it publishes nothing (FORK.md #12)
   */
  getGroceryNutrition(groceryUrl: string): Promise<GroceryNutrition>;

  /**
   * Add an item to the shopping cart
   */
  addToCart(groceryUrl: string, quantity: number): Promise<CartResult>;

  /**
   * Search for freebie/deal groceries
   */
  searchFreebieGroceries(): Promise<GroceryItem[]>;

  /**
   * Get list of past order dates
   */
  getPastOrderDates(): Promise<PastOrder[]>;

  /**
   * Get groceries from a specific past order
   */
  getPastOrderGroceries(orderDate: string): Promise<GroceryItem[]>;

  /**
   * Add an item to favorites
   */
  addFavorite(groceryUrl: string): Promise<CartResult>;

  /**
   * Remove an item from favorites
   */
  removeFavorite(groceryUrl: string): Promise<CartResult>;

  /**
   * Remove an item from the cart
   */
  removeFromCart(groceryUrl: string): Promise<CartResult>;

  /**
   * Get current cart contents.
   *
   * THROWS when the basket cannot be read. It must never answer an unreadable
   * basket with an empty array — a caller cannot tell those apart, and telling
   * them apart is the difference between "your cart is empty" and the truth.
   */
  getCart(): Promise<CartItem[]>;

  /**
   * Get the current basket with its totals. Same read as `getCart()`, and the
   * same contract: it throws rather than inventing an empty basket.
   */
  getBasket(): Promise<BasketSnapshot>;

  /**
   * Get the current page URL
   */
  getCurrentUrl(): Promise<string>;

  /**
   * Close the browser
   */
  close(): Promise<void>;

  /**
   * Get the configuration
   */
  getConfig(): GoodEggsConfig;
}

/**
 * A browser this server should USE rather than LAUNCH.
 *
 * strad's single collapsed bundle co-locates good-eggs, fetchpet and pointsyeah
 * in one container. Three Chromiums in one 1-vCPU box is three ~545MB peaks
 * competing for one core, so the host launches ONE Chromium (with the same
 * playwright-extra stealth plugin applied at the browser level) and hands it to
 * each server through this seam. Each server still opens its OWN context — the
 * logged-in Good Eggs session stays isolated from Fetch Pet's.
 *
 * Unset (the default, and how the standalone good-eggs image runs): this server
 * launches and owns its own browser exactly as before.
 */
export type SharedBrowserProvider = () => Promise<import('playwright').Browser>;

let sharedBrowserProvider: SharedBrowserProvider | null = null;

export function setSharedBrowserProvider(provider: SharedBrowserProvider | null): void {
  sharedBrowserProvider = provider;
}

/**
 * Good Eggs client implementation using Playwright
 */
export class GoodEggsClient implements IGoodEggsClient {
  private browser: import('playwright').Browser | null = null;
  private context: import('playwright').BrowserContext | null = null;
  private page: import('playwright').Page | null = null;
  private config: GoodEggsConfig;
  private isInitialized = false;
  /** False when the browser came from a host (see SharedBrowserProvider): we
   *  close our context on teardown, never someone else's browser. */
  private ownsBrowser = true;

  constructor(config: GoodEggsConfig) {
    this.config = config;
  }

  private async ensureBrowser(): Promise<import('playwright').Page> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }
    return this.page;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    if (sharedBrowserProvider) {
      // A host owns the browser (strad's collapsed bundle). It applied the same
      // stealth plugin at launch, and stealth patches the Browser object itself,
      // so contexts we open on it are evasion-equipped exactly as our own would be.
      this.browser = await sharedBrowserProvider();
      this.ownsBrowser = false;
    } else {
      // Use playwright-extra with stealth plugin for better bot detection avoidance
      const { chromium } = await import('playwright-extra');
      const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;

      chromium.use(StealthPlugin());

      // Timed and counted, and the returned browser gets a `disconnected` listener
      // that reports a crash together with the container's memory pressure at that
      // instant — which is the only way to tell an OOM-killed Chromium apart from
      // one that died on a bad page. No-ops entirely when no telemetry bootstrap
      // is loaded. See shared/src/telemetry.ts.
      //
      // Only OUR OWN launch is wrapped: a browser handed to us by a host (the
      // collapsed bundle) was launched — and instrumented — by that host, and
      // double-counting it would report two Chromiums where one exists.
      this.browser = await withBrowserTelemetry('good-eggs', () =>
        chromium.launch({
          headless: this.config.headless,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--no-sandbox',
          ],
        }),
      );
      this.ownsBrowser = true;
    }

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    this.page = await this.context.newPage();

    // Navigate to login page
    // Use domcontentloaded instead of networkidle - Good Eggs has persistent connections that prevent networkidle
    await this.page.goto(`${BASE_URL}/signin`, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2000);

    // Fill in login credentials
    await this.page.fill('input[name="email"], input[type="email"]', this.config.username);
    await this.page.fill('input[name="password"], input[type="password"]', this.config.password);

    // Click sign in button
    await this.page.click('button:has-text("Sign In")');

    await this.waitForSignIn();

    this.isInitialized = true;
  }

  /**
   * Block until the sign-in form has been left behind, then decide whether the
   * session is really authenticated.
   *
   * `waitUntil: 'domcontentloaded'` is the load-bearing argument. `waitForURL`
   * defaults to `'load'`, and the page Good Eggs lands on after accepting
   * credentials does not fire it. On 2026-08-28 every authenticated call in
   * production failed with `page.waitForURL: Timeout 30000ms exceeded`, over a
   * log that said the navigation to `/home?recently-logged-in=true` had already
   * happened and that `networkidle` and `domcontentloaded` had both fired —
   * `load` never did. Playwright only logs those lifecycle lines once the URL
   * predicate has matched, so the URL was never the problem: the wait was
   * parked on a `load` event that page does not send. Every other navigation in
   * this file passes `domcontentloaded` because Good Eggs holds connections
   * open; this one wait was the exception, and it gated the whole server.
   *
   * The wait is a SIGNAL, not the verdict. What decides is the state of the
   * page once the wait ends, whichever way it ended: a login that succeeded
   * while Playwright was still waiting for something must not be reported as a
   * failed one, and a wait that returned the instant the form was renamed must
   * not be reported as a successful one.
   *
   * fetchpet learned the same lesson one tree over and wrote it down — its
   * login avoids `waitForURL` outright because the default `'load'` "can hang
   * when third-party resources fail to load" — and this server did not get it.
   */
  private async waitForSignIn(): Promise<void> {
    const page = await this.ensureBrowser();

    let waitError: Error | null = null;
    try {
      await page.waitForURL((url) => isPostSignInUrl(url), {
        timeout: this.config.timeout,
        waitUntil: 'domcontentloaded',
      });
    } catch (error) {
      waitError = error instanceof Error ? error : new Error(String(error));
    }

    const detail = waitError ? ` The wait ended with: ${waitError.message}` : '';

    // `page.url()` is a CACHED client-side read that answers happily for a page
    // that no longer exists, so a Chromium killed mid-login (this container
    // shares one; see browser telemetry) would otherwise report the URL it died
    // on as a successful sign-in — and the mount would come up healthy and fail
    // every call.
    if (page.isClosed()) {
      throw new Error(`the page closed before sign-in could be confirmed.${detail}`);
    }

    // The page's own payload is the strongest evidence available, and it is
    // consulted whichever way the wait ended: an anonymous payload is a failed
    // login even on a URL that looks like an arrival.
    const signal = await signedInFromPage(page);
    if (signal === 'signed-in') return;
    // Nothing recognisable in the payload — a shape change, an error page, a
    // page that ships none. Where the browser ended up is what is left.
    if (signal === 'unknown' && isPostSignInUrl(page.url())) return;

    // Report the page WITHOUT its query string: this message becomes the
    // bundle's per-mount `degraded` text and the body of every tool error, and
    // a query string is upstream-authored content we did not choose to publish.
    // No "Login failed" prefix here: the caller that surfaces this
    // (`getReadyClient`) adds one, and two of them read as a stutter.
    throw new Error(
      `the session is not signed in after submitting credentials ` +
        `(${sanitizeUrl(page.url())}). Check GOOD_EGGS_USERNAME / GOOD_EGGS_PASSWORD.${detail}`
    );
  }

  async searchGroceries(query: string): Promise<GroceryItem[]> {
    const page = await this.ensureBrowser();

    // Navigate to search page
    // Use domcontentloaded instead of networkidle - Good Eggs has persistent connections
    await page.goto(`${BASE_URL}/search?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
    });

    // Wait for React to render the product list
    await page.waitForTimeout(3000);

    // Extract product information from the page
    const items = await page.evaluate(() => {
      const products: GroceryItem[] = [];
      const seen = new Set<string>();

      // Good Eggs product tiles have the structure with product-tile class at root
      // Each tile contains a favorite indicator and product links
      const productTiles = document.querySelectorAll('.product-tile');

      productTiles.forEach((tile) => {
        // Find the product link within this tile
        const link = tile.querySelector('a.js-product-link') as HTMLAnchorElement;
        if (!link) return;

        const href = link.href;

        // Skip if already seen or not a valid product URL
        if (!href || seen.has(href)) {
          return;
        }

        // Validate URL structure: should have at least 3 path segments after domain
        const urlPath = new URL(href).pathname;
        const segments = urlPath.split('/').filter((s) => s.length > 0);
        if (segments.length < 3) {
          return;
        }

        // Skip navigation pages
        if (
          href.includes('/search') ||
          href.includes('/signin') ||
          href.includes('/home') ||
          href.includes('/basket') ||
          href.includes('/account') ||
          href.includes('/favorites') ||
          href.includes('/reorder')
        ) {
          return;
        }

        // Check favorite status from the tile
        // Favorited items have: class="product-tile__favorite favorited"
        // Non-favorited items have: class="product-tile__favorite not-favorited"
        const favoriteEl = tile.querySelector('.product-tile__favorite');
        const isFavorite = favoriteEl?.classList.contains('favorited') ?? false;

        const nameEl =
          tile.querySelector('h2, h3, h4, h5, [class*="product-name"]') ||
          link.querySelector('h2, h3, h4, h5');
        const brandEl = tile.querySelector('[class*="producer-name"], [class*="brand"]');
        const priceEl = tile.querySelector('[data-testid="product-tile__final-price"]');
        const discountEl = tile.querySelector('[data-testid="discount-amount"]');
        const imgEl = tile.querySelector('img');

        // Get name from element or from the link text itself
        let name = nameEl?.textContent?.trim();
        if (!name || name.length < 3) {
          name = link.textContent?.trim();
        }
        if (!name || name.length < 3) return;

        seen.add(href);
        products.push({
          url: href,
          name: name,
          brand: brandEl?.textContent?.trim() || '',
          price: priceEl?.textContent?.trim() || '',
          discount: discountEl?.textContent?.trim() || undefined,
          imageUrl: imgEl?.src || undefined,
          isFavorite: isFavorite,
        });
      });

      return products;
    });

    return items;
  }

  async getFavorites(): Promise<GroceryItem[]> {
    const page = await this.ensureBrowser();

    // Navigate to favorites page
    // Use domcontentloaded instead of networkidle - Good Eggs has persistent connections
    await page.goto(`${BASE_URL}/favorites`, { waitUntil: 'domcontentloaded' });

    // Read the session from the SERVED document, before React hydrates over it.
    // The payload rides in the document Good Eggs sent, so — exactly as in
    // `getBasket()` — there is nothing to wait for beyond `domcontentloaded`,
    // and waiting anyway risks reading a document the app has since rewritten.
    const session = await signedInFromPage(page);

    // Wait for React to render
    await page.waitForTimeout(3000);

    // Check if we're redirected to signin
    if (!isPostSignInUrl(page.url())) {
      throw new Error('Not logged in. Cannot access favorites.');
    }

    // A page that says nobody is signed in is not this account's favorites page,
    // whatever it drew on itself. A signed-out /favorites can still render
    // product tiles — recommendations, a marketing carousel — and handing those
    // back as "your favorites" is the same false sentence as calling an unread
    // basket an empty one (FORK.md #5), with a plausible-looking list attached.
    if (session === 'anonymous') {
      throw new Error(
        'Could not read your Good Eggs favorites: the favorites page reports that nobody is ' +
          'signed in, so anything on it is not yours. The login has lapsed; your favorites ' +
          'are UNKNOWN, not empty.'
      );
    }

    // Extract favorite items
    const items = await page.evaluate(() => {
      const products: GroceryItem[] = [];
      const seen = new Set<string>();

      // Good Eggs uses 'js-product-link' class for product links
      const productElements = document.querySelectorAll('a.js-product-link');

      productElements.forEach((el) => {
        const link = el as HTMLAnchorElement;
        const href = link.href;

        if (!href || seen.has(href) || href.includes('/favorites') || href.includes('/signin')) {
          return;
        }

        // Validate URL structure
        const urlPath = new URL(href).pathname;
        const segments = urlPath.split('/').filter((s) => s.length > 0);
        if (segments.length < 3) {
          return;
        }

        const container = link.closest('div[class*="product"], article, [class*="card"]') || link;

        const nameEl = container.querySelector('h2, h3, [class*="title"], [class*="name"]');
        const brandEl = container.querySelector('[class*="brand"], [class*="producer"]');
        const priceEl = container.querySelector('[class*="price"]');
        const imgEl = container.querySelector('img');

        let name = nameEl?.textContent?.trim();
        if (!name || name.length < 3) {
          name = link.textContent?.trim();
        }
        if (!name || name.length < 3) return;

        seen.add(href);
        products.push({
          url: href,
          name: name,
          brand: brandEl?.textContent?.trim() || '',
          price: priceEl?.textContent?.trim() || '',
          imageUrl: imgEl?.src || undefined,
        });
      });

      return products;
    });

    // The page carried no payload this tree recognises — none at all, one with
    // no `user` key, or a `content()` read that threw. An empty scrape on top of
    // that is two absences and no evidence — an error page, a markup change, a
    // render that did not finish — so it is UNKNOWN rather than none.
    //
    // A non-empty scrape is returned: products drawn on a page that Good Eggs
    // served without its usual payload are still products, and dropping them
    // would understate the account. Only the answer that has nothing in it
    // needs a session behind it.
    if (items.length === 0 && session === 'unknown') {
      throw new Error(
        'Could not read your Good Eggs favorites: the favorites page carried no usable ' +
          'session payload and no items. The page failed to load, or its shape changed; ' +
          'your favorites are UNKNOWN, not empty.'
      );
    }

    return items;
  }

  async getGroceryDetails(groceryUrl: string): Promise<GroceryDetails> {
    const page = await this.ensureBrowser();

    // Check if we're already on the product page
    const currentUrl = page.url();
    if (!currentUrl.includes(groceryUrl) && !groceryUrl.includes(currentUrl)) {
      // Navigate to the product page
      // Use domcontentloaded instead of networkidle - Good Eggs has persistent connections
      const fullUrl = groceryUrl.startsWith('http') ? groceryUrl : `${BASE_URL}${groceryUrl}`;
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
    }

    // Wait for React to render
    await page.waitForTimeout(3000);

    // Extract product details
    const details = await page.evaluate((url) => {
      // Find the main product info
      const nameEl = document.querySelector('h1, [class*="product-name"], [class*="title"]');
      const brandEl = document.querySelector('[class*="brand"], [class*="producer"]');
      const priceEl = document.querySelector('[class*="sale-price"], [class*="current-price"]');
      const originalPriceEl = document.querySelector(
        '[class*="original-price"], [class*="regular-price"], s'
      );
      const discountEl = document.querySelector('[class*="off"], [class*="discount"]');
      const descriptionEl = document.querySelector(
        '[class*="description"], [class*="details"] p, .product-description'
      );
      const productDetailsEl = document.querySelector('[class*="product-details"]');
      const imgEl = document.querySelector('[class*="product"] img, main img');

      // Get availability dates
      const availabilityEls = document.querySelectorAll(
        '[class*="availability"] span, [class*="delivery"] span'
      );
      const availability: string[] = [];
      availabilityEls.forEach((el) => {
        const text = el.textContent?.trim();
        if (text) availability.push(text);
      });

      return {
        url: url,
        name: nameEl?.textContent?.trim() || 'Unknown',
        brand: brandEl?.textContent?.trim() || '',
        price: priceEl?.textContent?.trim() || '',
        originalPrice: originalPriceEl?.textContent?.trim() || undefined,
        discount: discountEl?.textContent?.trim() || undefined,
        description: descriptionEl?.textContent?.trim() || undefined,
        productDetails: productDetailsEl?.textContent?.trim() || undefined,
        availability: availability.length > 0 ? availability : undefined,
        imageUrl: (imgEl as HTMLImageElement)?.src || undefined,
      };
    }, groceryUrl);

    return details;
  }

  async getGroceryNutrition(groceryUrl: string): Promise<GroceryNutrition> {
    const page = await this.ensureBrowser();
    const fullUrl = groceryUrl.startsWith('http') ? groceryUrl : `${BASE_URL}${groceryUrl}`;
    const productId = extractProductId(fullUrl);

    // Always load the page, and read the SERVED document straight after
    // domcontentloaded, the way the basket read does: the payload is the
    // server's state for this product, and nothing here needs React to draw.
    await withNavigationRetry(
      () => page.goto(fullUrl, { waitUntil: 'domcontentloaded' }),
      async () => {}
    );
    const html = await page.content();

    return groceryNutritionFromHtml(
      html,
      fullUrl,
      getKitchenNutritionSource(),
      PRODUCT_ID_PATTERN.test(productId) ? productId : undefined
    );
  }

  async addToCart(groceryUrl: string, quantity: number): Promise<CartResult> {
    const page = await this.ensureBrowser();

    const elementTimeout = Math.min(this.config.timeout, ELEMENT_WAIT_TIMEOUT_MS);
    const fullUrl = groceryUrl.startsWith('http') ? groceryUrl : `${BASE_URL}${groceryUrl}`;

    // Snapshot the cart BEFORE attempting the add so we can judge success by a
    // before/after delta. Without this, an item that is already in the cart at a
    // sufficient quantity would be misreported as a successful add even when this
    // attempt changed nothing (e.g. a delivery day still needs to be selected).
    let priorCartItems: CartItem[] | null = null;
    try {
      priorCartItems = await this.getCart();
    } catch {
      priorCartItems = null;
    }

    // Load the product page. The add is sent from it, so the request carries the
    // page's origin, cookies and referer exactly as the site's own button does.
    // Wrap in a retry so a stale page / re-render during navigation reloads once
    // instead of failing the whole add.
    const navigateIfNeeded = async (): Promise<void> => {
      const currentUrl = page.url();
      const normalizedGroceryUrl = groceryUrl.replace(BASE_URL, '');
      const normalizedCurrentUrl = currentUrl.replace(BASE_URL, '');
      if (!normalizedCurrentUrl.includes(normalizedGroceryUrl.split('/').pop() || '')) {
        // Use domcontentloaded instead of networkidle - Good Eggs has persistent connections
        await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
      }
    };
    await withNavigationRetry(navigateIfNeeded, async () => {
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
    });
    const productHtml = await page.content();

    // The product page carries the same basket payload /basket does, so a
    // before-read that failed there gets a second chance here. Only a signed-in
    // payload counts — an anonymous basket is not this account's.
    if (priorCartItems === null) {
      const snapshot = basketSnapshotFromHtml(productHtml, BASE_URL);
      if (snapshot?.signedIn) priorCartItems = snapshot.items;
    }
    const priorQuantityKnown = priorCartItems !== null;
    const priorQuantity = priorCartItems
      ? (findCartItemForUrl(priorCartItems, groceryUrl)?.quantity ?? 0)
      : 0;

    // Name the product from the page's own payload, falling back to the
    // heading. The heading is not reliable: it reads `h1, [class*="title"]`,
    // and on a product page with no delivery day chosen the first such element
    // is the day picker — which is why successful adds were reported against an
    // item called "Select a delivery day".
    const productId = extractProductId(fullUrl);
    const itemName =
      productNameFromHtml(productHtml, productId) ??
      (await page.evaluate(() => {
        const nameEl = document.querySelector('h1, [class*="product-name"], [class*="title"]');
        return nameEl?.textContent?.trim() || 'Unknown item';
      }));

    let addSent = false;
    let addFailure: string | undefined;
    const alreadySatisfied = priorQuantityKnown && priorQuantity >= quantity;

    if (alreadySatisfied) {
      // Nothing to send. The basket update sets a TOTAL, so posting the request
      // here could only lower the line; reconciliation reports it as already met.
    } else if (!PRODUCT_ID_PATTERN.test(productId)) {
      addFailure = `the URL carries no Good Eggs product id (got "${productId.slice(0, 40)}")`;
    } else if (priorQuantityKnown) {
      // The primary path: the request the site's own button sends, with the
      // quantity the line should end at. It does not depend on how, or how fast,
      // the page draws its controls — which is what failed half the adds in the
      // 2026-10-19 shop (strad#439).
      const outcome = await this.sendBasketUpdate(page, productId, quantity, elementTimeout);
      if (outcome.accepted) {
        addSent = true;
      } else {
        addFailure = outcome.reason;
      }
    } else {
      // The basket could not be read before the add, so the line's current total
      // is unknown and a total-setting request could lower it. Leave the add to
      // the page's own button, which only ever adds.
      addFailure = 'the basket could not be read before the add';
    }

    if (!addSent && !alreadySatisfied) {
      const clicked = await this.clickAddButton(page, quantity, elementTimeout);
      if (clicked) {
        addSent = true;
        addFailure = undefined;
      } else {
        addFailure = addFailure
          ? `${addFailure}; the add-to-cart button was not found either`
          : 'the add-to-cart button was not found';
      }
    }

    // Read the cart back and reconcile against what we requested: an accepted
    // update is not proof the line landed, and an unsent add is not proof it did
    // not. Reading the cart navigates away from the product page, so do it last.
    let cartItems: CartItem[] = [];
    let cartReadable = true;
    try {
      cartItems = await this.getCart();
    } catch {
      // One reload-and-retry for a transient/stale read.
      try {
        cartItems = await this.getCart();
      } catch {
        // Still unreadable. Say so — an unread basket is not an empty one, and
        // reconciling against `[]` here is how a successful add was reported as
        // "it does not appear in your cart afterward".
        cartItems = [];
        cartReadable = false;
      }
    }

    return reconcileAddResult({
      groceryUrl,
      requestedQuantity: quantity,
      itemName,
      priorQuantity,
      priorQuantityKnown,
      cartItems,
      addSent,
      addFailure,
      cartReadable,
    });
  }

  /**
   * POST the basket update from inside the product page, the way the page's
   * own button does: same origin, the session's cookies, a JSON body. Never
   * throws — a network failure or a timeout is a refusal with its reason.
   */
  private async sendBasketUpdate(
    page: import('playwright').Page,
    productId: string,
    quantity: number,
    timeoutMs: number
  ): Promise<BasketUpdateOutcome> {
    let answer: { status: number; body: string };
    try {
      answer = await page.evaluate(
        async ({ path, productId, quantity, timeoutMs }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetch(path, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ productId, quantity, shouldSubscribe: false }),
              credentials: 'same-origin',
              signal: controller.signal,
            });
            return { status: response.status, body: await response.text() };
          } finally {
            clearTimeout(timer);
          }
        },
        { path: BASKET_UPDATE_PATH, productId, quantity, timeoutMs }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      return {
        accepted: false,
        reason: `the basket update could not be sent (${message.slice(0, 200)})`,
      };
    }
    return parseBasketUpdateResponse(answer.status, answer.body, productId);
  }

  /**
   * The fallback add: the page's own button, with the quantity set first when
   * more than one is wanted. Returns whether a button was found and clicked; a
   * click that throws still counts, because the add may have registered and
   * the basket re-read decides.
   */
  private async clickAddButton(
    page: import('playwright').Page,
    quantity: number,
    timeoutMs: number
  ): Promise<boolean> {
    // Wait for the add control to render (it can appear a beat after
    // domcontentloaded) rather than synchronously null-checking it.
    const addButton = (await waitForElement(page, ADD_BUTTON_SELECTOR, timeoutMs)) as
      | import('playwright').ElementHandle
      | null;
    if (!addButton) return false;

    // Best-effort: if the quantity controls can't be found the add still goes
    // ahead, and the basket re-read reports the quantity that resulted.
    if (quantity > 1) {
      const quantitySelector = await page.$(
        'select[class*="quantity"], [class*="quantity"] select'
      );
      if (quantitySelector) {
        await quantitySelector.selectOption(String(quantity)).catch(() => {});
      } else {
        const plusButton = await page.$('button[aria-label*="increase"], button:has-text("+")');
        if (plusButton) {
          for (let i = 1; i < quantity; i++) {
            await plusButton.click().catch(() => {});
            await page.waitForTimeout(200);
          }
        }
      }
    }

    try {
      await addButton.click();
    } catch {
      // Ignore - verified against cart state by the caller.
    }
    // Give the cart a moment to update server-side before it is read back.
    await page.waitForTimeout(1500);
    return true;
  }

  async searchFreebieGroceries(): Promise<GroceryItem[]> {
    const page = await this.ensureBrowser();
    const allFreeItems: GroceryItem[] = [];
    const seen = new Set<string>();

    // Helper function to extract free items ($0.00) from current page
    const extractFreeItems = async (): Promise<GroceryItem[]> => {
      return await page.evaluate(() => {
        const products: GroceryItem[] = [];
        const seenUrls = new Set<string>();

        // Good Eggs uses 'js-product-link' class for product links
        const productElements = document.querySelectorAll('a.js-product-link');

        productElements.forEach((el) => {
          const link = el as HTMLAnchorElement;
          const href = link.href;

          if (
            !href ||
            seenUrls.has(href) ||
            href.includes('/fresh-picks') ||
            href.includes('/signin')
          ) {
            return;
          }

          // Validate URL structure
          const urlPath = new URL(href).pathname;
          const segments = urlPath.split('/').filter((s) => s.length > 0);
          if (segments.length < 3) {
            return;
          }

          const container = link.closest('div[class*="product"], article, [class*="card"]') || link;

          // Look for price element and check if it's $0.00
          const priceEl = container.querySelector('[class*="price"]');
          const priceText = priceEl?.textContent?.trim() || '';

          // Only include items that are truly free ($0.00 or $0)
          // Must use exact matching to avoid false positives like $10.00, $20.50
          const isFree =
            /^\$0(\.00)?$/.test(priceText) || priceText === '$0.00' || priceText === '$0';
          if (!isFree) {
            return;
          }

          const nameEl = container.querySelector('h2, h3, [class*="title"], [class*="name"]');
          const brandEl = container.querySelector('[class*="brand"], [class*="producer"]');
          const imgEl = container.querySelector('img');

          let name = nameEl?.textContent?.trim();
          if (!name || name.length < 3) {
            name = link.textContent?.trim();
          }
          if (!name || name.length < 3) return;

          seenUrls.add(href);
          products.push({
            url: href,
            name: name,
            brand: brandEl?.textContent?.trim() || '',
            price: priceText,
            discount: 'FREE',
            imageUrl: imgEl?.src || undefined,
          });
        });

        return products;
      });
    };

    // Check homepage for free items
    // Use domcontentloaded instead of networkidle - Good Eggs has persistent connections
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const homePageItems = await extractFreeItems();
    for (const item of homePageItems) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        allFreeItems.push(item);
      }
    }

    // Check /fresh-picks page for free items
    await page.goto(`${BASE_URL}/fresh-picks`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const freshPicksItems = await extractFreeItems();
    for (const item of freshPicksItems) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        allFreeItems.push(item);
      }
    }

    return allFreeItems;
  }

  /**
   * Load `/account/orders` and read the past-order list off its payload.
   *
   * Always a fresh load. A lookup that trusted a list already on screen would
   * search whatever it said when it last loaded, and a failed lookup leaves the
   * page there — so one miss would keep missing until something navigated away.
   */
  private async loadPastOrders(page: import('playwright').Page): Promise<PastOrder[]> {
    await page.goto(`${BASE_URL}/account/orders`, { waitUntil: 'domcontentloaded' });

    if (page.url().includes('/signin')) {
      throw new Error('Not logged in. Cannot access past orders.');
    }

    const orders = pastOrdersFromStoreData(
      extractStoreData(await page.content()) as PastOrdersStoreData | null
    );
    if (!orders) {
      // Never "no past orders": an unreadable list is not an empty one.
      throw new Error('Could not read the past-order list from the Good Eggs orders page.');
    }
    return orders;
  }

  async getPastOrderDates(): Promise<PastOrder[]> {
    const page = await this.ensureBrowser();
    return this.loadPastOrders(page);
  }

  async getPastOrderGroceries(orderDate: string): Promise<GroceryItem[]> {
    const page = await this.ensureBrowser();

    const query = parseOrderDateQuery(orderDate);
    if (!query) {
      throw new Error(
        `Could not read a date from "${orderDate}". ` +
          'Use a date like "2026-09-21", "9/21" or "Monday, September 21st".'
      );
    }

    const orders = await this.loadPastOrders(page);
    const order = findPastOrder(orders, query);
    if (!order?.orderId) {
      const onFile = orders.map((o) => o.isoDate ?? o.date).join(', ') || 'none';
      throw new Error(`No past order was delivered on ${orderDate}. Orders on file: ${onFile}.`);
    }

    if (!/^[0-9a-f]{24}$/.test(order.orderId)) {
      throw new Error(`Good Eggs listed an order id that is not an id: "${order.orderId}".`);
    }
    await page.goto(`${BASE_URL}/account/orders/${order.orderId}`, {
      waitUntil: 'domcontentloaded',
    });
    if (page.url().includes('/signin')) {
      throw new Error('Not logged in. Cannot access past orders.');
    }

    const fromPayload = pastOrderItemsFromStoreData(
      extractStoreData(await page.content()) as PastOrdersStoreData | null,
      BASE_URL
    );
    if (fromPayload) return fromPayload;

    // The payload carried no line items: fall back to the drawn page.
    await page.waitForTimeout(2000);

    // Extract items with quantity ordered from the drawn order page
    const items = await page.evaluate(() => {
      interface ProductItem {
        url: string;
        name: string;
        brand: string;
        price: string;
        imageUrl?: string;
        quantity?: string;
        quantityOrdered?: number;
      }

      const products: ProductItem[] = [];

      // Find all line items on the order details page
      const lineItems = document.querySelectorAll('.single-order-page__line-item');

      lineItems.forEach((item) => {
        // Extract quantity ordered (the number on the left)
        const quantityOrderedEl = item.querySelector(
          '.single-order-page__line-item-quantity-value'
        );
        const quantityOrdered = parseInt(quantityOrderedEl?.textContent?.trim() || '1', 10) || 1;

        // Extract product name and URL
        const nameLink = item.querySelector(
          '.single-order-page__line-item-details-name a'
        ) as HTMLAnchorElement;
        const name = nameLink?.textContent?.trim() || '';
        const url = nameLink?.href || '';

        // Extract brand
        const brandEl = item.querySelector('.single-order-page__line-item-details-vendor-name a');
        const brand = brandEl?.textContent?.trim() || '';

        // Extract unit (e.g., "1 bunch", "1 lb")
        const unitEl = item.querySelector('.single-order-page__line-item-details-unit-quantity');
        const unit = unitEl?.textContent?.trim() || '';

        // Extract price
        const priceEl = item.querySelector('.summary-item__price');
        const price = priceEl?.textContent?.trim() || '';

        // Extract image URL
        const imageDiv = item.querySelector(
          '.single-order-page__line-item-image-image'
        ) as HTMLElement;
        const bgImage = imageDiv?.style?.backgroundImage || '';
        const imageMatch = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
        const imageUrl = imageMatch ? imageMatch[1] : undefined;

        if (name && url) {
          products.push({
            url,
            name,
            brand,
            price,
            quantity: unit, // unit of sale (e.g., "1 bunch")
            quantityOrdered, // number ordered (e.g., 2)
            imageUrl,
          });
        }
      });

      return products;
    });

    // A delivered order has lines, so an empty scrape is a page this could not
    // read, never an empty order.
    if (items.length === 0) {
      throw new Error(`Could not read the items of the order delivered on ${order.isoDate}.`);
    }
    return items;
  }

  async addFavorite(groceryUrl: string): Promise<CartResult> {
    const page = await this.ensureBrowser();

    // Navigate to the product page if not already there
    const currentUrl = page.url();
    const normalizedGroceryUrl = groceryUrl.replace(BASE_URL, '');
    const normalizedCurrentUrl = currentUrl.replace(BASE_URL, '');

    if (!normalizedCurrentUrl.includes(normalizedGroceryUrl.split('/').pop() || '')) {
      // Use domcontentloaded instead of networkidle - Good Eggs has persistent connections
      const fullUrl = groceryUrl.startsWith('http') ? groceryUrl : `${BASE_URL}${groceryUrl}`;
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    }

    // Name the product from the page's own payload, falling back to the
    // heading. The heading is not reliable: it reads `h1, [class*="title"]`,
    // and on a product page with no delivery day chosen the first such element
    // is the day picker — which is why successful adds were reported against an
    // item called "Select a delivery day".
    const itemName =
      productNameFromHtml(await page.content(), extractProductId(groceryUrl)) ??
      (await page.evaluate(() => {
        const nameEl = document.querySelector('h1, [class*="product-name"], [class*="title"]');
        return nameEl?.textContent?.trim() || 'Unknown item';
      }));

    // Look for the favorite control - Good Eggs uses a div, not a button.
    // Wait for it to render rather than synchronously null-checking.
    const favoriteControl = (await waitForElement(
      page,
      '.product-detail__favorite-control',
      Math.min(this.config.timeout, ELEMENT_WAIT_TIMEOUT_MS)
    )) as import('playwright').ElementHandle | null;

    if (!favoriteControl) {
      return {
        success: false,
        message: 'Could not find favorite button',
        itemName,
      };
    }

    // Check if already favorited by looking for 'favorited' class (vs 'not-favorited')
    const isAlreadyFavorited = await page.evaluate((el) => {
      return (el as Element).classList.contains('favorited');
    }, favoriteControl);

    if (isAlreadyFavorited) {
      return {
        success: true,
        message: `${itemName} is already in favorites`,
        itemName,
      };
    }

    await favoriteControl.click();
    await page.waitForTimeout(500);

    return {
      success: true,
      message: `Successfully added ${itemName} to favorites`,
      itemName,
    };
  }

  async removeFavorite(groceryUrl: string): Promise<CartResult> {
    const page = await this.ensureBrowser();

    // Navigate to the product page if not already there
    const currentUrl = page.url();
    const normalizedGroceryUrl = groceryUrl.replace(BASE_URL, '');
    const normalizedCurrentUrl = currentUrl.replace(BASE_URL, '');

    if (!normalizedCurrentUrl.includes(normalizedGroceryUrl.split('/').pop() || '')) {
      // Use domcontentloaded instead of networkidle - Good Eggs has persistent connections
      const fullUrl = groceryUrl.startsWith('http') ? groceryUrl : `${BASE_URL}${groceryUrl}`;
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    }

    // Name the product from the page's own payload, falling back to the
    // heading. The heading is not reliable: it reads `h1, [class*="title"]`,
    // and on a product page with no delivery day chosen the first such element
    // is the day picker — which is why successful adds were reported against an
    // item called "Select a delivery day".
    const itemName =
      productNameFromHtml(await page.content(), extractProductId(groceryUrl)) ??
      (await page.evaluate(() => {
        const nameEl = document.querySelector('h1, [class*="product-name"], [class*="title"]');
        return nameEl?.textContent?.trim() || 'Unknown item';
      }));

    // Look for the favorite control - Good Eggs uses a div, not a button.
    // Wait for it to render rather than synchronously null-checking.
    const favoriteControl = (await waitForElement(
      page,
      '.product-detail__favorite-control',
      Math.min(this.config.timeout, ELEMENT_WAIT_TIMEOUT_MS)
    )) as import('playwright').ElementHandle | null;

    if (!favoriteControl) {
      return {
        success: false,
        message: 'Could not find favorite button',
        itemName,
      };
    }

    // Check if favorited by looking for 'favorited' class (vs 'not-favorited')
    const isFavorited = await page.evaluate((el) => {
      return (el as Element).classList.contains('favorited');
    }, favoriteControl);

    if (!isFavorited) {
      return {
        success: true,
        message: `${itemName} is not in favorites`,
        itemName,
      };
    }

    await favoriteControl.click();
    await page.waitForTimeout(500);

    return {
      success: true,
      message: `Successfully removed ${itemName} from favorites`,
      itemName,
    };
  }

  async removeFromCart(groceryUrl: string): Promise<CartResult> {
    const page = await this.ensureBrowser();

    // Good Eggs product ids are 24-char Mongo hex. Insisting on that shape is
    // also what makes the id safe to interpolate into a CSS selector below.
    const productId = extractProductId(groceryUrl);
    if (!PRODUCT_ID_PATTERN.test(productId)) {
      return {
        success: false,
        message: 'Invalid grocery URL - could not extract product identifier',
        itemName: groceryUrl,
      };
    }

    // Presence is decided by the basket payload, not by the markup. The scrape
    // this replaced looked for `.js-basket-item` rows, which the card layout
    // does not render, so it answered "Item not found in cart" for items that
    // were plainly there — and there was no other way to undo an add.
    let before: BasketSnapshot;
    try {
      before = await this.getBasket();
    } catch (error) {
      return {
        success: false,
        verified: false,
        message:
          `Could not read the basket, so removal was not attempted: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        itemName: groceryUrl,
      };
    }

    const target = findCartItemForUrl(before.items, groceryUrl);
    if (!target) {
      return {
        success: false,
        verified: true,
        message: `Item not found in cart (the basket has ${before.items.length} product${
          before.items.length === 1 ? '' : 's'
        }, none of them this one).`,
        itemName: groceryUrl,
      };
    }

    const itemName = target.name.trim() || 'Unknown item';

    // Both basket layouts tag the item's container with `data-product-id`, so
    // one selector finds it whichever one the account was bucketed into. The
    // basket page also carries recommendation tiles tagged the same way, hence
    // the search below for the container that actually holds a remove control.
    const cardSelector = `[data-product-id="${productId}"]`;

    // The payload is in the served document but the CARDS are drawn by React, so
    // wait for one before probing rather than racing the first paint.
    const elementTimeout = Math.min(this.config.timeout, ELEMENT_WAIT_TIMEOUT_MS);
    await waitForElement(page, cardSelector, elementTimeout);

    // Removing takes a different number of clicks per layout, so drive it as a
    // bounded loop and let the basket say when it worked:
    //   card layout    the quantity pill's left button decrements, and turns
    //                  into the trash control at quantity 1
    //   summary layout a "Remove" control, or a quantity <select> with a 0
    //                  option
    // The cap keeps a large line (or a control that does not decrement) from
    // turning one tool call into a minute of clicking.
    const maxAttempts = Math.min(Math.max(target.quantity, 1) + 2, MAX_REMOVE_CLICKS);
    let removalAttempted = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const cards = await page.$$(cardSelector);
      if (cards.length === 0) break;

      let clicked = false;
      for (const card of cards) {
        const control = await card.$(REMOVE_CONTROL_SELECTOR);
        if (control) {
          // Only a click that actually landed counts as an attempt — a thrown
          // click is not evidence that anything was tried.
          try {
            await control.click();
            removalAttempted = true;
            clicked = true;
          } catch {
            // Stale or covered element; fall through to the next candidate.
          }
          if (clicked) break;
          continue;
        }

        // The summary layout removes through the quantity dropdown's 0 option.
        // Take every <select> on the card, not the first: DOM order is not a
        // promise that the first one is the quantity control.
        for (const quantitySelect of await card.$$('select')) {
          try {
            await quantitySelect.selectOption('0');
            removalAttempted = true;
            clicked = true;
            break;
          } catch {
            // Not the quantity select, or it has no zero option.
          }
        }
        if (clicked) break;
      }

      if (!clicked) break;
      await page.waitForTimeout(1000);
    }

    // Verify against the basket, which is the only thing that decides this.
    let after: BasketSnapshot;
    try {
      after = await this.getBasket();
    } catch (error) {
      return {
        success: false,
        verified: false,
        message: removalAttempted
          ? `Clicked remove for ${itemName}, but the basket could not be read back, so the ` +
            `result is UNVERIFIED: ${error instanceof Error ? error.message : String(error)}`
          : `Could not find a way to remove ${itemName}, and the basket could not be re-read.`,
        itemName,
      };
    }

    const stillPresent = findCartItemForUrl(after.items, groceryUrl);
    if (!stillPresent) {
      return {
        success: true,
        verified: true,
        message: `Successfully removed ${itemName} from cart`,
        itemName,
      };
    }

    return {
      success: false,
      verified: true,
      message: removalAttempted
        ? `Attempted to remove ${itemName}, but it is still in your cart (quantity ${stillPresent.quantity}).`
        : `Could not find a remove control for ${itemName}; it is still in your cart (quantity ${stillPresent.quantity}).`,
      itemName,
      quantity: stillPresent.quantity,
    };
  }

  /**
   * Read the basket from the page's Redux payload.
   *
   * `storeData.basket` is what the SERVER thinks the basket is, rendered into
   * every page against the session cookie. The rendered markup is a view of it,
   * and which view depends on a per-account layout experiment: the current
   * basket page draws either `.js-basket-item.summary-item` rows or
   * `.basket-item-card` cards, and the DOM scrape this replaced only knew the
   * first. An account bucketed into the card layout therefore read as an EMPTY
   * basket, every time — see FORK.md #1.
   *
   * Throws when the payload is absent, so an unreadable basket can never be
   * mistaken for an empty one.
   */
  async getBasket(): Promise<BasketSnapshot> {
    const page = await this.ensureBrowser();

    // Use domcontentloaded instead of networkidle - Good Eggs has persistent
    // connections. The payload is in the served document, so there is nothing
    // to wait for beyond it.
    await page.goto(`${BASE_URL}/basket`, { waitUntil: 'domcontentloaded' });

    const html = await page.content();
    const snapshot = basketSnapshotFromHtml(html, BASE_URL);
    if (!snapshot) {
      throw new Error(
        'Could not read the Good Eggs basket: the page carried no usable basket payload. ' +
          'The page failed to load, or its shape changed; it does NOT mean the basket ' +
          'is empty.'
      );
    }
    // A signed-out page serves a readable payload for an ANONYMOUS basket, which
    // is empty. That is not the user's basket, and reporting it as one would put
    // "your cart is empty" back in front of a full cart by a second route.
    if (!snapshot.signedIn) {
      throw new Error(
        'Could not read the Good Eggs basket: the page is not signed in, so the basket ' +
          'it carries is an anonymous one and not yours. The login has lapsed; the ' +
          'basket contents are UNKNOWN, not empty.'
      );
    }
    return snapshot;
  }

  async getCart(): Promise<CartItem[]> {
    return (await this.getBasket()).items;
  }

  async getCurrentUrl(): Promise<string> {
    const page = await this.ensureBrowser();
    return page.url();
  }

  async close(): Promise<void> {
    if (this.browser) {
      // Close only what we created. A shared browser belongs to the host and may
      // still be serving fetchpet or pointsyeah contexts.
      if (this.ownsBrowser) await this.browser.close();
      else await this.context?.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.isInitialized = false;
    }
  }

  getConfig(): GoodEggsConfig {
    return this.config;
  }
}

export type ClientFactory = () => IGoodEggsClient;

/**
 * Callback invoked when a login attempt fails.
 *
 * A failure is not final — the next tool call tries again (see
 * `startBackgroundLogin`) — so a host that renders this as "degraded" should
 * also take `LoginRecoveredCallback` to un-render it.
 *
 * @param error The error that caused login to fail
 */
export type LoginFailedCallback = (error: Error) => void;

/** Callback invoked when a login attempt succeeds after an earlier one failed. */
export type LoginRecoveredCallback = () => void;

export interface CreateMCPServerOptions {
  version: string;
}

/**
 * Per-connection options for `registerHandlers`.
 *
 * These are decided fresh for each MCP session, because the one thing that
 * varies between sessions is the CLIENT: `appUi` is derived from the client's
 * advertised `initialize` capabilities. The browser and login live in the
 * factory closure and are shared across every session regardless.
 */
export interface RegisterHandlersOptions {
  /** Override the Good Eggs client factory (tests inject a fake here). */
  clientFactory?: ClientFactory;
  /**
   * The client advertised `io.modelcontextprotocol/ui`, so serve the MCP-App
   * surface (the `ui://` resource + `_meta` binding + structured results).
   * Defaults to false: a plain, byte-identical tool surface.
   */
  appUi?: boolean;
}

export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    {
      name: 'good-eggs-mcp-server',
      version: options.version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Track active client for cleanup
  let activeClient: IGoodEggsClient | null = null;

  // The login attempt that is in flight, or the one that succeeded. Null means
  // no attempt is running — including after a failed one, which is the whole
  // point: a login failure is retried, not cached for the life of the process.
  let loginAttempt: Promise<IGoodEggsClient> | null = null;
  let lastLoginError: Error | null = null;
  let onLoginFailed: LoginFailedCallback | null = null;
  let onLoginRecovered: LoginRecoveredCallback | null = null;

  /**
   * Create the client instance (but don't initialize/login yet)
   */
  const createClient = (): IGoodEggsClient => {
    const username = process.env.GOOD_EGGS_USERNAME;
    const password = process.env.GOOD_EGGS_PASSWORD;
    const headless = process.env.HEADLESS !== 'false';
    const timeout = parseInt(process.env.TIMEOUT || '30000', 10);

    if (!username || !password) {
      throw new Error(
        'GOOD_EGGS_USERNAME and GOOD_EGGS_PASSWORD environment variables must be configured'
      );
    }

    activeClient = new GoodEggsClient({
      username,
      password,
      headless,
      timeout,
    });
    return activeClient;
  };

  /**
   * One login attempt, from a fresh client.
   *
   * A failed attempt leaves nothing behind: the half-initialized client is
   * closed and discarded and `loginAttempt` is cleared, so the next caller
   * starts over from a clean browser context rather than inheriting a page
   * parked on the sign-in form.
   */
  const attemptLogin = (): Promise<IGoodEggsClient> => {
    const remember = (error: unknown): Error => {
      const failure = error instanceof Error ? error : new Error(String(error));
      lastLoginError = failure;
      return failure;
    };

    // createClient() THROWS on missing credentials rather than rejecting, and
    // every failure has to leave through one door: remembered, reported, and
    // retryable. A caller that fixes the environment and calls again gets a real
    // attempt instead of a promise nobody reported.
    let client: IGoodEggsClient;
    try {
      client = createClient();
    } catch (error) {
      const failure = remember(error);
      onLoginFailed?.(failure);
      return Promise.reject(failure);
    }

    const attempt = client
      .initialize()
      .then(() => {
        if (lastLoginError) {
          lastLoginError = null;
          onLoginRecovered?.();
        }
        return client;
      })
      .catch(async (error: unknown) => {
        const failure = remember(error);
        loginAttempt = null;
        if (activeClient === client) {
          activeClient = null;
        }
        // Reported BEFORE the teardown is awaited. Clearing `loginAttempt` above
        // opens the retry, and a host reads these two callbacks as one flag: a
        // retry that got in during the close would otherwise clear `degraded`
        // and then have this failure set it again on a mount that is serving.
        onLoginFailed?.(failure);
        await client.close().catch(() => {});
        throw failure;
      });

    loginAttempt = attempt;
    return attempt;
  };

  /**
   * Start the login in the background, so the first real tool call does not also
   * pay for a cold browser and a full sign-in.
   *
   * @param onFailed Callback invoked when an attempt fails. The server stays
   *   usable: the next tool call retries. A host with other servers on board
   *   should mark this one degraded rather than exit.
   * @param onRecovered Callback invoked when an attempt succeeds after a failure
   *   — the signal that clears the degraded mark the failure set.
   */
  const startBackgroundLogin = (
    onFailed?: LoginFailedCallback,
    onRecovered?: LoginRecoveredCallback
  ): void => {
    onLoginFailed = onFailed || null;
    onLoginRecovered = onRecovered || null;

    if (loginAttempt) {
      // Already started
      return;
    }

    // Nothing awaits this until the first tool call, and a rejection nobody is
    // listening to is an unhandled rejection. The failure is reported through
    // onFailed and remembered by attemptLogin; swallow it here.
    void attemptLogin().catch(() => {});
  };

  /**
   * Get a client that is ready to use (login completed).
   *
   * Waits for the background login if one is running, and starts one if none is
   * — including after an earlier attempt failed. That retry is what keeps a
   * transient boot failure, or a Good Eggs sign-in page that changed and was
   * fixed, from disabling this server until the container is redeployed.
   */
  const getReadyClient = async (): Promise<IGoodEggsClient> => {
    try {
      return await (loginAttempt ?? attemptLogin());
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // An instruction to the caller, not a promise about this process: a host
      // that treats a failed login as fatal (the standalone image does) may be
      // on its way down, and the retry then belongs to its replacement.
      throw new Error(`Login failed: ${failure.message} (retry the call)`);
    }
  };

  const registerHandlers = async (
    server: Server,
    options: RegisterHandlersOptions = {}
  ) => {
    // Use provided factory or create our managed client getter
    const factory = options.clientFactory || (() => activeClient || createClient());

    // Create tools with a special async getter that waits for background login.
    // `appUi` is decided per-connection from the client's advertised
    // capabilities (see the remote entrypoint) and gates the MCP-App surface.
    const registerTools = createRegisterTools(factory, getReadyClient, {
      appUi: options.appUi === true,
    });
    registerTools(server);
  };

  const cleanup = async () => {
    if (activeClient) {
      await activeClient.close();
      activeClient = null;
    }
    // Reset login state
    loginAttempt = null;
    lastLoginError = null;
  };

  return { server, registerHandlers, cleanup, startBackgroundLogin };
}
