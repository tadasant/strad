/**
 * What a result keeps of AeroAPI's reply, and what it drops.
 *
 * AeroAPI's flight object has some sixty fields, most of them null on any given
 * flight, and a search result carries each flight's planned route as a
 * `waypoints` array of hundreds of numbers. Returned verbatim, one page of
 * fifteen flights is mostly `null` and coordinates. So:
 *
 *   - null and undefined fields are dropped (absent means "AeroAPI did not
 *     know", which is what null meant);
 *   - the relative portal links (`airport_info_url`, `airport_flights_url`)
 *     are dropped — they are paths on AeroAPI, useless without the key;
 *   - `waypoints` is replaced by its point count, and the tool that wants the
 *     flown path (`get_flight_track`) returns that instead, downsampled.
 *
 * Every field with a value is kept. The trim is about tokens, never about
 * deciding what a caller is allowed to know.
 */

const DROPPED_KEYS = new Set([
  "airport_info_url",
  "airport_flights_url",
  "foresight_predictions_available",
]);

export function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner === null || inner === undefined || DROPPED_KEYS.has(key))
      continue;
    if (key === "waypoints" && Array.isArray(inner)) {
      // Lat/lon pairs flattened into one array, so the point count is half.
      out.waypoint_count = Math.floor(inner.length / 2);
      continue;
    }
    out[key] = compact(inner);
  }
  return out;
}

/**
 * At most `max` points, evenly spaced, always keeping the first and the last.
 *
 * Downsampled rather than truncated: a track cut at point 200 of 1,400 shows a
 * flight that never left its climb-out, while 200 evenly spaced points still
 * show where it went and where it is.
 */
export function downsample<T>(
  points: T[],
  max: number,
): { kept: T[]; dropped: number } {
  if (points.length <= max) return { kept: points, dropped: 0 };
  if (max <= 1) return { kept: points.slice(-1), dropped: points.length - 1 };
  const kept: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) kept.push(points[Math.round(i * step)]!);
  return { kept, dropped: points.length - kept.length };
}
