# google-flights — a fork, not a vendor copy

Everything under `servers/bundle-api/upstream/` is copied verbatim: fixes go
upstream, then get re-vendored. This directory is one of two exceptions, and it
sits in `fork/` so that the difference is visible from the path.

**Forked from** [`google-flights-mcp-server`](https://www.npmjs.com/package/google-flights-mcp-server)
v0.2.6 (`com.pulsemcp/google-flights`) — the same package Tadas's sessions run
over `npx`. At that version the vendored copy was identical to the published
build at every site this fork touches.

## Why it is forked

Three defects, found in one flight-research session (Brisbane → New Zealand →
SFO, Dec 2026 / Jan 2027). What they have in common is the thing that makes them
worth a fork: **none of them errored.** Each returned a well-formed, plausible,
wrong answer, and two of them returned it under a field name that asserted the
opposite. A scraper that fails loudly costs you a retry; one that fails like this
costs you the decision you made on top of it.

The session hit all three, worked around all three, and its price table is
sampled rather than continuous because of the first one.

### 1. `get_date_grid` returned dates in the past

Asked on 2026-08-12 for a grid anchored on 2027-01-10, it returned
2026-06-12 → 2026-08-11: sixty-one days, every one of them already gone.

The anchor was **not** ignored on the way out — the request encoded it correctly.
The response was the wrong series. `ds1[5][10][0]` is a price HISTORY: what this
itinerary has been costing over the trailing 61 days. Its dates do not depend on
the anchor at all, which is directly observable — three different anchors return
the same 61 dates, with different prices:

| anchor | first | last |
| --- | --- | --- |
| 2027-01-10 | 2026-06-12 ($469) | 2026-08-11 ($713) |
| 2026-09-05 | 2026-06-12 ($485) | 2026-08-11 ($433) |
| 2026-12-20 | 2026-06-12 ($452) | 2026-08-11 ($433) |

There is no forward-looking grid anywhere in that page to read instead. The only
future date in the entire document is the anchor itself, and the response carries
no other `[timestamp, price]` array. So the grid is now assembled the honest way:
**one search per date**, lowest offer per date, over a window centred on the
anchor and clamped so it never begins before today.

That costs one request per date, and the cost per date is
`max(1.5s, however long Google takes)` — the limiter's interval runs start to
start, so a slow response is not absorbed by the gap, it replaces it. Measured:
7.2s for a 5-date grid, i.e. about 1.5s per date with the floor dominating, which
puts the 7-day default near 10s.

That is the good case, and it is not the one to design for. The window is capped
at 31 days AND the whole grid stops at a 55s wall-clock budget, reporting the
dates it did not reach: the MCP SDK's default per-request timeout is 60s, and a
client that gives up does not stop the loop, so an unbudgeted grid would keep
scraping for a caller who is no longer listening.

The requests go in sequence, not in parallel — this is scraping someone else's
page, and a burst is both rude and the fastest way to get the tool blocked
outright. The rate limiter reserves its slot synchronously for the same reason:
read-await-write is not atomic, and two concurrent grids in the one bundle
process would otherwise fire in pairs.

### 2. Cabin class — and passenger counts — never reached Google

A business-class request came back byte-identical to economy: $955 on United
AKL→SFO, `31 inches` of legroom.

`tfs` is a protobuf blob in a URL, and **field numbers are the whole contract**.
Google parses it with the real schema; a field numbered differently on this side
is not an error on either end, it is an *unknown field*, which proto3 skips in
silence before falling back to the default. Upstream numbered `Info.seat` **1**
and `Info.passengers` **6**; the schema has them at **9** and **8**.

So every request ever sent by this server asked for economy, one adult. The
`query` block in the response echoed the caller's `seat_class` and `adults` back
to them, which is what made it look like the parameter had been honoured.

Google's own parsed-request echo (`ds:0[1][1]`, index 5 = cabin, index 6 =
`[adults, children, infants_in_seat, infants_on_lap]`) is the proof:

| numbering | requested | Google understood |
| --- | --- | --- |
| `seat=1, passengers=6` | business, 1 adult | `1, [1,0,0,0]` — economy |
| `seat=1, passengers=6` | economy, 3 adults | `1, [1,0,0,0]` — 1 adult |
| `seat=9, passengers=8` | business, 1 adult | `3, [1,0,0,0]` ✓ |
| `seat=9, passengers=8` | economy, 3 adults | `1, [3,0,0,0]` ✓ |

End to end on AKL→SFO 2027-01-10 nonstop, after the fix: economy $955 / $1,183,
business $3,391 / $4,217.

The passenger half was not in the original report, and is arguably the worse of
the two: a quoted fare for the wrong number of travellers looks exactly like a
quoted fare for the right number.

`FlightData.max_stops` was also numbered 9 where the schema has 5. Nothing sent
it — stop filtering is applied client-side after parsing — so it changed no
behaviour, but leaving a known-wrong number in a schema file is how the next
person reintroduces the bug.

