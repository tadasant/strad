# good-eggs — what this fork changes, and why

Forked from **`pulsemcp/mcp-servers` `experimental/good-eggs`** at
**`44f32a32afe27ffe9d00f23b24934c8242730f65`** — the commit this tree was last
verified identical to, not a commit that touched the server.

It is a fork, not a vendor copy: strad owns this code and fixes land here. What
follows is the reason for that, and every delta.

## Why it stopped being a vendor copy

Until this fork, `shared/` was copied verbatim and carried a "do not edit it
here — fixes belong upstream, then re-vendor" note. That instruction had nowhere
to point. The npm package the defects were actually reported against,
`good-eggs-mcp-server@0.1.11` (published 2026-06-30), declares no `repository`,
`homepage` or `bugs` URL; no repo exists at `tadasant/good-eggs-mcp-server`,
`pulsemcp/good-eggs-mcp-server`, or the bare names; and the `pulsemcp` org
carries no match. So there was no upstream to fix, and strad's own copy was
forbidden from being fixed.

The precedent for the other direction is
[`servers/bundle-api/fork/google-flights`](../bundle-api/fork/google-flights/FORK.md)
and [`servers/strad-fetch`](../strad-fetch/FORK.md): a server whose defects
returned confident wrong answers becomes first-party, and its tests become the
only thing defending the fix. This tree is shaped like `strad-fetch` — a whole
tree that is one server, `shared/` plus a `remote/` entrypoint, with the deltas
here — rather than like `bundle-api/fork/<slug>/`, because that layout exists to
distinguish forked from vendored servers colocated in ONE image, and good-eggs
has an image of its own (it needs a Chromium base; see the README).

`shared/`'s tests are what stops a careless re-vendor from reverting any of
this. CI runs them on every PR (`servers (good-eggs)`).

---

## The incident

During the 2026-08-18 weekly shop (Zimmer session 6073, tracked as
`tadasant/tadasant-internal#1346`) the server told a user his cart was empty
while it held 43 line items totalling $340.70, reported successful adds as
failures, and refused to remove items it claimed were not there. The agent read
the resulting cart deltas as edits the user had made and told him "I see you
pulled the yellow onion" — a false statement to a human, produced entirely by
trusting an unreliable read.

Deltas 1–4 are that incident. **One root cause explains all three defects**, and
delta 5 is the rule that keeps the class of harm from coming back.

---

## 1. The basket is read from the page's state payload, not from the markup

**Upstream.** `getCart()` navigates to `/basket` and scrapes
`document.querySelectorAll('.js-basket-item')`, reading each row's
`.summary-item__name a`, `.summary-item__producer a`, `.summary-item__unit`,
`.summary-item__quantity select` and `.summary-item__price`.

**Here.** `basketState.ts` extracts `storeData` from the payload Good Eggs
renders into every page —

```html
<script>window._goodeggs.initReactRedux(window._goodeggs.entrypoint, {"storeData":{…}});</script>
```

— and builds the cart from `storeData.basket.items` joined to
`storeData.products` and `storeData.basket.totals.lineItemTotals`. `getCart()`
and the new `getBasket()` (which also carries the subtotal) both read it.

**Why.** The basket page renders one of two layouts, chosen by an
`enableNewBasketLayout` flag in the page's own React context. The card layout —
the one served on desktop today — renders `div.basket-item-card`, with no
`js-basket-item` and none of the `summary-item__*` children the scrape depends
on. So on an account served that layout, the scrape matched **nothing** and
`get_cart` answered `"Your cart is empty. Add items to your cart on Good Eggs to
see them here."` every single time.

Measured on live `www.goodeggs.com`, anonymous session, one item added:

