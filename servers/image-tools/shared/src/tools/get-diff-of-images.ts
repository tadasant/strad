import { z } from "zod";

import {
  guard,
  READ_ONLY_ANNOTATIONS,
  refuseLegacyPaths,
  URL_GUIDANCE,
  type ToolContext,
  type ToolDefinition,
} from "./shared.js";

const PARAM_DESCRIPTIONS = {
  source_image_url: `URL of the reference image (e.g. the design mock). PNG, JPEG, WebP, GIF, TIFF or AVIF. ${URL_GUIDANCE}`,
  target_image_url:
    "URL of the comparison image (e.g. the actual UI screenshot). Same rules as source_image_url.",
  threshold:
    "Color matching sensitivity, 0 to 1. Lower detects subtler differences. Default 0.1 (good for UI); " +
    "0.05 is strict, 0.2 lenient.",
  include_aa:
    "Count anti-aliased pixels (font smoothing, rounded corners) as differences. Default false, which cuts noise.",
  min_cluster_size:
    "Minimum connected diff pixels for a cluster to be reported; filters speckle. Default 4.",
  cluster_gap:
    "Merge clusters whose bounding boxes are within this many pixels. Omit for an automatic gap (natural " +
    "breaks in cluster distances); 0 disables merging; 5-20 for manual control.",
  max_clusters:
    "Most clusters to list, largest first. Default 50, max 200. summary.clusterCount is always the total.",
  return_images:
    'Images returned inline: "composite" (default; the heatmap over the source), "heatmap" (diff only, ' +
    'transparent elsewhere), "both", or "none" (JSON only, fewest tokens). Nothing is returned for an identical pair.',
} as const;

export const GetDiffOfImagesSchema = z.object({
  source_image_url: z
    .string()
    .min(1)
    .describe(PARAM_DESCRIPTIONS.source_image_url),
  target_image_url: z
    .string()
    .min(1)
    .describe(PARAM_DESCRIPTIONS.target_image_url),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe(PARAM_DESCRIPTIONS.threshold),
  include_aa: z
    .boolean()
    .default(false)
    .describe(PARAM_DESCRIPTIONS.include_aa),
  min_cluster_size: z
    .number()
    .int()
    .min(1)
    .default(4)
    .describe(PARAM_DESCRIPTIONS.min_cluster_size),
  cluster_gap: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(PARAM_DESCRIPTIONS.cluster_gap),
  max_clusters: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe(PARAM_DESCRIPTIONS.max_clusters),
  return_images: z
    .enum(["composite", "heatmap", "both", "none"])
    .default("composite")
    .describe(PARAM_DESCRIPTIONS.return_images),
});

const DESCRIPTION = `Compare two images pixel by pixel and locate what differs. Both are fetched from URLs.

Returns JSON, then the images asked for:
{"identical":false,"summary":{"diffPercentage":1.42,"clusterCount":2,"description":"1.42% of pixels differ across 2 cluster(s). Severity breakdown: 1 major, 1 minor."},"clusters":[{"id":1,"left":120,"top":48,"width":310,"height":40,"severity":"major","meanIntensity":0.41}],"clustersOmitted":0,"clustering":{"gapUsed":12,"autoGap":true,"suggestedSmallerGap":4,"suggestedLargerGap":60},"dimensions":{"width":1280,"height":800},"images":[{"kind":"composite","width":1280,"height":800,"scale":1}]}

Severity (area and intensity): trivial < minor < moderate < major. Cluster boxes are in full-resolution pixels of the compared region; an image wider than 1568px comes back downscaled, and images[].scale says by how much.

Different sizes are fine: the smaller image is located inside the larger (template matching) and only that region is compared; "alignment" reports where, and how confident.

Use cases:
- A design mock against the implemented UI
- One Figma component against a full-page screenshot
- Visual regressions between two versions of a page
- Checking a CSS change touched only what it meant to

Images over 10 megapixels or 25MB are refused; crop or downscale first.`;

const LEGACY = {
  source_image: "source_image_url",
  target_image: "target_image_url",
};

export function getDiffOfImagesTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "get_diff_of_images",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        source_image_url: {
          type: "string",
          description: PARAM_DESCRIPTIONS.source_image_url,
        },
        target_image_url: {
          type: "string",
          description: PARAM_DESCRIPTIONS.target_image_url,
        },
        threshold: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: PARAM_DESCRIPTIONS.threshold,
        },
        include_aa: {
          type: "boolean",
          description: PARAM_DESCRIPTIONS.include_aa,
        },
        min_cluster_size: {
          type: "integer",
          minimum: 1,
          description: PARAM_DESCRIPTIONS.min_cluster_size,
        },
        cluster_gap: {
          type: "integer",
          minimum: 0,
          description: PARAM_DESCRIPTIONS.cluster_gap,
        },
        max_clusters: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: PARAM_DESCRIPTIONS.max_clusters,
        },
        return_images: {
          type: "string",
          enum: ["composite", "heatmap", "both", "none"],
          description: PARAM_DESCRIPTIONS.return_images,
        },
      },
      required: ["source_image_url", "target_image_url"],
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: (args, signal) =>
      guard(async () => {
        refuseLegacyPaths(args, LEGACY);
        const a = GetDiffOfImagesSchema.parse(args);
        const [source, target] = await Promise.all([
          ctx.fetchImage(a.source_image_url, "source_image_url", signal),
          ctx.fetchImage(a.target_image_url, "target_image_url", signal),
        ]);
        const output = await ctx.runJob(
          {
            kind: "diff",
            source: source.bytes,
            target: target.bytes,
            options: {
              threshold: a.threshold,
              includeAA: a.include_aa,
              minClusterSize: a.min_cluster_size,
              clusterGap: a.cluster_gap,
              maxClusters: a.max_clusters,
              returnImages: a.return_images,
              maxImageEdge: ctx.limits.maxImageEdge,
              maxPixels: ctx.limits.maxPixels,
            },
          },
          signal,
        );
        if (output.kind !== "diff")
          throw new Error("the worker answered a different job");
        return {
          content: [
            { type: "text", text: JSON.stringify(output.result, null, 2) },
            ...output.pngs.map((png) => ({
              type: "image" as const,
              data: Buffer.from(png).toString("base64"),
              mimeType: "image/png",
            })),
          ],
        };
      }),
  };
}
