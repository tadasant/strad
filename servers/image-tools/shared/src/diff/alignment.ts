/**
 * Alignment for images of different sizes: find where the smaller image (a
 * Figma mock of one component, say) sits inside the larger one (a full-page
 * screenshot).
 *
 * Upstream ran OpenCV's `matchTemplate` through `opencv-wasm` on a DOWNSCALED
 * pair and refined around the one best hit. This is the same measure —
 * zero-mean normalised cross-correlation (TM_CCOEFF_NORMED) — computed the way
 * OpenCV computes it internally: the numerator for EVERY position at once by FFT
 * cross-correlation, the window variances from integral images. That makes the
 * search exhaustive at full resolution for any scene whose padded FFT fits
 * `MAX_FFT_POINTS`, which is the case that matters: a downscaled search over a
 * page of TEXT, where every line resembles the next, locked onto the wrong line
 * in two of three trials. Past that size the scene is downscaled only as far as
 * needed, and the best few distinct hits are refined at full resolution.
 */
import { fft2d, nextPow2 } from "./fft.js";

export interface RawImage {
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
  width: number;
  height: number;
}

export interface AlignmentResult {
  x: number;
  y: number;
  /** (zncc + 1) / 2, in [0, 1]. */
  confidence: number;
  strategy: string;
  timeMs: number;
}

/**
 * Largest padded FFT, in points. The correlation holds six Float64 planes of
 * this size at peak (two spectra, real and imaginary, plus the transpose
 * scratch), so 2M points is ~96MB. A 1280×900 screenshot fits at full
 * resolution; a full-page one is downscaled by 2-3 and refined.
 */
const MAX_FFT_POINTS = 1 << 21;

/**
 * Multiply-adds the full-resolution refinement may spend. Past it, the
 * refinement samples every `stride`-th template row and column — enough to
 * choose among positions a few pixels apart, at a bounded cost.
 */
const REFINE_WORK_BUDGET = 2e8;

/** Coarse hits refined at full resolution, when the search had to downscale. */
const COARSE_CANDIDATES = 5;

interface Plane {
  gray: Float32Array;
  width: number;
  height: number;
}

interface Hit {
  x: number;
  y: number;
  score: number;
}

/** Larger by pixel count is the scene; the other is the template. */
export function orderBySize(
  img1: RawImage,
  img2: RawImage,
): { scene: RawImage; template: RawImage; swapped: boolean } {
  return img1.width * img1.height >= img2.width * img2.height
    ? { scene: img1, template: img2, swapped: false }
    : { scene: img2, template: img1, swapped: true };
}

/** ITU-R BT.601 luminance. */
export function toGrayscale(
  data: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const len = width * height;
  const gray = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const p = i * 4;
    gray[i] = data[p]! * 0.299 + data[p + 1]! * 0.587 + data[p + 2]! * 0.114;
  }
  return gray;
}

/** Box-average downscale by an integer factor. */
function downscale(plane: Plane, factor: number): Plane {
  const w = Math.max(1, Math.floor(plane.width / factor));
  const h = Math.max(1, Math.floor(plane.height / factor));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * plane.width + x * factor;
        for (let dx = 0; dx < factor; dx++) sum += plane.gray[row + dx]!;
      }
      out[y * w + x] = sum / (factor * factor);
    }
  }
  return { gray: out, width: w, height: h };
}

/** Integral images of the values and their squares, (w+1)×(h+1), Float64. */
function integrals(plane: Plane) {
  const { gray, width, height } = plane;
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  const sq = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSq = 0;
    for (let x = 0; x < width; x++) {
      const v = gray[y * width + x]!;
      rowSum += v;
      rowSq += v * v;
      sum[(y + 1) * stride + x + 1] = sum[y * stride + x + 1]! + rowSum;
      sq[(y + 1) * stride + x + 1] = sq[y * stride + x + 1]! + rowSq;
    }
  }
  return { sum, sq, stride };
}

/**
 * Keep the best `k` hits that are at least `apart` from each other in both
 * axes, so the candidates are distinct places rather than one peak's shoulders.
 */
