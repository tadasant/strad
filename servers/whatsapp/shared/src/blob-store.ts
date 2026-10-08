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
import { Storage, type StorageOptions } from "@google-cloud/storage";
import { errMessage, logWarning } from "./logging.js";

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

/**
 * GCS could not be reached cleanly, every time this process asked, within the
 * retry budget. The message is the whole caller-facing answer and carries none
 * of the transport's text (a URL, a library's wording); `cause` keeps it.
 */
export class TransientStoreError extends Error {
  constructor(operation: string, attempts: number, cause: unknown) {
    super(
      `Google Cloud Storage dropped the connection while this bridge was ` +
        `${operation} (${attempts} attempts). This is a transient network ` +
        `error, not a configuration problem: transient; retry the call.`,
      { cause },
    );
    this.name = "TransientStoreError";
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
  /**
   * Tests only: a local stand-in for the GCS JSON API. With a custom endpoint
   * the client sends no credentials, which is what lets the suite drive the
   * REAL client library end to end.
   */
  apiEndpoint?: string;
  /** Tests only: stands in for the service-account token fetch. */
  authClient?: StorageOptions["authClient"];
  /** Tests only: the transport-retry budget. */
  retry?: Partial<TransportRetry>;
}

export interface TransportRetry {
  /** Total tries, the first included. */
  attempts: number;
  /** The first backoff; each later one doubles, plus up to 50% jitter. */
  baseDelayMs: number;
}

/**
 * 4 tries over roughly two seconds. Enough to ride out a connection the far end
 * closed mid-response, and short enough that a tool call still answers well
 * inside a client's timeout when GCS is genuinely unreachable.
 */
export const DEFAULT_TRANSPORT_RETRY: TransportRetry = { attempts: 4, baseDelayMs: 250 };

const status = (err: unknown): number | undefined => {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
};

const TRANSIENT_CODES = new Set([
  "ERR_STREAM_PREMATURE_CLOSE",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);

const TRANSIENT_TEXT =
  /premature close|socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|network socket disconnected|other side closed|unexpected connection closure/i;

/**
 * A request that never got a whole answer: the connection closed mid-body, was
 * reset, or timed out. Anything carrying an HTTP status is NOT one of these —
 * GCS answered, and the client's own `autoRetry` already owns 429 and 5xx.
 *
 * Why this exists: the service-account token fetch (gtoken → gaxios 6 →
 * node-fetch 2) sits outside `autoRetry`, and the storage client's own
 * connection-problem test does not recognise node-fetch's `Premature close` on
 * an object read or write either. Either one surfaced to a caller as
 * "Invalid response body while trying to fetch …/oauth2/v4/token: Premature
 * close", and failed `whatsapp_pair` outright.
 */
export function isTransientTransportError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const o = e as {
      code?: unknown;
      status?: unknown;
      response?: { status?: unknown };
      message?: unknown;
      cause?: unknown;
      error?: unknown;
    };
    if (typeof o.code === "number" || typeof o.status === "number") return false;
    if (typeof o.response?.status === "number") return false;
    if (typeof o.code === "string" && TRANSIENT_CODES.has(o.code)) return true;
    if (typeof o.message === "string" && TRANSIENT_TEXT.test(o.message)) return true;
    e = o.cause ?? o.error;
  }
  return false;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GcsBlobStore implements BlobStore {
  private readonly storage: Storage;
  private readonly bucketName: string;
  private readonly retry: TransportRetry;

  constructor(options: GcsBlobStoreOptions) {
    this.bucketName = options.bucket;
    this.retry = { ...DEFAULT_TRANSPORT_RETRY, ...options.retry };
    this.storage = new Storage({
      ...(options.projectId ? { projectId: options.projectId } : {}),
      credentials: {
        client_email: options.clientEmail,
        private_key: options.privateKey,
      },
      retryOptions: { autoRetry: true, maxRetries: 3 },
      ...(options.apiEndpoint ? { apiEndpoint: options.apiEndpoint } : {}),
      ...(options.authClient
        ? { authClient: options.authClient, useAuthWithCustomEndpoint: true }
        : {}),
    });
  }

  /**
   * Every GCS call goes through here, so the token fetch each one may trigger
   * is covered with it. Retrying is safe for all four operations: a read and a
   * list change nothing, a delete is idempotent here (404 is success), an
   * unconditional write rewrites the same bytes, and a conditional write that
   * landed before its response was lost fails its own precondition on the
   * replay — which `StateStore` already answers by re-reading.
   */
  private async transport<T>(operation: string, call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (err) {
        if (!isTransientTransportError(err)) throw err;
        if (attempt >= this.retry.attempts) {
          throw new TransientStoreError(operation, attempt, err);
        }
        logWarning(
          `GCS ${operation}: transient transport error (try ${attempt}/` +
            `${this.retry.attempts}), retrying: ${errMessage(err)}`,
        );
        const backoff = this.retry.baseDelayMs * 2 ** (attempt - 1);
        await sleep(backoff + Math.random() * backoff * 0.5);
      }
    }
  }

  private file(name: string) {
    return this.storage.bucket(this.bucketName).file(name);
  }

  /**
   * The generation comes from the object's METADATA, and the bytes from a
   * download pinned to that generation. `download()` alone reads no metadata —
   * `file.metadata` stays empty — and a read that reported no generation would
   * make every later conditional write fail its precondition, forever.
   *
   * Pinned, so the bytes and the generation describe the same write. If the
   * object is replaced between the two calls the pinned download 404s, and the
   * read starts over.
   */
  async read(name: string): Promise<BlobRead | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let generation: string;
      try {
        const [metadata] = await this.transport(`reading ${name}`, () =>
          this.file(name).getMetadata(),
        );
        generation = String(metadata.generation ?? "");
      } catch (err) {
        if (status(err) === 404) return null;
        throw err;
      }
      if (!/^\d+$/.test(generation)) {
        throw new Error(`GCS returned no generation for ${name}`);
      }
      try {
        const [data] = await this.transport(`reading ${name}`, () =>
          this.storage
            .bucket(this.bucketName)
            .file(name, { generation: Number(generation) })
            .download(),
        );
        return { data, generation };
      } catch (err) {
        if (status(err) !== 404) throw err;
      }
    }
    throw new Error(`${name} kept changing while it was being read`);
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
      await this.transport(`writing ${name}`, () =>
        file.save(data, {
          resumable: false,
          contentType: "application/octet-stream",
          // A conditional write is safe to retry: a replay of one that landed
          // fails its own precondition rather than writing twice.
          ...(preconditionOpts ? { preconditionOpts } : {}),
          metadata: { cacheControl: "no-store" },
        }),
      );
    } catch (err) {
      if (status(err) === 412) throw new PreconditionFailed(name);
      throw err;
    }
    // A save DOES set `file.metadata` (the upload's response body).
    const generation = String(file.metadata?.generation ?? "");
    if (!/^\d+$/.test(generation)) {
      throw new Error(`GCS returned no generation after writing ${name}`);
    }
    return generation;
  }

  async delete(name: string): Promise<void> {
    try {
      await this.transport(`deleting ${name}`, () => this.file(name).delete());
    } catch (err) {
      if (status(err) !== 404) throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const [files] = await this.transport(`listing ${prefix}`, () =>
      this.storage.bucket(this.bucketName).getFiles({ prefix, autoPaginate: true }),
    );
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