```
OLD DOM scrape (.js-basket-item + .summary-item__name a) -> 0 items []
rendered .basket-item-card cards                          -> 1
NEW payload read                                          -> 1 items
  [{"name":"Organic Dry-Farmed Early Girl Tomatoes","qty":1,"price":"$5.99",
    "brand":"Blue House Farm","unit":"1 lb"}]
NEW subtotal                                              -> 599 cents
```

The payload is what the SERVER believes the basket is, rendered per request
against the session cookie, and it is the same state the page then draws itself
from. It does not depend on which layout the account is bucketed into. That is
also why the workaround the agent fell back on during the incident — reading the
`"basket":{…}` blob out of a product page — was accurate every time.

Two shapes are read defensively because both appear in the wild: a line's
product id as `item.product.id` **or** `item.productId`, and its subtotal under
`totals.lineItemTotals[item.id]` (where a live basket puts it) **or** inline on
the item.

## 2. `add_to_cart` no longer asserts a failure it did not observe

**Upstream.** After clicking add, it re-reads the cart and reconciles. Every read
failure — including a `getCart()` that returned `[]` because of delta 1 — landed
in the same branch, which returns:

> Clicked add for …, but it does not appear in your cart afterward. The add did
> not take effect (a delivery day may need to be selected, or the item may be
> unavailable).

Since the read was broken, essentially every SUCCESSFUL add returned that
string. It asserts the opposite of what happened, which invites a blind retry and
produces duplicates.

**Here.** `reconcileAddResult` takes `cartReadable` and `priorQuantityKnown`.
When the basket could not be read, the result is `verified: false` and says the
outcome is **UNVERIFIED**, naming the retry hazard rather than a failure. When
the before-read failed but the after-read worked, a present item is reported at
its true quantity without crediting this call for putting it there. The genuine
failure message is unchanged and still fires when the basket was read and really
does lack the item.

The FIELDS say the same thing as the prose: an unverified result omits
`quantity` rather than setting it to 0 (a 0 is indistinguishable from a measured
absence) and never derives `success` from the click. The tool layer follows —
an unverified result is neither prefixed `Failed to add to cart:` nor flagged
`isError`, because unknown is not failed.

## 3. `remove_from_cart` works, and its "not found" means something

**Upstream.** It scrapes `.js-basket-item` for a row containing
`a[href*="<slug>"]`, then clicks `.summary-item__remove` or picks `0` in
`.summary-item__quantity select`. Under delta 1 there were no such rows, so it
returned `Item not found in cart` for items that were plainly there — for every
item tried. There was no other way to undo an add (`add_to_cart` rejects
`quantity: 0` at the schema layer), so a wrong add was unrecoverable.

**Here.** Presence is decided against the basket payload. The item's container is
found by `[data-product-id="<id>"]`, which **both** layouts emit, and removal is
a bounded click loop over the controls either layout offers: the card layout's
quantity pill (`[data-testid="qty-decrement"]`, which becomes
`[data-testid="qty-trash"]` at quantity 1), or the summary layout's
`.summary-item__remove` / quantity `<select>`. The result is verified by
re-reading the basket.

Measured on live `www.goodeggs.com`, anonymous session, quantity 3:

```
before remove: ["Organic Dry-Farmed Early Girl Tomatoes x3 $17.97"] subtotal 1797
  click 1: aria="Decrease quantity" testid="qty-decrement"
  click 2: aria="Decrease quantity" testid="qty-decrement"
  click 3: aria="Remove item"       testid="qty-trash"
after remove:  [] subtotal 0 | clicks used: 3 | budget: 5
```

`Item not found in cart` now means the basket really does not contain it, and
says how many products it does contain.

The loop is bounded twice — by the line's own quantity plus two, and by a hard
ceiling of 15 clicks — because a decrement-per-click control on a large line
would otherwise spend a second per unit inside one tool call. The product id is
validated as 24-char Mongo hex before it reaches the selector.

## 4. Items are named from the payload, not from the first heading

**Upstream.** `add_to_cart`, `add_favorite` and `remove_favorite` name the
product with `document.querySelector('h1, [class*="product-name"], [class*="title"]')`.