function offer(best: Hit[], hit: Hit, k: number, apart: number): void {
  if (best.length === k && hit.score <= best[k - 1]!.score) return;
  const near = best.findIndex(
    (b) => Math.abs(b.x - hit.x) < apart && Math.abs(b.y - hit.y) < apart,
  );
  if (near >= 0) {
    if (best[near]!.score >= hit.score) return;
    best.splice(near, 1);
  }
  let at = best.findIndex((b) => b.score < hit.score);
  if (at < 0) at = best.length;
  best.splice(at, 0, hit);
  if (best.length > k) best.pop();
}

/** The zero-mean template and its norm. */
function centre(template: Plane): { centred: Float32Array; norm: number } {
  const n = template.width * template.height;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += template.gray[i]!;
  mean /= n;
  const centred = new Float32Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    const c = template.gray[i]! - mean;
    centred[i] = c;
    v += c * c;
  }
  return { centred, norm: Math.sqrt(v) };
}

/**
 * Every position's ZNCC, by FFT: the best `k` distinct hits.
 *
 * corr(x, y) = Σ scene(x+i, y+j)·t'(i, j), with t' the zero-mean template, is
 * the inverse FFT of FFT(scene)·conj(FFT(t')). The template sits at the origin
 * and the planes are padded to at least the scene's size, so a valid position
 * never reads a wrapped-around pixel. Centring the scene as well changes
 * nothing (Σt' = 0) but keeps the products, and the float error, small.
 */
function correlateAll(scene: Plane, template: Plane, k: number): Hit[] {
  const { width: sw, height: sh } = scene;
  const { width: tw, height: th } = template;
  const pw = nextPow2(sw);
  const ph = nextPow2(sh);
  const n = tw * th;
  const { centred, norm } = centre(template);

  let sMean = 0;
  for (let i = 0; i < sw * sh; i++) sMean += scene.gray[i]!;
  sMean /= sw * sh;

  const aRe = new Float64Array(pw * ph);
  const aIm = new Float64Array(pw * ph);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++)
      aRe[y * pw + x] = scene.gray[y * sw + x]! - sMean;
  const bRe = new Float64Array(pw * ph);
  const bIm = new Float64Array(pw * ph);
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) bRe[y * pw + x] = centred[y * tw + x]!;

  fft2d(aRe, aIm, pw, ph);
  fft2d(bRe, bIm, pw, ph);
  for (let i = 0; i < pw * ph; i++) {
    const re = aRe[i]! * bRe[i]! + aIm[i]! * bIm[i]!;
    const im = aIm[i]! * bRe[i]! - aRe[i]! * bIm[i]!;
    aRe[i] = re;
    aIm[i] = im;
  }
  fft2d(aRe, aIm, pw, ph, true);

  const { sum, sq, stride } = integrals(scene);
  const apart = Math.max(2, Math.min(tw, th) >> 1);
  const best: Hit[] = [];
  for (let y = 0; y <= sh - th; y++) {
    for (let x = 0; x <= sw - tw; x++) {
      const a = y * stride + x;
      const c = (y + th) * stride + x;
      const s = sum[c + tw]! - sum[a + tw]! - sum[c]! + sum[a]!;
      const s2 = sq[c + tw]! - sq[a + tw]! - sq[c]! + sq[a]!;
      const sVar = s2 - (s * s) / n;
      // Below this the window is flat for practical purposes, and the FFT's
      // float error would otherwise be divided by almost nothing.
      const score =
        sVar > 1e-3 * n && norm > 1e-6
          ? aRe[y * pw + x]! / (Math.sqrt(sVar) * norm)
          : 0;
      offer(best, { x, y, score }, k, apart);
    }
  }
  return best;
}

/**
 * The best ZNCC in a small window of positions, computed directly over every
 * `stride`-th template row and column.
 */
