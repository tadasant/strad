import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  MAX_MERGE_CLUSTERS,
  findDiffClusters,
} from "../src/diff/clustering.js";
import { executeJob, type JobOutput } from "../src/jobs.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import {
  BLACK,
  CLEAR,
  png,
  rect,
  textPage,
  texture,
  WHITE,
} from "./fixtures.js";

const BASE = {
  maxImageEdge: DEFAULT_LIMITS.maxImageEdge,
  maxPixels: DEFAULT_LIMITS.maxPixels,
};

async function diff(
  a: Buffer,
  b: Buffer,
  options: Record<string, unknown> = {},
) {
  const out = (await executeJob({
    kind: "diff",
    source: a,
    target: b,
    options: { ...BASE, ...options },
  })) as Extract<JobOutput, { kind: "diff" }>;
  return out;
}

describe("diffImages", () => {
  it("reports an identical pair as identical, with no images", async () => {
    const a = await png(64, 48, texture);
    const { result, pngs } = await diff(a, a);
    expect(result.identical).toBe(true);
    expect(result.summary.description).toMatch(/identical/);
    expect(pngs).toHaveLength(0);
  });

  it("finds a changed rectangle and boxes it", async () => {
    const a = await png(200, 100, () => WHITE);
    const b = await png(200, 100, rect(40, 30, 50, 20, [255, 0, 0, 255]));
    const { result, pngs } = await diff(a, b);
    expect(result.identical).toBe(false);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]).toMatchObject({
      left: 40,
      top: 30,
      width: 50,
      height: 20,
    });
    expect(result.summary.diffPixels).toBe(1000);
    expect(result.images).toEqual([
      { kind: "composite", width: 200, height: 100, scale: 1 },
    ]);
    const meta = await sharp(Buffer.from(pngs[0]!)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 200, 100]);
  });

  it("returns both images, or none, on request", async () => {
    const a = await png(50, 50, () => WHITE);
    const b = await png(50, 50, rect(10, 10, 10, 10));
    expect(
      (await diff(a, b, { returnImages: "both" })).result.images.map(
        (i) => i.kind,
      ),
    ).toEqual(["composite", "heatmap"]);
    expect((await diff(a, b, { returnImages: "none" })).pngs).toHaveLength(0);
  });

  it("downscales a returned image past the edge limit and says by how much", async () => {
    const a = await png(400, 100, () => WHITE);
    const b = await png(400, 100, rect(300, 50, 20, 20));
    const { result } = await diff(a, b, { maxImageEdge: 200 });
    expect(result.images[0]).toMatchObject({
      width: 200,
      height: 50,
      scale: 0.5,
    });
    // Cluster coordinates stay at full resolution.
    expect(result.clusters[0]).toMatchObject({ left: 300, top: 50 });
  });

  it("locates a smaller image inside a larger one and compares only that region", async () => {
    const big = await png(320, 240, texture);
    const crop = await sharp(big)
      .extract({ left: 137, top: 61, width: 90, height: 70 })
      .png()
      .toBuffer();
    const { result } = await diff(big, crop);
    expect(result.alignment).toMatchObject({
      x: 137,
      y: 61,
      templateImage: "target",
      strategy: "zncc-fft",
    });
    expect(result.alignment!.confidence).toBeGreaterThan(0.99);
    expect(result.identical).toBe(true);
    expect(result.dimensions).toEqual({ width: 90, height: 70 });
  });

  // The case that matters most and fails a downscaled search: a crop out of a
  // page where every line resembles the next.
  it.each([
    [503, 377, 300, 200],
    [100, 50, 400, 120],
    [20, 700, 600, 40],
  ])(
    "finds a crop at (%i, %i) in a page of near-identical lines",
    async (left, top, width, height) => {
      const page = await png(1200, 900, textPage);
      const crop = await sharp(page)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();
      const { result } = await diff(crop, page, { returnImages: "none" });
      expect(result.alignment).toMatchObject({
        x: left,
        y: top,
        templateImage: "source",
      });
      expect(result.identical).toBe(true);
    },
  );

  it("downscales the search only for a scene too large for one FFT, and still lands exactly", async () => {
    const page = await png(2800, 2000, textPage);
    const crop = await sharp(page)
      .extract({ left: 1001, top: 1203, width: 500, height: 300 })
      .png()
      .toBuffer();
    const { result } = await diff(page, crop, { returnImages: "none" });
    expect(result.alignment).toMatchObject({
      x: 1001,
      y: 1203,
      strategy: "zncc-fft-1/2+refine",
    });
    expect(result.identical).toBe(true);
  }, 60_000);

  it("refuses a template too small to locate in a scene that had to be downscaled", async () => {
    const page = await png(2800, 2000, textPage);
    const icon = await sharp(page)
      .extract({ left: 100, top: 100, width: 6, height: 6 })
      .png()
      .toBuffer();
    await expect(diff(page, icon)).rejects.toThrow(/too small to locate/);
  }, 60_000);

  it("says so when the smaller image is probably not in the larger one", async () => {
    const page = await png(400, 300, textPage);
    const elsewhere = await png(80, 60, rect(10, 10, 30, 30, [255, 0, 0, 255]));
    const { result } = await diff(page, elsewhere, { returnImages: "none" });
    expect(result.alignment!.confidence).toBeLessThan(0.9);
    expect(result.summary.description).toMatch(/Alignment confidence is low/);
  });

  it("refuses to align when the smaller image does not fit inside the other", async () => {
    await expect(
      diff(await png(100, 10, texture), await png(20, 60, texture)),
    ).rejects.toThrow(/cannot sit inside/);
  });

  it("decodes greyscale and transparent inputs to four channels", async () => {
    const grey = await sharp(Buffer.alloc(30 * 20, 200), {
      raw: { width: 30, height: 20, channels: 1 },
    })
      .png()
      .toBuffer();
    const rgba = await png(30, 20, () => [200, 200, 200, 255]);
    expect((await diff(grey, rgba)).result.identical).toBe(true);
    const clear = await png(30, 20, () => CLEAR);
    expect((await diff(clear, rgba)).result.identical).toBe(false);
  });

  it("caps the listed clusters and counts what it left out", async () => {
    const a = await png(200, 200, () => WHITE);
    // 25 well-separated 4x4 blocks; cluster_gap 0 keeps them apart.
    const b = await png(200, 200, (x, y) =>
      x % 40 < 4 && y % 40 < 4 ? BLACK : WHITE,
    );
    const { result } = await diff(a, b, { maxClusters: 10, clusterGap: 0 });
    expect(result.summary.clusterCount).toBe(25);
    expect(result.clusters).toHaveLength(10);
    expect(result.clustersOmitted).toBe(15);
  });

  it("refuses to decode past the pixel limit", async () => {
    // Only the source is over the limit: both decode at once, so with two
    // oversized images either could be the one named.
    const big = await png(100, 100, () => WHITE);
    const small = await png(50, 50, () => WHITE);
    await expect(diff(big, small, { maxPixels: 5000 })).rejects.toThrow(
      /Could not decode the source image/,
    );
  });
});

