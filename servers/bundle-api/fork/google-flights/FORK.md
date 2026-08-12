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

That costs one rate-limited request per date, which is why the window is small by
default (7 days, ~10s) and capped (31 days, ~47s), why the cost is stated in the
tool description, and why the requests are issued in sequence rather than in
parallel — this is scraping someone else's page, and a burst is both rude and the
fastest way to get the tool blocked outright.

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

**`isBasicEconomy` moved with it, and that is not a behaviour change.** It tested
`checked_bags_included === 0`, which — given the swap — was already reading the
carry-on count. It now says what it was doing: lowest fare tier **and** no free
carry-on, which is what "basic economy" names on the US carriers the filter
exists for. Correcting the field names *without* correcting this predicate is
what would have changed behaviour, and badly: on SFO→LAX every fare has zero free
checked bags, so the filter would have gone from excluding 9 offers to excluding
all 27 tier-1 ones. Verified identical on three routes — SFO→LAX 9 of 171 before
and after, LAX→JFK 1 of 116, AKL→SFO 0 of 112.

An unknown carry-on is not basic economy: this filter is **on by default**, and a
silent default must not drop flights.

## The delta

| File | Change |
| --- | --- |
| `src/flights-client/flights-client.ts` | `Info.seat` 1→9, `Info.passengers` 6→8, `FlightData.maxStops` 9→5. `parseExtensions` reads `[checked, carry_on]` and maps absent→`null`. `isBasicEconomy` tests the carry-on. `getDateGrid` rewritten to price each date; new exported `gridDates` window. |
| `src/flights-client/types.ts` | Baggage fields become nullable. `GetDateGridOptions` gains `window_days` and `return_date`; `DateGridResult` gains `window` and `unavailable_dates`. |
| `src/flights.proto` | The two field numbers, matched to the code. |
| `src/tools/get-date-grid.ts` | `window_days` and `return_date` params; description states the per-date cost and the no-past-dates guarantee; `round_trip` now requires a return date instead of quietly pricing a one-way. |
| `src/tools/search-flights.ts` | Description: `fare_brand` is a tier *within* the cabin and does not name the cabin; a `null` baggage value means unknown, not zero. |
| `test/fork.test.mjs` | **New.** Sixteen tests over all three. |

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

## Known gaps, not fixed here

- **`segments[].legroom` is `null` on premium cabins.** It reads `leg[30]`, which
  is populated on economy offers (`"31 inches"`) and absent on the business
  offers this fork can now retrieve. The economy path is unaffected. Finding the
  premium-cabin index is a separate exercise against a payload that only became
  reachable once bug 2 was fixed.
- **`fare_brand` is a tier, not a product name.** `"Economy Flex"` on a
  business-class result is the *tier within* that cabin. Upstream's own comment
  admits the mapping is a best-effort read of undocumented numeric codes; this
  fork documents the trap in the tool description rather than inventing a
  cabin-aware label the payload does not support.
- **The date grid cannot be cheap.** One request per date is inherent to there
  being no forward grid in the payload. If Google exposes a calendar RPC, that
  would be the better source.

## Re-vendoring

There is no sync script and no drift test here, because the point of `fork/` is
that it **has** drifted. To pick up upstream changes, diff the new version of the
published package against this tree, apply what is relevant by hand, re-run
`npm test`, and update the version recorded above. The tests are the guard rail:
they fail if a re-vendor drops the delta. In particular, a re-vendor that
restores `Info.seat = 1` fails immediately and by name.
