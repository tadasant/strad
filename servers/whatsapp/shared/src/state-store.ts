// GENERATED — DO NOT EDIT.
// Vendored from src/state/store.ts by `npm run statestore:sync`.
// Edit the source, run the sync, and commit both. CI fails if these drift.
/**
 * strad's STATE STORE: the one place a stateful server keeps what has to
 * survive a restart. strad has no database and App Platform has no persistent
 * disk, so it is a GCS bucket — ONE bucket and ONE service account for the
 * deployment, with each consumer in a folder of its own under a key of its own.
 *
 *   {bucket}/whatsapp/prod/…         the WhatsApp bridge (servers/whatsapp)
 *   {bucket}/whatsapp/prod-tadas/…   a second WhatsApp account
 *   {bucket}/slack-events/…          the Slack events ingest (fork/slack)
 *
 * WHAT IS SHARED, AND WHAT IS NOT.
 *
 *   - WHERE: `STRAD_STATE_GCS_BUCKET`, `STRAD_STATE_GCS_CLIENT_EMAIL` and
 *     `STRAD_STATE_GCS_PRIVATE_KEY`, seeded once, deployment-wide.
 *   - A NAMESPACE per consumer: a folder that must sit under the consumer's
 *     own ROOT (`whatsapp`, `slack-events`). A prefix outside it is refused at
 *     boot, so no configuration can point one consumer at another's objects.
 *   - A KEY per consumer: `{CONSUMER}_STATE_ENCRYPTION_KEY`. Never shared. A
 *     WhatsApp key together with its state IS the account, and a container
 *     that only needs the Slack buffer has no business holding it. With one
 *     bucket credential, the keys are the only confidentiality boundary left
 *     between consumers.
 *
 * WHAT ONE CREDENTIAL COSTS. Every container that holds the storage key can
 * read, overwrite and delete EVERY consumer's objects. It cannot open them —
 * that needs the consumer's key — but it can destroy them, or put an older
 * sealed copy back under the same name. A per-consumer service account would
 * have stopped that; one shared one does not. `HACKS.md` records the trade.
 *
 * WHAT IS IN HERE: the GCS client (Node's own `fetch`, see `GcsBlobStore`) and
 * the in-memory double the tests use, the AES-256-GCM seal every object is
 * written under, the single-writer lease, and the environment rules above.
 *
 * VENDORED, NOT IMPORTED. Each consumer is its own npm tree, built into the
 * bundle image from its own Docker context, so this file is copied into each
 * by `npm run statestore:sync` (scripts/sync-vendored.mjs) and checked
 * byte-for-byte in CI. It imports nothing but `node:crypto` so that a copy
 * needs nothing beside it. Edit THIS file.
 */
import {
  createCipheriv,
  createDecipheriv,
  createSign,
  randomBytes,
  randomUUID,
} from "node:crypto";

// =============================================================================
// Where the store is
// =============================================================================

/** The three deployment-wide variables every consumer reads. */
export const STATE_STORE_ENV = {
  /** The bucket's bare name, no `gs://`. Not a secret. */
  bucket: "STRAD_STATE_GCS_BUCKET",
  /** The service account's email. Not a secret. */
  clientEmail: "STRAD_STATE_GCS_CLIENT_EMAIL",
  /** That service account's `private_key` (PEM; `\n`-escaped is fine). */
  privateKey: "STRAD_STATE_GCS_PRIVATE_KEY",
} as const;

/**
 * Names a consumer read before the store was shared, read when the shared name
 * is unset. The WhatsApp bridge's `WHATSAPP_GCS_*` are the case: production
 * holds them under two slugs' namespaces, and a fallback is what lets the shared
 * names arrive without a coordinated re-seed.
 */
export interface LegacyStoreNames {
  bucket?: string;
  clientEmail?: string;
  privateKey?: string;
}