### 3. Baggage was reported backwards

Every fare came back `checked bags: 1 included`, `carry-on: not included` —
across China Airlines, Air New Zealand, Qantas and United alike. A universally
included checked bag with a universally excluded carry-on is not a plausible
state of the world, which is how it got noticed.

`offer[4][6]` is `[checked_bag_count, carry_on_count]`. Upstream read it as
`[carry_on_flag, checked_bag_flag]`, and additionally mapped a *missing* entry to
"not included" rather than "not stated". On that route every offer carries
`[null, 1]`, so both halves came out wrong for all 111 of them.

The order is established against the text Google renders for the same offers
(each label appears 8× in the page, so divide by 8). LAX→JFK 2026-09-15 is the
decisive case because all four combinations occur, and the bijection is exact:

| `offer[4][6]` | offers | Google's own text |
| --- | --- | --- |
| `[0,1]` | 106 | 1 carry-on bag included. **0** checked bags included. |
| `[1,1]` | 8 | 1 carry-on bag included. **1** checked bag included. |
| `[2,1]` | 1 | 1 carry-on bag included. **2** checked bags included. |
| `[0,0]` | 1 | **0** carry-on bags included. 0 checked bags included. |

It only holds with index 0 as the checked count.

A missing entry is now `null`, never `false` or `0`. Google states nothing about
checked bags on the AKL→SFO search — it renders no baggage text there at all — and
"unknown" is the only honest report. An agent telling a traveller "no checked bag
included" because a scraper defaulted a missing field is the failure this fork
exists to prevent.

**`isBasicEconomy` had to move with it.** It tested `checked_bags_included === 0`,
which — given the swap — was already reading the carry-on count. It now says what
it was doing: lowest fare tier **and** no free carry-on, which is what "basic
economy" names on the US carriers the filter exists for. Correcting the field
names *without* moving this predicate is what would have changed behaviour, and
badly: on SFO→LAX no fare has a free checked bag, so the filter would have gone
from excluding 9 offers to excluding all 27 lowest-tier ones.

Wherever Google states a carry-on count, old and new agree exactly — SFO→LAX 9 of
171 excluded before and after, LAX→JFK 1 of 116, AKL→SFO 0 of 112.

Where Google states **nothing**, they deliberately differ, and this is the one
behavioural change in the filter. The old expression `flags[1] || 0` collapsed a
null to 0, so an unstated carry-on counted as basic economy and the fare was
dropped. Now `null` is unknown and the fare is kept. This filter is **on by
default**, and a default that silently drops flights on absent data is the same
class of failure as reporting that absence as "not included".

## The delta

| File | Change |
| --- | --- |
| `src/flights-client/flights-client.ts` | `Info.seat` 1→9, `Info.passengers` 6→8, `FlightData.maxStops` 9→5. `parseExtensions` reads `[checked, carry_on]` and maps absent→`null`. `isBasicEconomy` tests the carry-on. `getDateGrid` rewritten to price each date, classifying no-offers / failed / not-attempted separately and raising a block rather than reporting it as an empty route; new exported `gridDates` (with a real-calendar-date guard and a return-date bound) and `GRID_BUDGET_MS`. The rate limiter reserves its slot synchronously. `parseSegment` records what a `null` legroom is — the payload's answer, not a missing index — with the diff and the 372-leg table behind it. |
| `src/flights-client/types.ts` | Baggage fields become nullable. `GetDateGridOptions` gains `window_days` and `return_date`; `DateGridResult` gains `window`, `unavailable_dates`, `failed_dates` and `not_attempted_dates`. |
| `src/flights.proto` | The two field numbers, matched to the code. |
| `src/tools/get-date-grid.ts` | `window_days` and `return_date` params; description states the per-date cost and the no-past-dates guarantee; `round_trip` now requires a return date instead of quietly pricing a one-way. |
| `src/tools/search-flights.ts` | Description: `fare_brand` is a tier *within* the cabin and does not name the cabin; a `null` baggage value means unknown, not zero; a `null` `legroom` means Google published no measurement for that seat, which is normal for a lie-flat and is not a property of the cabin. |
| `test/fork.test.ts` | **New.** Thirty tests over all three, the legroom null, the tool schema, and the fan-out (driven through an injected `fetch`). |

No tool is renamed, added or removed. The surface is still the three tools the
`google-flights` slug serves, so every `tools:` policy entry still names a tool
the mount serves.

### What the tests actually pin

The cabin tests assert the **encoded `tfs` bytes** — the field numbers in the
wire format — not a round-trip through this file's own schema. A round-trip test
would have passed on the broken numbering, because the bug was never an
inconsistency on this side; it was a disagreement with a schema that lives at
Google. Likewise `gridDates` is pure and exported so the window can be asserted
as dates, since "which dates came back" *was* the bug.

