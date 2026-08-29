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
function rawOffer({ price, airline, flags, fareTier, token, legs = [] }) {
  const details = [];
  details[0] = 'XX';
  details[1] = [airline];
  details[2] = legs;
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
      rawOffer({ price: 1183, airline: 'Air NZ', flags: [0, null], fareTier: 1, token: 'j' }),
      rawOffer({ price: 1190, airline: 'Qantas', flags: undefined, fareTier: 1, token: 'k' }),
    ]),
    'USD'
  );
  assert.equal(isBasicEconomy(offers[0]), true, 'tier 1 + no carry-on');
  assert.equal(isBasicEconomy(offers[1]), false, 'tier 1 but carry-on included');
  assert.equal(isBasicEconomy(offers[2]), false, 'no carry-on but not the lowest tier');

  // The two cases where the predicate deliberately differs from the old one.
  // The old `flags[1] || 0` collapsed an ABSENT carry-on to 0 and dropped the
  // fare; the filter is on by default, so that silently lost flights on data
  // Google never stated. These must be `false` for a reason no other assertion
  // here covers — note carry_on is null, not 1, so a passing result cannot come
  // from "the carry-on is included".
  assert.equal(offers[3].extensions.carry_on_included, null, 'fixture must be UNKNOWN, not included');
  assert.equal(isBasicEconomy(offers[3]), false, 'unknown carry-on is not basic economy');
  assert.equal(offers[4].extensions.carry_on_included, null, 'fixture must be UNKNOWN, not included');
  assert.equal(isBasicEconomy(offers[4]), false, 'absent baggage array is not basic economy');
});

// =============================================================================
// Legroom — a `null` that is the payload's answer, not the parser's failure
// =============================================================================
//
// "Business-class segments always report null" reads like a parser that knows
// the economy index and misses a premium one. There is no premium one. Diffed
// whole — offer subtree against offer subtree, UA916 AKL->SFO 2027-01-10 sold
// as economy vs as business — the only differences are `leg[13]`, `leg[14]`,
// `leg[16]`, `leg[30]` and the price/booking token, and no string matching
// /\d+\s*(in|inches|cm)/ occurs anywhere in a premium document.
//
// The predicate is `leg[13]`, Google's classification of the SEAT, and NOT
// `leg[16]`, the cabin. Over 372 legs from eight searches across two routes and
// four cabins, legroom is present exactly when `leg[13] <= 3` (a legroom band)
// and absent exactly when it is 4 or more (a seat type — recliner, angled flat,
// lie flat), with cabin values appearing on both sides of that line.
//
// The fixtures below are transcribed from those captures. They exist to fail a
// "fix" keyed on the cabin, which would report premium economy and mixed-cabin
// connections wrongly, and to fail one that translates a `leg[13]` code into a
// seat-type label the payload carries no text to establish.

/** A leg in Google's shape, carrying just the fields `parseSegment` reads. */
function rawLeg({ code, number, airline, seatCode, cabin, legroom, legroomShort }) {
  const leg = [];
  leg[3] = 'AKL';
  leg[4] = 'Auckland Airport';
  leg[5] = 'San Francisco International Airport';
  leg[6] = 'SFO';
  leg[8] = [15, 50];
  leg[10] = [7, 5];
  leg[11] = 735;
  leg[13] = seatCode;
  leg[14] = legroomShort ?? null;
  leg[16] = cabin;
  leg[17] = 'Boeing 777';
  leg[20] = [2027, 1, 10];
  leg[21] = [2027, 1, 10];
  leg[22] = [code, number, null, airline];
  leg[30] = legroom ?? null;
  return leg;
}

const legroomOf = (offer) => offer.segments.map((s) => s.legroom);

const offerWithLegs = (legs, token) =>
  parseFlightOffers(
    ds1With([
      rawOffer({ price: 4163, airline: 'United', flags: [null, 1], fareTier: 3, token, legs }),
    ]),
    'USD'
  )[0];

test('legroom is the long form at leg[30], with the short form at leg[14] as fallback', () => {
  // Both indices carry the same measurement — "31 inches" and "31 in" — and on
  // every captured leg they are present or absent together. The fallback covers
  // a shape difference, so it must prefer the long form and still read a leg
  // that only carries the short one.
  const offer = offerWithLegs(
    [
      rawLeg({ code: 'UA', number: '916', airline: 'United', seatCode: 1, cabin: 1, legroom: '31 inches', legroomShort: '31 in' }),
      rawLeg({ code: 'NZ', number: '8', airline: 'Air New Zealand', seatCode: 1, cabin: 1, legroomShort: '31 in' }),
    ],
    'l1'
  );
  assert.deepEqual(legroomOf(offer), ['31 inches', '31 in']);
});

test('a premium seat states no legroom, and none is invented', () => {
  // AKL->SFO 2027-01-10, the reproduction on the issue: business reported `n/a`
  // where economy reported "31 inches". This is the honest half of that — the
  // measurement is absent from the document, so the field is null.
  const offer = offerWithLegs(
    [rawLeg({ code: 'UA', number: '916', airline: 'United', seatCode: 5, cabin: 3 })],
    'l2'
  );
  assert.deepEqual(legroomOf(offer), [null]);
});

