import { InputError } from "../errors.js";
import {
  args,
  BILLING_NOTE,
  guard,
  ok,
  optionalEnum,
  optionalInt,
  optionalString,
  PAGING_PROPERTIES,
  pagingArgs,
  pagingResult,
  READ_ANNOTATIONS,
  rejectUnknown,
  type ToolContext,
  type ToolDefinition,
} from "./shared.js";

/** AeroAPI's own ceiling on the simplified query. */
const QUERY_MAX_BYTES = 1000;

/**
 * The structured arguments, each mapped to the `-key value` term it becomes.
 * `pattern` is what a value may contain: codes and `*`/`?` wildcards, nothing
 * that could close a term and open another one. A registration may hold a `-`
 * (`G-ABCD`) but may not START with one: `-identOrReg -origin` would read as a
 * second key, not as a value.
 */
const TERMS = {
  origin: { key: "-origin", pattern: /^[A-Za-z0-9]{2,5}$/ },
  destination: { key: "-destination", pattern: /^[A-Za-z0-9]{2,5}$/ },
  origin_or_destination: {
    key: "-originOrDestination",
    pattern: /^[A-Za-z0-9]{2,5}$/,
  },
  airline: { key: "-airline", pattern: /^[A-Za-z0-9]{2,3}$/ },
  idents: { key: "-idents", pattern: /^[A-Za-z0-9*?]{1,20}$/ },
  ident_or_registration: {
    key: "-identOrReg",
    pattern: /^[A-Za-z0-9*?][A-Za-z0-9*?-]{0,19}$/,
  },
  aircraft_type: { key: "-type", pattern: /^[A-Za-z0-9*?]{1,10}$/ },
} as const;

const NUMERIC_TERMS = {
  min_altitude: { key: "-aboveAltitude", max: 1000 },
  max_altitude: { key: "-belowAltitude", max: 1000 },
  min_groundspeed: { key: "-aboveGroundspeed", max: 2000 },
  max_groundspeed: { key: "-belowGroundspeed", max: 2000 },
} as const;

/** The min/max pairs that must not describe an empty range. */
const NUMERIC_RANGES = [
  ["min_altitude", "max_altitude"],
  ["min_groundspeed", "max_groundspeed"],
] as const;

const CATEGORIES = ["airline", "ga"] as const;

/** Decimal places a box corner keeps: 1e-6 degrees is about 11 cm. */
const COORD_DECIMALS = 6;

/**
 * A coordinate as plain decimal. `String(1e-7)` is `"1e-7"`, which AeroAPI's
 * query parser has no reason to read as a number.
 */
export function formatCoord(n: number): string {
  const text = n.toFixed(COORD_DECIMALS).replace(/\.?0+$/, "");
  return text === "-0" ? "0" : text;
}

const PROPERTIES = {
  origin: {
    type: "string",
    description: 'Departed from this airport (ICAO preferred: "KSFO").',
  },
  destination: {
    type: "string",
    description: 'Bound for this airport (ICAO preferred: "KJFK").',
  },
  origin_or_destination: {
    type: "string",
    description: "Departed from OR bound for this airport.",
  },
  airline: {
    type: "string",
    description:
      'Operated by this airline, ICAO code preferred ("UAL", "BAW").',
  },
  idents: {
    type: "string",
    description:
      'Flight ident, with `*` and `?` wildcards ("UAL1*"). Codeshares are not ' +
      "searched.",
  },
  ident_or_registration: {
    type: "string",
    description: 'An ident or a tail number ("N123HQ"), wildcards allowed.',
  },
  aircraft_type: {
    type: "string",
    description: 'ICAO aircraft type, wildcards allowed ("B77*", "A320").',
  },
  min_altitude: {
    type: "integer",
    description: "Above this altitude, in HUNDREDS of feet (350 = 35,000 ft).",
  },
  max_altitude: {
    type: "integer",
    description: "Below this altitude, in hundreds of feet.",
  },
  min_groundspeed: { type: "integer", description: "Faster than this, knots." },
  max_groundspeed: { type: "integer", description: "Slower than this, knots." },
  bounding_box: {
    type: "array",
    items: { type: "number" },
    minItems: 4,
    maxItems: 4,
    description:
      "Inside this box: [min_lat, min_lon, max_lat, max_lon] in degrees, " +
      "e.g. [40.5, -74.3, 41.0, -73.6]. Must not cross the antimeridian.",
  },
  category: {
    type: "string",
    enum: CATEGORIES,
    description:
      "`airline` for airline flights only, `ga` for general aviation.",
  },
  query: {
    type: "string",
    description:
      "Escape hatch: AeroAPI's raw simplified query, used INSTEAD of every " +
      "argument above — e.g. `-destination KJFK -airline UAL`. Keys: -prefix, " +
      "-type, -idents, -identOrReg, -airline, -destination, -origin, " +
      "-originOrDestination, -aboveAltitude, -belowAltitude, " +
      '-aboveGroundspeed, -belowGroundspeed, -latlong "MINLAT MINLON MAXLAT ' +
      'MAXLON", -filter {ga|airline}. At most 1000 bytes.',
  },
  ...PAGING_PROPERTIES,
};

