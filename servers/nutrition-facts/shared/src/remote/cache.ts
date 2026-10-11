/**
 * A bounded, expiring, in-process cache.
 *
 * In process, and so lost on every restart and not shared between bundle
 * instances: the bundle has no disk that outlives a deploy and no shared store.
 * That is acceptable because what it protects is a DAILY quota — a restart
 * costs at most the calls needed to re-warm it.
 *
 * The TTL is FatSecret's rule, not a tuning knob: its Terms (1.5) and storable
 * data guide allow nutrient values to be kept for at most 24 hours. Entries
 * expire at 23 hours, so no value is ever served at its limit.
 */

export const CACHE_TTL_MS = 23 * 60 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 2_000;

export class TtlCache<V> {
  private readonly map = new Map<string, { at: number; value: V }>();

  constructor(
    private readonly ttlMs = CACHE_TTL_MS,
    private readonly maxEntries = CACHE_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert: Map iteration order is insertion order, so this is the LRU touch.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { at: this.now(), value });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
