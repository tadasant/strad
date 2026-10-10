import { describe, expect, it } from "vitest";

import { compact, downsample } from "../src/shape.js";

describe("compact", () => {
  it("drops nulls and portal links, keeps every value, counts waypoints", () => {
    expect(
      compact({
        a: 1,
        b: null,
        airport_info_url: "/airports/KJFK",
        nested: { c: "x", d: null },
        waypoints: [1, 2, 3, 4, 5, 6],
        list: [{ e: null, f: 0 }],
      }),
    ).toEqual({
      a: 1,
      nested: { c: "x" },
      waypoint_count: 3,
      list: [{ f: 0 }],
    });
  });
});

describe("downsample", () => {
  it("leaves a short track alone", () => {
    expect(downsample([1, 2, 3], 10)).toEqual({ kept: [1, 2, 3], dropped: 0 });
  });
  it("keeps the first and last point and reports what it dropped", () => {
    const points = Array.from({ length: 1000 }, (_, i) => i);
    const { kept, dropped } = downsample(points, 10);
    expect(kept).toHaveLength(10);
    expect(kept[0]).toBe(0);
    expect(kept[9]).toBe(999);
    expect(dropped).toBe(990);
  });
});
