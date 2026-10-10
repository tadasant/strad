/**
 * Heatmap rendering from the intensity map. Ported from
 * `@pulsemcp/image-diff-mcp-server`: matching pixels are transparent,
 * anti-aliased ones a faint yellow, and differing ones a gradient from yellow
 * (subtle) to red (major) whose opacity also scales with intensity.
 */
import sharp from "sharp";

import type { RawImage } from "./alignment.js";

/** The heatmap as raw RGBA, the same dimensions as the intensity map. */
export function renderHeatmap(
  intensityMap: Float32Array,
  width: number,
  height: number,
): RawImage {
  const len = width * height;
  const out = new Uint8Array(len * 4);
  for (let i = 0; i < len; i++) {
    const pos = i * 4;
    const intensity = intensityMap[i]!;
    if (intensity < 0) {
      out[pos] = 255;
      out[pos + 1] = 255;
      out[pos + 2] = 150;
      out[pos + 3] = 60;
    } else if (intensity === 0) {
      out[pos] = 255;
      out[pos + 1] = 255;
      out[pos + 2] = 255;
      out[pos + 3] = 0;
    } else {
      const t = Math.max(0, Math.min(1, intensity));
      out[pos] = 255;
      out[pos + 1] = Math.round(255 * (1 - t));
      out[pos + 2] = 0;
      out[pos + 3] = Math.round(100 + 155 * intensity);
    }
  }
  return { data: out, width, height };
}

/**
 * Encode a raw RGBA image as PNG, downscaled so its longer edge is at most
 * `maxEdge`. Returns the PNG and the scale applied (1 when none was).
 *
 * The scale is reported because cluster coordinates are always in FULL
 * resolution, and a caller reading a box off a downscaled picture needs it.
 */
export async function encodePng(
  image: RawImage,
  maxEdge: number,
  overlay?: RawImage,
): Promise<{ png: Buffer; scale: number; width: number; height: number }> {
  const { width, height } = image;
  let pipeline = sharp(
    Buffer.from(
      image.data.buffer,
      image.data.byteOffset,
      image.data.byteLength,
    ),
    {
      raw: { width, height, channels: 4 },
    },
  );
  if (overlay) {
    const top = await sharp(
      Buffer.from(
        overlay.data.buffer,
        overlay.data.byteOffset,
        overlay.data.byteLength,
      ),
      { raw: { width: overlay.width, height: overlay.height, channels: 4 } },
    )
      .png()
      .toBuffer();
    // Flatten the composite first: `resize` after `composite` in one sharp
    // pipeline resizes the base before compositing, which would misalign them.
    const flat = await pipeline
      .composite([{ input: top, blend: "over" }])
      .raw()
      .toBuffer();
    pipeline = sharp(flat, { raw: { width, height, channels: 4 } });
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale < 1) {
    pipeline = pipeline.resize(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
      {
        fit: "fill",
      },
    );
  }
  const { data, info } = await pipeline
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  return {
    png: data,
    scale: Math.round(scale * 10000) / 10000,
    width: info.width,
    height: info.height,
  };
}