The fan-out tests drive `getDateGrid` through an injected `fetch`, which is what
pins the distinction the old shape could not make: a date with **no offers**, a
date whose **request failed**, and dates **never attempted** are three different
answers, and only the first is about the route. One of them asserts that a
rate-limit block raises and stops after a single request rather than scraping the
remaining thirty dates and then reporting "no offers on any date".

`flights.proto` is pinned against the encoder, because the `.proto` is
documentation and a half-applied re-vendor could fix one and leave the other
reading as authority for the numbering that caused the bug.

## Known gaps, not fixed here

- **`segments[].legroom` is `null` on a lie-flat seat, because Google publishes
  no measurement for one.** This was carried as a suspected parser gap — an
  index the fork had not found — and it is not one. See below.
- **`fare_brand` is a tier, not a product name.** `"Economy Flex"` on a
  business-class result is the *tier within* that cabin. Upstream's own comment
  admits the mapping is a best-effort read of undocumented numeric codes; this
  fork documents the trap in the tool description rather than inventing a
  cabin-aware label the payload does not support.
- **The date grid cannot be cheap.** One request per date is inherent to there
  being no forward grid in the payload. If Google exposes a calendar RPC, that
  would be the better source.

### Legroom: what the null means, established

The premium payload only became inspectable once bug 2 was fixed, so the gap was
recorded on the assumption that a premium-cabin legroom index existed and had not
been found. Dumping one settles it: there is no such index, and the field the
absence tracks is not the cabin.

A business offer for the SAME physical flight differs from its economy twin in
the seat classification, the two legroom strings, the cabin, and what it costs —
in nothing else that could name an amenity. Diffed whole, offer subtree against
offer subtree, UA916 AKL→SFO 2027-01-10 (the booking token and the page's own
opaque ids differ too, and are omitted):

| path | economy | business |
| --- | --- | --- |
| `[0][2][0][13]` | 1 | 5 |
| `[0][2][0][14]` | `"31 in"` | `null` |
| `[0][2][0][16]` | 1 | 3 |
| `[0][2][0][30]` | `"31 inches"` | `null` |
| `[1][0][1]` | 1108 | 4163 |

`leg[14]` is the same measurement short-form and goes absent with `leg[30]`. No
string matching `/\d+\s*(in|inches|cm)/`, and none saying "lie flat", "angled" or
"reclining", occurs anywhere in a premium document — not in the leg, not in the
offer, not in the page.

**And the cabin does not predict it**, which is what makes a cabin-keyed
workaround wrong rather than merely unnecessary. `leg[16]` IS the cabin — 1
economy, 2 premium economy, 3 business, 4 first, the same numbering the request
encodes. The predicate is `leg[13]`, how Google classified the SEAT. Over 372
legs from eight searches across two routes and four cabins:

| `leg[13]` | legs | cabins (`leg[16]`) | `leg[30]` |
| --- | --- | --- | --- |
| 1 | 26 | 1 | `"30 inches"`, `"31 inches"` |
| 2 | 6 | 1, 2 | `"29 inches"`, `"35 inches"` |
| 3 | 19 | 1, 2 | `"32 inches"`, `"33 inches"`, `"37 inches"` |
| 4 | 25 | 2, 3, 4 | `null` |
| 5 | 127 | 3, 4 | `null` |
| 6 | 68 | 3, 4 | `null` |
| 8 | 99 | 3, 4 | `null` |
| 9 | 2 | 3 | `null` |

A measurement is present on every one of the 51 legs at codes 1–3 and on none of
the 321 at 4 and above, and cabin values sit on both sides of that line.
Premium-economy legs on LAX→JFK report `"35 inches"` and `"37 inches"`; one
AKL→JFK business itinerary reports `"30 inches"` on its economy connection and
`null` on the premium legs either side of it, in the same offer, in the same
document. Code 7 does not occur in the capture, so "4 and above" is five observed
codes rather than a proven ceiling.

Codes 1–3 are BANDS: a code covers a range of measurements, and which range
depends on the cabin — in economy 2 is 29 in, 1 is 30–31 in and 3 is 32–33 in,
while in premium economy 2 is 35 in and 3 is 37 in. They are not named here,
because the payload does not name them. 4 and up are seat TYPES, the
classification Google uses for a recliner or a lie-flat, shipped without a
measurement.

So `null` is the document's answer and the whole of what it knows. `leg[13]` is
not translated into a label either: the codes above 3 have no text anywhere in
the payload to establish what they name, and `"lie flat seat"` invented from an
ordinal is the same failure as a baggage count invented from an absent flag. A
caller that needs the number for a premium seat needs the airline's seat map;
the tool description says so.

## Re-vendoring

There is no sync script and no drift test here, because the point of `fork/` is
that it **has** drifted. To pick up upstream changes, diff the new version of the
published package against this tree, apply what is relevant by hand, re-run
`npm test`, and update the version recorded above. The tests are the guard rail:
they fail if a re-vendor drops the delta. In particular, a re-vendor that
restores `Info.seat = 1` fails immediately and by name.
