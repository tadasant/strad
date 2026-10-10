/**
 * Bitmap → SVG tracing with potrace. Ported from
 * `@pulsemcp/svg-tracer-mcp-server`; what changed is the edges. Input is bytes
 * rather than a path, and nothing is written to disk — the SVG comes back to
 * the caller, which is the only place a remote caller can use it.
 */
import { createRequire } from "node:module";

import sharp from "sharp";

interface PotraceOptions {
  threshold: number;
  turdSize: number;
  optTolerance: number;
  color: string;
  background: string;
}

// potrace is CommonJS and ships no types.
const require = createRequire(import.meta.url);
const potrace = require("potrace") as {
  trace: (
    input: Buffer,
    options: PotraceOptions,
    cb: (err: Error | null, svg: string) => void,
  ) => void;
};

function traceAsync(input: Buffer, options: PotraceOptions): Promise<string> {
  return new Promise((resolve, reject) =>
    potrace.trace(input, options, (err, svg) =>
      err ? reject(err) : resolve(svg),
    ),
  );
}

export interface TraceOptions {
  threshold?: number;
  turdSize?: number;
  optTolerance?: number;
  color?: string;
  background?: string;
  targetWidth?: number;
  targetHeight?: number;
  /** Refuse to decode an image with more pixels than this. */
  maxPixels: number;
}

export interface TraceResult {
  svg: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  /** True when an alpha channel was flattened into a black-on-white mask. */
  preprocessed: boolean;
}

/**
 * Greyscale for potrace. A transparent image becomes a mask: opaque pixels
 * keep their luminance, transparent ones blend to white — so a logo on a
 * transparent background traces as its shape rather than as a solid square.
 */
async function preprocess(input: Uint8Array, maxPixels: number) {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: maxPixels }).metadata();
  } catch (err) {
    throw new Error(
      `Could not decode the image: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!meta.width || !meta.height)
    throw new Error("Could not read the image's dimensions.");

  // `rotate()` applies EXIF orientation, so a phone photo traces upright.
  const base = () => sharp(input, { limitInputPixels: maxPixels }).rotate();

  if (meta.hasAlpha) {
    const { data, info } = await base()
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const n = info.width * info.height;
    const grey = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const lum =
        0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!;
      const a = data[p + 3]! / 255;
      grey[i] = Math.round(lum * a + 255 * (1 - a));
    }
    const png = await sharp(grey, {
      raw: { width: info.width, height: info.height, channels: 1 },
    })
      .png()
      .toBuffer();
    return { png, width: info.width, height: info.height, hadAlpha: true };
  }

  const { data, info } = await base()
    .grayscale()
    .png()
    .toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height, hadAlpha: false };
}

/**
 * Wrap potrace's paths in a scaled, centred group inside a new viewBox.
 *
 * potrace emits self-closing, single-line `<path>` (and, with a background,
 * `<rect>`) elements, which is the only SVG this regex has to read.
 */
function adaptToTargetSize(
  svg: string,
  ow: number,
  oh: number,
  tw: number,
  th: number,
): string {
  const scale = Math.min(tw / ow, th / oh);
  const offsetX = (tw - ow * scale) / 2;
  const offsetY = (th - oh * scale) / 2;
  const elements = svg.match(/<(path|rect)[^>]*\/>/g);
  if (!elements) return svg;
  const rects = elements.filter((el) => el.startsWith("<rect"));
  const paths = elements.filter((el) => el.startsWith("<path"));
  const fill = paths[0]?.match(/fill="([^"]*)"/)?.[1] ?? "#000000";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}" viewBox="0 0 ${tw} ${th}">` +
    (rects.length > 0 ? "\n  " + rects.join("\n  ") : "") +
    `\n  <g transform="translate(${offsetX.toFixed(2)}, ${offsetY.toFixed(2)}) scale(${scale.toFixed(6)})" fill="${fill}">` +
    `\n    ${paths.join("\n    ")}` +
    `\n  </g>\n</svg>`
  );
}

export async function traceToSvg(
  input: Uint8Array,
  options: TraceOptions,
): Promise<TraceResult> {
  const { png, width, height, hadAlpha } = await preprocess(
    input,
    options.maxPixels,
  );

  let svg = await traceAsync(png, {
    threshold: options.threshold ?? 128,
    turdSize: options.turdSize ?? 2,
    optTolerance: options.optTolerance ?? 0.2,
    color: options.color ?? "#000000",
    background: options.background ?? "transparent",
  });

  let outW = width;
  let outH = height;
  if (options.targetWidth || options.targetHeight) {
    // One dimension given: the other follows the aspect ratio.
    outW =
      options.targetWidth ??
      Math.max(1, Math.round(options.targetHeight! * (width / height)));
    outH =
      options.targetHeight ??
      Math.max(1, Math.round(options.targetWidth! * (height / width)));
    svg = adaptToTargetSize(svg, width, height, outW, outH);
  }

  return {
    svg,
    width: outW,
    height: outH,
    originalWidth: width,
    originalHeight: height,
    preprocessed: hadAlpha,
  };
}
