// The strad fork delta for google-flights: three defects that all shipped a
// confident, well-formed, wrong answer.
//
// None of them errored. A business-class request returned economy fares, a
// baggage field said "no carry-on" for every airline on earth, and a date grid
// anchored on next January returned last June. So what these tests pin is not
// "does it throw" but "does the value mean what the field name says".
//
// The payload fixtures below are transcribed from real Google Flights responses
// captured on 2026-08-12; the provenance of each is recorded at its definition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import protobuf from 'protobufjs';

import {
  buildTfsParam,
  parseFlightOffers,
  isBasicEconomy,
  gridDates,
  MAX_GRID_DAYS,
} from '../build/flights-client/flights-client.js';

// =============================================================================
// Bug 2 — cabin class and passenger counts reached Google as unknown fields
// =============================================================================
//
// `tfs` is protobuf in a URL. Google parses it against the real schema, so a
// field numbered differently here is not rejected — proto3 skips unknown fields
// and uses the default. Upstream numbered `seat` 1 and `passengers` 6; the
// schema has them at 9 and 8. Every request was therefore economy, one adult.
//
// Asserting on the ENCODED BYTES is the point: a test that only checked
// `buildTfsParam` round-trips through its own schema would have passed happily
// on the broken numbering, because the bug was never an inconsistency on this
// side — it was a disagreement with a schema that lives at Google.

/** Top-level field numbers present in a `tfs` blob, with their varint values. */
function decodeTopLevelVarints(tfs) {
  const buf = Buffer.from(tfs.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const reader = protobuf.Reader.create(buf);
  const found = [];
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) found.push({ field, value: reader.uint32() });
    else if (wireType === 2) reader.skip(reader.uint32());
    else reader.skipType(wireType);
  }
  return found;
}

const BASE = {
  origin: 'AKL',
  destination: 'SFO',
  departureDate: '2027-01-10',
  tripType: 'one_way',
  seatClass: 'economy',
  adults: 1,
  children: 0,
  infantsInSeat: 0,
  infantsOnLap: 0,
};

test('seat class is encoded at field 9, the number Google reads', async () => {
  const business = decodeTopLevelVarints(await buildTfsParam({ ...BASE, seatClass: 'business' }));
  assert.deepEqual(
    business.find((f) => f.field === 9),
    { field: 9, value: 3 },
    'BUSINESS (3) must be at field 9'
  );
  // The old home of the value. Anything here is invisible to Google.
  assert.equal(business.find((f) => f.field === 1), undefined, 'nothing may sit at field 1');
});

test('every cabin maps to its own enum value', async () => {
  const seatOf = async (seatClass) =>
    decodeTopLevelVarints(await buildTfsParam({ ...BASE, seatClass })).find((f) => f.field === 9)
      ?.value;
  assert.equal(await seatOf('economy'), 1);
  assert.equal(await seatOf('premium_economy'), 2);
  assert.equal(await seatOf('business'), 3);
  assert.equal(await seatOf('first'), 4);
});

test('a business request does not encode the same bytes as an economy one', async () => {
  // The reported symptom, reduced to its cause: byte-identical requests cannot
  // produce different results, and upstream emitted byte-identical requests.
  const economy = await buildTfsParam({ ...BASE, seatClass: 'economy' });
  const business = await buildTfsParam({ ...BASE, seatClass: 'business' });
  assert.notEqual(economy, business);
});

test('passenger counts are encoded at field 8, one entry per traveller', async () => {
  const tfs = await buildTfsParam({
    ...BASE,
    adults: 2,
    children: 1,
    infantsInSeat: 0,
    infantsOnLap: 1,
  });
  const passengers = decodeTopLevelVarints(tfs)
    .filter((f) => f.field === 8)
    .map((f) => f.value);
  // ADULT=1 x2, CHILD=2 x1, INFANT_ON_LAP=4 x1
  assert.deepEqual(passengers, [1, 1, 2, 4]);
  assert.equal(decodeTopLevelVarints(tfs).find((f) => f.field === 6), undefined);
});

