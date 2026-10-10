# FlightAware AeroAPI MCP server

strad's server for **live flight data** from FlightAware AeroAPI v4: a flight's
status, airborne flights matching a filter, a flight's current position and the
track it has flown, an airport's facts, flight boards and delays, and who an
airline code belongs to. Everything is a read. Every read costs money.

## Why this is a first-party server

The Zimmer catalog entry this replaces ran `npx flightaware-mcp-server@latest`.
**That package does not exist on npm** (the registry answers 404), so the entry
never started, and there was no upstream surface to adopt or fork. The tools
here were designed from what the catalog promised — "searching flights,
retrieving flight status, and looking up airport information", read-only,
billed per query — against the AeroAPI v4 OpenAPI document.

## Configuration

| Variable             | Required | What it is                                                                                        |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `AEROAPI_API_KEY`    | yes      | An AeroAPI v4 key, sent as the `x-apikey` header to `https://aeroapi.flightaware.com/aeroapi`     |
| `ENABLED_TOOLGROUPS` | no       | `readonly` / `readwrite`. Unset serves everything; an unrecognised value falls back to `readonly` |

**Getting a key:** sign in at the [AeroAPI portal](https://www.flightaware.com/aeroapi/portal),
choose a tier (Personal is enough for every tool here), then **API Keys →
create a key**. The key belongs to whoever pays for the queries.

The key is read at **call** time, from the env object the server was given.
`tools/list` works with no key; a call without one fails naming
`AEROAPI_API_KEY` and saying how to get it, and makes no request. In the strad
bundle that env object is a snapshot taken at boot (and the variable may carry a
slug prefix, e.g. `FLIGHTAWARE__AEROAPI_API_KEY`), so a rotated key takes a
redeploy.

## Billing — read this before you use it

AeroAPI bills **per query**, and on a list endpoint **per result set**: each
page it returns (about 15 flights on most endpoints) is billed. So:

- Every tool makes **exactly one** HTTP request. Nothing walks pages on its own.
- List tools take `max_pages` (default **1**, capped at **3**), which is
  forwarded to AeroAPI as its own `max_pages` — how many pages that one request
  may return.
- Every list result reports `pages_billed` (AeroAPI's `num_pages`) and, when
  there is more, a `next_cursor`. Pass it back as `cursor`, with the same other
  arguments, to buy the next page.
- Nothing is retried. A 429 or 5xx is reported to the caller with
  `retryable: true` (and `retry_after_seconds` when AeroAPI sent one — an
  HTTP-date `Retry-After` is converted to seconds), because a re-sent query can
  be a second billed query. A 2xx whose body is not a JSON object is reported
  the same way rather than read as an empty result.
- Arguments are validated before any request — a `start`/`end` must be a real
  calendar date or an RFC 3339 instant with `Z` or `±HH:MM`, and a min above
  its max is refused — and unknown arguments are refused: a misspelt filter silently dropped would widen a search, and the wide
  search is the expensive one.
- Not offered, because each is a different bill: alerts (a write that keeps
  charging), `/history/*` (priced above live data), Foresight predictions.

## Tools

All eight are in both groups — AeroAPI's flight data has no write side, so
`readwrite` is the same set as `readonly`. Every tool is annotated
`readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`.

| Tool                  | AeroAPI endpoint                     | What it does                                                                                                                                                      |
| --------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_flight`          | `GET /flights/{ident}`               | Status of a flight by ident, registration or `fa_flight_id`; legs from 10 days back to 2 days ahead, narrowed by `start`/`end`                                    |
| `search_flights`      | `GET /flights/search`                | Airborne flights by origin, destination, airline, ident, type, altitude, speed or lat/lon box (or a raw simplified `query`); a box may not cross the antimeridian |
| `get_flight_position` | `GET /flights/{id}/position`         | The latest position of one flight                                                                                                                                 |
| `get_flight_track`    | `GET /flights/{id}/track`            | The flown path, evenly downsampled to `max_points` (default 200, max 1000), with `total_points` / `points_dropped`                                                |
| `get_airport`         | `GET /airports/{id}`                 | Name, codes, location, elevation, timezone                                                                                                                        |
| `get_airport_flights` | `GET /airports/{id}/flights/{board}` | One board: `arrivals`, `departures`, `scheduled_arrivals`, `scheduled_departures`; filter by `airline` or `flight_type` and a window                              |
| `get_airport_delays`  | `GET /airports/{id}/delays`          | Airport-wide delays in effect and why                                                                                                                             |
| `get_operator`        | `GET /operators/{id}`                | Who an airline code belongs to                                                                                                                                    |

Results drop `null` fields and AeroAPI's relative portal links, and replace a
flight's planned `waypoints` array with a `waypoint_count`. Times are UTC,
altitude is hundreds of feet, speed is knots.

## Errors

| AeroAPI says                                                  | The caller is told                                                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 400                                                           | the request was rejected; fix the arguments, do not retry                                                                    |
| 401                                                           | the key was rejected; a human replaces it (in strad, the variable may be slug-prefixed, e.g. `FLIGHTAWARE__AEROAPI_API_KEY`) |
| 402 / 403                                                     | the key is valid but the account's tier (or balance) does not cover this endpoint                                            |
| 404                                                           | no such flight / airport / operator; on a `/flights/` path, possibly older than the ~10-day window                           |
| 429                                                           | rate-limited, structured with `retryable` and `retry_after_seconds`                                                          |
| 5xx, timeout (30 s), network, a 2xx that is not a JSON object | FlightAware's side; retry later                                                                                              |

Upstream error text is summarised and capped at 300 characters. The literal key
is scrubbed from every result this server returns, error or success, and a
32-character key-shaped run is scrubbed from every error as a backstop.

## Layout

`shared/` is the whole server: `createMCPServer({ version, env, toolGroups,
fetch, baseUrl })` returns `{ server, registerHandlers }`, the shape the strad
bundle host mounts. `missingCredentials()`, `ENV`, `parseToolGroups()` and
`toolNames()` are exported beside it.

```sh
npm ci
npm test   # tsc, then vitest
```

## What is proven, and what is not

**Tested only against a fake.** The suite drives a real MCP client over an
in-memory transport against a fake AeroAPI built from the v4 OpenAPI document.
Nothing here has called the live service: the response shapes, the
`links.next` cursor format, which statuses AeroAPI actually sends for a tier
refusal (402 vs 403), and whether a 429 is billed are all taken from the
documentation, not observed.
