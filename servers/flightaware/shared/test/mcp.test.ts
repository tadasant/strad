import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import {
  createMCPServer,
  ENV,
  toolNames,
  type ToolGroup,
} from "../src/index.js";
import { DESCRIPTION_BUDGET } from "../src/tools/shared.js";
import { FakeAeroApi, FLIGHT, KEY } from "./fake-aeroapi.js";

/**
 * The server as an agent meets it: a real MCP `Client` over an in-memory
 * transport, talking to `createMCPServer`'s server after `registerHandlers`, in
 * front of a fake AeroAPI.
 */

const ALL = [
  "get_flight",
  "search_flights",
  "get_flight_position",
  "get_flight_track",
  "get_airport",
  "get_airport_flights",
  "get_airport_delays",
  "get_operator",
];

async function connect(
  options: {
    env?: NodeJS.ProcessEnv;
    toolGroups?: ToolGroup[];
    fake?: FakeAeroApi;
  } = {},
) {
  const fake = options.fake ?? new FakeAeroApi();
  const { server, registerHandlers } = createMCPServer({
    version: "0.0.0-test",
    env: options.env ?? { [ENV.apiKey]: KEY },
    fetch: fake.fetch,
    baseUrl: "https://aeroapi.example/aeroapi",
    ...(options.toolGroups ? { toolGroups: options.toolGroups } : {}),
  });
  await registerHandlers(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    const text = result.content[0]!.text;
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    return { isError: result.isError === true, text, json };
  };
  return { fake, client, call };
}

/** One valid call per tool, so the sweeps below cover the whole surface. */
const HAPPY: Record<string, Record<string, unknown>> = {
  get_flight: { ident: "UAL4" },
  search_flights: { destination: "KJFK" },
  get_flight_position: { fa_flight_id: FLIGHT.fa_flight_id },
  get_flight_track: { fa_flight_id: FLIGHT.fa_flight_id },
  get_airport: { airport: "KJFK" },
  get_airport_flights: { airport: "KJFK", board: "scheduled_arrivals" },
  get_airport_delays: { airport: "KSFO" },
  get_operator: { operator: "UAL" },
};

describe("tools/list", () => {
  it("serves all eight by default", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL].sort());
  });

  it("readonly and readwrite are the same eight reads", async () => {
    for (const group of ["readonly", "readwrite"] as ToolGroup[]) {
      const { client } = await connect({ toolGroups: [group] });
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...ALL].sort());
    }
    expect(toolNames(["readonly"]).sort()).toEqual([...ALL].sort());
    expect(toolNames(["readwrite"]).sort()).toEqual([...ALL].sort());
  });

  it("fails closed to readonly on a mistyped ENABLED_TOOLGROUPS", async () => {
    const { client } = await connect({
      env: { [ENV.apiKey]: KEY, ENABLED_TOOLGROUPS: "everything" },
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      toolNames(["readonly"]).sort(),
    );
  });

  it("annotates every tool as a read that touches the outside world", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it("keeps every description inside the budget and says it is billed", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description!.length, tool.name).toBeLessThanOrEqual(
        DESCRIPTION_BUDGET,
      );
      expect(tool.description, tool.name).toMatch(/BILLED PER QUERY/);
    }
  });
});

