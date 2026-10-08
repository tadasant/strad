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
import { createSign, randomBytes } from "node:crypto";
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
 * GCS could not be reached cleanly — the connection dropped, or it answered
 * 408, 429 or 5xx — every time this process asked, within the retry budget. The message is the whole caller-facing answer and carries none
 * of the transport's text (a URL, a library's wording); `cause` keeps it.
 */
export class TransientStoreError extends Error {
  constructor(operation: string, attempts: number, cause: unknown) {
    super(
      `Google Cloud Storage did not answer cleanly while this bridge was ` +
        `${operation} (${attempts} attempts). This is a transient error, not ` +
        `a configuration problem: transient; retry the call.`,
      { cause },
    );
    this.name = "TransientStoreError";
  }
}

/**
 * GCS, or Google's token endpoint, answered with a non-2xx status. `code` is
 * the status, as a number — which is what tells {@link isTransientTransportError}
 * that the far end DID answer.
 */
export class GcsHttpError extends Error {
  constructor(
    readonly code: number,
    what: string,
    detail: string,
  ) {
    super(`${what}: HTTP ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "GcsHttpError";
  }
}

/**
 * The service-account token request failed, so the object request it was for
 * was never sent. That is what makes an unconditional write safe to replay.
 */
export class TokenFetchFailed extends Error {
  constructor(cause: unknown) {
    super(`the service-account token request failed: ${errMessage(cause)}`, { cause });
    this.name = "TokenFetchFailed";
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
  /**
   * Tests only: a local stand-in for the GCS JSON API, serving both the
   * `/storage/v1` and `/upload/storage/v1` paths.
   */
  apiEndpoint?: string;
  /** Tests only: a local stand-in for Google's OAuth 2.0 token endpoint. */
  tokenUrl?: string;
  /** Tests only: the transport-retry budget. */
  retry?: Partial<TransportRetry>;
}

export interface TransportRetry {
  /** Total tries, the first included. */
  attempts: number;
  /** The first backoff; each later one doubles, plus up to 50% jitter. */
  baseDelayMs: number;
  /** No new try starts once this long has passed since the first. */
  deadlineMs: number;
  /**
   * One request, response body included. undici's own limits are minutes long,
   * and a call that hangs holds the tool call that is waiting on it.
   */
  requestTimeoutMs: number;
}

/**
 * Up to 4 tries, 250 ms backoff doubling, and no new try after 15 s. Enough to
 * ride out a connection the far end closed mid-response; a GCS that stays
 * unreachable still fails the call rather than holding it for minutes.
 */
export const DEFAULT_TRANSPORT_RETRY: TransportRetry = {
  attempts: 4,
  baseDelayMs: 250,
  deadlineMs: 15_000,
  requestTimeoutMs: 30_000,
};

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GCS_API = "https://storage.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";
/** A token is refreshed this long before Google says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** The statuses GCS documents as retryable. Only ever on a replayable call. */
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const TRANSIENT_CODES = new Set([
  "ERR_STREAM_PREMATURE_CLOSE",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** `AbortSignal.timeout()` rejects with a DOMException named `TimeoutError`. */
const TRANSIENT_NAMES = new Set(["TimeoutError"]);

const TRANSIENT_TEXT =
  /premature close|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|network timeout at|network socket disconnected|other side closed|unexpected connection closure/i;

type ErrLike = {
  code?: unknown;
  status?: unknown;
  response?: { status?: unknown };
  message?: unknown;
  name?: unknown;
  cause?: unknown;
  error?: unknown;
};

/**
 * A request that never got a whole answer: the connection closed mid-body, was
 * reset, or timed out. Anything carrying an HTTP status is NOT one of these —
 * GCS answered. Walks `cause`, because native fetch reports every one of these
 * as `TypeError: fetch failed` or `TypeError: terminated` with the socket's
 * error, and its code, underneath.
 */
export function isTransientTransportError(err: unknown): boolean {
  if (httpStatus(err) !== undefined) return false;
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const o = e as ErrLike;
    // First: a DOMException carries a numeric `code` (23 for a timeout) that
    // is not an HTTP status.
    if (typeof o.name === "string" && TRANSIENT_NAMES.has(o.name)) return true;
    if (typeof o.code === "number" || typeof o.status === "number") return false;
    if (typeof o.response?.status === "number") return false;
    if (typeof o.code === "string" && TRANSIENT_CODES.has(o.code)) return true;
    if (typeof o.message === "string" && TRANSIENT_TEXT.test(o.message)) return true;
    e = o.cause ?? o.error;
  }
  return false;
}

/** The HTTP status somewhere in the chain, if the far end answered. */
function httpStatus(err: unknown): number | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (e instanceof GcsHttpError) return e.code;
    e = (e as ErrLike).cause;
  }
  return undefined;
}

/**
 * An error and every cause under it, with codes: `fetch failed <- other side
 * closed [UND_ERR_SOCKET]`. The top-level message of a native-fetch failure
 * says nothing on its own; the cause is the diagnosis.
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const o = e as ErrLike;
    const code = typeof o.code === "string" ? ` [${o.code}]` : "";
    parts.push(`${errMessage(e)}${code}`);
    e = o.cause;
  }
  return parts.join(" <- ");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

const enc = encodeURIComponent;

/** A 2xx body that is not the JSON promised. Fixed text: no body in a message. */
function parseJson<T>(body: Buffer | string, what: string): T {
  try {
    return JSON.parse(body.toString()) as T;
  } catch {
    throw new Error(`${what}: Google answered 2xx with a body that is not JSON`);
  }
}

/**
 * The bucket, over the GCS JSON API, on Node's own `fetch`.
 *
 * Not `@google-cloud/storage`: that client, and the token fetch under it, run
 * on gaxios 6 and node-fetch 2. node-fetch 2.7 decides a CHUNKED response was
 * cut short by a heuristic — any `data` listener still on the socket when the
 * response closes — and on prod's `bundle-whatsapp-tadas` every token POST
 * failed that test, three tries out of three, on every call (`HACKS.md` #109).
 * undici's parser knows whether it saw the last chunk, so a body this reports
 * as cut off was cut off, and the error under `cause` says by what.
 *
 * Six requests, and nothing else: a token POST, an object's metadata, a
 * download pinned to a generation, a multipart upload with a generation
 * precondition, a delete, and a paged list.
 */
export class GcsBlobStore implements BlobStore {
  private readonly bucketName: string;
  private readonly clientEmail: string;
  private readonly privateKey: string;
  private readonly api: string;
  private readonly tokenUrl: string;
  private readonly retry: TransportRetry;
  private token?: { value: string; expiresAt: number };
  private pendingToken?: Promise<string>;

  constructor(options: GcsBlobStoreOptions) {
    this.bucketName = options.bucket;
    this.clientEmail = options.clientEmail;
    this.privateKey = options.privateKey;
    this.api = (options.apiEndpoint ?? GCS_API).replace(/\/+$/, "");
    this.tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL;
    this.retry = { ...DEFAULT_TRANSPORT_RETRY, ...options.retry };
  }

  /**
   * A service-account JWT, signed here, traded for an access token. Cached
   * until five minutes before it expires; concurrent callers share one fetch.
   */
  private accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) {
      return Promise.resolve(this.token.value);
    }
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = undefined;
    });
    return this.pendingToken;
  }

  private async fetchToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const unsigned =
      b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
      "." +
      b64url(
        JSON.stringify({
          iss: this.clientEmail,
          scope: SCOPE,
          aud: this.tokenUrl,
          iat: now,
          exp: now + 3600,
        }),
      );
    let signature: string;
    try {
      signature = createSign("RSA-SHA256").update(unsigned).sign(this.privateKey, "base64url");
    } catch {
      // The crypto error says nothing useful, and the key must not reach a log.
      throw new Error(
        "WHATSAPP_GCS_PRIVATE_KEY is not a usable PEM private key. It is the " +
          "`private_key` field of the service account's JSON key, BEGIN and END " +
          "lines included.",
      );
    }
    const res = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(this.retry.requestTimeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      // Google's own words (`invalid_grant: account not found`); no credential.
      let detail = "";
      try {
        const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
        detail = [body.error, body.error_description].filter((x) => typeof x === "string").join(": ");
      } catch {
        // Not JSON: the status alone.
      }
      throw new GcsHttpError(res.status, "token request", detail);
    }
    const body = parseJson<{ access_token?: unknown; expires_in?: unknown }>(text, "token request");
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new Error("Google's token endpoint answered without an access_token");
    }
    const ttlMs = (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000;
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(0, ttlMs - TOKEN_REFRESH_MARGIN_MS),
    };
    return body.access_token;
  }

  /**
   * One authenticated request, its body read to the end INSIDE the call, so a
   * body cut off mid-read is retried with the request rather than surfacing
   * after it. Non-2xx is a {@link GcsHttpError} carrying the status.
   */
  private async send(
    what: string,
    method: string,
    url: string,
    init: { body?: Buffer; contentType?: string } = {},
  ): Promise<{ status: number; body: Buffer }> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch (err) {
      throw new TokenFetchFailed(err);
    }
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.contentType ? { "content-type": init.contentType } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      signal: AbortSignal.timeout(this.retry.requestTimeoutMs),
    });
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status === 401) this.token = undefined;
    if (!res.ok) {
      let detail = "";
      try {
        const parsed = JSON.parse(body.toString("utf8")) as { error?: { message?: unknown } };
        if (typeof parsed.error?.message === "string") detail = parsed.error.message;
      } catch {
        // Not JSON: the status alone.
      }
      throw new GcsHttpError(res.status, what, detail);
    }
    return { status: res.status, body };
  }

  /**
   * Every GCS call goes through here, the token fetch each one may trigger
   * included. A read and a list change nothing, a delete is idempotent here
   * (404 is success), and a conditional write that landed before its response
   * was lost fails its own precondition on the replay — which `StateStore`
   * already answers by re-reading. Those always replay, on a transport error
   * and on a retryable status (408, 429, 5xx).
   *
   * An UNCONDITIONAL write (`replayable: false`) replays only when the write
   * was certainly not applied: the token fetch failed, so it was never sent;
   * or GCS answered 401 or 429, which it does before touching the object.
   * Otherwise it may have landed, and a replay a moment later could overwrite
   * what another process wrote in between — for the lease, a newer process's
   * claim.
   *
   * A 401 gets ONE more try on any call, with the token `send` just dropped.
   */
  private async transport<T>(
    operation: string,
    call: () => Promise<T>,
    replayable = true,
  ): Promise<T> {
    const started = Date.now();
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (err) {
        const transport = isTransientTransportError(err);
        const answered = httpStatus(err);
        // GCS's own status; a token-endpoint status says nothing about the object.
        const status = err instanceof TokenFetchFailed ? undefined : answered;
        const retryable =
          transport ||
          (answered !== undefined && RETRY_STATUSES.has(answered)) ||
          (status === 401 && !refreshed);
        if (!retryable) throw err;
        if (status === 401) refreshed = true;
        const notApplied = err instanceof TokenFetchFailed || status === 401 || status === 429;
        const last =
          attempt >= this.retry.attempts ||
          Date.now() - started >= this.retry.deadlineMs ||
          (!replayable && !notApplied);
        if (last) {
          throw status === 401 ? err : new TransientStoreError(operation, attempt, err);
        }
        logWarning(
          `GCS ${operation}: ${transport ? "transient transport error" : `HTTP ${answered}`} ` +
            `(try ${attempt}/${this.retry.attempts}), retrying: ${describeError(err)}`,
        );
        const backoff = this.retry.baseDelayMs * 2 ** (attempt - 1);
        await sleep(backoff + Math.random() * backoff * 0.5);
      }
    }
  }

  private objectUrl(name: string, query = ""): string {
    return `${this.api}/storage/v1/b/${enc(this.bucketName)}/o/${enc(name)}${query}`;
  }

  /**
   * The generation comes from the object's METADATA, and the bytes from a
   * download pinned to that generation, so the two describe the same write. A
   * read that reported no generation would make every later conditional write
   * fail its precondition, forever. If the object is replaced between the two
   * calls the pinned download 404s, and the read starts over.
   */
  async read(name: string): Promise<BlobRead | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let generation: string;
      try {
        const { body } = await this.transport(`reading ${name}`, () =>
          this.send(`reading ${name}`, "GET", this.objectUrl(name, "?fields=generation")),
        );
        generation = String(parseJson<{ generation?: unknown }>(body, `reading ${name}`).generation ?? "");
      } catch (err) {
        if (httpStatus(err) === 404 && !(err instanceof TokenFetchFailed)) return null;
        throw err;
      }
      if (!/^\d+$/.test(generation)) {
        throw new Error(`GCS returned no generation for ${name}`);
      }
      try {
        const { body } = await this.transport(`reading ${name}`, () =>
          this.send(
            `reading ${name}`,
            "GET",
            this.objectUrl(name, `?alt=media&generation=${generation}`),
          ),
        );
        return { data: body, generation };
      } catch (err) {
        if (httpStatus(err) !== 404 || err instanceof TokenFetchFailed) throw err;
      }
    }
    throw new Error(`${name} kept changing while it was being read`);
  }

  async write(
    name: string,
    data: Buffer,
    ifGeneration?: string | null,
  ): Promise<string> {
    const conditional = ifGeneration !== undefined;
    const query = new URLSearchParams({ uploadType: "multipart" });
    if (conditional) query.set("ifGenerationMatch", ifGeneration === null ? "0" : ifGeneration);
    const url = `${this.api}/upload/storage/v1/b/${enc(this.bucketName)}/o?${query}`;
    const boundary = `strad-${randomBytes(12).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
          JSON.stringify({ name, contentType: "application/octet-stream", cacheControl: "no-store" }) +
          `\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    let response: Buffer;
    try {
      ({ body: response } = await this.transport(
        `writing ${name}`,
        () =>
          this.send(`writing ${name}`, "POST", url, {
            body,
            contentType: `multipart/related; boundary=${boundary}`,
          }),
        conditional,
      ));
    } catch (err) {
      if (httpStatus(err) === 412 && !(err instanceof TokenFetchFailed)) {
        throw new PreconditionFailed(name);
      }
      throw err;
    }
    const generation = String(
      parseJson<{ generation?: unknown }>(response, `writing ${name}`).generation ?? "",
    );
    if (!/^\d+$/.test(generation)) {
      throw new Error(`GCS returned no generation after writing ${name}`);
    }
    return generation;
  }

  async delete(name: string): Promise<void> {
    try {
      await this.transport(`deleting ${name}`, () =>
        this.send(`deleting ${name}`, "DELETE", this.objectUrl(name)),
      );
    } catch (err) {
      if (httpStatus(err) !== 404 || err instanceof TokenFetchFailed) throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const names: string[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ prefix, fields: "items(name),nextPageToken" });
      if (pageToken) query.set("pageToken", pageToken);
      const url = `${this.api}/storage/v1/b/${enc(this.bucketName)}/o?${query}`;
      const { body } = await this.transport(`listing ${prefix}`, () =>
        this.send(`listing ${prefix}`, "GET", url),
      );
      const page = parseJson<{ items?: { name?: unknown }[]; nextPageToken?: unknown }>(
        body,
        `listing ${prefix}`,
      );
      for (const item of page.items ?? []) {
        if (typeof item.name === "string") names.push(item.name);
      }
      pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
    } while (pageToken);
    return names;
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
