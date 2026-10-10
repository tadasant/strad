/**
 * Connected Component Labeling: adjacent diff pixels become clusters, each with
 * a bounding box and statistics, and nearby clusters are merged by gap.
 *
 * Ported from `@pulsemcp/image-diff-mcp-server`. Two deltas, both bounds:
 *
 *  - MERGING IS CAPPED at `MAX_MERGE_CLUSTERS`. Upstream merges with an
 *    all-pairs scan that restarts after every merge and materialises every
 *    pairwise distance. On a noisy diff that is tens of thousands of clusters,
 *    i.e. billions of distances, in a process that hosts every other bundle
 *    mount. Past the cap the largest clusters are kept and the rest are counted
 *    in `clustering.droppedClusters` rather than silently lost.
 *  - A MERGE PASS IS ONE ALL-PAIRS UNION, repeated until stable, rather than a
 *    restart per merge. The fixed point is the same: boxes grow when merged, so
 *    a box that only came within the gap after a merge is caught next pass.
 */

export type Severity = "trivial" | "minor" | "moderate" | "major";

export interface DiffCluster {
  id: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  pixelCount: number;
  areaPercentage: number;
  meanIntensity: number;
  maxIntensity: number;
  severity: Severity;
}

export interface ClusteringMeta {
  gapUsed: number;
  autoGap: boolean;
  suggestedSmallerGap: number | null;
  suggestedLargerGap: number | null;
  /** Clusters under `minClusterSize`, or past the merge cap, that were not reported. */
  droppedClusters: number;
}

export interface ClusteringResult {
  clusters: DiffCluster[];
  clusteringMeta: ClusteringMeta;
}

/** The most clusters the gap merge and the natural-gap analysis will consider. */
export const MAX_MERGE_CLUSTERS = 2000;

interface Stats {
  left: number;
  top: number;
  right: number;
  bottom: number;
  pixelCount: number;
  totalIntensity: number;
  maxIntensity: number;
}

/**
 * @param clusterGap undefined = auto (natural breaks), 0 = no merging, >0 = explicit.
 */