test('legroom is not derived from the cabin — premium economy carries a figure', () => {
  // LAX->JFK 2026-11-15 premium economy: `leg[16]` is 2 on all three, and the
  // two with a legroom BAND (`leg[13]` 2 and 3) carry a measurement while the
  // one with a seat TYPE (4) does not. A fix keyed on "premium cabin -> null"
  // would erase the first two; one keyed on "premium cabin -> some other index"
  // would invent a value for the third.
  const offer = offerWithLegs(
    [
      rawLeg({ code: 'B6', number: '224', airline: 'JetBlue', seatCode: 3, cabin: 2, legroom: '37 inches', legroomShort: '37 in' }),
      rawLeg({ code: 'B6', number: '624', airline: 'JetBlue', seatCode: 2, cabin: 2, legroom: '35 inches', legroomShort: '35 in' }),
      rawLeg({ code: 'NZ', number: '8', airline: 'Air New Zealand', seatCode: 4, cabin: 2 }),
    ],
    'l3'
  );
  assert.deepEqual(legroomOf(offer), ['37 inches', '35 inches', null]);
});

test('one itinerary reports per leg: the economy connection has legroom, the business legs do not', () => {
  // AKL->JFK 2027-01-10 in business, Air Canada: AC40 (business, seat type 5),
  // AC8650 (an economy connection, band 1, "30 inches"), AS18 (cabin 4, seat
  // type 8). Same offer, same document — so this cannot be explained by "the
  // premium document omits the field", and it is why the read stays per leg.
  const offer = offerWithLegs(
    [
      rawLeg({ code: 'AC', number: '40', airline: 'Air Canada', seatCode: 5, cabin: 3 }),
      rawLeg({ code: 'AC', number: '8650', airline: 'Air Canada', seatCode: 1, cabin: 1, legroom: '30 inches', legroomShort: '30 in' }),
      rawLeg({ code: 'AS', number: '18', airline: 'Alaska', seatCode: 8, cabin: 4 }),
    ],
    'l4'
  );
  assert.deepEqual(legroomOf(offer), [null, '30 inches', null]);
});

