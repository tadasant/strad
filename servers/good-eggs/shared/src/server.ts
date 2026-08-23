import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createRegisterTools } from './tools.js';
import { withBrowserTelemetry } from './telemetry.js';
import {
  basketSnapshotFromHtml,
  productNameFromHtml,
  type BasketSnapshot,
} from './basketState.js';
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

// Good Eggs renders the add control as a <button> whose label varies in casing
// ("ADD TO BASKET", "Add to Cart", "Add to Basket") and is occasionally a
// role="button" element rather than a real <button>. Match all of these
// case-insensitively so a markup/copy tweak doesn't break the add flow.
const ADD_BUTTON_SELECTOR =
  'button:has-text("add to basket"), button:has-text("add to cart"), ' +
  '[role="button"]:has-text("add to basket"), [role="button"]:has-text("add to cart")';

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
  buttonFound: boolean;
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
 * This exists because the add button and the server-side cart state can
 * disagree: Good Eggs frequently adds the item even when the button can't be
 * located (false negative), and occasionally reports a clicked button when
 * nothing was added because, e.g., a delivery day still needs to be selected
 * (false positive). The cart is the source of truth.
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
    buttonFound,
    cartReadable,
    priorQuantityKnown,
  } = params;

  // The basket could not be read back. Nothing here is evidence, so say that
  // instead of picking an outcome. Reporting an unread basket as "the add did
  // not take effect" is what invited re-adds and produced duplicates.
  if (!cartReadable) {
    const name = itemName && itemName !== 'Unknown item' ? itemName : 'the item';
    return {
      success: buttonFound,
      verified: false,
      message: buttonFound
        ? `Clicked add for ${name}, but the basket could not be read back, so the result is ` +
          `UNVERIFIED. Do not re-add it without checking the cart first — a blind retry is how ` +
          `duplicates happen.`
        : `The add-to-cart button was not found for ${name} and the basket could not be read ` +
          `back, so the result is UNVERIFIED. Check the cart before retrying.`,
      itemName,
      quantity: 0,
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
      message: buttonFound
        ? `Clicked add for ${displayName}, but it is not in your cart afterward. The add did ` +
          `not take effect (a delivery day may need to be selected, or the item may be ` +
          `unavailable).`
        : `Could not find the add-to-cart button, and ${displayName} is not in your cart. The ` +
          `add did not succeed.`,
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
        message: buttonFound
          ? `Successfully added ${displayName} to cart (cart now has ${cartQuantity}).`
          : `The add-to-cart button was not found on the page, but the cart quantity for ` +
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
      message: buttonFound
        ? `Clicked add for ${displayName}, but the cart quantity did not change (still ` +
          `${cartQuantity}, below the requested ${requestedQuantity}). The add did not take ` +
          `effect (a delivery day may need to be selected).`
        : `The add-to-cart button was not found and the cart quantity for ${displayName} did ` +
          `not change (still ${cartQuantity}, below the requested ${requestedQuantity}). The ` +
          `add did not take effect.`,
      itemName: displayName,
      quantity: cartQuantity,
    };
  }

  return {
    success: false,
    verified: true,
    message: buttonFound
      ? `Clicked add for ${displayName}, but it does not appear in your cart afterward. ` +
        `The add did not take effect (a delivery day may need to be selected, or the item may be unavailable).`
      : `Could not find the add-to-cart button, and ${displayName} is not in your cart. The add did not succeed.`,
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

    // Wait for navigation to complete (should redirect to home or previous page)
    await this.page.waitForURL((url) => !url.pathname.includes('/signin'), {
      timeout: this.config.timeout,
    });

    // Verify login was successful by checking if we're no longer on signin page
    const currentUrl = this.page.url();
    if (currentUrl.includes('/signin')) {
      throw new Error('Login failed - still on signin page. Check your credentials.');
    }

    this.isInitialized = true;
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

    // Wait for React to render
    await page.waitForTimeout(3000);

    // Check if we're redirected to signin
    if (page.url().includes('/signin')) {
      throw new Error('Not logged in. Cannot access favorites.');
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

  async addToCart(groceryUrl: string, quantity: number): Promise<CartResult> {
    const page = await this.ensureBrowser();

    const elementTimeout = Math.min(this.config.timeout, ELEMENT_WAIT_TIMEOUT_MS);
    const fullUrl = groceryUrl.startsWith('http') ? groceryUrl : `${BASE_URL}${groceryUrl}`;

    // Snapshot the cart BEFORE attempting the add so we can judge success by a
    // before/after delta. Without this, an item that is already in the cart at a
    // sufficient quantity would be misreported as a successful add even when this
    // attempt changed nothing (e.g. the button was missing or a delivery day
    // still needs to be selected).
    let priorCartItems: CartItem[] | null = null;
    try {
      priorCartItems = await this.getCart();
    } catch {
      priorCartItems = null;
    }
    const priorQuantity = priorCartItems
      ? (findCartItemForUrl(priorCartItems, groceryUrl)?.quantity ?? 0)
      : 0;

    // Navigate to the product page if we're not already on it. Wrap in a retry
    // so a stale page / re-render during navigation reloads once instead of
    // failing the whole add.
    const navigateIfNeeded = async (): Promise<void> => {
      const currentUrl = page.url();
      const normalizedGroceryUrl = groceryUrl.replace(BASE_URL, '');
      const normalizedCurrentUrl = currentUrl.replace(BASE_URL, '');
      if (!normalizedCurrentUrl.includes(normalizedGroceryUrl.split('/').pop() || '')) {
        // Use domcontentloaded instead of networkidle - Good Eggs has persistent connections
        await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
      }
    };
    await withNavigationRetry(navigateIfNeeded, async () => {
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    });

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

    // Set quantity if different from 1. This is best-effort: if the quantity
    // controls can't be found we still attempt the add and let cart
    // verification report the actual resulting quantity, rather than hard
    // failing here.
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

    // Wait for the add control to render (it can appear a beat after
    // domcontentloaded) rather than synchronously null-checking it.
    const addButton = (await waitForElement(page, ADD_BUTTON_SELECTOR, elementTimeout)) as
      | import('playwright').ElementHandle
      | null;
    const buttonFound = addButton !== null;

    if (addButton) {
      // The click itself can fail if the element goes stale; that's not fatal,
      // because the add may still have registered. Reconciliation against the
      // cart below determines the true outcome.
      try {
        await addButton.click();
      } catch {
        // Ignore - verified against cart state below.
      }
      // Give the cart a moment to update server-side before we read it back.
      await page.waitForTimeout(1500);
    }

    // Read the cart back and reconcile against what we requested. This is what
    // turns the frequent false negative ("button not found" on an add that
    // actually succeeded) into an accurate result. Reading the cart navigates
    // away from the product page, so do it last.
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
      priorQuantityKnown: priorCartItems !== null,
      cartItems,
      buttonFound,
      cartReadable,
    });
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

  async getPastOrderDates(): Promise<PastOrder[]> {
    const page = await this.ensureBrowser();

    // Navigate to reorder/past orders page
    // Use domcontentloaded instead of networkidle - Good Eggs has persistent connections
    await page.goto(`${BASE_URL}/reorder`, { waitUntil: 'domcontentloaded' });

    // Wait for React to render
    await page.waitForTimeout(3000);

    // Check if we're redirected to signin
    if (page.url().includes('/signin')) {
      throw new Error('Not logged in. Cannot access past orders.');
    }

    // Extract past order information
    const orders = await page.evaluate(() => {
      const orderList: PastOrder[] = [];

      // Good Eggs reorder page uses 'reorder-page__grid__header' class for order date headers
      // Each header contains a <p> element with text like "Delivered Saturday, January 10th"
      const headerElements = document.querySelectorAll('.reorder-page__grid__header');

      headerElements.forEach((header) => {
        const dateEl = header.querySelector('p');
        const dateText = dateEl?.textContent?.trim();

        if (!dateText) return;

        // Skip non-order headers like "Based on your shopping" recommendations section
        if (!dateText.includes('Delivered')) return;

        // Extract just the date part (e.g., "Saturday, January 10th" from "Delivered Saturday, January 10th")
        const dateMatch = dateText.match(/Delivered\s+(.+)/);
        const cleanDate = dateMatch ? dateMatch[1] : dateText;

        // Count the products in this order section
        // The products follow the header in the DOM as sibling elements with js-product-link
        let itemCount = 0;
        let sibling = header.nextElementSibling;
        while (sibling && !sibling.classList.contains('reorder-page__grid__header')) {
          const productLinks = sibling.querySelectorAll('a.js-product-link');
          itemCount += productLinks.length;
          sibling = sibling.nextElementSibling;
        }

        orderList.push({
          date: cleanDate,
          itemCount: itemCount > 0 ? itemCount : undefined,
        });
      });

      return orderList;
    });

    return orders;
  }

  async getPastOrderGroceries(orderDate: string): Promise<GroceryItem[]> {
    const page = await this.ensureBrowser();

    // First, go to account orders page to find the order ID
    // Check if we're on the orders list page (not a specific order details page)
    const currentUrl = page.url();
    const isOnOrdersList =
      currentUrl.includes('/account/orders') && !/\/account\/orders\/[^/]+/.test(currentUrl);
    if (!isOnOrdersList) {
      await page.goto(`${BASE_URL}/account/orders`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    }

    // Check if we're redirected to signin
    if (page.url().includes('/signin')) {
      throw new Error('Not logged in. Cannot access past orders.');
    }

    // Find the order that matches the date and get its URL
    const orderUrl = await page.evaluate((targetDate) => {
      // Try to find by looking at the page structure for order links
      const orderLinks = Array.from(document.querySelectorAll('a[href*="/account/orders/"]'));
      for (const link of orderLinks) {
        const linkEl = link as HTMLAnchorElement;
        // Get the parent container to check the date
        const container = linkEl.closest('[class*="card"], [class*="row"], div') || linkEl;
        const text = container.textContent || '';

        // Check if this order matches our target date
        // Dates can be like "Saturday 1/10", "January 10th", etc.
        if (text.includes(targetDate)) {
          return linkEl.href;
        }

        // Try more flexible date matching
        // Extract date components from targetDate and compare
        const datePatterns = [
          /(\d{1,2})\/(\d{1,2})/, // 1/10
          /([A-Za-z]+)\s+(\d{1,2})/, // January 10
          /(\d{1,2})(?:st|nd|rd|th)/, // 10th
        ];

        for (const pattern of datePatterns) {
          const targetMatch = targetDate.match(pattern);
          const textMatch = text.match(pattern);
          if (targetMatch && textMatch && targetMatch[0] === textMatch[0]) {
            return linkEl.href;
          }
        }
      }

      return null;
    }, orderDate);

    if (!orderUrl) {
      // Fallback: try clicking on "Order Details" for a matching date
      const clickedUrl = await page.evaluate((targetDate) => {
        const cards = Array.from(
          document.querySelectorAll('[class*="single-order"], [class*="order-summary"], div')
        );
        for (const card of cards) {
          const text = card.textContent || '';
          if (text.includes(targetDate)) {
            // This card contains the target date, look for Order Details link
            const detailsLink = card.querySelector(
              'a[href*="/account/orders/"]'
            ) as HTMLAnchorElement;
            if (detailsLink) {
              return detailsLink.href;
            }
          }
        }
        return null;
      }, orderDate);

      if (!clickedUrl) {
        return [];
      }

      await page.goto(clickedUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    } else {
      await page.goto(orderUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    }

    // Now we're on the order details page - extract items with quantity ordered
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

    const productId = extractProductId(groceryUrl);
    if (!productId || productId.length < 3) {
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
    // one selector finds it whichever one the account was bucketed into.
    const cardSelector = `[data-product-id="${productId}"]`;

    // Removing takes a different number of clicks per layout, so drive it as a
    // bounded loop and let the basket say when it worked:
    //   card layout    the quantity pill's left button decrements, and turns
    //                  into the trash control at quantity 1
    //   summary layout a "Remove" control, or a quantity <select> with a 0
    //                  option
    const maxAttempts = Math.max(target.quantity, 1) + 2;
    let removalAttempted = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const card = await page.$(cardSelector);
      if (!card) break;

      const control = await card.$(
        '[data-testid="qty-trash"], [data-testid="qty-decrement"], .quantity-pill__btn--left, ' +
          'button[aria-label*="remove" i], .summary-item__remove, [class*="remove-button"]'
      );
      if (control) {
        await control.click().catch(() => {});
        await page.waitForTimeout(1000);
        removalAttempted = true;
        continue;
      }

      const quantitySelect = await card.$('.summary-item__quantity select, select');
      if (quantitySelect) {
        try {
          await quantitySelect.selectOption('0');
          await page.waitForTimeout(1000);
          removalAttempted = true;
          continue;
        } catch {
          // No zero option; nothing else to try on this card.
        }
      }
      break;
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
        'Could not read the Good Eggs basket: the page carried no basket payload. ' +
          'This usually means the session is signed out or the page failed to load; ' +
          'it does NOT mean the basket is empty.'
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
 * Callback invoked when background login fails
 * @param error The error that caused login to fail
 */
export type LoginFailedCallback = (error: Error) => void;

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

  // Track background login state
  let loginPromise: Promise<void> | null = null;
  let loginFailed = false;
  let loginError: Error | null = null;
  let onLoginFailed: LoginFailedCallback | null = null;

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
   * Start background login process
   * This should be called after the server is connected to start authentication
   * without blocking the stdio connection.
   *
   * @param onFailed Callback invoked if login fails - use this to close the server
   */
  const startBackgroundLogin = (onFailed?: LoginFailedCallback): void => {
    if (loginPromise) {
      // Already started
      return;
    }

    onLoginFailed = onFailed || null;

    // Create client if not already created
    if (!activeClient) {
      createClient();
    }

    // Start login in background
    loginPromise = activeClient!.initialize().catch((error) => {
      loginFailed = true;
      loginError = error instanceof Error ? error : new Error(String(error));

      // Invoke callback to notify about login failure
      if (onLoginFailed) {
        onLoginFailed(loginError);
      }

      // Re-throw to make the promise rejected
      throw loginError;
    });
  };

  /**
   * Get a client that is ready to use (login completed)
   * If background login was started, this waits for it to complete.
   * If not started, this will initialize synchronously (blocking).
   */
  const getReadyClient = async (): Promise<IGoodEggsClient> => {
    // If login already failed, throw immediately
    if (loginFailed && loginError) {
      throw new Error(`Login failed: ${loginError.message}`);
    }

    // If background login is in progress, wait for it
    if (loginPromise) {
      await loginPromise;
      return activeClient!;
    }

    // No background login started - create and initialize client now (legacy behavior)
    if (!activeClient) {
      createClient();
    }
    await activeClient!.initialize();
    return activeClient!;
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
    loginPromise = null;
    loginFailed = false;
    loginError = null;
  };

  return { server, registerHandlers, cleanup, startBackgroundLogin };
}