function refine(
  scene: Plane,
  template: Plane,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  stride: number,
): Hit {
  const { width: tw, height: th } = template;
  let n = 0;
  let mean = 0;
  for (let ty = 0; ty < th; ty += stride) {
    for (let tx = 0; tx < tw; tx += stride) {
      mean += template.gray[ty * tw + tx]!;
      n++;
    }
  }
  mean /= n;
  let tVar = 0;
  for (let ty = 0; ty < th; ty += stride) {
    for (let tx = 0; tx < tw; tx += stride)
      tVar += (template.gray[ty * tw + tx]! - mean) ** 2;
  }
  const norm = Math.sqrt(tVar);
  let best: Hit = { x: x0, y: y0, score: -Infinity };
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let s = 0;
      let s2 = 0;
      let num = 0;
      for (let ty = 0; ty < th; ty += stride) {
        const row = (y + ty) * scene.width + x;
        for (let tx = 0; tx < tw; tx += stride) {
          const v = scene.gray[row + tx]!;
          s += v;
          s2 += v * v;
          num += v * (template.gray[ty * tw + tx]! - mean);
        }
      }
      const sVar = s2 - (s * s) / n;
      const score =
        sVar > 1e-6 && norm > 1e-6 ? num / (Math.sqrt(sVar) * norm) : 0;
      if (score > best.score) best = { x, y, score };
    }
  }
  return best;
}

export function alignImages(
  scene: RawImage,
  template: RawImage,
): AlignmentResult {
  const start = performance.now();
  if (template.width > scene.width || template.height > scene.height) {
    throw new Error(
      `Cannot align: the smaller image (${template.width}x${template.height}) is larger than the ` +
        `other (${scene.width}x${scene.height}) in one dimension, so it cannot sit inside it. ` +
        `Crop or resize one image so the smaller fits inside the larger.`,
    );
  }
  const sceneGray: Plane = {
    gray: toGrayscale(scene.data, scene.width, scene.height),
    width: scene.width,
    height: scene.height,
  };
  const templateGray: Plane = {
    gray: toGrayscale(template.data, template.width, template.height),
    width: template.width,
    height: template.height,
  };

  // Downscale only as far as the padded FFT needs. At full resolution the
  // search is exhaustive and exact, and the refinement below only re-scores it.
  let factor = 1;
  while (
    nextPow2(Math.floor(scene.width / factor)) *
      nextPow2(Math.floor(scene.height / factor)) >
    MAX_FFT_POINTS
  ) {
    factor++;
  }
  // A template a few downscaled pixels across has nothing left to correlate:
  // every score would be 0 and the answer the top-left corner, stated
  // confidently. Refuse instead.
  if (factor > 1 && Math.min(template.width, template.height) < factor * 4) {
    throw new Error(
      `Cannot align: the smaller image (${template.width}x${template.height}) is too small to locate ` +
        `inside one this large (${scene.width}x${scene.height}). Crop the larger image to the region ` +
        `around it first.`,
    );
  }

  const coarse =
    factor === 1
      ? correlateAll(sceneGray, templateGray, 1)
      : correlateAll(
          downscale(sceneGray, factor),
          downscale(templateGray, factor),
          COARSE_CANDIDATES,
        ).map((h) => ({ ...h, x: h.x * factor, y: h.y * factor }));

  const maxX = scene.width - template.width;
  const maxY = scene.height - template.height;
  // Downscaled, the window covers the rounding of a coarse coordinate.
  const radius = factor === 1 ? 0 : factor + 1;
  const work =
    coarse.length * (2 * radius + 1) ** 2 * template.width * template.height;
  const stride = Math.max(1, Math.ceil(Math.sqrt(work / REFINE_WORK_BUDGET)));
  let best: Hit = { x: 0, y: 0, score: -Infinity };
  for (const c of coarse) {
    const hit = refine(
      sceneGray,
      templateGray,
      Math.max(0, c.x - radius),
      Math.min(maxX, c.x + radius),
      Math.max(0, c.y - radius),
      Math.min(maxY, c.y + radius),
      stride,
    );
    if (hit.score > best.score) best = hit;
  }
  const score = Number.isFinite(best.score) ? best.score : 0;

  return {
    x: best.x,
    y: best.y,
    confidence:
      Math.round(Math.max(0, Math.min(1, (score + 1) / 2)) * 1000) / 1000,
    strategy: factor === 1 ? "zncc-fft" : `zncc-fft-1/${factor}+refine`,
    timeMs: Math.round(performance.now() - start),
  };
}