export function findDiffClusters(
  intensityMap: Float32Array,
  width: number,
  height: number,
  minClusterSize = 1,
  clusterGap?: number,
): ClusteringResult {
  const len = width * height;
  const labels = new Int32Array(len);
  // TYPED ARRAYS, not `number[]` and an object per component. A noisy diff — a
  // dither, JPEG against PNG, a low threshold — is millions of isolated pixels,
  // and one JS object each ran the worker's heap out of memory well under the
  // pixel limit. These grow by doubling and live off the JS heap.
  let parent = new Int32Array(1024);
  let nextLabel = 1;

  // Pass 1: provisional labels, 8-connectivity (NW, N, NE, W already scanned).
  const neighbors: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (intensityMap[i]! <= 0) continue;
      neighbors.length = 0;
      if (y > 0) {
        if (x > 0) pushLabel(neighbors, labels[i - width - 1]!);
        pushLabel(neighbors, labels[i - width]!);
        if (x < width - 1) pushLabel(neighbors, labels[i - width + 1]!);
      }
      if (x > 0) pushLabel(neighbors, labels[i - 1]!);

      if (neighbors.length === 0) {
        if (nextLabel >= parent.length) {
          const grown = new Int32Array(parent.length * 2);
          grown.set(parent);
          parent = grown;
        }
        parent[nextLabel] = nextLabel;
        labels[i] = nextLabel;
        nextLabel++;
      } else {
        let minLabel = Infinity;
        for (const n of neighbors)
          minLabel = Math.min(minLabel, find(parent, n));
        labels[i] = minLabel;
        for (const n of neighbors) union(parent, minLabel, n);
      }
    }
  }

  // Pass 2: statistics per root label, in parallel typed arrays.
  const n = nextLabel;
  const left = new Int32Array(n).fill(width);
  const top = new Int32Array(n).fill(height);
  const right = new Int32Array(n).fill(-1);
  const bottom = new Int32Array(n).fill(-1);
  const count = new Int32Array(n);
  const total = new Float64Array(n);
  const peak = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (labels[i]! <= 0) continue;
      const r = find(parent, labels[i]!);
      const v = intensityMap[i]!;
      if (x < left[r]!) left[r] = x;
      if (y < top[r]!) top[r] = y;
      if (x > right[r]!) right[r] = x;
      if (y > bottom[r]!) bottom[r] = y;
      count[r]!++;
      total[r]! += v;
      if (v > peak[r]!) peak[r] = v;
    }
  }

  // Filter, and cap, BEFORE building an object per cluster.
  let roots = 0;
  let kept = 0;
  const keep = new Int32Array(n);
  for (let r = 1; r < n; r++) {
    if (count[r]! === 0) continue;
    roots++;
    if (count[r]! >= minClusterSize) keep[kept++] = r;
  }
  let chosen = keep.subarray(0, kept);
  if (kept > MAX_MERGE_CLUSTERS) {
    chosen = chosen
      .sort((a, b) => count[b]! - count[a]!)
      .subarray(0, MAX_MERGE_CLUSTERS);
  }
  const droppedClusters = roots - chosen.length;
  let stats: Stats[] = Array.from(chosen, (r) => ({
    left: left[r]!,
    top: top[r]!,
    right: right[r]!,
    bottom: bottom[r]!,
    pixelCount: count[r]!,
    totalIntensity: total[r]!,
    maxIntensity: peak[r]!,
  }));

  const autoGap = clusterGap === undefined;
  let effectiveGap: number;
  let distances: number[] = [];
  if (autoGap && stats.length > 1) {
    const natural = computeNaturalGap(stats, width, height);
    effectiveGap = natural.naturalGap;
    distances = natural.distances;
  } else {
    effectiveGap = clusterGap ?? 0;
  }

  if (effectiveGap > 0 && stats.length > 1)
    stats = mergeByGap(stats, effectiveGap);

  const clusters: DiffCluster[] = stats.map((s) => {
    const meanIntensity = s.totalIntensity / s.pixelCount;
    const areaPercentage = (s.pixelCount / len) * 100;
    return {
      id: 0,
      left: s.left,
      top: s.top,
      right: s.right,
      bottom: s.bottom,
      width: s.right - s.left + 1,
      height: s.bottom - s.top + 1,
      pixelCount: s.pixelCount,
      areaPercentage: round3(areaPercentage),
      meanIntensity: round3(meanIntensity),
      maxIntensity: round3(s.maxIntensity),
      severity: classifySeverity(areaPercentage, meanIntensity),
    };
  });
  clusters.sort((a, b) => b.pixelCount - a.pixelCount);
  clusters.forEach((c, i) => (c.id = i + 1));

  return {
    clusters,
    clusteringMeta: {
      ...gapSuggestions(effectiveGap, distances),
      autoGap,
      droppedClusters,
    },
  };
}

function pushLabel(into: number[], label: number): void {
  if (label > 0) into.push(label);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Chebyshev edge-to-edge distance between boxes; 0 when they overlap or touch. */
function boxDistance(a: Stats, b: Stats): number {
  const horiz = Math.max(
    0,
    Math.max(a.left, b.left) - Math.min(a.right, b.right) - 1,
  );
  const vert = Math.max(
    0,
    Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom) - 1,
  );
  return Math.max(horiz, vert);
}

