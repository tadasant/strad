/**
 * The image diff pipeline, over bytes rather than paths:
 *
 *  1. decode both images to RGBA (sharp)
 *  2. if the dimensions differ, find the smaller inside the larger and crop
 *  3. compare pixel by pixel (pixelmatch's YIQ distance)
 *  4. cluster the differing pixels
 *  5. render the heatmap and the composite, downscaled for inline delivery
 *
 * Ported from `@pulsemcp/image-diff-mcp-server`. What changed is the edges:
 * inputs are buffers, the heatmap and composite come back as PNG bytes rather
 * than files in the server's temp directory (which no remote caller can open),
 * and the reported cluster list is capped.
 */
import sharp from "sharp";

import { alignImages, orderBySize, type RawImage } from "./alignment.js";
import {
  findDiffClusters,
  type ClusteringMeta,
  type DiffCluster,
} from "./clustering.js";
import { encodePng, renderHeatmap } from "./heatmap.js";
import { pixelDiff } from "./pixel-diff.js";

export type ReturnImages = "composite" | "heatmap" | "both" | "none";

export interface ImageDiffOptions {
  threshold?: number;
  includeAA?: boolean;
  minClusterSize?: number;
  clusterGap?: number;
  maxClusters?: number;
  returnImages?: ReturnImages;
  /** Longest edge of a returned PNG. */
  maxImageEdge: number;
  /** Refuse to decode an image with more pixels than this. */
  maxPixels: number;
}

export interface ImageDiffResult {
  identical: boolean;
  summary: {
    totalPixels: number;
    diffPixels: number;
    diffPercentage: number;
    antiAliasedPixels: number;
    matchingPixels: number;
    clusterCount: number;
    description: string;
  };
  /** Largest first, at most `maxClusters` of them. */
  clusters: DiffCluster[];
  clustersOmitted: number;
  clustering: ClusteringMeta;
  /** The compared region. Cluster coordinates are in this space. */
  dimensions: { width: number; height: number };
  alignment?: {
    x: number;
    y: number;
    confidence: number;
    strategy: string;
    alignmentTimeMs: number;
    templateImage: "source" | "target";
    originalDimensions: {
      source: { width: number; height: number };
      target: { width: number; height: number };
    };
  };
  /** What each returned image is, and the scale it was drawn at. */
  images: Array<{
    kind: "composite" | "heatmap";
    width: number;
    height: number;
    scale: number;
  }>;
}

export interface ImageDiffOutput {
  result: ImageDiffResult;
  /** PNGs, in the order `result.images` describes them. */
  pngs: Buffer[];
}

/** Below this, the located region is probably not the smaller image at all. */
const LOW_CONFIDENCE = 0.9;

