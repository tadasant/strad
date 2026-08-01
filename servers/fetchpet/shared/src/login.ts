/**
 * The login form, and the only two selectors that have to survive a redesign.
 *
 * Fetch's sign-in page is a React app with floating labels: the fields carry no
 * `placeholder` and no `autocomplete`, only `type`. Anything that identifies
 * them by placeholder text alone matches nothing, and a server that waits on
 * such a selector spends its whole login timeout waiting for an element that
 * exists a few characters away in the DOM.
 *
 * So the selectors here are UNIONS of every attribute the field has plausibly
 * carried, matched with a WAITING locator. A non-waiting probe (`page.$`) is the
 * trap this file exists to avoid: it returns null when the React tree has not
 * rendered yet, which on a slow container is most boots, and whatever the caller
 * does in that null branch becomes the real login path.
 */

/** The slice of Playwright's `Page` this module needs. */
export interface LoginPage {
  locator(selector: string): LoginLocator;
}

/** The slice of Playwright's `Locator` this module needs. */
export interface LoginLocator {
  first(): LoginLocator;
  waitFor(options: { state: 'visible'; timeout?: number }): Promise<void>;
  fill(value: string): Promise<void>;
}

/**
 * The email field. `input[type="email"]` is what Fetch serves; the rest are the
 * shapes it has served before and cost nothing to keep matching.
 */
export const EMAIL_FIELD_SELECTOR =
  'input[type="email"], input[name="email"], #email, input[placeholder*="email" i], input[autocomplete="email"]';

/** The password field, same reasoning. */
export const PASSWORD_FIELD_SELECTOR =
  'input[type="password"], input[name="password"], #password, input[placeholder*="password" i], input[autocomplete="current-password"]';

/**
 * Wait for a login field to be visible, then fill it.
 *
 * The wait is the point. `locator()` resolves at use, so this tolerates the SPA
 * rendering the form after navigation settles — and when it does time out, the
 * error names the whole union, which says "the form changed" rather than "the
 * one selector I happened to try is missing".
 */
export async function fillLoginField(
  page: LoginPage,
  selector: string,
  value: string,
  timeoutMs: number
): Promise<void> {
  const field = page.locator(selector).first();
  await field.waitFor({ state: 'visible', timeout: timeoutMs });
  await field.fill(value);
}