**Here.** `productNameFromHtml()` reads `storeData.products[<id>].name`, falling
back to that selector.

**Why.** On a product page with no delivery day chosen, the first matching
element is the day picker — which is why every result in the incident was
reported against an item called **"Select a delivery day"**. (`storeData` carries
`selectedFulfillmentOffer: null` on a perfectly healthy page, including an
anonymous one; it is not a signal that anything failed.)

## 5. An unreadable basket is "unknown", never "empty"

**Upstream.** `getCart()` returns `[]` on every failure path, and `get_cart`
renders `[]` as "Your cart is empty."

**Here.** `getBasket()` **throws** when the page carries no payload, `get_cart`
returns an error that says the contents are UNKNOWN rather than empty, and
`addToCart` distinguishes "read failed" from "read empty" instead of collapsing
them.

Three states that all look like an empty basket are refused as unreadable:

- **No payload at all** — an error page, or a markup change.
- **A payload whose `basket` carries no `items` array** — a shape change or a
  partial render, which would otherwise land as a zero-item basket.
- **A payload from a page that is not signed in.** This one is the trap: a
  logged-out Good Eggs page serves a perfectly READABLE payload for an
  ANONYMOUS basket, which is empty. The login here happens once, at startup,
  and nothing re-checks it, so a lapsed session would put "your cart is empty"
  back in front of a full cart by a second route. `storeData.user` is null on
  such a page, and that is what `signedIn` on the snapshot reads.

**Why.** This is the delta the actual user-facing harm came from. Every wrong
statement in the incident was downstream of a read that answered a question it
could not answer. A caller cannot tell an empty array from a failed one, so the
server must not hand it one.

## 6. The login wait does not wait for an event the page never sends

**Upstream.** After submitting credentials, `initialize()` calls

```ts
await this.page.waitForURL((url) => !url.pathname.includes('/signin'), {
  timeout: this.config.timeout,
});

const currentUrl = this.page.url();
if (currentUrl.includes('/signin')) {
  throw new Error('Login failed - still on signin page. Check your credentials.');
}
```

**Here.** `waitForSignIn()`: the wait passes `waitUntil: 'domcontentloaded'`, the
predicate is the exported `isPostSignInUrl()`, and the verdict comes from the
state of the page afterwards rather than from how the wait ended.