function mergeByGap(input: Stats[], gap: number): Stats[] {
  let current = input;
  for (;;) {
    const p = current.map((_, i) => i);
    let merged = false;
    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        if (boxDistance(current[i]!, current[j]!) <= gap) {
          const ri = find(p, i);
          const rj = find(p, j);
          if (ri !== rj) {
            p[rj] = ri;
            merged = true;
          }
        }
      }
    }
    if (!merged) return current;
    const groups = new Map<number, Stats>();
    current.forEach((s, i) => {
      const root = find(p, i);
      const g = groups.get(root);
      if (!g) {
        groups.set(root, { ...s });
        return;
      }
      g.left = Math.min(g.left, s.left);
      g.top = Math.min(g.top, s.top);
      g.right = Math.max(g.right, s.right);
      g.bottom = Math.max(g.bottom, s.bottom);
      g.pixelCount += s.pixelCount;
      g.totalIntensity += s.totalIntensity;
      g.maxIntensity = Math.max(g.maxIntensity, s.maxIntensity);
    });
    current = [...groups.values()];
  }
}

/**
 * The "natural gap": each cluster's distance to its nearest neighbour, sorted,
 * cut at the largest jump (when the jump is at least 2px). With no clear break —
 * uniformly spread diffs like a font change — fall back to 3% of the smaller
 * image dimension, clamped to [5, 50].
 */
function computeNaturalGap(
  stats: Stats[],
  imageWidth: number,
  imageHeight: number,
): { naturalGap: number; distances: number[] } {
  const distances: number[] = [];
  const nearest = new Array<number>(stats.length).fill(Infinity);
  for (let i = 0; i < stats.length; i++) {
    for (let j = i + 1; j < stats.length; j++) {
      const d = boxDistance(stats[i]!, stats[j]!);
      distances.push(d);
      if (d < nearest[i]!) nearest[i] = d;
      if (d < nearest[j]!) nearest[j] = d;
    }
  }
  const nn = nearest.filter((d) => d !== Infinity).sort((a, b) => a - b);
  const dimensionGap = Math.max(
    5,
    Math.min(50, Math.round(Math.min(imageWidth, imageHeight) * 0.03)),
  );

  if (nn.length <= 1) {
    return {
      naturalGap: nn.length === 1 ? Math.min(nn[0]!, dimensionGap) : 0,
      distances,
    };
  }
  if (nn[nn.length - 1] === 0) return { naturalGap: 0, distances };

  let bestJumpIdx = -1;
  let bestJumpSize = 0;
  for (let i = 0; i < nn.length - 1; i++) {
    const jump = nn[i + 1]! - nn[i]!;
    if (jump > bestJumpSize) {
      bestJumpSize = jump;
      bestJumpIdx = i;
    }
  }
  if (bestJumpIdx >= 0 && bestJumpSize >= 2)
    return { naturalGap: nn[bestJumpIdx]!, distances };
  return { naturalGap: dimensionGap, distances };
}

/** The next natural step in each direction from the gap used. */
function gapSuggestions(
  gapUsed: number,
  distances: number[],
): Pick<
  ClusteringMeta,
  "gapUsed" | "suggestedSmallerGap" | "suggestedLargerGap"
> {
  let suggestedSmallerGap: number | null = null;
  let suggestedLargerGap: number | null = null;
  if (distances.length > 0) {
    const unique = [...new Set(distances)].sort((a, b) => a - b);
    for (let i = unique.length - 1; i >= 0; i--) {
      if (unique[i]! < gapUsed) {
        suggestedSmallerGap = unique[i]!;
        break;
      }
    }
    if (suggestedSmallerGap === null && gapUsed > 0) suggestedSmallerGap = 0;
    suggestedLargerGap = unique.find((d) => d > gapUsed) ?? null;
  }
  return { gapUsed, suggestedSmallerGap, suggestedLargerGap };
}

/** Area weight + intensity weight. Area >1% is significant; intensity >0.3 moderate. */
function classifySeverity(
  areaPercentage: number,
  meanIntensity: number,
): Severity {
  const score = areaPercentage * 10 + meanIntensity * 50;
  if (score >= 30) return "major";
  if (score >= 10) return "moderate";
  if (score >= 3) return "minor";
  return "trivial";
}

function find(parent: Int32Array | number[], x: number): number {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]!]!;
    x = parent[x]!;
  }
  return x;
}

function union(parent: Int32Array, a: number, b: number): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) parent[rb] = ra;
}