describe("findDiffClusters", () => {
  it("bounds merging on a noisy diff instead of going quadratic in the noise", () => {
    const w = 400;
    const h = 400;
    const map = new Float32Array(w * h);
    // Isolated single pixels every 3px: ~17,700 clusters.
    for (let y = 0; y < h; y += 3)
      for (let x = 0; x < w; x += 3) map[y * w + x] = 0.5;
    const start = performance.now();
    const { clusters, clusteringMeta } = findDiffClusters(
      map,
      w,
      h,
      1,
      undefined,
    );
    expect(performance.now() - start).toBeLessThan(15_000);
    expect(clusteringMeta.droppedClusters).toBeGreaterThan(0);
    expect(clusters.length).toBeLessThanOrEqual(MAX_MERGE_CLUSTERS);
  });

  it("merges transitively: a box that only comes within the gap after a merge is caught", () => {
    const w = 100;
    const h = 10;
    const map = new Float32Array(w * h);
    for (const x of [0, 6, 12, 18]) map[x] = 1; // each 5px from the next
    const { clusters } = findDiffClusters(map, w, h, 1, 5);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ left: 0, right: 18, pixelCount: 4 });
  });
});

describe("traceToSvg", () => {
  it("traces a black square into a path", async () => {
    const input = await sharp(await png(64, 64, rect(16, 16, 32, 32)))
      .removeAlpha()
      .png()
      .toBuffer();
    const out = await executeJob({
      kind: "trace",
      input,
      options: { maxPixels: DEFAULT_LIMITS.maxPixels },
    });
    if (out.kind !== "trace") throw new Error("wrong job");
    expect(out.result).toMatchObject({
      width: 64,
      height: 64,
      preprocessed: false,
    });
    expect(out.result.svg).toMatch(/<path/);
  });

  it("turns transparency into a mask, and scales to a target size", async () => {
    const input = await png(
      100,
      50,
      rect(10, 10, 30, 30, [255, 0, 0, 255], CLEAR),
    );
    const out = await executeJob({
      kind: "trace",
      input,
      options: {
        maxPixels: DEFAULT_LIMITS.maxPixels,
        targetWidth: 50,
        color: "#123456",
      },
    });
    if (out.kind !== "trace") throw new Error("wrong job");
    expect(out.result).toMatchObject({
      width: 50,
      height: 25,
      originalWidth: 100,
      preprocessed: true,
    });
    expect(out.result.svg).toContain('viewBox="0 0 50 25"');
    expect(out.result.svg).toContain('fill="#123456"');
  });

  it("never scales a dimension to zero", async () => {
    const input = await png(1000, 10, rect(100, 2, 600, 6));
    const out = await executeJob({
      kind: "trace",
      input,
      options: { maxPixels: DEFAULT_LIMITS.maxPixels, targetWidth: 1 },
    });
    if (out.kind !== "trace") throw new Error("wrong job");
    expect(out.result).toMatchObject({ width: 1, height: 1 });
  });
});
