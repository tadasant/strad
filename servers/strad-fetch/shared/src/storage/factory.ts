import { ResourceStorage } from './types.js';
import { MemoryResourceStorage } from './memory.js';

/**
 * The one resource store, created once per process.
 *
 * FORK DELTA — THERE IS NO `filesystem` BACKEND HERE. Upstream picks between
 * memory and a directory on disk via `MCP_RESOURCE_STORAGE`. strad runs this in
 * an App Platform container with no persistent volume, so a filesystem store is
 * memory with extra steps and a slower failure mode; and `MCP_RESOURCE_*` is far
 * too generic a name to set on a box shared by every other mount in the bundle.
 * Both went away together. The bounds that replaced them are namespaced.
 */
const MAX_ENTRIES_ENV = 'STRAD_FETCH_CACHE_MAX_ENTRIES';
const MAX_BYTES_ENV = 'STRAD_FETCH_CACHE_MAX_BYTES';

/** A positive integer from the environment, or undefined — never NaN, never 0. */
function positiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

export class ResourceStorageFactory {
  private static instance: ResourceStorage | null = null;

  static async create(): Promise<ResourceStorage> {
    if (this.instance) {
      return this.instance;
    }

    this.instance = new MemoryResourceStorage({
      maxEntries: positiveInt(MAX_ENTRIES_ENV),
      maxBytes: positiveInt(MAX_BYTES_ENV),
    });

    return this.instance;
  }

  static reset(): void {
    this.instance = null;
  }
}