export interface StateStoreLocation {
  bucket: string;
  clientEmail: string;
  /** Real newlines: the `\n`-escaped form is unescaped here. */
  privateKey: string;
}

export class StateStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateStoreConfigError";
  }
}

type Env = Record<string, string | undefined>;

const readVar = (env: Env, name: string | undefined): string | undefined => {
  if (name === undefined) return undefined;
  const value = env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
};

const FIELDS = ["bucket", "clientEmail", "privateKey"] as const;

/**
 * The shared variables this environment lacks, by their SHARED names, in
 * declaration order. A legacy name that is set counts as present.
 */
export function missingStateStoreEnv(
  env: Env,
  legacy: LegacyStoreNames = {},
): string[] {
  return FIELDS.filter(
    (field) =>
      readVar(env, STATE_STORE_ENV[field]) === undefined &&
      readVar(env, legacy[field]) === undefined,
  ).map((field) => STATE_STORE_ENV[field]);
}

/**
 * The bucket and the identity that reaches it.
 *
 * The shared name wins over a legacy one, EXCEPT for the bucket: two different
 * buckets set under the two names is refused rather than resolved. Booting
 * against the other bucket would find no state there and look exactly like a
 * server nobody has set up — and for WhatsApp, a human re-pairing it would
 * strand the real state in the bucket that was not chosen. A credential
 * disagreement is not refused: it is the shape of a key rotation.
 */
export function readStateStoreEnv(
  env: Env,
  legacy: LegacyStoreNames = {},
): StateStoreLocation {
  const missing = missingStateStoreEnv(env, legacy);
  if (missing.length > 0) {
    throw new StateStoreConfigError(
      `strad's state store is not configured: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set.`,
    );
  }
  const shared = readVar(env, STATE_STORE_ENV.bucket);
  const old = readVar(env, legacy.bucket);
  if (shared !== undefined && old !== undefined && shared !== old) {
    // Bucket names are not secrets; quoting them is the diagnosis.
    throw new StateStoreConfigError(
      `${STATE_STORE_ENV.bucket} is "${shared}" but ${legacy.bucket} is ` +
        `"${old}". They name two buckets, and only one of them holds this ` +
        `server's state. Copy the state across first, or make them agree; ` +
        `then remove ${legacy.bucket}.`,
    );
  }
  const pick = (field: (typeof FIELDS)[number]): string =>
    (readVar(env, STATE_STORE_ENV[field]) ?? readVar(env, legacy[field]))!;
  return {
    bucket: pick("bucket"),
    clientEmail: pick("clientEmail"),
    // A PEM pasted into a single-line secret field arrives with literal `\n`s.
    privateKey: pick("privateKey").replace(/\\n/g, "\n"),
  };
}

export interface NamespaceRule {
  /** The variable that sets the folder, e.g. `WHATSAPP_STATE_PREFIX`. */
  variable: string;
  /** Read when `variable` is unset. Disagreeing with it is refused. */
  legacyVariable?: string;
  /**
   * The consumer's own top-level folder, and the default. Every prefix must be
   * this or a folder under it.
   */
  root: string;
}

/**
 * The folder a consumer's objects live under: no leading or trailing slash, and
 * always `root` or `root/…`. Refused when it would leave the consumer's root —
 * that is another consumer's folder, or the bucket's — and when the current and
 * legacy variables name two different folders, for the reason the bucket is.
 */