describe("a happy call to every tool", () => {
  it("covers the whole surface", () => {
    expect(Object.keys(HAPPY).sort()).toEqual([...ALL].sort());
  });

  for (const [name, args] of Object.entries(HAPPY)) {
    it(`${name} answers, with exactly one GET`, async () => {
      const { fake, call } = await connect();
      const result = await call(name, args);
      expect(result.isError, result.text).toBe(false);
      expect(result.json).toBeDefined();
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.method).toBe("GET");
      expect(fake.calls[0]!.headers["x-apikey"]).toBe(KEY);
    });
  }

  it("get_flight forwards its window and pages, and trims nulls", async () => {
    const { fake, call } = await connect();
    const result = await call("get_flight", {
      ident: "UAL4",
      ident_type: "designator",
      start: "2026-10-08",
      end: "2026-10-10T00:00:00Z",
      max_pages: 2,
    });
    const params = fake.calls[0]!.url.searchParams;
    expect(fake.calls[0]!.url.pathname).toBe("/aeroapi/flights/UAL4");
    expect(params.get("ident_type")).toBe("designator");
    expect(params.get("start")).toBe("2026-10-08");
    expect(params.get("end")).toBe("2026-10-10T00:00:00Z");
    expect(params.get("max_pages")).toBe("2");
    const flight = (result.json!.flights as Array<Record<string, unknown>>)[0]!;
    expect(flight.fa_flight_id).toBe(FLIGHT.fa_flight_id);
    expect("arrival_delay" in flight).toBe(false);
    expect("foresight_predictions_available" in flight).toBe(false);
    expect(result.json!.next_cursor).toBeUndefined();
  });

  it("search_flights composes the query and hands back the cursor alone", async () => {
    const { fake, call } = await connect();
    const result = await call("search_flights", {
      origin: "ksfo",
      destination: "KJFK",
      airline: "UAL",
      min_altitude: 300,
      bounding_box: [40, -75, 42, -72],
      category: "airline",
    });
    const sent = fake.calls[0]!.url.searchParams.get("query");
    expect(sent).toBe(
      '-origin KSFO -destination KJFK -airline UAL -aboveAltitude 300 -latlong "40 -75 42 -72" -filter airline',
    );
    expect(result.json!.query_sent).toBe(sent);
    expect(result.json!.next_cursor).toBe("CUR2");
    expect(result.json!.pages_billed).toBe(1);
    const flight = (result.json!.flights as Array<Record<string, unknown>>)[0]!;
    expect(flight.waypoints).toBeUndefined();
    expect(flight.waypoint_count).toBe(3);
  });

  it("search_flights passes a raw query through and a cursor on", async () => {
    const { fake, call } = await connect();
    await call("search_flights", {
      query: "-prefix L -destination KJFK",
      cursor: "CUR2",
    });
    const params = fake.calls[0]!.url.searchParams;
    expect(params.get("query")).toBe("-prefix L -destination KJFK");
    expect(params.get("cursor")).toBe("CUR2");
    expect(params.get("max_pages")).toBe("1");
  });

  it("percent-encodes a cursor on the way out and decodes it on the way back", async () => {
    const fake = new FakeAeroApi();
    fake.routes["/aeroapi/flights/search"] = () => ({
      status: 200,
      body: {
        links: { next: "/flights/search?query=x&cursor=n%2Fx%2By%3D%3D%26z" },
        num_pages: 1,
        flights: [],
      },
    });
    const { call } = await connect({ fake });
    const result = await call("search_flights", {
      destination: "KJFK",
      cursor: "a/b+c==&d",
    });
    const url = fake.calls[0]!.url;
    expect(url.search).toContain("cursor=a%2Fb%2Bc%3D%3D%26d");
    expect(url.searchParams.get("cursor")).toBe("a/b+c==&d");
    expect(result.json!.next_cursor).toBe("n/x+y==&z");
  });

  it("a foreign-origin links.next yields the cursor alone, and no request goes there", async () => {
    const fake = new FakeAeroApi();
    fake.routes["/aeroapi/flights/search"] = () => ({
      status: 200,
      body: {
        links: { next: "https://evil.example/collect?cursor=EVIL1&steal=1" },
        num_pages: 1,
        flights: [],
      },
    });
    const { call } = await connect({ fake });
    const first = await call("search_flights", { destination: "KJFK" });
    expect(first.json!.next_cursor).toBe("EVIL1");
    expect(JSON.stringify(first.json)).not.toContain("evil.example");
    await call("search_flights", {
      destination: "KJFK",
      cursor: first.json!.next_cursor,
    });
    expect(fake.calls).toHaveLength(2);
    for (const { url } of fake.calls) {
      expect(url.origin).toBe("https://aeroapi.example");
      expect(url.pathname).toBe("/aeroapi/flights/search");
      expect(url.searchParams.has("steal")).toBe(false);
    }
    expect(fake.calls[1]!.url.searchParams.get("cursor")).toBe("EVIL1");
  });

  it("search_flights writes bounding-box corners without exponent notation", async () => {
    const { fake, call } = await connect();
    await call("search_flights", {
      bounding_box: [-1e-7, 1e-7, 1.5e1, 0.0000123],
    });
    expect(fake.calls[0]!.url.searchParams.get("query")).toBe(
      '-latlong "0 0 15 0.000012"',
    );
  });

  it("search_flights keeps a hyphen inside a registration", async () => {
    const { fake, call } = await connect();
    await call("search_flights", { ident_or_registration: "g-abcd" });
    expect(fake.calls[0]!.url.searchParams.get("query")).toBe(
      "-identOrReg G-ABCD",
    );
  });

  it("caps max_pages, because every page is billed", async () => {
    const { fake, call } = await connect();
    await call("get_airport_flights", {
      airport: "KJFK",
      board: "scheduled_arrivals",
      max_pages: 50,
    });
    expect(fake.calls[0]!.url.searchParams.get("max_pages")).toBe("3");
  });

  it("get_airport_flights reads the board's own key and reports pages billed", async () => {
    const { fake, call } = await connect();
    const result = await call("get_airport_flights", {
      airport: "kjfk",
      board: "scheduled_arrivals",
      airline: "BAW",
      start: "2026-10-09",
    });
    const url = fake.calls[0]!.url;
    expect(url.pathname).toBe(
      "/aeroapi/airports/KJFK/flights/scheduled_arrivals",
    );
    expect(url.searchParams.get("airline")).toBe("BAW");
    expect(url.searchParams.get("start")).toBe("2026-10-09");
    expect(url.searchParams.has("type")).toBe(false);
    expect(result.json!.board).toBe("scheduled_arrivals");
    expect(result.json!.returned).toBe(2);
    expect(result.json!.pages_billed).toBe(2);
    expect(result.json!.next_cursor).toBe("NEXT9");
  });

  it("get_airport_flights forwards flight_type as AeroAPI's `type`", async () => {
    const { fake, call } = await connect();
    await call("get_airport_flights", {
      airport: "KJFK",
      board: "scheduled_arrivals",
      flight_type: "General_Aviation",
    });
    const params = fake.calls[0]!.url.searchParams;
    expect(params.get("type")).toBe("General_Aviation");
    expect(params.has("airline")).toBe(false);
  });

  for (const board of ["arrivals", "departures", "scheduled_departures"]) {
    it(`get_airport_flights reads the ${board} board from its own key`, async () => {
      const fake = new FakeAeroApi();
      fake.routes[`/aeroapi/airports/KJFK/flights/${board}`] = () => ({
        status: 200,
        body: {
          links: null,
          num_pages: 1,
          [board]: [{ ...FLIGHT, ident: `${board}-1` }],
          // A sibling board's key in the same body must not be read.
          scheduled_arrivals:
            board === "scheduled_arrivals" ? [] : [FLIGHT, FLIGHT],
        },
      });
      const { call } = await connect({ fake });
      const result = await call("get_airport_flights", {
        airport: "KJFK",
        board,
      });
      expect(result.isError, result.text).toBe(false);
      expect(fake.calls[0]!.url.pathname).toBe(
        `/aeroapi/airports/KJFK/flights/${board}`,
      );
      expect(result.json!.board).toBe(board);
      expect(result.json!.returned).toBe(1);
      const flights = result.json!.flights as Array<Record<string, unknown>>;
      expect(flights[0]!.ident).toBe(`${board}-1`);
      expect(result.json!.next_cursor).toBeUndefined();
    });
  }

  it("get_flight accepts RFC 3339 offsets and fractional seconds", async () => {
    const { fake, call } = await connect();
    const result = await call("get_flight", {
      ident: "UAL4",
      start: "2026-10-09T09:30:00+05:30",
      end: "2026-10-09T23:59:59.123Z",
    });
    expect(result.isError, result.text).toBe(false);
    const params = fake.calls[0]!.url.searchParams;
    expect(params.get("start")).toBe("2026-10-09T09:30:00+05:30");
    expect(params.get("end")).toBe("2026-10-09T23:59:59.123Z");
  });

  it("get_flight_track downsamples and says how much it dropped", async () => {
    const { fake, call } = await connect();
    const result = await call("get_flight_track", {
      fa_flight_id: FLIGHT.fa_flight_id,
      max_points: 100,
      include_surface_positions: true,
    });
    expect(
      fake.calls[0]!.url.searchParams.get("include_surface_positions"),
    ).toBe("true");
    expect(
      fake.calls[0]!.url.searchParams.has("include_estimated_positions"),
    ).toBe(false);
    expect(result.json!.total_points).toBe(1312);
    expect(result.json!.returned_points).toBe(100);
    expect(result.json!.points_dropped).toBe(1212);
    expect((result.json!.positions as unknown[]).length).toBe(100);
    expect(result.json!.actual_distance).toBe(2154);
  });

  it("get_flight_position reduces waypoints to a count", async () => {
    const { call } = await connect();
    const result = await call("get_flight_position", {
      fa_flight_id: FLIGHT.fa_flight_id,
    });
    expect(result.json!.waypoints).toBeUndefined();
    expect(result.json!.waypoint_count).toBe(2);
    expect(
      (result.json!.last_position as Record<string, unknown>).altitude,
    ).toBe(370);
  });
});