export async function decodeRgba(
  bytes: Uint8Array,
  maxPixels: number,
  label: string,
): Promise<RawImage> {
  try {
    // `toColourspace` first: a greyscale PNG decodes to one channel (two with
    // alpha), and every loop downstream assumes four bytes per pixel.
    // `rotate()` applies EXIF orientation, so a phone photo compares upright.
    const { data, info } = await sharp(bytes, { limitInputPixels: maxPixels })
      .rotate()
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4)
      throw new Error(`decoded to ${info.channels} channels, expected 4`);
    return {
      data: new Uint8Array(data.buffer, data.byteOffset, data.length),
      width: info.width,
      height: info.height,
    };
  } catch (err) {
    throw new Error(
      `Could not decode the ${label} image: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function crop(
  image: RawImage,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * image.width + x) * 4;
    out.set(image.data.subarray(src, src + w * 4), row * w * 4);
  }
  return out;
}

export async function diffImages(
  sourceBytes: Uint8Array,
  targetBytes: Uint8Array,
  options: ImageDiffOptions,
): Promise<ImageDiffOutput> {
  const {
    threshold = 0.1,
    includeAA = false,
    minClusterSize = 4,
    clusterGap,
    maxClusters = 50,
    returnImages = "composite",
    maxImageEdge,
    maxPixels,
  } = options;

  const [source, target] = await Promise.all([
    decodeRgba(sourceBytes, maxPixels, "source"),
    decodeRgba(targetBytes, maxPixels, "target"),
  ]);

  let width = source.width;
  let height = source.height;
  let sourceData = source.data;
  let targetData = target.data;
  let alignment: ImageDiffResult["alignment"];

  if (source.width !== target.width || source.height !== target.height) {
    const { scene, template, swapped } = orderBySize(source, target);
    const found = alignImages(scene, template);
    width = template.width;
    height = template.height;
    const croppedScene = crop(scene, found.x, found.y, width, height);
    sourceData = swapped ? template.data : croppedScene;
    targetData = swapped ? croppedScene : template.data;
    alignment = {
      x: found.x,
      y: found.y,
      confidence: found.confidence,
      strategy: found.strategy,
      alignmentTimeMs: found.timeMs,
      templateImage: swapped ? "source" : "target",
      originalDimensions: {
        source: { width: source.width, height: source.height },
        target: { width: target.width, height: target.height },
      },
    };
  }

  const diff = pixelDiff(sourceData, targetData, width, height, {
    threshold,
    includeAA,
  });
  const { clusters, clusteringMeta } = findDiffClusters(
    diff.intensityMap,
    width,
    height,
    minClusterSize,
    clusterGap,
  );
  const identical = diff.diffCount === 0 && clusters.length === 0;

  const images: ImageDiffResult["images"] = [];
  const pngs: Buffer[] = [];
  // An identical pair has nothing to show: the composite would be the source.
  if (!identical && returnImages !== "none") {
    const heat = renderHeatmap(diff.intensityMap, width, height);
    if (returnImages === "composite" || returnImages === "both") {
      // The composite is drawn over the SOURCE's view of the compared region.
      const base: RawImage = { data: sourceData, width, height };
      const out = await encodePng(base, maxImageEdge, heat);
      images.push({
        kind: "composite",
        width: out.width,
        height: out.height,
        scale: out.scale,
      });
      pngs.push(out.png);
    }
    if (returnImages === "heatmap" || returnImages === "both") {
      const out = await encodePng(heat, maxImageEdge);
      images.push({
        kind: "heatmap",
        width: out.width,
        height: out.height,
        scale: out.scale,
      });
      pngs.push(out.png);
    }
  }

  const reported = clusters.slice(0, maxClusters);
  return {
    result: {
      identical,
      summary: {
        totalPixels: diff.totalPixels,
        diffPixels: diff.diffCount,
        diffPercentage: Math.round(diff.diffPercentage * 1000) / 1000,
        antiAliasedPixels: diff.aaCount,
        matchingPixels: diff.matchCount,
        clusterCount: clusters.length,
        description:
          describe(diff.diffPercentage, diff.diffCount, clusters) +
          (alignment && alignment.confidence < LOW_CONFIDENCE
            ? ` Alignment confidence is low (${alignment.confidence}): the smaller image may not appear in the larger one, so these differences may be meaningless.`
            : ""),
      },
      clusters: reported,
      clustersOmitted: clusters.length - reported.length,
      clustering: clusteringMeta,
      dimensions: { width, height },
      ...(alignment ? { alignment } : {}),
      images,
    },
    pngs,
  };
}

function describe(
  diffPercentage: number,
  diffPixels: number,
  clusters: DiffCluster[],
): string {
  if (clusters.length === 0 && diffPixels === 0)
    return "Images are identical (no differences detected).";
  if (clusters.length === 0) {
    return `${diffPixels} isolated diff pixel(s) found but all filtered by min_cluster_size. No significant clusters.`;
  }
  const count = (s: DiffCluster["severity"]) =>
    clusters.filter((c) => c.severity === s).length;
  const parts = (["major", "moderate", "minor", "trivial"] as const)
    .map((s) => [count(s), s] as const)
    .filter(([n]) => n > 0)
    .map(([n, s]) => `${n} ${s}`);
  return (
    `${diffPercentage.toFixed(2)}% of pixels differ across ${clusters.length} cluster(s).` +
    (parts.length > 0 ? ` Severity breakdown: ${parts.join(", ")}.` : "")
  );
}
