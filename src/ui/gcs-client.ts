import { createSign } from "node:crypto";

/**
 * A dependency-free Google Cloud Storage listing client.
 *
 * The gcs MCP server (servers/bundle-api) drives GCS with the full
 * `@google-cloud/storage` SDK. The core gateway deliberately does NOT: it ships
 * four runtime deps (mcp-sdk, express, yaml, zod) and stays that way. Pulling in
 * the Storage SDK — hundreds of transitive packages, gRPC, the whole auth stack —
 * to render a read-only object browser would bloat the image the core is
 * intentionally lean about (see src/secrets/index.ts, which lazy-imports its GCP
 * dep for the same reason).
 *
 * So this is the minimum that lists a bucket: mint an OAuth2 access token from a
 * service-account key by signing a JWT with node:crypto, then hit the GCS JSON
 * API with a delimiter so "folders" (common prefixes) come back distinct from
 * objects. It is the same wire behaviour the SDK produces — `getFiles({
 * delimiter: "/" })` is `objects.list?delimiter=/` underneath — just without the
 * SDK.
 *
 * The code holds no credential of its own. A ServiceAccount is passed in, having
 * been resolved from config + injected secrets at the call site (see resolve.ts).
 */

// The service-account shape and JWT plumbing are store-neutral and live in one
// place (src/secrets/parameters/service-account.ts). This browser re-exports the
// type for its own callers; it does NOT define its own, so "the GCS file" is not
// where the secrets store gets its ServiceAccount from.
export type { ServiceAccount } from "../secrets/parameters/service-account.ts";
import type { ServiceAccount } from "../secrets/parameters/service-account.ts";

/** One object in a bucket. Field names mirror the GCS JSON API. */
export interface GcsObject {
  /** Full object name, e.g. "screenshots/2024/pr-123.png". */
  name: string;
  /** Size in bytes. The API returns it as a string; we coerce to number. */
  size?: number;
  /** RFC 3339 timestamp of the last update. */
  updated?: string;
  contentType?: string;
  storageClass?: string;
}

export interface ListResult {
  /** Objects living directly under the prefix (not inside a sub-folder). */
  objects: GcsObject[];
  /** Common prefixes — the "folders" one level down. Each ends with "/". */
  prefixes: string[];
  /** Present when the listing was truncated; pass it back to get the next page. */
  nextPageToken?: string;
}

export interface ListOptions {
  bucket: string;
  /** Only list keys under this prefix. "" lists the bucket root. */
  prefix?: string;
  /** Roll up keys sharing this delimiter into `prefixes`. Defaults to "/". */
  delimiter?: string;
  pageToken?: string;
  maxResults?: number;
}

/** The read-only Storage scope. This browser never writes. */
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STORAGE_API = "https://storage.googleapis.com/storage/v1";

/** Injectable so tests can drive the client without touching the network. */
export type FetchLike = typeof fetch;

/**
 * The listing surface the UI depends on. Real GCS in production; a canned fake
 * in tests. Keeping this an interface (not a bare function) lets the app wire a
 * substitute through one seam — see mountConsoleUi's `gcsList` option.
 */
export type GcsLister = (
  account: ServiceAccount,
  options: ListOptions,
) => Promise<ListResult>;

interface CachedToken {
  token: string;
  /** Epoch ms after which we must re-mint. */
  expiresAt: number;
}

/**
 * A GCS lister backed by the real JSON API.
 *
 * Access tokens are cached per service-account email until shortly before they
 * expire — a listing that clicks through folders should not mint a fresh JWT on
 * every navigation.
 */
export function createGcsLister(fetchImpl: FetchLike = fetch): GcsLister {
  const tokens = new Map<string, CachedToken>();

  async function accessToken(account: ServiceAccount): Promise<string> {
    const cached = tokens.get(account.client_email);
    // 60s of slack so a token that is about to expire is not handed out.
    if (cached && cached.expiresAt - 60_000 > nowMs()) return cached.token;

    const minted = await mintAccessToken(account, fetchImpl);
    tokens.set(account.client_email, minted);
    return minted.token;
  }

  return async function list(account, options): Promise<ListResult> {
    const token = await accessToken(account);

    const url = new URL(
      `${STORAGE_API}/b/${encodeURIComponent(options.bucket)}/o`,
    );
    url.searchParams.set("delimiter", options.delimiter ?? "/");
    if (options.prefix) url.searchParams.set("prefix", options.prefix);
    if (options.pageToken) url.searchParams.set("pageToken", options.pageToken);
    url.searchParams.set("maxResults", String(options.maxResults ?? 1000));

    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const body = await safeText(res);
      throw new GcsError(
        `GCS list failed: ${res.status} ${res.statusText}`,
        res.status,
        body,
      );
    }

    const json = (await res.json()) as {
      items?: {
        name: string;
        size?: string;
        updated?: string;
        contentType?: string;
        storageClass?: string;
      }[];
      prefixes?: string[];
      nextPageToken?: string;
    };

    return {
      objects: (json.items ?? []).map((it) => ({
        name: it.name,
        size: it.size != null ? Number(it.size) : undefined,
        updated: it.updated,
        contentType: it.contentType,
        storageClass: it.storageClass,
      })),
      prefixes: json.prefixes ?? [],
      nextPageToken: json.nextPageToken,
    };
  };
}

/** A GCS API error that carries the HTTP status, so the UI can explain a 403. */
export class GcsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "GcsError";
  }
}

/**
 * Mint a short-lived OAuth2 access token from a service-account key.
 *
 * This is the "signed JWT bearer" flow (RFC 7523): build a JWT asserting the
 * service account, sign it with the account's RSA private key, and exchange it
 * at Google's token endpoint for an access token. No SDK, no metadata server.
 */
export async function mintAccessToken(
  account: ServiceAccount,
  fetchImpl: FetchLike = fetch,
): Promise<CachedToken> {
  const iat = Math.floor(nowMs() / 1000);
  const exp = iat + 3600;

  const claims = {
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp,
  };

  const header = { alg: "RS256", typ: "JWT" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claims),
  )}`;

  // Service-account keys are stored with escaped newlines when they travel
  // through an env var (`\n` as two characters). Restore real newlines or the
  // PEM parser rejects the key.
  const pem = account.private_key.includes("\\n")
    ? account.private_key.replace(/\\n/g, "\n")
    : account.private_key;

  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(pem, "base64");
  const assertion = `${signingInput}.${base64urlFromBase64(signature)}`;

  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!res.ok) {
    const body = await safeText(res);
    throw new GcsError(
      `GCS token exchange failed: ${res.status} ${res.statusText}`,
      res.status,
      body,
    );
  }

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new GcsError("GCS token exchange returned no access_token", 502);
  }

  return {
    token: json.access_token,
    expiresAt: nowMs() + (json.expires_in ?? 3600) * 1000,
  };
}

function base64url(input: string): string {
  return base64urlFromBase64(Buffer.from(input, "utf8").toString("base64"));
}

function base64urlFromBase64(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function safeText(res: Response): Promise<string | undefined> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return undefined;
  }
}

// Date.now behind a helper so the one place that reads the clock is obvious.
function nowMs(): number {
  return Date.now();
}