describe("with no credential", () => {
  it("still lists every tool", async () => {
    const { client } = await connect({ env: {} });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(ALL.length);
  });

  for (const [name, args] of Object.entries(HAPPY)) {
    it(`${name} fails naming the variable, and makes no request`, async () => {
      const { fake, call } = await connect({ env: {} });
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(ENV.apiKey);
      expect(result.text).toContain("aeroapi/portal");
      expect(fake.calls).toHaveLength(0);
    });
  }

  // Per call, from the env OBJECT passed in — this mutates that object. In the
  // strad bundle the object is a boot-time snapshot, so rotation there is a
  // redeploy; what this pins is that nothing here caches the key.
  it("reads the key per call from the env object it was given", async () => {
    const env: NodeJS.ProcessEnv = {};
    const { call } = await connect({ env });
    expect((await call("get_operator", { operator: "UAL" })).isError).toBe(
      true,
    );
    env[ENV.apiKey] = KEY;
    expect((await call("get_operator", { operator: "UAL" })).isError).toBe(
      false,
    );
  });
});

describe("the key never reaches a caller", () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    for (const [name, args] of Object.entries(HAPPY)) {
      it(`${name}, HTTP ${status} echoing the key`, async () => {
        const fake = new FakeAeroApi();
        fake.failWith(status, {
          title: `echo ${KEY}`,
          detail: `x-apikey: ${KEY}`,
        });
        const { call } = await connect({ fake });
        const result = await call(name, args);
        expect(result.isError).toBe(true);
        expect(result.text).not.toContain(KEY);
      });
    }
  }

  it("nor in a SUCCESS body that echoes it", async () => {
    const fake = new FakeAeroApi();
    fake.routes["/aeroapi/operators/UAL"] = () => ({
      status: 200,
      body: { icao: "UAL", name: `United ${KEY}` },
    });
    const { call } = await connect({ fake });
    const result = await call("get_operator", { operator: "UAL" });
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(KEY);
  });

  it("a rate limit comes back structured and retryable", async () => {
    const fake = new FakeAeroApi();
    fake.failWith(429, { title: "Too Many Requests" }, { "retry-after": "3" });
    const { call } = await connect({ fake });
    const result = await call("get_operator", { operator: "UAL" });
    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      error: "RateLimitError",
      retryable: true,
      retry_after_seconds: 3,
    });
  });
});

