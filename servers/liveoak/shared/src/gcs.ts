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
  constructor(
    readonly status: number,
    what: string,
  ) {
    // The response BODY is never quoted: GCS error bodies can echo the object
    // name and request details, and none of it helps a caller.
    super(`Google Cloud Storage refused to ${what}: HTTP ${status}.`);
    this.name = "GcsError";
  }
}

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
    return fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
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
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.options.privateKey, "base64url");
    const res = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new GcsError(res.status, "issue a service-account token");
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new GcsError(res.status, "issue a service-account token");
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
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