/** Compose the simplified query out of the structured arguments. */
export function buildQuery(input: Record<string, unknown>): string[] {
  const terms: string[] = [];
  for (const [arg, { key, pattern }] of Object.entries(TERMS)) {
    const value = optionalString(input, arg);
    if (value === undefined) continue;
    if (!pattern.test(value)) {
      const allowed =
        arg === "ident_or_registration"
          ? "letters, digits, * ? wildcards and `-`, not as the first character"
          : arg === "idents" || arg === "aircraft_type"
            ? "letters, digits and * ? wildcards only"
            : "letters and digits only";
      throw new InputError(
        `\`${arg}\`="${value}" is not a valid ${arg.replace(/_/g, " ")} ` +
          `(${allowed}).`,
      );
    }
    terms.push(`${key} ${value.toUpperCase()}`);
  }
  const numbers: Record<string, number> = {};
  for (const [arg, { key, max }] of Object.entries(NUMERIC_TERMS)) {
    const value = optionalInt(input, arg, 0, max);
    if (value === undefined) continue;
    numbers[arg] = value;
    terms.push(`${key} ${value}`);
  }
  for (const [min, max] of NUMERIC_RANGES) {
    const lo = numbers[min];
    const hi = numbers[max];
    if (lo !== undefined && hi !== undefined && lo > hi) {
      throw new InputError(
        `\`${min}\`=${lo} is above \`${max}\`=${hi}, so no flight can match. ` +
          `Swap them, or drop one.`,
      );
    }
  }
  const box = input.bounding_box;
  if (box !== undefined && box !== null) {
    if (
      !Array.isArray(box) ||
      box.length !== 4 ||
      !box.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      throw new InputError(
        "`bounding_box` must be four numbers: [min_lat, min_lon, max_lat, max_lon].",
      );
    }
    const [minLat, minLon, maxLat, maxLon] = box as number[];
    const corners = [minLat!, minLon!, maxLat!, maxLon!].map(formatCoord);
    const [lo1, lo2, hi1, hi2] = corners.map(Number) as number[];
    if (
      Math.abs(minLat!) > 90 ||
      Math.abs(maxLat!) > 90 ||
      Math.abs(minLon!) > 180 ||
      Math.abs(maxLon!) > 180 ||
      lo1! >= hi1! ||
      lo2! >= hi2!
    ) {
      throw new InputError(
        "`bounding_box` must be [min_lat, min_lon, max_lat, max_lon] with each " +
          "min below its max, latitudes within ±90 and longitudes within ±180. " +
          "A box crossing the antimeridian (min_lon > max_lon) is not " +
          "supported: search each side of ±180 separately.",
      );
    }
    terms.push(`-latlong "${corners.join(" ")}"`);
  }
  const category = optionalEnum(input, "category", CATEGORIES);
  if (category !== undefined) terms.push(`-filter ${category}`);
  return terms;
}

/**
 * Airborne flights matching a filter. Structured arguments rather than a bare
 * query string, because the arguments can be validated before a billed query
 * is spent on them, and the raw syntax is easy to get subtly wrong (an
 * unrecognised key is not always an error). The raw form stays as an escape
 * hatch for the keys not modelled here.
 */
export function searchFlightsTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "search_flights",
    description:
      "Find flights IN THE AIR RIGHT NOW by origin, destination, airline, " +
      "ident, aircraft type, altitude, speed or a lat/lon box. Scheduled and " +
      "landed flights are not searched: for a known flight number use " +
      "get_flight, for an airport's board use get_airport_flights.\n\n" +
      "Combine arguments to narrow (they AND together). At least one is " +
      "required. `query` takes AeroAPI's raw syntax instead, for the rare " +
      "filter not modelled here.\n\n" +
      `${BILLING_NOTE} A broad search (one airline, a big box) fills pages ` +
      "fast; narrow first, then follow `next_cursor` only if you need more.\n\n" +
      'Example: {"flights":[{"ident":"UAL1549","fa_flight_id":"UAL1549-' +
      '1760000000-airline-0099","origin":{"code":"KSFO",…},"destination":' +
      '{"code":"KJFK",…},"aircraft_type":"B39M","last_position":{"altitude":' +
      '370,"groundspeed":482,"heading":78,"latitude":41.2,"longitude":-98.4,' +
      '"timestamp":"2026-10-09T18:22:10Z"},"waypoint_count":212}],' +
      '"returned":1,"query_sent":"-origin KSFO -destination KJFK",' +
      '"pages_billed":1,"next_cursor":"…"}\n\n' +
      "Altitude is in hundreds of feet, speed in knots. Planned waypoints are " +
      "reduced to a count; get_flight_track has the flown path.",
    inputSchema: {
      type: "object",
      properties: PROPERTIES,
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS },
    handler: (raw) =>
      guard(ctx, async () => {
        const input = args(raw);
        rejectUnknown(input, PROPERTIES);
        const rawQuery = optionalString(input, "query");
        const terms = buildQuery(input);
        if (rawQuery !== undefined && terms.length > 0) {
          throw new InputError(
            "Pass EITHER `query` OR the structured arguments, not both — a raw " +
              "query is sent as-is and the other arguments would be ignored.",
          );
        }
        const query = rawQuery ?? terms.join(" ");
        if (query === "") {
          throw new InputError(
            "Give at least one filter (e.g. `destination`, `airline`, " +
              "`bounding_box`). An unfiltered search returns every airborne " +
              "flight, one billed page at a time.",
          );
        }
        if (Buffer.byteLength(query, "utf8") > QUERY_MAX_BYTES) {
          throw new InputError(
            `\`query\` is longer than AeroAPI's ${QUERY_MAX_BYTES}-byte limit.`,
          );
        }
        const body = await ctx
          .client()
          .get<Record<string, unknown>>("/flights/search", {
            query,
            ...pagingArgs(input),
          });
        const flights = Array.isArray(body?.flights) ? body.flights : [];
        return ok(ctx, {
          flights,
          returned: flights.length,
          query_sent: query,
          ...pagingResult(body ?? {}),
        });
      }),
  };
}