test('four adults do not encode as one', async () => {
  const one = await buildTfsParam({ ...BASE, adults: 1 });
  const four = await buildTfsParam({ ...BASE, adults: 4 });
  assert.notEqual(one, four);
});

// =============================================================================
// Bug 3 — the two baggage entries were read in the wrong order
// =============================================================================
//
// `offer[4][6]` is [checked_bag_count, carry_on_count]. Upstream read it as
// [carry_on_flag, checked_bag_flag] and additionally mapped a missing entry to
// "not included" instead of "not stated".
//
// The four fixtures below are the four distinct flag values observed on
// LAX->JFK 2026-09-15, paired with the text Google rendered for those same
// offers. That pairing is what establishes the order, so it is what the test
// asserts against.

/** A raw offer in Google's shape, carrying just the fields the parser reads. */
function rawOffer({ price, airline, flags, fareTier, token }) {
  const details = [];
  details[0] = 'XX';
  details[1] = [airline];
  details[2] = [];           // legs
  details[4] = [2026, 9, 15];
  details[5] = [10, 0];
  details[7] = [2026, 9, 15];
  details[8] = [18, 30];
  details[9] = 330;
  details[22] = [null, null, fareTier];
  const raw = [];
  raw[0] = details;
  raw[1] = [[null, price], token];
  raw[4] = [null, null, null, null, null, null, flags];
  raw[5] = [0];
  return raw;
}

/** ds1 with the offers in the "other flights" section. */
const ds1With = (offers) => {
  const ds1 = [];
  ds1[3] = [offers];
  return ds1;
};

const bags = (offer) => offer.extensions;

test('baggage flags map [checked, carry_on] — the four real LAX->JFK combinations', () => {
  // flags            Google's own text for these offers
  // [0,1] x106       "1 carry-on bag included. 0 checked bags included."
  // [1,1] x8         "1 carry-on bag included. 1 checked bag included."
  // [2,1] x1         "1 carry-on bag included. 2 checked bags included."
  // [0,0] x1         "0 carry-on bags included. 0 checked bags included."
  const offers = parseFlightOffers(
    ds1With([
      rawOffer({ price: 300, airline: 'Delta', flags: [0, 1], fareTier: 3, token: 'a' }),
      rawOffer({ price: 400, airline: 'JetBlue', flags: [1, 1], fareTier: 3, token: 'b' }),
      rawOffer({ price: 500, airline: 'JetBlue', flags: [2, 1], fareTier: 3, token: 'c' }),
      rawOffer({ price: 200, airline: 'Spirit', flags: [0, 0], fareTier: 1, token: 'd' }),
    ]),
    'USD'
  );

  assert.deepEqual(bags(offers[0]), { carry_on_included: true, checked_bags_included: 0 });
  assert.deepEqual(bags(offers[1]), { carry_on_included: true, checked_bags_included: 1 });
  assert.deepEqual(bags(offers[2]), { carry_on_included: true, checked_bags_included: 2 });
  assert.deepEqual(bags(offers[3]), { carry_on_included: false, checked_bags_included: 0 });
});

test('the reported symptom is gone: [null,1] is not "no carry-on, 1 checked bag"', () => {
  // Every AKL->SFO offer carried [null, 1] — 111 of them, across China Airlines,
  // Air New Zealand, Qantas and United alike. Upstream turned that into
  // "carry-on: not included, checked: 1 included" for all of them: wrong in both
  // halves, and implausible on its face, which is how it got noticed.
  const [offer] = parseFlightOffers(
    ds1With([
      rawOffer({ price: 1183, airline: 'Air New Zealand', flags: [null, 1], fareTier: 3, token: 'e' }),
    ]),
    'USD'
  );
  assert.deepEqual(bags(offer), { carry_on_included: true, checked_bags_included: null });
});

