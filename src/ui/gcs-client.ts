/**
 * A dependency-free Google Cloud Storage listing client.
 *
 * The gcs MCP server (servers/bundle-api) drives GCS with the full
 * `@google-cloud/storage` SDK. The core gateway deliberately does NOT: it ships
 * four runtime deps (mcp-sdk, express, yaml, zod) and stays that way. Pulling in
 * the Storage SDK — hundreds of transitive packages, gRPC, the whole auth stack —
 * to render a read-only object browser would bloat the image the core is
 * intentionally lean about.
 *
 * So this is the minimum that lists a bucket: mint an OAuth2 access token from a
 * service-account key (the shared signed-JWT flow), then hit the GCS JSON API
 * with a delimiter so "folders" (common prefixes) come back distinct from
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
// where the secrets store gets its ServiceAccount from. The mint is that same
// module's — one RS256 signing path, one escaped-newline PEM repair, for every
// GCP client in strad.
export type { ServiceAccount } from "../secrets/parameters/service-account.ts";
import {
  mintAccessToken,
  ServiceAccountAuthError,
  type FetchLike,
  type MintedToken,
  type ServiceAccount,
} from "../secrets/parameters/service-account.ts";
import { withRequestDeadline } from "../util/deadline.ts";

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

/**
 * The read-only Storage scope. This browser never writes, so it does NOT use the
 * shared `SCOPE_CLOUD_PLATFORM` — this is the narrower one, passed to the mint.
 */
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";
const STORAGE_API = "https://storage.googleapis.com/storage/v1";

/**
 * How long one listing waits on GCS before the page says so.
 *
 * The caller is a human looking at a console page that has not painted, and
 * Node's `fetch` bounds nothing on its own, so an unbounded listing is a browser
 * tab spinning for undici's 300s header timeout over a bucket that is never
 * going to answer. Ten seconds is the number strad waits on Google elsewhere
 * (`src/auth/google.ts`, and the mint this listing already goes through); a
 * healthy list of a thousand objects is well inside it.
 */
const LIST_TIMEOUT_MS = 10_000;

/** Injectable so tests can drive the client without touching the network. */
export type { FetchLike } from "../secrets/parameters/service-account.ts";

/**
 * The listing surface the UI depends on. Real GCS in production; a canned fake
 * in tests. Keeping this an interface (not a bare function) lets the app wire a
 * substitute through one seam — see mountConsoleUi's `gcsList` option.
 */
export type GcsLister = (
  account: ServiceAccount,
  options: ListOptions,
) => Promise<ListResult>;

/**
 * A GCS lister backed by the real JSON API.
 *
 * Access tokens are cached per service-account email until shortly before they
 * expire — a listing that clicks through folders should not mint a fresh JWT on
 * every navigation. The cache is this client's; the shared mint deliberately
 * owns no cache (see gcp.ts, which keeps its own for the same reason).
 */
export function createGcsLister(fetchImpl: FetchLike = fetch): GcsLister {
  const tokens = new Map<string, MintedToken>();

  async function accessToken(account: ServiceAccount): Promise<string> {
    const cached = tokens.get(account.client_email);
    // 60s of slack so a token that is about to expire is not handed out.
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

    let minted: MintedToken;
    try {
      minted = await mintAccessToken(account, { scope: SCOPE, fetchImpl });
    } catch (err) {
      // The console renders `GcsError.status` into its 403 explanation, so a
      // failed exchange stays a GcsError here rather than leaking the shared
      // module's error type into the view.
      if (err instanceof ServiceAccountAuthError) {
        throw new GcsError(`GCS ${err.message}`, err.status);
      }
      throw err;
    }
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

    // THE BODY READ IS INSIDE THE DEADLINE, not merely the response. A listing
    // of a thousand objects is a body worth stalling in, and a rejection that
    // arrived after this call returned would leave the console a raw
    // `DOMException` — no class to branch on and no status to render.
    const json = await withRequestDeadline(
      LIST_TIMEOUT_MS,
      async (signal) => {
        const res = await fetchImpl(url, {
          headers: { authorization: `Bearer ${token}` },
          signal,
        });

        if (!res.ok) {
          const body = await safeText(res);
          throw new GcsError(
            `GCS list failed: ${res.status} ${res.statusText}`,
            res.status,
            body,
          );
        }

        return (await res.json()) as {
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
      },
      // A GcsError, because that is what this module's callers switch on and
      // what the console renders a status out of. `504` says the failure is
      // upstream of the console rather than a refusal it could explain — the
      // bound is on THIS end, and the listing changes nothing, so retrying is
      // safe and is what the page suggests.
      () => new GcsError(`GCS list timed out after ${LIST_TIMEOUT_MS}ms`, 504),
    );

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

async function safeText(res: Response): Promise<string | undefined> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return undefined;
  }
}
