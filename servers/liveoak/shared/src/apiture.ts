/**
 * LiveOak's banking API — Apiture, at `api.liveoak-production.apiture.com` —
 * and the three GETs this server makes against it. Nothing else.
 *
 * READ-ONLY BY CONSTRUCTION. This client has no method that sends anything but
 * GET, so no tool built on it can move money or change a setting, whatever an
 * agent asks of it. The bearer token it carries is the account's full Cognito
 * access token (the API's scopes include `banking/write`), which is exactly
 * why the boundary has to be this file rather than the token.
 *
 * WHAT THE PORTAL DOES, AND THEREFORE WHAT THIS DOES. Read out of the portal's
 * public bundle, not from any published documentation (there is none):
 *
 * - Statements are DOCUMENTS. The document center asks
 *   `GET /documents/documents?category=accountStatements|customerStatements`
 *   with `startOn` (an ISO date-time) and `period` (an ISO 8601 duration such
 *   as `P13M`), and reads `_embedded.items`. Each item has `_id`, `endOn` (the
 *   date the portal shows) and `_links["apiture:document"].href`.
 * - Viewing one is `window.open(_links["apiture:document"].href)` — a URL the
 *   browser fetches with no Authorization header, so it carries its own
 *   authority. The generated client also has
 *   `GET /documents/documents/{id}/content`, which is the fallback here.
 * - Every call is `Authorization: Bearer <Cognito access token>`. The portal
 *   sets no API key.
 *
 * The bearer token goes ONLY to the API origin. A document link on another
 * origin (a pre-signed object URL) is fetched bare: it needs no token, and
 * must not be handed one.
 */
import { redact } from "./logging.js";

export const LIVEOAK_API_ROOT = "https://api.liveoak-production.apiture.com";

/** Statement documents, as the portal's document center asks for them. */
export const STATEMENT_CATEGORIES = ["accountStatements", "customerStatements"] as const;

/** A page cap, so a server that keeps answering `next` cannot hold a call forever. */
const MAX_PAGES = 20;

/** Statements are a few hundred KB. 50 MB is a refusal, not a limit anyone hits. */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApitureOptions {
  /** Default {@link LIVEOAK_API_ROOT}. Tests point it at a fake. */
  apiRoot?: string;
  /** Per request. */
  timeoutMs?: number;
}

export type RawDocument = Record<string, unknown> & { _id?: unknown };

export interface FetchedContent {
  bytes: Buffer;
  contentType: string;
}

export class ApitureClient {
  readonly apiRoot: string;
  private readonly timeoutMs: number;

  constructor(options: ApitureOptions = {}) {
    this.apiRoot = (options.apiRoot ?? LIVEOAK_API_ROOT).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Every statement document whose window starts at `startOn` and runs `period`. */
  async listStatements(token: string, startOn: string, period: string): Promise<RawDocument[]> {
    const query = new URLSearchParams({
      category: STATEMENT_CATEGORIES.join("|"),
      startOn,
      period,
    });
    let url: string | undefined = `${this.apiRoot}/documents/documents?${query.toString()}`;
    const items: RawDocument[] = [];
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const body = (await this.getJson(token, url, "list statements")) as {
        _embedded?: { items?: unknown };
        _links?: { next?: { href?: unknown } };
      };
      const pageItems = body?._embedded?.items;
      if (Array.isArray(pageItems)) {
        for (const item of pageItems) {
          if (item && typeof item === "object") items.push(item as RawDocument);
        }
      }
      const next = body?._links?.next?.href;
      url = typeof next === "string" && next !== "" ? this.resolve(next) : undefined;
    }
    return items;
  }

  async getDocument(token: string, id: string): Promise<RawDocument> {
    return (await this.getJson(
      token,
      `${this.apiRoot}/documents/documents/${encodeURIComponent(id)}`,
      "read the statement",
    )) as RawDocument;
  }

  /**
   * The document's bytes: its `apiture:document` link if it has one (what the
   * portal opens), else the API's `/content` route.
   */
  async fetchContent(token: string, doc: RawDocument): Promise<FetchedContent> {
    const links = (doc._links ?? {}) as Record<string, { href?: unknown } | undefined>;
    const href = links["apiture:document"]?.href;
    let url: string;
    if (typeof href === "string" && href !== "") {
      url = this.resolve(href);
    } else {
      url = `${this.apiRoot}/documents/documents/${encodeURIComponent(String(doc._id))}/content`;
    }
    const target = new URL(url);
    // https only — loopback excepted, which is where the tests' fakes listen.
    if (target.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(target.hostname)) {
      throw new ApiError(0, "LiveOak returned a statement link that is not https; refusing to fetch it.");
    }
    const sameOrigin = target.origin === new URL(this.apiRoot).origin;
    const res = await this.get(url, sameOrigin ? token : undefined, "*/*");
    if (!res.ok) throw await this.failure(res, "download the statement");
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) {
      throw new ApiError(res.status, `the statement is ${declared} bytes, over the ${MAX_DOCUMENT_BYTES}-byte cap.`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_DOCUMENT_BYTES) {
      throw new ApiError(res.status, `the statement is over the ${MAX_DOCUMENT_BYTES}-byte cap.`);
    }
    return {
      bytes,
      contentType: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim(),
    };
  }

  private resolve(href: string): string {
    return new URL(href, `${this.apiRoot}/`).toString();
  }

  private async getJson(token: string, url: string, what: string): Promise<unknown> {
    const res = await this.get(url, token, "application/hal+json, application/json");
    if (!res.ok) throw await this.failure(res, what);
    try {
      return await res.json();
    } catch {
      throw new ApiError(res.status, `LiveOak's API answered "${what}" with something that is not JSON.`);
    }
  }

  private async get(url: string, token: string | undefined, accept: string): Promise<Response> {
    try {
      return await fetch(url, {
        method: "GET",
        headers: { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ApiError(
        0,
        `LiveOak's API could not be reached (${redact(err instanceof Error ? err.message : String(err))}): transient; retry the call.`,
      );
    }
  }

  private async failure(res: Response, what: string): Promise<ApiError> {
    // A short, redacted excerpt of the body: Apiture's error envelope says
    // which rule refused the call, and none of it is a credential — but the
    // redaction runs anyway, because the body is not ours.
    let detail = "";
    try {
      const text = (await res.text()).slice(0, 300);
      detail = text ? `: ${redact(text.replace(/\s+/g, " "))}` : "";
    } catch {
      // nothing to add
    }
    const hint =
      res.status === 401 || res.status === 403
        ? " The login token was refused; the next call logs in again."
        : res.status === 404
          ? " Check the statement_id (from list_statements)."
          : res.status >= 500 || res.status === 429
            ? " transient; retry the call."
            : "";
    return new ApiError(res.status, `LiveOak's API refused to ${what}: HTTP ${res.status}${detail}.${hint}`);
  }
}
