/**
 * Where the bridge's state lives between processes: GCS, because strad has no
 * database and App Platform has no persistent disk.
 *
 * The interface is the seam the tests drive (`MemoryBlobStore`), and it carries
 * GENERATIONS because two processes can briefly hold the same account — an App
 * Platform deploy starts the new container before it stops the old one — and a
 * write that silently overwrote the other process's state is how a Signal
 * session gets corrupted without anybody seeing it. See `store.ts`.
 */
import { Storage } from "@google-cloud/storage";

export interface BlobRead {
  data: Buffer;
  /** Opaque. Pass back as `ifGeneration` to make a write conditional. */
  generation: string;
}

export class PreconditionFailed extends Error {
  constructor(name: string) {
    super(`${name} changed under this process`);
    this.name = "PreconditionFailed";
  }
}

export interface BlobStore {
  read(name: string): Promise<BlobRead | null>;
  /**
   * `ifGeneration`: `undefined` writes unconditionally; `null` writes only if
   * the object does not exist; a string writes only if the object is still at
   * that generation. A failed condition throws {@link PreconditionFailed}.
   */
  write(
    name: string,
    data: Buffer,
    ifGeneration?: string | null,
  ): Promise<string>;
  delete(name: string): Promise<void>;
  /** Every object name under `prefix`. */
  list(prefix: string): Promise<string[]>;
}

export interface GcsBlobStoreOptions {
  bucket: string;
  clientEmail: string;
  privateKey: string;
  projectId?: string;
}

const status = (err: unknown): number | undefined => {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
};

export class GcsBlobStore implements BlobStore {
  private readonly storage: Storage;
  private readonly bucketName: string;

  constructor(options: GcsBlobStoreOptions) {
    this.bucketName = options.bucket;
    this.storage = new Storage({
      ...(options.projectId ? { projectId: options.projectId } : {}),
      credentials: {
        client_email: options.clientEmail,
        private_key: options.privateKey,
      },
      retryOptions: { autoRetry: true, maxRetries: 3 },
    });
  }

  private file(name: string) {
    return this.storage.bucket(this.bucketName).file(name);
  }

  async read(name: string): Promise<BlobRead | null> {
    try {
      const file = this.file(name);
      const [data] = await file.download();
      const generation = String(file.metadata?.generation ?? "");
      return { data, generation };
    } catch (err) {
      if (status(err) === 404) return null;
      throw err;
    }
  }

  async write(
    name: string,
    data: Buffer,
    ifGeneration?: string | null,
  ): Promise<string> {
    const file = this.file(name);
    const preconditionOpts =
      ifGeneration === undefined
        ? undefined
        : { ifGenerationMatch: ifGeneration === null ? 0 : Number(ifGeneration) };
    try {
      await file.save(data, {
        resumable: false,
        contentType: "application/octet-stream",
        // A conditional write is safe to retry: a replay of one that landed
        // fails its own precondition rather than writing twice.
        ...(preconditionOpts ? { preconditionOpts } : {}),
        metadata: { cacheControl: "no-store" },
      });
    } catch (err) {
      if (status(err) === 412) throw new PreconditionFailed(name);
      throw err;
    }
    return String(file.metadata?.generation ?? "");
  }

  async delete(name: string): Promise<void> {
    try {
      await this.file(name).delete();
    } catch (err) {
      if (status(err) !== 404) throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const [files] = await this.storage
      .bucket(this.bucketName)
      .getFiles({ prefix, autoPaginate: true });
    return files.map((f) => f.name);
  }
}

/** The test double, and a faithful one: generations and preconditions included. */
export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, { data: Buffer; generation: number }>();
  private counter = 0;
  writes = 0;

  async read(name: string): Promise<BlobRead | null> {
    const obj = this.objects.get(name);
    return obj
      ? { data: Buffer.from(obj.data), generation: String(obj.generation) }
      : null;
  }

  async write(
    name: string,
    data: Buffer,
    ifGeneration?: string | null,
  ): Promise<string> {
    const current = this.objects.get(name);
    if (ifGeneration === null && current) throw new PreconditionFailed(name);
    if (
      typeof ifGeneration === "string" &&
      (!current || String(current.generation) !== ifGeneration)
    ) {
      throw new PreconditionFailed(name);
    }
    const generation = ++this.counter;
    this.objects.set(name, { data: Buffer.from(data), generation });
    this.writes++;
    return String(generation);
  }

  async delete(name: string): Promise<void> {
    this.objects.delete(name);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