export function namespacePrefix(env: Env, rule: NamespaceRule): string {
  const clean = (raw: string) => raw.replace(/^\/+|\/+$/g, "");
  const current = readVar(env, rule.variable);
  const old = readVar(env, rule.legacyVariable);
  if (
    current !== undefined &&
    old !== undefined &&
    clean(current) !== clean(old)
  ) {
    throw new StateStoreConfigError(
      `${rule.variable} is "${current}" but ${rule.legacyVariable} is ` +
        `"${old}". They name two folders, and only one of them holds this ` +
        `server's state. Make them agree, then remove ${rule.legacyVariable}.`,
    );
  }
  const raw = current ?? old;
  const prefix = raw === undefined ? rule.root : clean(raw);
  const named = current !== undefined ? rule.variable : rule.legacyVariable;
  if (prefix !== rule.root && !prefix.startsWith(`${rule.root}/`)) {
    throw new StateStoreConfigError(
      `${named}="${raw}" is outside this server's folder in the shared state ` +
        `bucket. It must be "${rule.root}" or a folder under it ` +
        `("${rule.root}/prod"): everything else in that bucket belongs to ` +
        `another server.`,
    );
  }
  return prefix;
}

/**
 * A consumer's key, from base64 (standard or url-safe) or hex. Anything that
 * does not decode to exactly 32 bytes is refused: a short key would still
 * "work", and AES-256 with 16 bytes of key is not AES-256. The value is never
 * quoted — it is the key.
 */
export function parseStateKey(raw: string, variable: string): Buffer {
  const value = raw.trim();
  let key: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(value)) {
    key = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  }
  if (!key || key.length !== 32) {
    throw new StateStoreConfigError(
      `${variable} must be exactly 32 bytes, as base64 (44 characters, ` +
        `\`openssl rand -base64 32\`) or hex (64 characters). The value set is ` +
        `neither.`,
    );
  }
  return key;
}

// =============================================================================
// The seal
// =============================================================================

/**
 * How one consumer's objects are told apart from everyone else's.
 *
 * `magic` is four ASCII bytes at the front of every object, and is per
 * consumer: an object of one consumer's does not even parse as another's.
 */
export interface SealFormat {
  magic: string;
  /** "a sealed WhatsApp state object" */
  what: string;
  /** The key's variable, named when an object does not open. */
  keyVariable: string;
  /** The sentence that tells a human what to do about it. */
  recovery: string;
}

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM. Layout: magic (4 bytes) | IV (12) | tag (16) | ciphertext.
 *
 * The object's NAME is the associated data, so a ciphertext only opens under
 * the name it was written to: swapping one chat's object for another's, or
 * the auth state for a buffer, fails authentication rather than decoding as
 * the wrong thing. The bucket is NOT in it, which is what lets an object be
 * copied to another bucket under the same name and still open.
 */
export function seal(
  key: Buffer,
  name: string,
  plain: Buffer,
  format: SealFormat,
): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([
    Buffer.from(format.magic, "latin1"),
    iv,
    cipher.getAuthTag(),
    body,
  ]);
}

export function open(
  key: Buffer,
  name: string,
  sealed: Buffer,
  format: SealFormat,
): Buffer {
  const magic = Buffer.from(format.magic, "latin1");
  if (
    sealed.length < magic.length + IV_BYTES + TAG_BYTES ||
    !sealed.subarray(0, magic.length).equals(magic)
  ) {
    throw new SealError(`${name} is not ${format.what}.`);
  }
  const iv = sealed.subarray(magic.length, magic.length + IV_BYTES);
  const tag = sealed.subarray(
    magic.length + IV_BYTES,
    magic.length + IV_BYTES + TAG_BYTES,
  );
  const body = sealed.subarray(magic.length + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new SealError(
      `${name} does not open with ${format.keyVariable}. The key was changed ` +
        `after this object was written, or the object was altered. ` +
        format.recovery,
    );
  }
}

// =============================================================================
// The bucket
// =============================================================================

export interface BlobRead {
  data: Buffer;
  /** Opaque. Pass back as `ifGeneration` to make a write conditional. */
  generation: string;
}

/**
 * The seam the tests drive (`MemoryBlobStore`). It carries GENERATIONS because
 * two processes can briefly hold the same state — an App Platform deploy starts
 * the new container before it stops the old one — and a write that silently
 * overwrote the other process's is how state gets corrupted without anybody
 * seeing it. See `Lease`.
 */
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