test('an absent flag array is unknown, not "nothing included"', () => {
  const [offer] = parseFlightOffers(
    ds1With([rawOffer({ price: 900, airline: 'Qantas', flags: undefined, fareTier: 3, token: 'f' })]),
    'USD'
  );
  assert.deepEqual(bags(offer), { carry_on_included: null, checked_bags_included: null });
});

test('basic economy is the lowest tier with no free carry-on', () => {
  const offers = parseFlightOffers(
    ds1With([
      rawOffer({ price: 200, airline: 'United', flags: [0, 0], fareTier: 1, token: 'g' }),
      rawOffer({ price: 260, airline: 'United', flags: [0, 1], fareTier: 1, token: 'h' }),
      rawOffer({ price: 320, airline: 'Delta', flags: [0, 0], fareTier: 3, token: 'i' }),
      rawOffer({ price: 1183, airline: 'Air NZ', flags: [null, 1], fareTier: 1, token: 'j' }),
    ]),
    'USD'
  );
  assert.equal(isBasicEconomy(offers[0]), true, 'tier 1 + no carry-on');
  assert.equal(isBasicEconomy(offers[1]), false, 'tier 1 but carry-on included');
  assert.equal(isBasicEconomy(offers[2]), false, 'no carry-on but not the lowest tier');
  // The default filter is ON. An unknown carry-on must not silently drop a
  // flight — which is every international fare Google says nothing about.
  assert.equal(isBasicEconomy(offers[3]), false, 'unknown carry-on is not basic economy');
});

// =============================================================================
// Bug 1 — the grid returned a trailing price history, not future departures
// =============================================================================
//
// Upstream read `ds1[5][10][0]`, which is the last 61 days of observed prices
// for the itinerary. Its dates do not depend on the anchor: asked on
// 2026-08-12 for a grid around 2027-01-10, it returned 2026-06-12..2026-08-11,
// and three different anchors produced the same 61 dates. `gridDates` is the
// replacement's window, kept pure so the dates can be asserted directly.

const TODAY = '2026-08-12';

test('the window is centred on the anchor', () => {
  assert.deepEqual(gridDates('2027-01-10', 7, TODAY), [
    '2027-01-07',
    '2027-01-08',
    '2027-01-09',
    '2027-01-10',
    '2027-01-11',
    '2027-01-12',
    '2027-01-13',
  ]);
});

test('the anchor is honoured — the regression, stated as dates', () => {
  // The exact query that failed, and the shape of the old answer.
  const dates = gridDates('2027-01-10', 7, TODAY);
  assert.ok(dates.includes('2027-01-10'), 'the requested date must be in its own grid');
  assert.ok(
    dates.every((d) => d.startsWith('2027-01')),
    `a January 2027 anchor must not return ${dates[0]}`
  );
});

test('no date in a grid is ever in the past', () => {
  for (const anchor of ['2026-06-12', '2020-01-01', TODAY]) {
    const dates = gridDates(anchor, 9, TODAY);
    assert.ok(dates.every((d) => d >= TODAY), `${anchor} produced ${dates[0]}`);
  }
});

test('an anchor near today is shifted forward, not truncated', () => {
  const dates = gridDates(TODAY, 7, TODAY);
  assert.equal(dates.length, 7, 'the caller still gets the window they asked for');
  assert.equal(dates[0], TODAY);
  assert.equal(dates[6], '2026-08-18');
});

test('the window is capped, because every day is a live request', () => {
  assert.equal(gridDates('2027-01-10', 365, TODAY).length, MAX_GRID_DAYS);
  assert.equal(gridDates('2027-01-10', 0, TODAY).length, 1);
});

test('windows are contiguous and ordered', () => {
  const dates = gridDates('2027-03-01', 31, TODAY);
  assert.equal(dates.length, 31);
  for (let i = 1; i < dates.length; i++) {
    const gap = Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`);
    assert.equal(gap, 86_400_000, `${dates[i - 1]} -> ${dates[i]}`);
  }
});

test('the window crosses a month and a year boundary correctly', () => {
  const dates = gridDates('2026-12-31', 5, TODAY);
  assert.deepEqual(dates, ['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
});
