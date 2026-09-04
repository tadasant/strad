import { afterEach, describe, expect, it } from 'vitest';
import { MemoryResourceStorage } from '../src/storage/memory.js';
import { ResourceStorageFactory } from '../src/storage/factory.js';

/**
 * The resource cache is the other thing the hosting model changed.
 *
 * Upstream's store grows for the life of the process, which is right for a stdio
 * subprocess and an out-of-memory kill in a container that also hosts twenty
 * other mounts. These tests pin the bounds and the eviction order — the failure
 * they guard against has no symptom short of the container dying.
 */
describe('MemoryResourceStorage bounds', () => {
  it('evicts the least recently used entry over the entry cap', async () => {
    const store = new MemoryResourceStorage({ maxEntries: 2 });

    const a = await store.write('https://example.com/a', 'aaa');
    const b = await store.write('https://example.com/b', 'bbb');
    const c = await store.write('https://example.com/c', 'ccc');

    expect(await store.exists(a)).toBe(false);
    expect(await store.exists(b)).toBe(true);
    expect(await store.exists(c)).toBe(true);
    expect(store.usage().entries).toBe(2);
  });

  it('counts a READ as a use, so an actively-read page outlives a newer one', async () => {
    const store = new MemoryResourceStorage({ maxEntries: 2 });

    const a = await store.write('https://example.com/a', 'aaa');
    await store.write('https://example.com/b', 'bbb');
    await store.read(a); // a is now the most recent
    const c = await store.write('https://example.com/c', 'ccc');

    expect(await store.exists(a)).toBe(true);
    expect(await store.exists(c)).toBe(true);
  });

  it('evicts on the byte budget, not just the entry count', async () => {
    const store = new MemoryResourceStorage({ maxEntries: 100, maxBytes: 30 });

    await store.write('https://example.com/a', 'x'.repeat(20));
    const b = await store.write('https://example.com/b', 'y'.repeat(20));

    expect(store.usage().entries).toBe(1);
    expect(store.usage().bytes).toBe(20);
    expect(await store.exists(b)).toBe(true);
  });

  it('does not hold an entry that is larger than the whole budget', async () => {
    const store = new MemoryResourceStorage({ maxEntries: 10, maxBytes: 10 });

    const big = await store.write('https://example.com/big', 'z'.repeat(50));

    expect(await store.exists(big)).toBe(false);
    expect(store.usage()).toEqual({ entries: 0, bytes: 0 });
  });

  it('measures BYTES, not characters', async () => {
    const store = new MemoryResourceStorage();
    // Four astral-plane characters: 2 UTF-16 units each, 4 UTF-8 bytes each.
    await store.write('https://example.com/emoji', '😀😀😀😀');
    expect(store.usage().bytes).toBe(16);
  });

  it('gives the bytes back when an entry is deleted', async () => {
    const store = new MemoryResourceStorage();
    const uri = await store.write('https://example.com/a', 'aaaaa');
    expect(store.usage().bytes).toBe(5);

    await store.delete(uri);
    expect(store.usage()).toEqual({ entries: 0, bytes: 0 });
    await expect(store.delete(uri)).rejects.toThrow('Resource not found');
  });

  it('does not double-count a re-written URI', async () => {
    const store = new MemoryResourceStorage();
    const uri = await store.write('https://example.com/a', 'aaa');
    // Same URI: same url, same resourceType, same millisecond is not guaranteed,
    // so write through the private path the same way `store` would see a repeat.
    await store.write('https://example.com/a', 'aaa');
    const usage = store.usage();
    expect(usage.bytes).toBe(usage.entries * 3);
    expect(await store.exists(uri)).toBe(true);
  });
});

describe('MemoryResourceStorage content', () => {
  it('stores raw and cleaned under separate URIs and reads them back', async () => {
    const store = new MemoryResourceStorage();
    const uris = await store.writeMulti({
      url: 'https://example.com/a',
      raw: '<html>raw</html>',
      cleaned: '# cleaned',
      metadata: { contentType: 'text/html' },
    });

    expect(uris.raw).toContain('memory://raw/');
    expect(uris.cleaned).toContain('memory://cleaned/');
    expect((await store.read(uris.raw)).text).toBe('<html>raw</html>');
    expect((await store.read(uris.cleaned!)).text).toBe('# cleaned');
  });

  it('omits the cleaned resource when cleaning produced nothing', async () => {
    const store = new MemoryResourceStorage();
    const uris = await store.writeMulti({ url: 'https://example.com/a', raw: 'raw only' });
    expect(uris.cleaned).toBeUndefined();
    expect(store.usage().entries).toBe(1);
  });

  it('finds a URL and returns the most recent first', async () => {
    const store = new MemoryResourceStorage();
    // Distinct resource TYPES, because the URI a write mints is
    // `memory://<type>/<url>_<ms>` — two same-type writes of one URL inside the
    // same millisecond are the same URI, and the second replaces the first.
    await store.write('https://example.com/a', 'older', {
      resourceType: 'raw',
      timestamp: '2020-01-01T00:00:00.000Z',
    });
    await store.write('https://example.com/a', 'newer', {
      resourceType: 'cleaned',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    await store.write('https://example.com/other', 'unrelated');

    const found = await store.findByUrl('https://example.com/a');
    expect(found).toHaveLength(2);
    expect(found[0].metadata.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('throws a named error for a URI it does not hold', async () => {
    const store = new MemoryResourceStorage();
    await expect(store.read('memory://raw/nope')).rejects.toThrow('Resource not found');
  });
});

describe('ResourceStorageFactory', () => {
  afterEach(() => {
    ResourceStorageFactory.reset();
    delete process.env.STRAD_FETCH_CACHE_MAX_ENTRIES;
    delete process.env.STRAD_FETCH_CACHE_MAX_BYTES;
  });

  it('is one store per process', async () => {
    expect(await ResourceStorageFactory.create()).toBe(await ResourceStorageFactory.create());
  });

  it('honours the namespaced bounds', async () => {
    process.env.STRAD_FETCH_CACHE_MAX_ENTRIES = '1';
    const store = await ResourceStorageFactory.create();
    const a = await store.write('https://example.com/a', 'aaa');
    await store.write('https://example.com/b', 'bbb');
    expect(await store.exists(a)).toBe(false);
  });

  it.each(['0', '-5', 'lots', '1.5', ''])(
    'ignores a nonsense bound (%s) rather than storing nothing',
    async (value) => {
      process.env.STRAD_FETCH_CACHE_MAX_ENTRIES = value;
      const store = await ResourceStorageFactory.create();
      const uri = await store.write('https://example.com/a', 'aaa');
      expect(await store.exists(uri)).toBe(true);
    }
  );
});
