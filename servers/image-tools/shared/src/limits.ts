/**
 * Every bound this tree enforces, in one place.
 *
 * They are tight because of WHERE these servers run: one process in the bundle
 * container, beside two dozen other mounts and a shared Chromium on a 2GB
 * instance. The npx packages could take any file on the agent's disk because
 * the agent's machine was theirs alone; this one is not.
 */
export interface Limits {
  /** Largest image body accepted over the wire, in bytes. */
  maxBytes: number;
  /** One image fetch, connect to last byte, redirects included. */
  fetchTimeoutMs: number;
  /** Redirect hops followed before giving up. */
  maxRedirects: number;
  /**
   * Largest decoded image, in pixels. Checked from the header before decoding,
   * and again by sharp's `limitInputPixels` while decoding, so a small file
   * that claims huge dimensions (a decompression bomb) never allocates them.
   * A diff holds about forty bytes per pixel at peak — two RGBA copies, the
   * intensity map, the labels, the heatmap — so 10M pixels is ~400MB.
   */
  maxPixels: number;
  /** Wall clock for the CPU work of one call, in its worker. */
  jobTimeoutMs: number;
  /** How long a call may wait for a free worker before it is refused as busy. */
  queueTimeoutMs: number;
  /** Jobs that may run at once across BOTH servers in this process. */
  maxConcurrentJobs: number;
  /**
   * Calls that may WAIT for a job slot. A waiting call holds its fetched bytes
   * (up to 2 × maxBytes), so past this many it is refused as busy at once.
   */
  maxQueuedJobs: number;
  /** Longest edge of a PNG returned inline. Claude downsamples past ~1568px anyway. */
  maxImageEdge: number;
  /** Longest SVG returned inline, in characters. */
  maxSvgChars: number;
}

/**
 * The worst case is one fetch, one queue wait and one job: 30 + 20 + 60 = 110s.
 * That is kept UNDER core's default per-call `timeoutMs` of 120s, so a slow call
 * ends in one of this tree's own sentences — "Busy", "took longer than" —
 * rather than a bare gateway timeout.
 */
export const DEFAULT_LIMITS: Limits = {
  maxBytes: 25 * 1024 * 1024,
  fetchTimeoutMs: 30_000,
  maxRedirects: 5,
  maxPixels: 10_000_000,
  jobTimeoutMs: 60_000,
  queueTimeoutMs: 20_000,
  maxConcurrentJobs: 1,
  maxQueuedJobs: 2,
  maxImageEdge: 1568,
  maxSvgChars: 1_000_000,
};