describe("input validation spends nothing", () => {
  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ["get_flight", {}, /`ident` is required/],
    ["get_flight", { ident: "UAL4/../operators" }, /not a flight identifier/],
    ["get_flight", { ident: "UAL4", start: "2026-10-09T14:00" }, /zoned/],
    [
      "get_flight",
      { ident: "UAL4", start: "2026-10-10", end: "2026-10-09" },
      /window is empty/,
    ],
    [
      "get_flight",
      { ident: "UAL4", start: "2026-10-09T14:00:00-0800" },
      /±HH:MM/,
    ],
    ["get_flight", { ident: "UAL4", start: "2026-02-30" }, /real/],
    [
      "get_flight",
      { ident: "UAL4", end: "2026-04-31T00:00:00Z" },
      /calendar date/,
    ],
    ["get_flight", { ident: "UAL4", ident_type: "tail" }, /not one of/],
    [
      "get_flight",
      { ident: "UAL4", identtype: "designator" },
      /Unknown argument/,
    ],
    ["search_flights", {}, /at least one filter/],
    [
      "search_flights",
      { destination: "KJFK -origin X" },
      /not a valid destination/,
    ],
    ["search_flights", { query: "-origin KSFO", airline: "UAL" }, /EITHER/],
    [
      "search_flights",
      { bounding_box: [42, -75, 40, -72] },
      /min below its max/,
    ],
    ["search_flights", { min_altitude: -5 }, /between 0 and 1000/],
    [
      "search_flights",
      { min_altitude: 400, max_altitude: 300 },
      /`min_altitude`=400 is above `max_altitude`=300/,
    ],
    [
      "search_flights",
      { min_groundspeed: 500, max_groundspeed: 100 },
      /`min_groundspeed`=500 is above/,
    ],
    [
      "search_flights",
      { ident_or_registration: "-origin" },
      /not as the first character/,
    ],
    ["search_flights", { bounding_box: [50, 170, 60, -170] }, /antimeridian/],
    [
      "search_flights",
      { bounding_box: [40, -75, 40.0000001, -72] },
      /min below its max/,
    ],
    ["search_flights", { query: "x".repeat(1001) }, /1000-byte/],
    ["get_flight_position", { fa_flight_id: "" }, /required/],
    [
      "get_flight_track",
      { fa_flight_id: FLIGHT.fa_flight_id, max_points: 0 },
      /between 1 and/,
    ],
    ["get_airport", { airport: "NEW YORK" }, /not an airport code/],
    ["get_airport_flights", { airport: "KJFK" }, /`board` is required/],
    [
      "get_airport_flights",
      {
        airport: "KJFK",
        board: "arrivals",
        airline: "UAL",
        flight_type: "Airline",
      },
      /not both/,
    ],
    ["get_airport_delays", { airport: 7 }, /must be a string/],
    ["get_operator", { operator: "United" }, /not an operator code/],
  ];
  for (const [name, args, message] of bad) {
    it(`${name} ${JSON.stringify(args).slice(0, 60)}`, async () => {
      const { fake, call } = await connect();
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(message);
      expect(fake.calls).toHaveLength(0);
    });
  }
});