**Why.** On 2026-08-28 every authenticated call against strad's production
`good-eggs` slug — `get_favorites` and `get_cart` alike — failed with
`Login failed: page.waitForURL: Timeout 30000ms exceeded`
([strad#195](https://github.com/tadasant/strad/issues/195)), over a Playwright
log that said the navigation had already happened:

```
waiting for navigation until "load"
  navigated to "https://www.goodeggs.com/home?recently-logged-in=true"
  "networkidle" event fired
  "domcontentloaded" event fired
```

`waitForURL` defaults to `waitUntil: 'load'`. Playwright logs `navigated to …`
from inside its URL predicate and the `"…" event fired` lines only from the
lifecycle wait it enters AFTER that predicate has matched, so the log itself
says the URL was never the problem: the credentials were accepted, the page
rendered, the predicate matched — and the wait then sat for 30 seconds on a
`load` event that page does not send. Every other navigation in this server
already passes `domcontentloaded`, with a comment saying Good Eggs holds
connections open; this one wait was the exception, and it gated all eleven tools.

The trap was documented one tree over and this server did not get the lesson:
`servers/fetchpet/shared/src/server.ts` avoids `waitForURL` outright, saying the
default `'load'` "can hang when third-party resources fail to load".

Three further changes decide the login on evidence rather than on the wait:

- **`isPostSignInUrl()`** is a path test against goodeggs.com — query strings,
  fragments, trailing slashes, casing and percent-encoding are noise — so the
  next time Good Eggs moves its landing page it is not another outage. It is
  segment-anchored where `includes('/signin')` was a substring match.
- **The page's own payload decides, whichever way the wait ended.** `storeData`
  carries `user`: an object when somebody is signed in, `null` on an anonymous
  page (the signal delta 5 refuses an anonymous basket on). A signed-in payload
  is a successful login even if the wait threw — which is exactly the outage
  above — and an ANONYMOUS payload is a failed one even on a URL that looks like
  an arrival, which is what would happen if Good Eggs renamed the form to a path
  the predicate does not know: the wait would return instantly, on the form.
  A payload with no `user` key, or no payload at all, is `unknown` and leaves the
  verdict to the URL — refusing a login on an unrecognised payload would be a
  second way to take the server down.
- **A closed page is not a signed-in one.** `page.url()` is a cached client-side
  read that answers happily for a page that no longer exists, so a Chromium
  killed mid-login — this container shares one across three servers — would
  otherwise report the URL it died on as a successful sign-in, bringing the mount
  up healthy to fail every call.

The failure message carries the page WITHOUT its query string, and without the
`Login failed` prefix its caller already adds. It becomes the bundle's per-mount
`degraded` string and the body of every tool error that mount returns.

`shared/test/login.test.ts` pins all of it over a fake page injected through
`setSharedBrowserProvider`, with no browser and no credentials: the `waitUntil`
argument, the predicate against the real observed URL and the logged-out forms,
each verdict, and that the password and the query string stay out of the error.
Seven of its twenty cases pin this delta, and fail against the code above.

**What this delta does not cover.** The wait is why that login failed; it is not
why the failure lasted. That is delta 9.

## 7. An unconfirmed favorites page is "unknown", never "you have none"

**Upstream (and this tree until this delta).** `getFavorites()` throws if the URL
is the sign-in form and otherwise returns whatever `a.js-product-link` scrapes
off the page — `[]` included.

**Here.** The page's own `storeData.user` decides whether the session is real,
read through the same `signedInFromPage()` the login wait uses, and the answer is
a THREE-state one:

| The page's payload | The scrape found | `getFavorites()` |
| --- | --- | --- |
| a user | items | the items |
| a user | nothing | `[]` — a true empty |
| `user: null` | anything | throws: nobody is signed in, so none of it is yours |
| no payload, or none it recognises | items | the items |
| no payload, or none it recognises | nothing | throws: two absences and no evidence |

**Why.** This is delta 5's harm arriving by a third route. A signed-out
`/favorites` does not always redirect, and it fails in two directions. It can
render a page with no product links, which scrapes to `[]` — "you have no
favorites" — against an account that has plenty. It can equally render
recommendation tiles to a signed-out visitor, which scrape to a plausible list
that is not the user's favorites at all; that one is worse, because a wrong list
invites action in a way an empty one does not. The login happens once at startup
and nothing re-establishes it (`HACKS.md` #67), so a lapsed session lands in
both.

The three-state split is what makes the rule safe in both directions.
`user: null` is a STATEMENT that nobody is signed in, so nothing on that page is
reportable. `unknown` is a statement about nothing, so only the EMPTY answer is
refused there — products drawn on a page Good Eggs served without a payload this
tree recognises are still products, and dropping them would understate the
account, which is the failure this whole discipline exists to stop.

Two details, both pinned by tests:

- **The payload is read from the SERVED document**, immediately after
  `domcontentloaded` and before the existing 3-second wait for React — exactly as
  `getBasket()` reads it. Reading after hydration risks judging a document the
  app has since rewritten, which would turn a signed-in account with genuinely
  zero favorites into a hard error.
- **A `content()` that throws is `unknown`, not `anonymous`.** "Execution context
  was destroyed" is a fact about timing, not about the session.

The sign-in guard on the same path also moves from `page.url().includes('/signin')`
to `isPostSignInUrl()` (delta 6), so the two paths agree on what the form is.
That widens the throw from one spelling of `/signin` to all of them, and to a
login bouncing through an off-domain identity provider — which is correctly not
this account's favorites page. It narrows it too: the substring test threw on any
URL merely CONTAINING the word, so `/favorites?next=/signin` was a failed read.

The tool layer follows the client: `get_favorites`'s error says the favorites are
UNKNOWN rather than none, the way `get_cart`'s already did, and its description
tells the model that an error is not an empty list.

`shared/test/favorites-truthfulness.test.ts` pins all twelve cases — every row
of the table, both `content()`-throws paths, the read's position in the flow, and
the sign-in redirect — driving the real `getFavorites()` over a fake page through
`setSharedBrowserProvider`, with the payload built by the same `renderPage`
fixture the basket tests use. The in-page DOM scrape is the one part stubbed — it
runs in a browser — so what the tests pin is the rule around the scrape, not the
selectors inside it.

## 8. Not vendored: the upstream `local/` stdio entrypoint

Only `shared/` came across. `remote/` is strad's own Express +
`StreamableHTTPServerTransport` front door over the same `createMCPServer()`
factory — see the README.

## 9. A failed login is retried, not cached for the life of the container

**Upstream (and this tree until this delta).** `createMCPServer()` runs the login
once and latches its outcome:

```ts
loginPromise = activeClient!.initialize().catch((error) => {
  loginFailed = true;
  loginError = error instanceof Error ? error : new Error(String(error));
  ...
```

and `getReadyClient()` short-circuits on that latch forever:

```ts
if (loginFailed && loginError) {
  throw new Error(`Login failed: ${loginError.message}`);
}
```

Only `cleanup()` clears it.

**Here.** There is one piece of state — `loginAttempt`, the attempt in flight or
the one that succeeded — and a failed attempt sets it back to null. `attemptLogin()`
closes and discards the client that failed, so the next caller starts from a clean
browser context rather than inheriting a page parked on the sign-in form, and
`getReadyClient()` starts a fresh attempt whenever none is running. Concurrent
callers share the one attempt. `startBackgroundLogin` takes a second callback,
`onRecovered`, invoked when an attempt succeeds after a failure.

**Why.** The standalone `remote/` entrypoint exits on a login failure and the
platform restarts it, so the next boot retries. strad's collapsed bundle is the
production path and it deliberately does the opposite: with twenty other servers
on board, it marks the one mount `degraded` and keeps serving. It never calls
`cleanup()`, the only thing that cleared the latch — so every `get_cart`,
`get_favorites` and `add_to_cart` on that container answered with the same cached
error until a redeploy
([strad#196](https://github.com/tadasant/strad/issues/196)). Login failures are
very often transient (a slow page, a cold browser, a form that took too long),
and this turned every one of them into a permanent one.

`servers/fetchpet/shared/src/server.ts` had the same defect and fixed it first;
this is that shape, so the two browser servers in the bundle behave alike. The
host passes `onRecovered` for both, clearing `degraded` when a retry logs in
— otherwise `/healthz` keeps naming a mount that is serving.

The error `getReadyClient()` raises carries `(retry the call)`. That is an
instruction to the caller rather than a promise about the process: a host that
treats a failed login as fatal — the standalone image does — may be on its way
down, and the retry then belongs to its replacement.

`shared/test/login.test.ts` pins it over the same fake browser the wait tests
use: a login that fails and then works again recovers on the next tool call
without a restart, on a FRESH context and with `onRecovered` fired exactly once;
two failures produce two attempts and two reports rather than one replayed; three
concurrent calls open one context; and a missing credential leaves through the
callback rather than as a synchronous throw at the host, and is retried once the
credential arrives. Four of its twenty cases fail against the code above (the
fifth, the shared attempt, already held).

## 10. The freebie tool says which two pages it checked

**Upstream.** `search_for_freebie_groceries` is described as *"Search for free
items ($0.00) on Good Eggs"*, and when it finds nothing it answers:

> No free items or deals currently available.

**Here.** The sweep is unchanged — `searchFreebieGroceries()` still reads
`a.js-product-link` tiles priced `$0.00` off the homepage and `/fresh-picks`, and
nothing else. What changed is what the tool claims about it:

- The **description** names the two pages, says it does not search the catalog,
  says an empty result means "none on those two pages" and not "none available",
  and tells the caller to treat any `$0.00` item in a `search_for_grocery` result
  as a freebie too.
- The **empty result** says the same, in the result itself: *"This check found
  no $0.00 items on the Good Eggs homepage and /fresh-picks, the only two pages
  it looks at"*, then *"This does NOT mean no free items are available"*. It is
  phrased as what the check found rather than as a fact about the pages, because
  a scrape that waits a fixed three seconds and never scrolls can miss a tile
  that is there.
- A **non-empty result** names the pages it came from, says other `$0.00` items
  may be listed elsewhere, and points at `search_for_grocery` results. It says
  "$0.00 items", not "deals/freebies" — the sweep matches a `$0.00` price and
  nothing else, so it never returned a deal.
- An **error** names the two pages too, and says whether free items exist is
  UNKNOWN, not none — the rule `get_cart` and `get_favorites` already follow.

**Why.** During the 2026-08-23 weekly shop the tool answered *"No free items or
deals currently available."* while two `$0.00` "TRY ME!" Reelie chip samples were
live and orderable. An ordinary `search_for_grocery("kosher salt")` surfaced them
by chance ([strad#191](https://github.com/tadasant/strad/issues/191)). The
grocery-shopping agent calls this tool as a required early step and reads a
negative answer as "no freebies this week", so the upstream sentence cost the
user free items. The sweep measured two pages. The answer claimed the whole store.

The other remedy — a `$0.00` price filter over the catalog or search index — is
not built. It is a new traversal, and Good Eggs' search UI may not expose a price
filter at all. `HACKS.md` #90 records the gap.

`shared/test/freebie-scope.test.ts` pins the description and all three results
through the tool surface, over a stubbed client. It also drives the real
`searchFreebieGroceries()` over a fake page through `setSharedBrowserProvider`
and pins that it visits the homepage and `/fresh-picks` and nothing else, so the
strings cannot quietly understate a sweep that grows a third page.

## 11. Past orders are found by delivery date in the payload, not by page text

**Upstream.** `get_list_of_past_order_dates` reads `/reorder`, takes each
`.reorder-page__grid__header` whose text says "Delivered …", and counts the
`a.js-product-link` elements under it. `get_past_order_groceries` then loads
`/account/orders`, but skips the load if the page is already there, and walks
every `a[href*="/account/orders/"]`. For each link it checks whether the text of
its nearest `div` contains the date it was given, or whether the first `m/d`,
`Word 12` or `12th` in that text equals the first one in the date. If no link
matches, it takes the first `div` anywhere on the page whose text contains the
date. Then it scrapes `.single-order-page__line-item` rows off the order page.

**Here.** `pastOrders.ts` reads both pages' `storeData`. The list comes from
`populatedPastOrders`: each order's id, `deliveryWindow.startAt` converted to a
calendar day in the foodhub's timezone (`foodhub.tzid`, or
`America/Los_Angeles` when the payload names none), `itemCount`, and
`totals.stripeTotal`. The list tool prints each date both ways,
`Monday, September 21st (2026-09-21)`. A lookup parses the date it was given as
a month and day, plus a year if one is included (`2026-09-21`, `9/21`,
`09/21/2026`, `Sep 21`, `Monday, September 21st`, `Monday 9/21`), compares it
with those calendar days, and loads `/account/orders/{id}`. The items come from
that page's `storeData.order.items`. The row scrape is kept only as a fallback
for a payload with no items array. `/account/orders` is reloaded on every call.
A date that matches no order is an error that lists the dates that do exist. It
is never "No items found".

**Why.** On 2026-09-21 the weekly shop could not read back the order it had just
placed. `get_past_order_groceries` answered "No items found" for the 9/21 order
under `9/21`, `09/21`, `2026-09-21`, `September 21st` and
`Monday, September 21st`, on 9/21 and again on 9/22, while `9/13` read normally
(`tadasant-internal#2956`). Measured live on 9/22:

- `/account/orders` draws the order as `Monday 9/21`. The list tool had named it
  `Monday, September 21st`, taken from a different page. That string cannot match
  the text search, so a date the list hands out works only by accident: the same
  call returned "No items found" for `Monday, September 21st` and all 11 items
  for `9/21`.
- The order and its page were fine. Given text that only that order's card
  contains, its total `$78.13`, the old lookup returned all 11 items.
- `9/21` itself missed three times on 9/21 and once on 9/22, then matched on a
  later call. That call went through the same code against the same
  `Monday 9/21` markup, so the heuristic's answer depended on how the page
  happened to be drawn at the moment of each call. The 9/22 miss came right
  after a failed lookup had left the browser on `/account/orders` overnight.
  Because of the reload skip, that lookup may have searched a list drawn the
  evening before. Which failure caused which miss can't be established after the
  fact, and the fix does not depend on it: the lookup reads no drawn text. The
  row scrape reads it only when an order page's payload has no items array,
  and an empty scrape is an error, not an empty order.

The list's item counts were also exactly doubled against the payload: 56 for an
order of 28, 22 for 11, 26 for 13. The payload's `itemCount` is the number the
orders page itself prints ("28 Products").

`shared/test/past-orders.test.ts` pins the timezone conversion (a Friday-evening
window starts on Saturday in UTC), every date format the failed lookups tried,
the real counts, and a miss that lists the dates on file. It also runs the real
client over a fake page through `setSharedBrowserProvider`. That covers the
list-then-read flow, that a lookup reloads a list it is already sitting on, and
that the path never falls back to a DOM scrape when the payload is there.

## 12. `get_grocery_nutrition`: what Good Eggs publishes about a product's nutrition, and nothing it does not

**Upstream.** No such tool. `get_grocery_details` scrapes a name, price,
description and one `img` off the drawn page.

**Here.** A twelfth tool, `get_grocery_nutrition(grocery_url)`, built in
`shared/src/nutrition.ts`. It loads the product page and reads
`storeData.productDetails`, the product payload the page renders, for the name,
producer, retail units and photos. It returns JSON with three parts:

- **`nutrition.status`**, always set:
  - `found` comes with `facts`: calories, total fat, carbohydrate, protein,
    serving size, servings per package, and the other ten columns the table
    carries. It also comes with the matched row and the article it came from,
    including the article's `updatedAt`. `sizeMatches: false` flags a row for a
    different package size.
  - `ambiguous` lists every candidate row.
  - `not_in_kitchen_tables`.
  - `not_published`.
  - `unknown`: the tables could not be read. That is not the same as absent.
- **`images`**: for each photo, an uncropped JPEG rendition at most 2000px wide,
  and the original upload. Both are public CDN URLs. The tool returns URLs and
  never bytes.
- **The product's identity** (producer, name, retail units, product type), so a
  caller can take a `not_published` product to a nutrition database.

A nutrient is a number when the table prints one. It is the printed text when
the table prints something else (`"less than 1"`), and `null` when the cell is
blank or the column is missing.

**Why it looks like this. Good Eggs has no structured nutrition, except for one
producer.** Measured on 2026-10-15:

- The product payload has no nutrition field. `storeData.productDetails` carries
  `product`, `photoUrl`, `photosUrls`, `breadCrumbs`, `rawDescription`, `tags`
  and availability, and none of `calor|serving|nutri` appears anywhere in
  `storeData` except category names ("Shop by Serving Size").
- The product page makes no product API call. Its network log is the document,
  two bundles, Cloudflare's challenge script and a chat widget.
- Its JavaScript names nutrition once:
  `"goodeggskitchen"===e.currentProducer.slug && … "View Nutritional Information"`,
  a link to a help-center section.
- That section, read through Zendesk's public API
  (`/api/v2/help_center/en-us/sections/360007686892/articles.json`: HTTP 200
  with no cookie, where the HTML section page is behind a Cloudflare challenge),
  is 13 articles with one HTML table each. It has 498 product rows, headed
  `Recipe name | Servings per Package | Serving Size | Calories | Total Fat (g) | … | Protein (g) | …`.
- Every product checked (eleven favorites and the kitchen range) has one or two
  photos. The ones looked at were front of pack (Oatly, Ezekiel bread) or plated
  food (Corn Chowder's second photo), not a Nutrition Facts panel. Both URL
  forms return `200` to an unauthenticated `curl`:

  ```
  200 image/jpeg 298821B   https://images.goodeggs.com/cdn-cgi/image/width=2000,fit=scale-down,format=jpeg,quality=85/27e44621-….jpg
  200 image/jpeg 5719840B  https://images.goodeggs.com/27e44621-….jpg
  ```

  So no signed or temporary hosting is needed. The URLs are the download
  links.

**How the tables are read.** Each table's header row is repeated through it
(496 header rows in all), and every header row restarts the column map. Columns
are mapped by header TEXT, because one real article has no
`Servings per Package` column. Mapping by position would read its calories as
serving size. A response with no `articles` array, or one that parses to zero
rows, throws. A section that changed shape must not come back as "no row for
this product". A good read is cached for six hours. A failed one is not cached,
so the next call retries.

**How a product is matched to a row.** The product's whole name and the row's
name are compared after folding case, accents, apostrophes, and `&` to `and`. The
row's name has its size suffix removed first (`Black Beans - 10 oz`,
`Grana Padano- 2 oz`, `Chicken Tenders-16oz`). A substring never matches,
because a near miss would report another product's macros. If nothing matches,
a parenthetical such as `(Frozen)` is dropped from both names and the comparison
runs once more. Rows with identical values fold into one: one article repeats a
row seven times. When several rows remain, the product's retail units choose
between them. If that does not leave exactly one, the answer is `ambiguous`.
That case is real: `Achiote Marinade - 2 oz` is 70 kcal in one article and 140
kcal in another.

**Coverage.** On 2026-10-15, 3 of the 15 kitchen products on
`/goodeggskitchen` had a row: Corn Chowder, Baked Pasta with Pork & Beef Ragu,
and Brown Butter Squash Soup (Frozen). Most articles were last edited in
2020–2022. `HACKS.md` #126 records this.

`shared/test/nutrition.test.ts` pins the parse and the match against real rows
in `shared/test/fixtures/kitchen-nutrition.mjs`, and every status against real
product payloads. It also covers the HTTPS source's caching and retry, the
client's page read, and the tool's description, JSON result and error.

## Deltas that predate this fork

These were already in the tree when it was still a vendor copy, and are listed so
the diff against upstream is complete:

- **`setSharedBrowserProvider`** — the shared-browser seam that lets one Chromium
  serve good-eggs, fetchpet and pointsyeah in one container. The client closes
  its own context, never a browser it does not own.
- **Browser telemetry** (`telemetry.ts`, `withBrowserTelemetry`).
- **The MCP-App surface** (`appUi.ts`) — the `ui://good-eggs/search-results`
  resource and the `_meta` binding on `search_for_grocery`, gated on the client
  advertising the extension.
- **`extractProductId` / `findCartItemForUrl`** — id-based cart joins, and an
  add whose success is judged by a before/after delta rather than an after
  snapshot.
