import {
  ResourceStorage,
  ResourceData,
  ResourceContent,
  ResourceMetadata,
  ResourceType,
  MultiResourceWrite,
  MultiResourceUris,
} from './types.js';

/**
 * How much scraped content one process will hold, and how many entries.
 *
 * FORK DELTA — UPSTREAM'S CACHE IS UNBOUNDED, and for upstream that is right: it
 * is a stdio subprocess per client session, and the operating system reclaims it
 * when the session ends. In strad the same code runs inside a long-lived
 * container shared by every other mount in the bundle image, so "grows for the
 * process lifetime" is an out-of-memory kill that takes those mounts with it.
 *
 * The numbers are a budget, not a measurement: ~64MB is a few hundred cleaned
 * pages, small next to the container and large enough that ordinary reuse of a
 * URL still hits. Eviction is least-recently-USED (a read counts), so the page an
 * agent keeps coming back to is the last to go.
 */
const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface MemoryResourceStorageOptions {
  maxEntries?: number;
  maxBytes?: number;
}

interface Entry {
  data: ResourceData;
  content: string;
  bytes: number;
}

export class MemoryResourceStorage implements ResourceStorage {
  /**
   * Insertion order IS the recency order: a Map iterates in insertion order, so
   * `delete` + `set` on touch moves an entry to the end and the FIRST key is
   * always the least recently used.
   */
  private resources: Map<string, Entry> = new Map();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: MemoryResourceStorageOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /** What this store currently holds — the numbers the eviction policy acts on. */
  usage(): { entries: number; bytes: number } {
    return { entries: this.resources.size, bytes: this.bytes };
  }

  async list(): Promise<ResourceData[]> {
    return Array.from(this.resources.values()).map((r) => r.data);
  }

  async read(uri: string): Promise<ResourceContent> {
    const resource = this.resources.get(uri);
    if (!resource) {
      throw new Error(`Resource not found: ${uri}`);
    }

    // A read is a use: move it to the most-recent end so a page under active
    // reading is not evicted by a burst of one-off scrapes.
    this.resources.delete(uri);
    this.resources.set(uri, resource);

    return {
      uri,
      mimeType: resource.data.mimeType,
      text: resource.content,
    };
  }

  async write(url: string, content: string, metadata?: Partial<ResourceMetadata>): Promise<string> {
    const timestamp = new Date().toISOString();
    const resourceType = metadata?.resourceType || 'raw';
    const uri = this.generateUri(url, timestamp, resourceType);

    const fullMetadata: ResourceMetadata = {
      url,
      timestamp,
      resourceType,
      ...metadata,
    };

    const resourceData: ResourceData = {
      uri,
      name: this.generateName(url, timestamp, resourceType),
      description: metadata?.description || `Fetched content from ${url}`,
      mimeType: metadata?.contentType || 'text/plain',
      metadata: fullMetadata,
    };

    this.store(uri, {
      data: resourceData,
      content,
      bytes: Buffer.byteLength(content, 'utf8'),
    });

    return uri;
  }

  async writeMulti(data: MultiResourceWrite): Promise<MultiResourceUris> {
    const timestamp = new Date().toISOString();
    const uris: MultiResourceUris = {} as MultiResourceUris;

    // Save raw content
    uris.raw = await this.write(data.url, data.raw, {
      ...data.metadata,
      resourceType: 'raw',
      timestamp,
    });

    // Save cleaned content if provided.
    //
    // FORK DELTA — `contentType` is OVERRIDDEN here. The caller's metadata
    // describes what was fetched, so passing it through unchanged stored the
    // cleaned Markdown under the raw page's mime type (`text/html`): a
    // `resources/read` then described Markdown as HTML, and a cache hit disagreed
    // with the fresh scrape that produced it, which reports `text/markdown`.
    if (data.cleaned) {
      uris.cleaned = await this.write(data.url, data.cleaned, {
        ...data.metadata,
        resourceType: 'cleaned',
        contentType: 'text/markdown',
        timestamp,
      });
    }

    return uris;
  }

  async exists(uri: string): Promise<boolean> {
    return this.resources.has(uri);
  }

  async delete(uri: string): Promise<void> {
    const existing = this.resources.get(uri);
    if (!existing) {
      throw new Error(`Resource not found: ${uri}`);
    }
    this.bytes -= existing.bytes;
    this.resources.delete(uri);
  }

  async findByUrl(url: string): Promise<ResourceData[]> {
    const matchingResources = Array.from(this.resources.values())
      .filter((r) => r.data.metadata.url === url)
      .sort((a, b) => {
        // Sort by timestamp descending (most recent first)
        const timeA = new Date(a.data.metadata.timestamp).getTime();
        const timeB = new Date(b.data.metadata.timestamp).getTime();
        return timeB - timeA;
      })
      .map((r) => r.data);

    return matchingResources;
  }

  /**
   * Insert an entry and evict until the store is inside both budgets.
   *
   * A single entry larger than `maxBytes` is stored and then immediately evicted
   * by the loop, which leaves the store empty rather than over budget — the one
   * outcome that must not happen is holding something bigger than the budget
   * because it was too big to make room for.
   */
  private store(uri: string, entry: Entry): void {
    const previous = this.resources.get(uri);
    if (previous) this.bytes -= previous.bytes;
    this.resources.delete(uri);

    this.resources.set(uri, entry);
    this.bytes += entry.bytes;

    while (
      this.resources.size > 0 &&
      (this.resources.size > this.maxEntries || this.bytes > this.maxBytes)
    ) {
      const oldest = this.resources.keys().next().value as string;
      const evicted = this.resources.get(oldest)!;
      this.bytes -= evicted.bytes;
      this.resources.delete(oldest);
    }
  }

  private generateUri(url: string, timestamp: string, resourceType: ResourceType = 'raw'): string {
    const sanitizedUrl = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.-]/g, '_');
    const timestampPart = timestamp.replace(/[^0-9]/g, '');
    return `memory://${resourceType}/${sanitizedUrl}_${timestampPart}`;
  }

  private generateName(url: string, timestamp: string, resourceType: ResourceType = 'raw'): string {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const dateStr = new Date(timestamp).toISOString().split('T')[0];
    return `${resourceType}/${hostname}_${dateStr}`;
  }
}
