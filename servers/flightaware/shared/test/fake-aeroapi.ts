/**
 * A fake AeroAPI v4 behind an injected `fetch`. It records every request — the
 * URL, the method, the headers — so a test can assert what this server SENDS,
 * and answers from a route table so a test can choose what it RECEIVES.
 *
 * Shapes follow the AeroAPI v4 OpenAPI document; nothing here has been checked
 * against the live service.
 */

export const KEY = "Zq8xVb3NfK2mWp7RtY4uHs9LcD6eGa1J"; // 32 chars, AeroAPI-shaped

export interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
}

export type Route = (url: URL) => {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export const FLIGHT = {
  ident: "UAL4",
  ident_icao: "UAL4",
  ident_iata: "UA4",
  fa_flight_id: "UAL4-1760000000-airline-0123",
  operator: "UAL",
  flight_number: "4",
  registration: "N2639U",
  atc_ident: null,
  origin: {
    code: "KIAH",
    code_icao: "KIAH",
    code_iata: "IAH",
    code_lid: "IAH",
    timezone: "America/Chicago",
    name: "Houston Bush Int'ctl",
    city: "Houston",
    airport_info_url: "/airports/KIAH",
  },
  destination: {
    code: "EGLL",
    code_icao: "EGLL",
    code_iata: "LHR",
    code_lid: null,
    timezone: "Europe/London",
    name: "London Heathrow",
    city: "London",
    airport_info_url: "/airports/EGLL",
  },
  status: "En Route / On Time",
  departure_delay: 420,
  arrival_delay: null,
  progress_percent: 38,
  aircraft_type: "B789",
  scheduled_out: "2026-10-09T22:00:00Z",
  actual_out: "2026-10-09T22:07:00Z",
  foresight_predictions_available: false,
};

export const POSITION = {
  fa_flight_id: FLIGHT.fa_flight_id,
  altitude: 370,
  altitude_change: "-",
  groundspeed: 512,
  heading: 61,
  latitude: 52.31,
  longitude: -31.07,
  timestamp: "2026-10-10T03:41:00Z",
  update_type: "A",
};

export function trackPoints(n: number) {
  return Array.from({ length: n }, (_, i) => ({ ...POSITION, altitude: i }));
}

/** The default route table: one happy answer per endpoint the tools use. */
export function defaultRoutes(): Record<string, Route> {
  return {
    "/aeroapi/flights/search": () => ({
      status: 200,
      body: {
        links: { next: "/flights/search?query=-destination+KJFK&cursor=CUR2" },
        num_pages: 1,
        flights: [
          {
            ...FLIGHT,
            waypoints: [29.9, -95.3, 30.1, -94.9, 30.4, -94.2],
            last_position: POSITION,
          },
        ],
      },
    }),
    [`/aeroapi/flights/${FLIGHT.fa_flight_id}/position`]: () => ({
      status: 200,
      body: { ...FLIGHT, last_position: POSITION, waypoints: [1, 2, 3, 4] },
    }),
    [`/aeroapi/flights/${FLIGHT.fa_flight_id}/track`]: () => ({
      status: 200,
      body: { actual_distance: 2154, positions: trackPoints(1312) },
    }),
    "/aeroapi/flights/UAL4": () => ({
      status: 200,
      body: { links: null, num_pages: 1, flights: [FLIGHT] },
    }),
    "/aeroapi/airports/KJFK": () => ({
      status: 200,
      body: {
        airport_code: "KJFK",
        code_icao: "KJFK",
        code_iata: "JFK",
        name: "John F Kennedy Intl",
        timezone: "America/New_York",
        airport_flights_url: "/airports/KJFK/flights",
        state: null,
      },
    }),
    "/aeroapi/airports/KSFO/delays": () => ({
      status: 200,
      body: {
        airport: "KSFO",
        category: "weather",
        color: "red",
        delay_secs: 5400,
        reasons: [
          {
            category: "weather",
            color: "red",
            delay_secs: 5400,
            reason: "Ground delay program: low ceilings",
          },
        ],
      },
    }),
    "/aeroapi/airports/KJFK/flights/scheduled_arrivals": () => ({
      status: 200,
      body: {
        links: {
          next: "/airports/KJFK/flights/scheduled_arrivals?cursor=NEXT9",
        },
        num_pages: 2,
        scheduled_arrivals: [FLIGHT, { ...FLIGHT, ident: "BAW117" }],
      },
    }),
    "/aeroapi/operators/UAL": () => ({
      status: 200,
      body: {
        icao: "UAL",
        iata: "UA",
        callsign: "United",
        name: "United Airlines",
        country: "US",
        wiki_url: null,
      },
    }),
  };
}

export class FakeAeroApi {
  readonly calls: Recorded[] = [];
  routes: Record<string, Route>;
  private readonly raw: Record<string, { status: number; text: string }> = {};

  constructor(routes: Record<string, Route> = defaultRoutes()) {
    this.routes = routes;
  }

  /** Every route answers with this instead. */
  failWith(status: number, body: unknown, headers?: Record<string, string>) {
    for (const key of Object.keys(this.routes)) {
      this.routes[key] = () => ({
        status,
        body,
        ...(headers ? { headers } : {}),
      });
    }
  }

  /** One route answers with a raw text body instead of JSON. */
  answerText(path: string, status: number, text: string) {
    this.raw[path] = { status, text };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[k.toLowerCase()] = v;
    }
    this.calls.push({ url, method: init?.method ?? "GET", headers });
    // The RAW pathname, as sent: a route keyed on the decoded form would also
    // match a request whose encoding was wrong.
    const rawAnswer = this.raw[url.pathname];
    if (rawAnswer) {
      return new Response(rawAnswer.text, {
        status: rawAnswer.status,
        headers: { "content-type": "text/html" },
      });
    }
    const route = this.routes[url.pathname];
    const answer = route
      ? route(url)
      : {
          status: 404,
          body: { title: "Not Found", detail: `no route ${url.pathname}` },
        };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: {
        "content-type": "application/json",
        ...(answer.headers ?? {}),
      },
    });
  };
}
