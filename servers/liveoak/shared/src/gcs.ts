/**
 * Where the remembered-device state lives between processes: one GCS object,
 * because strad has no database and App Platform has no persistent disk.
 *
 * DELIBERATELY SMALLER THAN THE WHATSAPP SERVER'S `blob-store.ts`. That one
 * carries generations and a lease because a Signal session is rewritten on
 * nearly every message by a long-lived socket, and two containers briefly
 * holding it during a deploy can corrupt it. This object is written once per
 * enrolment, by a tool call a human is waiting on, and read on every login. A
 * lost race here is "the newest enrolment wins", which is the right answer.
 *
 * Node's own `fetch`, no client library — the same reason as the WhatsApp
 * server (`servers/whatsapp/shared/src/blob-store.ts`): node-fetch 2 failed
 * every token POST on prod.
 */
import { createSign } from "node:crypto";

export interface BlobStore {
  read(name: string): Promise<Buffer | null>;
  write(name: string, data: Buffer): Promise<void>;
  delete(name: string): Promise<void>;
}

export class GcsError extends Error {
  /**
   * `status` 0 is a failure before any HTTP answer: the key would not sign,
   * or GCS could not be reached. `message` replaces the default wording.
   */
  constructor(
    readonly status: number,
    what: string,
    message?: string,
  ) {
    // The response BODY is never quoted: GCS error bodies can echo the object
    // name and request details, and none of it helps a caller.
    super(message ?? `Google Cloud Storage refused to ${what}: HTTP ${status}.`);
    this.name = "GcsError";
  }
}

/** What a 400/401/403 from the token endpoint means, which the bare status does not say. */
const TOKEN_REFUSED_HINT =
  " Google did not accept the service account's signed request: check that " +
  "LIVEOAK_GCS_CLIENT_EMAIL and LIVEOAK_GCS_PRIVATE_KEY belong to the same " +
  "service account and that the key has not been deleted.";

export interface GcsBlobStoreOptions {
  bucket: string;
  clientEmail: string;
  privateKey: string;
  /** Tests only: a local stand-in for the GCS JSON API. */
  apiEndpoint?: string;
  /** Tests only: a local stand-in for Google's OAuth 2.0 token endpoint. */
  tokenUrl?: string;
  /** Per request. A hung GCS must not hold a tool call for minutes. */
  timeoutMs?: number;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GCS_API = "https://storage.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";

export class GcsBlobStore implements BlobStore {
  private token: { value: string; expiresAt: number } | undefined;
  private readonly api: string;
  private readonly tokenUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: GcsBlobStoreOptions) {
    this.api = (options.apiEndpoint ?? GCS_API).replace(/\/+$/, "");
    this.tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async read(name: string): Promise<Buffer | null> {
    const res = await this.request(
      `${this.api}/storage/v1/b/${encodeURIComponent(this.options.bucket)}/o/${encodeURIComponent(name)}?alt=media`,
      { method: "GET" },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new GcsError(res.status, "read the device state");
    return Buffer.from(await res.arrayBuffer());
  }

  async write(name: string, data: Buffer): Promise<void> {
    const res = await this.request(
      `${this.api}/upload/storage/v1/b/${encodeURIComponent(this.options.bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(data),
      },
    );
    if (!res.ok) throw new GcsError(res.status, "write the device state");
    await res.arrayBuffer();
  }

  async delete(name: string): Promise<void> {
    const res = await this.request(
      `${this.api}/storage/v1/b/${encodeURIComponent(this.options.bucket)}/o/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 404) throw new GcsError(res.status, "delete the device state");
    await res.arrayBuffer();
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const token = await this.accessToken();
    return reach(() =>
      fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      }),
    );
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 5 * 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
      iss: this.options.clientEmail,
      scope: SCOPE,
      aud: this.tokenUrl,
      iat: now,
      exp: now + 3600,
    })}`;
    let signature: string;
    try {
      signature = createSign("RSA-SHA256").update(unsigned).sign(this.options.privateKey, "base64url");
    } catch {
      // OpenSSL's own words (`DECODER routines::unsupported`) name nothing a
      // human can act on, and loadConfig has already proven the key parses.
      throw new GcsError(
        0,
        "sign",
        "LIVEOAK_GCS_PRIVATE_KEY could not sign a Google token request. Paste the " +
          "service account's JSON key file, or its private_key value, again. See " +
          "docs/servers/liveoak (Setup).",
      );
    }
    const res = await reach(() =>
      fetch(this.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: `${unsigned}.${signature}`,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      }),
    );
    if (!res.ok) {
      const refused = res.status === 400 || res.status === 401 || res.status === 403;
      throw new GcsError(
        res.status,
        "issue a service-account token",
        refused
          ? `Google refused to issue a service-account token: HTTP ${res.status}.${TOKEN_REFUSED_HINT}`
          : undefined,
      );
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new GcsError(res.status, "issue a service-account token");
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }
}

/** A request that never got an HTTP answer, as a GcsError rather than `fetch failed`. */
async function reach(send: () => Promise<Response>): Promise<Response> {
  try {
    return await send();
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new GcsError(
      0,
      "answer",
      timedOut
        ? "Google Cloud Storage did not answer in time: transient; retry the call."
        : "Google Cloud Storage could not be reached: transient; retry the call.",
    );
  }
}

/** The test seam. */
export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, Buffer>();

  async read(name: string): Promise<Buffer | null> {
    return this.objects.get(name) ?? null;
  }

  async write(name: string, data: Buffer): Promise<void> {
    this.objects.set(name, Buffer.from(data));
  }

  async delete(name: string): Promise<void> {
    this.objects.delete(name);
  }
}