test('the seat classification is not published as a legroom label', () => {
  // `leg[13]` 4 and up name seat TYPES, and the payload carries no text — in the
  // leg, the offer or the page — establishing what any of them names. Turning a
  // 5 into "lie flat seat" is the class of guess this fork exists to refuse, so
  // no field of a segment may carry the code or a label read off it.
  const offer = offerWithLegs(
    [rawLeg({ code: 'UA', number: '916', airline: 'United', seatCode: 5, cabin: 3 })],
    'l5'
  );
  const values = Object.values(offer.segments[0]).map((v) => JSON.stringify(v));
  assert.ok(!values.includes('5'), 'the seat classification code is not reported as a value');
  assert.ok(
    !values.some((v) => /flat|reclin|suite|pod/i.test(v)),
    'no seat-type label is invented from the code'
  );
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

// =============================================================================
// The tool-layer delta, and the fan-out itself
// =============================================================================
//
// The tests above cover flights-client.ts. Nothing there would notice a
// re-vendor that pasted upstream's src/tools/get-date-grid.ts back — which would
// silently drop window_days, return_date and the round-trip guard while leaving
// all sixteen green. These cover that file, and the loop that calls it.

import { GetDateGridSchema } from '../build/tools/get-date-grid.js';
import { getDateGrid } from '../build/flights-client/flights-client.js';

test('the grid schema defaults, caps, and rejects a round trip with no return leg', () => {
  const base = { origin: 'AKL', destination: 'SFO' };

  const d = GetDateGridSchema.parse(base);
  assert.equal(d.window_days, 7, 'default window');
  assert.equal(d.trip_type, 'one_way');
  assert.equal(d.seat_class, 'economy');

  assert.throws(() => GetDateGridSchema.parse({ ...base, window_days: 40 }), /window_days|31/i);
  assert.throws(
    () => GetDateGridSchema.parse({ ...base, trip_type: 'round_trip' }),
    /return_date is required/
  );
  // …and accepts it once the return leg is there.
  assert.equal(
    GetDateGridSchema.parse({ ...base, trip_type: 'round_trip', return_date: '2027-01-20' })
      .return_date,
    '2027-01-20'
  );
});

/** A Google-shaped page carrying one offer at `price`. */
function pageWith(price) {
  const ds1 = [];
  ds1[3] = [[rawOffer({ price, airline: 'Air NZ', flags: [0, 1], fareTier: 3, token: `t${price}` })]];
  return `<html><script>AF_initDataCallback({key: 'ds:1', hash: '1', data:${JSON.stringify(ds1)}, sideChannel: {}});</script></html>`;
}

/** Swap global fetch for the duration of one call, recording the URLs asked for. */
async function withFetch(handler, run) {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return handler(String(url), urls.length);
  };
  try {
    return { result: await run(), urls };
  } finally {
    globalThis.fetch = real;
  }
}

const ok = (body) => ({ ok: true, status: 200, text: async () => body });

const GRID_OPTS = {
  origin: 'AKL',
  destination: 'SFO',
  departure_date: '2027-01-10',
  trip_type: 'one_way',
  seat_class: 'economy',
  adults: 1,
  currency: 'USD',
  window_days: 3,
};

test('the fan-out prices every date in the window, and reports the window it covered', async () => {
  const prices = { 1: 900, 2: 700, 3: 800 };
  const { result, urls } = await withFetch(
    (_url, n) => ok(pageWith(prices[n])),
    () => getDateGrid(GRID_OPTS)
  );

  assert.equal(urls.length, 3, 'one request per date — this is what makes the grid real');
  assert.equal(new Set(urls).size, 3, 'each date must be its OWN query, not the same one thrice');
  assert.deepEqual(
    result.date_grid.map((e) => e.date),
    ['2027-01-09', '2027-01-10', '2027-01-11']
  );
  assert.deepEqual(result.cheapest, { date: '2027-01-10', price: 700 });
  assert.equal(result.window.anchor_date, '2027-01-10');
  assert.deepEqual(result.failed_dates, []);
  assert.deepEqual(result.unavailable_dates, []);
});

test('one failed date does not lose the dates that priced', async () => {
  const { result } = await withFetch(
    (_url, n) => (n === 2 ? Promise.reject(new Error('socket hang up')) : ok(pageWith(600))),
    () => getDateGrid(GRID_OPTS)
  );

  assert.equal(result.date_grid.length, 2, 'a partial grid is useful');
  assert.equal(result.failed_dates.length, 1);
  assert.equal(result.failed_dates[0].date, '2027-01-10');
  assert.match(result.failed_dates[0].error, /socket hang up/);
  // The distinction the old code could not make: this date is not "no flights".
  assert.ok(!result.unavailable_dates.includes('2027-01-10'));
});

test('a date with no offers is unavailable, not failed', async () => {
  const empty = `<html><script>AF_initDataCallback({key: 'ds:1', hash: '1', data:[], sideChannel: {}});</script></html>`;
  const { result } = await withFetch(
    (_url, n) => ok(n === 2 ? empty : pageWith(500)),
    () => getDateGrid(GRID_OPTS)
  );
  assert.deepEqual(result.unavailable_dates, ['2027-01-10']);
  assert.deepEqual(result.failed_dates, []);
});

test('a block stops the run and is raised, not reported as "no flights anywhere"', async () => {
  // The failure this guard exists for: Google blocks on the first date, and the
  // old shape would have kept scraping and then answered "no offers on any date
  // in the window" — about the route, which is not what happened.
  const { urls } = await withFetch(
    () => ok('<html>Our systems have detected unusual traffic</html>'),
    () =>
      assert.rejects(() => getDateGrid({ ...GRID_OPTS, window_days: 31 }), /rate-limiting/).then(
        () => null
      )
  );
  assert.equal(urls.length, 1, 'a block must not be retried across the remaining 30 dates');
});

test('a round-trip grid never prices a departure at or after its fixed return', () => {
  const dates = gridDates('2027-01-10', 7, TODAY, '2027-01-12');
  assert.deepEqual(dates, ['2027-01-07', '2027-01-08', '2027-01-09', '2027-01-10', '2027-01-11']);
  assert.ok(dates.every((d) => d < '2027-01-12'));
});

test('a date that passes the regex but is not a real day is rejected, not rolled over', () => {
  // 2026-02-30 parses — V8 rolls it to 2026-03-02, which is in the past, so the
  // clamp would then move it to today and label next week's prices with the
  // caller's date.
  assert.throws(() => gridDates('2026-02-30', 7, TODAY), /not a real calendar date/);
  assert.throws(() => gridDates('2027-13-01', 7, TODAY), /not a real calendar date/);
  assert.doesNotThrow(() => gridDates('2028-02-29', 7, TODAY), 'a real leap day is fine');
});

test('flights.proto records the same field numbers the encoder uses', async () => {
  // The .proto is documentation — getProtoRoot() builds the schema in code — so
  // a re-vendor can fix one and miss the other, and the file would then read as
  // authority for the numbers that caused the bug.
  const { readFile } = await import('node:fs/promises');
  const proto = await readFile(new URL('../src/flights.proto', import.meta.url), 'utf8');
  assert.match(proto, /Seat seat = 9;/);
  assert.match(proto, /repeated Passenger passengers = 8;/);
  assert.match(proto, /optional int32 max_stops = 5;/);
  assert.doesNotMatch(proto, /Seat seat = 1;/, 'the numbering that made every search economy');
});

test('a return date before the whole window is refused, not silently emptied', async () => {
  // Every candidate departure is at or after the fixed return, so there is no
  // trip to price. Erroring names the contradiction; an empty grid would read as
  // "this route has no flights".
  await assert.rejects(
    () =>
      getDateGrid({
        origin: 'AKL',
        destination: 'SFO',
        departure_date: '2027-01-10',
        return_date: '2027-01-01',
        trip_type: 'round_trip',
        seat_class: 'economy',
        adults: 1,
        currency: 'USD',
        window_days: 5,
      }),
    /falls before return_date/
  );
});
