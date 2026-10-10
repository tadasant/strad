/**
 * A 2D complex FFT, radix-2, over separate real and imaginary Float64Arrays.
 * Enough to cross-correlate two images in O(N log N), which is all
 * `alignment.ts` needs it for. Both dimensions must be powers of two.
 *
 * Rows are transformed in place; columns by transposing, transforming rows and
 * transposing back, because a strided column pass is cache-hostile enough to
 * double the cost at screenshot sizes.
 */

interface Plan {
  n: number;
  rev: Uint32Array;
  cos: Float64Array;
  sin: Float64Array;
}

function plan(n: number): Plan {
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n >> 1);
  const sin = new Float64Array(n >> 1);
  for (let k = 0; k < n >> 1; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }
  return { n, rev, cos, sin };
}

/** Each row of a `rows`×`p.n` image, transformed in place. */
function fftRows(
  re: Float64Array,
  im: Float64Array,
  rows: number,
  p: Plan,
  inverse: boolean,
): void {
  const { n, rev, cos, sin } = p;
  const sign = inverse ? 1 : -1;
  for (let row = 0; row < rows; row++) {
    const o = row * n;
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (i < j) {
        let t = re[o + i]!;
        re[o + i] = re[o + j]!;
        re[o + j] = t;
        t = im[o + i]!;
        im[o + i] = im[o + j]!;
        im[o + j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step]!;
          const wi = sign * sin[k * step]!;
          const a = o + i + k;
          const b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
  }
  if (inverse) {
    const s = 1 / n;
    for (let i = 0; i < rows * n; i++) {
      re[i] = re[i]! * s;
      im[i] = im[i]! * s;
    }
  }
}

function transpose(
  src: Float64Array,
  dst: Float64Array,
  w: number,
  h: number,
): void {
  const B = 32;
  for (let y0 = 0; y0 < h; y0 += B) {
    for (let x0 = 0; x0 < w; x0 += B) {
      const y1 = Math.min(h, y0 + B);
      const x1 = Math.min(w, x0 + B);
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) dst[x * h + y] = src[y * w + x]!;
    }
  }
}

/** In-place 2D FFT of a `w`×`h` row-major complex image. */
export function fft2d(
  re: Float64Array,
  im: Float64Array,
  w: number,
  h: number,
  inverse = false,
): void {
  fftRows(re, im, h, plan(w), inverse);
  const tRe = new Float64Array(w * h);
  const tIm = new Float64Array(w * h);
  transpose(re, tRe, w, h);
  transpose(im, tIm, w, h);
  fftRows(tRe, tIm, w, plan(h), inverse);
  transpose(tRe, re, h, w);
  transpose(tIm, im, h, w);
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
