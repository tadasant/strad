import { z } from "zod";

import { ImageInputError } from "../fetch-image.js";
import {
  guard,
  READ_ONLY_ANNOTATIONS,
  refuseLegacyPaths,
  URL_GUIDANCE,
  type ToolContext,
  type ToolDefinition,
} from "./shared.js";

const HEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

const PARAM_DESCRIPTIONS = {
  image_url: `URL of the bitmap to trace: PNG, JPEG, WebP, GIF, TIFF or AVIF. ${URL_GUIDANCE}`,
  threshold:
    "Black/white cut-off, 0-255. Lower captures more detail; higher simplifies. Default 128.",
  turd_size:
    "Suppress speckles up to this many pixels. Raise to remove noise. Default 2.",
  opt_tolerance:
    "Curve optimization tolerance, 0-1. Higher gives simpler curves. Default 0.2.",
  color:
    'Fill color for the traced paths, as hex (e.g. "#FF5733"). Default "#000000".',
  background: 'Background: "transparent" (default) or a hex color.',
  target_width:
    "Width of the output SVG's viewBox in pixels; paths are scaled to fit, aspect ratio kept (e.g. 50 for an icon).",
  target_height:
    "Height of the output SVG's viewBox in pixels. Give one or both of target_width/target_height.",
} as const;

export const TraceBitmapToSvgSchema = z.object({
  image_url: z.string().min(1).describe(PARAM_DESCRIPTIONS.image_url),
  threshold: z
    .number()
    .min(0)
    .max(255)
    .default(128)
    .describe(PARAM_DESCRIPTIONS.threshold),
  turd_size: z
    .number()
    .min(0)
    .default(2)
    .describe(PARAM_DESCRIPTIONS.turd_size),
  opt_tolerance: z
    .number()
    .min(0)
    .max(1)
    .default(0.2)
    .describe(PARAM_DESCRIPTIONS.opt_tolerance),
  color: z
    .string()
    .regex(HEX, 'must be a hex color, e.g. "#FF5733"')
    .default("#000000"),
  background: z
    .union([
      z.literal("transparent"),
      z.string().regex(HEX, 'must be "transparent" or a hex color'),
    ])
    .default("transparent"),
  target_width: z.number().positive().max(10_000).optional(),
  target_height: z.number().positive().max(10_000).optional(),
});

const DESCRIPTION = `Trace a bitmap image (fetched from a URL) into an SVG vector graphic with potrace, and return the SVG.

The image is flattened to greyscale and cut at threshold; a transparent PNG is first turned into a black-on-white mask of its alpha, so a logo on a transparent background traces as its shape. The trace is ONE color: every path gets the same fill.

Returns:
{"svg":"<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"50\\" height=\\"50\\" viewBox=\\"0 0 50 50\\">…</svg>","width":50,"height":50,"originalWidth":512,"originalHeight":512,"preprocessed":true,"svgLength":4210}

preprocessed: true when an alpha channel was converted to a mask. width/height are the SVG's; originalWidth/originalHeight the bitmap's.

Use cases:
- Convert a brand logo PNG to an SVG icon
- Trace a favicon or app icon to vector form
- Produce 50x50 SVG icons from source images (target_width + target_height)
- Get scalable paths that can be restyled with CSS

Nothing is written anywhere: save the returned svg yourself. Images over 10 megapixels or 25MB are refused; an SVG over 1M characters is refused with a hint to simplify (raise turd_size or threshold, or trace a smaller image).`;

const LEGACY = { input_path: "image_url", output_path: "" };

export function traceBitmapToSvgTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "trace_bitmap_to_svg",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        image_url: {
          type: "string",
          description: PARAM_DESCRIPTIONS.image_url,
        },
        threshold: {
          type: "number",
          minimum: 0,
          maximum: 255,
          description: PARAM_DESCRIPTIONS.threshold,
        },
        turd_size: {
          type: "number",
          minimum: 0,
          description: PARAM_DESCRIPTIONS.turd_size,
        },
        opt_tolerance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: PARAM_DESCRIPTIONS.opt_tolerance,
        },
        color: { type: "string", description: PARAM_DESCRIPTIONS.color },
        background: {
          type: "string",
          description: PARAM_DESCRIPTIONS.background,
        },
        target_width: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 10000,
          description: PARAM_DESCRIPTIONS.target_width,
        },
        target_height: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 10000,
          description: PARAM_DESCRIPTIONS.target_height,
        },
      },
      required: ["image_url"],
    },
    annotations: READ_ONLY_ANNOTATIONS,
    handler: (args, signal) =>
      guard(async () => {
        refuseLegacyPaths(args, LEGACY);
        const a = TraceBitmapToSvgSchema.parse(args);
        const image = await ctx.fetchImage(a.image_url, "image_url", signal);
        const output = await ctx.runJob(
          {
            kind: "trace",
            input: image.bytes,
            options: {
              threshold: a.threshold,
              turdSize: a.turd_size,
              optTolerance: a.opt_tolerance,
              color: a.color,
              background: a.background,
              targetWidth: a.target_width,
              targetHeight: a.target_height,
              maxPixels: ctx.limits.maxPixels,
            },
          },
          signal,
        );
        if (output.kind !== "trace")
          throw new Error("the worker answered a different job");
        const r = output.result;
        if (r.svg.length > ctx.limits.maxSvgChars) {
          throw new ImageInputError(
            `The traced SVG is ${r.svg.length.toLocaleString("en-US")} characters, over the ` +
              `${ctx.limits.maxSvgChars.toLocaleString("en-US")} limit. Simplify the trace: raise turd_size ` +
              "(e.g. 10-50) or opt_tolerance, move threshold to drop detail, or trace a smaller or cropped image.",
          );
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  svg: r.svg,
                  width: r.width,
                  height: r.height,
                  originalWidth: r.originalWidth,
                  originalHeight: r.originalHeight,
                  preprocessed: r.preprocessed,
                  svgLength: r.svg.length,
                },
                null,
                2,
              ),
            },
          ],
        };
      }),
  };
}
