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

The tool layer follows: an unverified result is no longer prefixed
`Failed to add to cart:`.

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

**Why.** This is the delta the actual user-facing harm came from. Every wrong
statement in the incident was downstream of a read that answered a question it
could not answer. A caller cannot tell an empty array from a failed one, so the
server must not hand it one.

## 6. Not vendored: the upstream `local/` stdio entrypoint

Only `shared/` came across. `remote/` is strad's own Express +
`StreamableHTTPServerTransport` front door over the same `createMCPServer()`
factory — see the README.

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