export class PreconditionFailed extends Error {
  constructor(name: string) {
    super(`${name} changed under this process`);
    this.name = "PreconditionFailed";
  }
}

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * GCS could not be reached cleanly — the connection dropped, or it answered
 * 408, 429 or 5xx — every time this process asked, within the retry budget.
 * The message is the whole caller-facing answer and carries none of the
 * transport's text (a URL, a library's wording); `cause` keeps it.
 */
export class TransientStoreError extends Error {
  constructor(
    operation: string,
    attempts: number,
    cause: unknown,
    who = "this server",
  ) {
    super(
      `Google Cloud Storage did not answer cleanly while ${who} was ` +
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
  readonly code: number;
  constructor(code: number, what: string, detail: string) {
    super(`${what}: HTTP ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "GcsHttpError";
    this.code = code;
  }
}

/**
 * The service-account token request failed, so the object request it was for
 * was never sent. That is what makes an unconditional write safe to replay.
 */
export class TokenFetchFailed extends Error {
  constructor(cause: unknown) {
    super(`the service-account token request failed: ${errMessage(cause)}`, {
      cause,
    });
    this.name = "TokenFetchFailed";
  }
}

export interface GcsBlobStoreOptions {
  bucket: string;
  clientEmail: string;
  privateKey: string;
  /** Who is asking, in a {@link TransientStoreError}: "this bridge". */
  who?: string;
  /** The variable the private key came from, named when it is not a PEM. */
  privateKeyVariable?: string;
  /** Where a retried request is reported. Silent when absent. */
  warn?: (message: string) => void;
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
    if (typeof o.code === "number" || typeof o.status === "number")
      return false;
    if (typeof o.response?.status === "number") return false;
    if (typeof o.code === "string" && TRANSIENT_CODES.has(o.code)) return true;
    if (typeof o.message === "string" && TRANSIENT_TEXT.test(o.message))
      return true;
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

const b64url = (data: Buffer | string) =>
  Buffer.from(data).toString("base64url");

const enc = encodeURIComponent;

/** A 2xx body that is not the JSON promised. Fixed text: no body in a message. */
function parseJson<T>(body: Buffer | string, what: string): T {
  try {
    return JSON.parse(body.toString()) as T;
  } catch {
    throw new Error(
      `${what}: Google answered 2xx with a body that is not JSON`,
    );
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
  private readonly who: string | undefined;
  private readonly privateKeyVariable: string;
  private readonly warn: (message: string) => void;
  private readonly api: string;
  private readonly tokenUrl: string;
  private readonly retry: TransportRetry;
  private token?: { value: string; expiresAt: number };
  private pendingToken?: Promise<string>;

  constructor(options: GcsBlobStoreOptions) {
    this.bucketName = options.bucket;
    this.clientEmail = options.clientEmail;
    this.privateKey = options.privateKey;
    this.who = options.who;
    this.privateKeyVariable =
      options.privateKeyVariable ?? STATE_STORE_ENV.privateKey;
    this.warn = options.warn ?? (() => {});
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
      signature = createSign("RSA-SHA256")
        .update(unsigned)
        .sign(this.privateKey, "base64url");
    } catch {
      // The crypto error says nothing useful, and the key must not reach a log.
      throw new Error(
        `${this.privateKeyVariable} is not a usable PEM private key. It is the ` +
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
        const body = JSON.parse(text) as {
          error?: unknown;
          error_description?: unknown;
        };
        detail = [body.error, body.error_description]
          .filter((x) => typeof x === "string")
          .join(": ");
      } catch {
        // Not JSON: the status alone.
      }
      throw new GcsHttpError(res.status, "token request", detail);
    }
    const body = parseJson<{ access_token?: unknown; expires_in?: unknown }>(
      text,
      "token request",
    );
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new Error(
        "Google's token endpoint answered without an access_token",
      );
    }
    const ttlMs =
      (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000;
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
      ...(init.body ? { body: new Uint8Array(init.body) } : {}),
      signal: AbortSignal.timeout(this.retry.requestTimeoutMs),
    });
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status === 401) this.token = undefined;
    if (!res.ok) {
      let detail = "";
      try {
        const parsed = JSON.parse(body.toString("utf8")) as {
          error?: { message?: unknown };
        };
        if (typeof parsed.error?.message === "string")
          detail = parsed.error.message;
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
   * was lost fails its own precondition on the replay — which every caller
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
        const notApplied =
          err instanceof TokenFetchFailed || status === 401 || status === 429;
        const last =
          attempt >= this.retry.attempts ||
          Date.now() - started >= this.retry.deadlineMs ||
          (!replayable && !notApplied);
        if (last) {
          throw status === 401
            ? err
            : new TransientStoreError(operation, attempt, err, this.who);
        }
        this.warn(
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
          this.send(
            `reading ${name}`,
            "GET",
            this.objectUrl(name, "?fields=generation"),
          ),
        );
        generation = String(
          parseJson<{ generation?: unknown }>(body, `reading ${name}`)
            .generation ?? "",
        );
      } catch (err) {
        if (httpStatus(err) === 404 && !(err instanceof TokenFetchFailed))
          return null;
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
        if (httpStatus(err) !== 404 || err instanceof TokenFetchFailed)
          throw err;
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
    if (conditional)
      query.set(
        "ifGenerationMatch",
        ifGeneration === null ? "0" : ifGeneration,
      );
    const url = `${this.api}/upload/storage/v1/b/${enc(this.bucketName)}/o?${query}`;
    const boundary = `strad-${randomBytes(12).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
          JSON.stringify({
            name,
            contentType: "application/octet-stream",
            cacheControl: "no-store",
          }) +
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
      parseJson<{ generation?: unknown }>(response, `writing ${name}`)
        .generation ?? "",
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
      const query = new URLSearchParams({
        prefix,
        fields: "items(name),nextPageToken",
      });
      if (pageToken) query.set("pageToken", pageToken);
      const url = `${this.api}/storage/v1/b/${enc(this.bucketName)}/o?${query}`;
      const { body } = await this.transport(`listing ${prefix}`, () =>
        this.send(`listing ${prefix}`, "GET", url),
      );
      const page = parseJson<{
        items?: { name?: unknown }[];
        nextPageToken?: unknown;
      }>(body, `listing ${prefix}`);
      for (const item of page.items ?? []) {
        if (typeof item.name === "string") names.push(item.name);
      }
      pageToken =
        typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
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

// =============================================================================
// One writer
// =============================================================================

/** How often a lease holder re-reads the lease when nothing forces it. */
export const LEASE_CHECK_MS = 30_000;

export interface LeaseView {
  instanceId: string;
  owner: string | null;
  superseded: boolean;
}

/**
 * Which process owns a namespace. Plain JSON, not sealed: it names a random
 * process id and a time, and nothing else.
 *
 * An App Platform deploy starts the new container before it stops the old one,
 * so two processes holding the same state is routine, not exotic. So:
 *
 *   - a process CLAIMS the lease when it starts, so the newest one owns it;
 *   - a consumer writes its state conditionally on the generation it last saw;
 *     a conflict means another process wrote it, and the lease says which of
 *     the two should stop;
 *   - the lease is re-read at most every `LEASE_CHECK_MS` unless forced, so an
 *     old process that has nothing to write still learns it was replaced;
 *   - with `heartbeat` on, the owner refreshes `heartbeat_at` on each check,
 *     CONDITIONALLY on the generation it just read: an unconditional refresh
 *     racing a newer process's claim would take the lease back from it. A lost
 *     race is a lost lease. Off, a check is a read and nothing else, and
 *     `heartbeat_at` is the time of the claim;
 *   - a superseded process may take the lease back once that heartbeat is
 *     stale (`reclaimIfStale`), so a newer container that died does not leave
 *     the consumer down until a restart. Whether to do that is the consumer's
 *     call: one that holds an identity two sockets cannot share should not.
 *
 * A process that loses the lease is SUPERSEDED: it must stop writing.
 */
export class Lease {
  readonly instanceId = randomUUID();
  private lastCheck = 0;
  private holder: string | null = null;
  superseded = false;

  private readonly blobs: BlobStore;
  private readonly objectName: string;
  private readonly clock: () => number;
  private readonly heartbeat: boolean;

  constructor(
    blobs: BlobStore,
    objectName: string,
    options: { clock?: () => number; heartbeat?: boolean } = {},
  ) {
    this.blobs = blobs;
    this.objectName = objectName;
    this.clock = options.clock ?? Date.now;
    this.heartbeat = options.heartbeat ?? true;
  }

  get view(): LeaseView {
    return {
      instanceId: this.instanceId,
      owner: this.holder,
      superseded: this.superseded,
    };
  }

  private body(): Buffer {
    return Buffer.from(
      JSON.stringify({ owner: this.instanceId, heartbeat_at: this.clock() }),
    );
  }

  /** Unconditional: the newest process takes the namespace, whoever held it. */
  async claim(): Promise<void> {
    await this.blobs.write(this.objectName, this.body());
    this.holder = this.instanceId;
    this.superseded = false;
    this.lastCheck = this.clock();
  }

  private async read(): Promise<{
    owner?: string;
    heartbeatAt?: number;
    generation: string | null;
  }> {
    const lease = await this.blobs.read(this.objectName);
    if (!lease) return { generation: null };
    try {
      const body = JSON.parse(lease.data.toString("utf8")) as {
        owner?: unknown;
        heartbeat_at?: unknown;
        claimed_at?: unknown;
      };
      // `claimed_at` is what a lease written before heartbeats carries.
      const at =
        typeof body.heartbeat_at === "number"
          ? body.heartbeat_at
          : body.claimed_at;
      return {
        owner: typeof body.owner === "string" ? body.owner : undefined,
        heartbeatAt: typeof at === "number" ? at : undefined,
        generation: lease.generation,
      };
    } catch {
      return { generation: lease.generation };
    }
  }

  /** True while this process still owns the namespace. Sets `superseded` if not. */
  async check(force = false): Promise<boolean> {
    if (this.superseded) return false;
    if (!force && this.clock() - this.lastCheck < LEASE_CHECK_MS) return true;
    this.lastCheck = this.clock();
    const lease = await this.read();
    // A missing or unreadable lease is nobody else's: take it back.
    if (lease.owner === undefined) {
      await this.claim();
      return true;
    }
    this.holder = lease.owner;
    if (lease.owner !== this.instanceId) {
      this.superseded = true;
      return false;
    }
    if (!this.heartbeat) return true;
    try {
      await this.blobs.write(this.objectName, this.body(), lease.generation);
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err;
      const now = await this.read();
      this.holder = now.owner ?? null;
      if (now.owner !== this.instanceId) this.superseded = true;
    }
    return !this.superseded;
  }

  /**
   * Take the lease back when its owner has stopped heartbeating. The write is
   * conditional on the stale lease it read, so two survivors cannot both win.
   * True when this process owns the lease again.
   */
  async reclaimIfStale(staleAfterMs: number): Promise<boolean> {
    if (!this.superseded) return true;
    const lease = await this.read();
    const stale =
      lease.owner === undefined ||
      lease.heartbeatAt === undefined ||
      this.clock() - lease.heartbeatAt > staleAfterMs;
    if (!stale) return false;
    try {
      await this.blobs.write(this.objectName, this.body(), lease.generation);
    } catch (err) {
      if (err instanceof PreconditionFailed) return false;
      throw err;
    }
    this.holder = this.instanceId;
    this.superseded = false;
    this.lastCheck = this.clock();
    return true;
  }
}
