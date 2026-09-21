import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { IncomingHttpHeaders, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { redirectUriProblem } from "./clients.ts";

/**
 * OAuth Client ID Metadata Documents (`draft-ietf-oauth-client-id-metadata-
 * document`), the registration mechanism the MCP authorization spec prefers
 * over RFC 7591.
 *
 * ## What it is
 *
 * The client id IS an `https` URL, and the URL serves a JSON document that
 * describes the client: its name and its redirect URIs. claude.ai's is
 * `https://claude.ai/oauth/mcp-oauth-client-metadata`. A client that uses one
 * skips `POST /oauth/register` entirely: it sends its URL as `client_id` to
 * `/oauth/authorize`, and strad fetches the document to learn where a code may
 * be delivered.
 *
 * It sits BESIDE dynamic registration, not in place of it. A sealed client id
 * (`clients.ts`) never contains a `:` — it is base64url and a MAC — so a
 * `client_id` with a URI scheme is a metadata-document client and anything
 * else is a registered one. The two cannot be confused for each other.
 *
 * ## Why this is safe to leave open
 *
 * The same argument as open registration, and the same limit: naming a client
 * grants nothing. A token still needs a member of the Workspace to sign in at
 * Google and approve the client by name on strad's consent screen. What a
 * metadata document adds over DCR is that the name is VOUCHED FOR by a host —
 * `claude.ai` said this is Claude, and only whoever controls `claude.ai` can
 * say it — which is why the consent screen shows that host. What it does not
 * add is protection for a loopback redirect URI: anyone can present
 * `https://vscode.dev/oauth/client-metadata.json` and listen on
 * `127.0.0.1:33418` themselves, so the consent screen says that too.
 *
 * ## Why the fetch is the dangerous part
 *
 * An unauthenticated caller chooses a URL and this process fetches it, from
 * inside the deployment's network. Every rule in `fetchClientMetadata` exists
 * because of that:
 *
 *   - `https` only, and the URL shape rules of the draft (§3): a path, no
 *     userinfo, no fragment, no dot segments.
 *   - The address the connection goes to is checked, not the name. The check
 *     runs INSIDE the socket's own DNS lookup, so the address that was vetted
 *     is the address that is dialled — a name that answers public for the
 *     check and private for the connect (DNS rebinding) has no second lookup
 *     to answer differently. Every address a name resolves to must be public,
 *     not just the first.
 *   - No redirects. The draft says MUST NOT follow them, and a redirect is the
 *     other way a public URL becomes a private one.
 *   - 5 KiB and five seconds, whichever comes first — the draft's recommended
 *     size, and a deadline on the whole exchange rather than per socket event.
 *   - Status `200` and a JSON content type, or it is not a document.
 *
 * Nothing the document CONTAINS is fetched: not `logo_uri`, not `jwks_uri`,
 * not `client_uri`. The consent screen names hosts; it never loads them.
 *
 * ## Caching
 *
 * A document is cached for the lifetime its `Cache-Control` gives it, bounded
 * to an hour, and five minutes when it gives none. `no-store` and `no-cache`
 * are respected by not caching. Failures and invalid documents are never
 * cached (draft §4), and concurrent authorizations for one client share one
 * fetch. The cache is per process and bounded in entries; losing it on a
 * redeploy costs one fetch.
 */

/** The draft's recommended ceiling on what an authorization server reads. */
export const CIMD_MAX_BYTES = 5 * 1024;

/** The deadline on the whole fetch: DNS, connect, TLS, headers and body. */
export const CIMD_TIMEOUT_MS = 5_000;

/** Freshness when the document's host says nothing about it. */
export const CIMD_DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * The most a host's `max-age` can buy. A client that changes its redirect URIs
 * should not wait a day for strad to notice.
 */
export const CIMD_MAX_TTL_MS = 60 * 60 * 1000;

/** How many documents the cache holds before evicting the oldest. */
const CACHE_ENTRIES = 256;

/** A client id this long does not fit in a query string anyone will relay. */
const MAX_CLIENT_ID_CHARS = 1024;

/** Bounds on what a document may declare. None of it is sealed, so looser than DCR's. */
const MAX_REDIRECT_URIS = 32;
const MAX_URI_CHARS = 2048;
const MAX_NAME_CHARS = 128;

/** A client whose metadata document was fetched and passed every check. */
export interface MetadataClient {
  /** The client id — the document's URL, exactly as presented. */
  clientId: string;
  /** The host that serves the document. The consent screen's anchor. */
  host: string;
  /** The document's `client_name`, when it has one. Display only. */
  name?: string;
  /** The document's redirect URIs, exactly as listed. */
  uris: string[];
}

export type MetadataOutcome =
  | { ok: true; client: MetadataClient }
  | { ok: false; reason: MetadataRefusal; description: string };

/**
 * Why a metadata-document client was refused. Closed, so the words can ride
 * on `mcp_oauth.refused` as its `reason`.
 */
export type MetadataRefusal =
  | "client_id_invalid"
  | "client_metadata_blocked"
  | "client_metadata_unreachable"
  | "client_metadata_invalid";

/**
 * Does this `client_id` claim to be a metadata-document URL?
 *
 * A URI scheme is the tell. A sealed registration (`clients.ts`) is base64url
 * plus a MAC and can never contain a `:`, so this is never true of one. Note
 * that `http:` answers yes here — it is refused by `clientIdUrlProblem` with a
 * sentence rather than falling through to "unknown client".
 */
export function isMetadataClientId(clientId: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(clientId);
}

/**
 * Why this string cannot be a metadata-document client id, or null.
 *
 * The draft's §3 rules, plus one: the URL must already be in the form the WHATWG
 * parser writes it in. The draft compares client ids as plain strings, so
 * `https://Claude.ai/x`, `https://claude.ai:443/x` and `https://claude.ai/a/../x`
 * would each be a DIFFERENT client that fetches the SAME document — and the
 * document's own `client_id` would then match none of them. Refusing the
 * non-canonical spellings up front says so in a sentence.
 */
export function clientIdUrlProblem(clientId: string): string | null {
  if (clientId.length > MAX_CLIENT_ID_CHARS) {
    return `a client_id URL may be at most ${MAX_CLIENT_ID_CHARS} characters`;
  }
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return "the client_id is not an absolute URL";
  }
  if (url.protocol !== "https:") {
    return "a client_id URL must use https";
  }
  if (url.username || url.password) {
    return "a client_id URL may not carry userinfo";
  }
  if (clientId.includes("#")) {
    return "a client_id URL may not carry a fragment";
  }
  const rawPath = clientId.slice(`https://${url.host}`.length).split("?")[0];
  if (rawPath === undefined || rawPath === "" || rawPath === "/") {
    return "a client_id URL must have a path, such as https://example.com/client.json";
  }
  if (
    rawPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return "a client_id URL may not contain . or .. path segments";
  }
  const literal = ipLiteral(url.hostname);
  if (literal !== null && !isPublicAddress(literal)) {
    return "a client_id URL may not name a private, loopback or reserved address";
  }
  if (url.href !== clientId) {
    return (
      "the client_id URL is not in normalized form (lowercase host, no " +
      `default port, percent-encoding as written by a URL parser): ${url.href}`
    );
  }
  return null;
}

/**
 * Validate a fetched document against the URL it was fetched from.
 *
 * Only the members strad acts on are read, and each is checked before it is
 * trusted. Unknown members are ignored — a document is written for every
 * authorization server at once, and claude.ai's lists a grant type strad has
 * never heard of.
 */
export function parseClientMetadata(
  clientId: string,
  body: unknown,
): MetadataOutcome {
  const invalid = (description: string): MetadataOutcome => ({
    ok: false,
    reason: "client_metadata_invalid",
    description,
  });
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return invalid("the client metadata document must be a JSON object");
  }
  const doc = body as Record<string, unknown>;

  // THE check. Without it a document at one URL could speak for another, and
  // the consent screen would be naming a host that never vouched for anything.
  // Simple string comparison, as the draft requires — no normalisation.
  if (doc.client_id !== clientId) {
    return invalid(
      "the document's client_id does not match the URL it was fetched from",
    );
  }

  // The draft forbids shared secrets in a public document outright, and strad
  // serves public clients only: `none` is the one method it can honour, and it
  // is the one its metadata advertises.
  if ("client_secret" in doc || "client_secret_expires_at" in doc) {
    return invalid("a client metadata document may not carry a client_secret");
  }
  const auth = doc.token_endpoint_auth_method;
  if (auth !== undefined && auth !== "none") {
    return invalid(
      'strad serves public clients only: token_endpoint_auth_method must be "none"',
    );
  }

  const rawUris = doc.redirect_uris;
  if (!Array.isArray(rawUris) || rawUris.length === 0) {
    return invalid("redirect_uris is required and must be a non-empty array");
  }
  if (rawUris.length > MAX_REDIRECT_URIS) {
    return invalid(`at most ${MAX_REDIRECT_URIS} redirect_uris`);
  }
  const uris: string[] = [];
  for (const candidate of rawUris) {
    if (typeof candidate !== "string" || candidate.length > MAX_URI_CHARS) {
      return invalid(
        `every redirect_uri must be a string of at most ${MAX_URI_CHARS} characters`,
      );
    }
    const problem = redirectUriProblem(candidate);
    if (problem) return invalid(problem);
    if (!uris.includes(candidate)) uris.push(candidate);
  }

  // A document may list grants strad does not serve — claude.ai's lists the
  // JWT-bearer grant — and that is fine. What is not fine is a client that says
  // it does not do the one flow strad has.
  if (!listIncludes(doc.grant_types, "authorization_code")) {
    return invalid(
      'grant_types, when present, must include "authorization_code"',
    );
  }
  if (!listIncludes(doc.response_types, "code")) {
    return invalid('response_types, when present, must include "code"');
  }

  const rawName = doc.client_name;
  if (rawName !== undefined && typeof rawName !== "string") {
    return invalid("client_name must be a string");
  }
  const name =
    typeof rawName === "string" && rawName.trim() !== ""
      ? rawName.trim().slice(0, MAX_NAME_CHARS)
      : undefined;

  return {
    ok: true,
    client: {
      clientId,
      host: new URL(clientId).host,
      ...(name ? { name } : {}),
      uris,
    },
  };
}

/**
 * A short, non-secret handle for a metadata client, for a log line.
 *
 * Derived rather than the URL itself, so the `client` field on
 * `mcp_oauth.granted` stays a value this repo produced (see
 * `src/telemetry/events.ts`) rather than a host a caller chose.
 */
export function metadataClientHandle(clientId: string): string {
  return `cimd-${createHash("sha256").update(clientId, "utf8").digest("hex").slice(0, 12)}`;
}

function listIncludes(value: unknown, required: string): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.includes(required);
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

/** What the resolver needs from one HTTP exchange. */
export interface FetchedDocument {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** The fetch, as a seam: the resolver's only contact with the network. */
export type DocumentFetcher = (url: URL) => Promise<FetchedDocument>;

/** A fetch refused before or during the exchange, with a sentence for the page. */
export class MetadataFetchRefused extends Error {
  constructor(
    readonly reason: "client_metadata_blocked" | "client_metadata_unreachable",
    message: string,
  ) {
    super(message);
    this.name = "MetadataFetchRefused";
  }
}

export interface GuardedFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Test seam: the resolver behind the socket's lookup. */
  lookup?: typeof dnsLookup;
  /** Test seam: which addresses may be dialled. Public ones only, by default. */
  addressAllowed?: (address: string) => boolean;
  /** Test seam: the transport. `https.request`, by default. */
  request?: typeof httpsRequest;
}

/**
 * GET one URL with every SSRF rule in the header applied.
 *
 * It does not check the URL's shape — `clientIdUrlProblem` has done that by
 * the time anything reaches here — but it does check every ADDRESS, because
 * only the socket knows which one it is about to dial.
 */
export function guardedFetch(
  url: URL,
  opts: GuardedFetchOptions = {},
): Promise<FetchedDocument> {
  const timeoutMs = opts.timeoutMs ?? CIMD_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? CIMD_MAX_BYTES;
  const allowed = opts.addressAllowed ?? isPublicAddress;
  const resolve = opts.lookup ?? dnsLookup;
  const send = opts.request ?? httpsRequest;

  return new Promise<FetchedDocument>((done, fail) => {
    // An IP literal never reaches `lookup` — the socket dials it directly — so
    // it is checked here, on the same rule.
    const literal = ipLiteral(url.hostname);
    if (literal !== null && !allowed(literal)) {
      fail(blocked());
      return;
    }

    /**
     * The one DNS lookup the connection makes, vetted before it is used.
     *
     * Node 22 dials with `autoSelectFamily`, which asks for EVERY address
     * (`all: true`) and races them; older paths ask for one. Both shapes are
     * answered, and in both every address the name has must be public — a name
     * with one public and one private address is refused rather than trimmed,
     * because "the attacker controls the record" is the case being defended.
     */
    const guardedLookup: LookupFunction = (hostname, options, callback) => {
      resolve(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) {
          callback(err, "", 4);
          return;
        }
        const list = addresses as unknown as LookupAddress[];
        if (list.length === 0 || list.some((a) => !allowed(a.address))) {
          callback(blocked(), "", 4);
          return;
        }
        if (options.all) {
          (callback as unknown as (e: null, a: LookupAddress[]) => void)(
            null,
            list,
          );
          return;
        }
        const first = list[0] as LookupAddress;
        callback(null, first.address, first.family);
      });
    };

    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const requestOptions: RequestOptions = {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "strad (OAuth client metadata fetch)",
      },
      lookup: guardedLookup,
      // No pooled socket: a kept-alive connection would skip the lookup, and
      // with it the address check, on the next fetch to the same host.
      agent: false,
    };

    const req = send(url, requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(() =>
            fail(
              new MetadataFetchRefused(
                "client_metadata_unreachable",
                `the client metadata document is larger than ${maxBytes} bytes`,
              ),
            ),
          );
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () =>
        settle(() =>
          done({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        ),
      );
      res.on("error", (err) => settle(() => fail(unreachable(err))));
    });

    const timer = setTimeout(() => {
      settle(() =>
        fail(
          new MetadataFetchRefused(
            "client_metadata_unreachable",
            `the client metadata document did not arrive within ${timeoutMs} ms`,
          ),
        ),
      );
      req.destroy();
    }, timeoutMs);

    req.on("error", (err) => settle(() => fail(unreachable(err))));
    req.end();
  });
}

function blocked(): MetadataFetchRefused {
  return new MetadataFetchRefused(
    "client_metadata_blocked",
    "the client_id URL resolves to a private, loopback or reserved address",
  );
}

function unreachable(err: unknown): MetadataFetchRefused {
  if (err instanceof MetadataFetchRefused) return err;
  return new MetadataFetchRefused(
    "client_metadata_unreachable",
    "the client metadata document could not be fetched",
  );
}

// ---------------------------------------------------------------------------
// Which addresses are public
// ---------------------------------------------------------------------------

/**
 * The special-use IPv4 ranges (RFC 6890 and its successors) — everything that
 * is not an ordinary address on the public internet. Cloud metadata endpoints
 * (`169.254.169.254`) are in link-local; App Platform's own network is in the
 * RFC 1918 blocks.
 */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/**
 * IPv6 is allow-listed rather than block-listed: only global unicast
 * (`2000::/3`) is public, and inside it the special-use blocks below are not.
 * That leaves out loopback, link-local, unique-local, multicast, NAT64
 * (`64:ff9b::/96`, which would tunnel to an IPv4 address of the caller's
 * choosing) and the IPv4-mapped form — which is unwrapped and checked as IPv4.
 */
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");

const BLOCKED = new BlockList();
for (const [net, prefix] of BLOCKED_V4) BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["2001::", 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which embeds an IPv4 address of the caller's choosing
  ["3fff::", 20], // documentation
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

/** May strad dial this address on a caller's behalf? */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return isPublicAddress(mapped[1]);
  if (/^::ffff:/i.test(address)) {
    // The hex spelling of a mapped address, `::ffff:7f00:1`.
    const hex = address.slice(7).split(":");
    if (hex.length === 2) {
      const n = hex.map((h) => parseInt(h, 16));
      if (n.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff)) {
        const [hi = 0, lo = 0] = n;
        return isPublicAddress(
          `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`,
        );
      }
    }
    return false;
  }
  if (!GLOBAL_V6.check(address, "ipv6")) return false;
  return !BLOCKED.check(address, "ipv6");
}

/** The address a hostname IS, when it is an IP literal; null for a name. */
function ipLiteral(hostname: string): string | null {
  const bare = hostname.replace(/^\[(.*)\]$/, "$1");
  return isIP(bare) ? bare : null;
}

// ---------------------------------------------------------------------------
// The resolver: fetch, validate, cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  client: MetadataClient;
  expiresAt: number;
}

export interface ClientMetadataResolverOptions {
  /** The network. `guardedFetch` unless a test substitutes it. */
  fetch?: DocumentFetcher;
  now?: () => number;
}

/**
 * Resolve a metadata-document client id to a validated client.
 *
 * One per authorization server, shared across requests; see the header for
 * the caching rules.
 */
export class ClientMetadataResolver {
  private readonly fetchDocument: DocumentFetcher;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<MetadataOutcome>>();

  constructor(opts: ClientMetadataResolverOptions = {}) {
    this.fetchDocument = opts.fetch ?? ((url) => guardedFetch(url));
    this.now = opts.now ?? (() => Date.now());
  }

  async resolve(clientId: string): Promise<MetadataOutcome> {
    const problem = clientIdUrlProblem(clientId);
    if (problem) {
      return { ok: false, reason: "client_id_invalid", description: problem };
    }

    const cached = this.cache.get(clientId);
    if (cached && cached.expiresAt > this.now()) {
      return { ok: true, client: cached.client };
    }
    if (cached) this.cache.delete(clientId);

    const pending = this.inFlight.get(clientId);
    if (pending) return pending;

    const work = this.fetchAndValidate(clientId).finally(() =>
      this.inFlight.delete(clientId),
    );
    this.inFlight.set(clientId, work);
    return work;
  }

  private async fetchAndValidate(clientId: string): Promise<MetadataOutcome> {
    let fetched: FetchedDocument;
    try {
      fetched = await this.fetchDocument(new URL(clientId));
    } catch (err) {
      if (err instanceof MetadataFetchRefused) {
        return { ok: false, reason: err.reason, description: err.message };
      }
      return {
        ok: false,
        reason: "client_metadata_unreachable",
        description: "the client metadata document could not be fetched",
      };
    }

    if (fetched.status !== 200) {
      // A 3xx lands here too, and that is the rule rather than an accident:
      // the draft forbids following a redirect.
      return {
        ok: false,
        reason: "client_metadata_unreachable",
        description:
          fetched.status >= 300 && fetched.status < 400
            ? `the client metadata URL answered a ${fetched.status} redirect, which is not followed`
            : `the client metadata URL answered ${fetched.status}, not 200`,
      };
    }
    if (!isJsonContentType(fetched.headers["content-type"])) {
      return {
        ok: false,
        reason: "client_metadata_invalid",
        description: "the client metadata document is not served as JSON",
      };
    }

    let body: unknown;
    try {
      body = JSON.parse(fetched.body.toString("utf8"));
    } catch {
      return {
        ok: false,
        reason: "client_metadata_invalid",
        description: "the client metadata document is not valid JSON",
      };
    }

    const outcome = parseClientMetadata(clientId, body);
    if (outcome.ok) {
      const ttl = freshnessMs(fetched.headers);
      if (ttl > 0) this.remember(clientId, outcome.client, ttl);
    }
    return outcome;
  }

  private remember(clientId: string, client: MetadataClient, ttl: number) {
    if (this.cache.size >= CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(clientId, { client, expiresAt: this.now() + ttl });
  }
}

/** `application/json`, or any `application/…+json`, with parameters allowed. */
function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const type = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type === "application/json" ||
    (type.startsWith("application/") && type.endsWith("+json"))
  );
}

/**
 * How long a fetched document stays fresh, from its `Cache-Control`.
 *
 * strad is a private cache here, so `max-age` is read and `s-maxage` is not.
 * `no-store` and `no-cache` both mean zero — `no-cache` would have strad
 * revalidate on every use, and a revalidation is a fetch. Absent any
 * directive, `CIMD_DEFAULT_TTL_MS`; never more than `CIMD_MAX_TTL_MS`.
 */
export function freshnessMs(headers: IncomingHttpHeaders): number {
  const raw = headers["cache-control"];
  if (!raw) return CIMD_DEFAULT_TTL_MS;
  const directives = raw
    .toLowerCase()
    .split(",")
    .map((d) => d.trim());
  if (directives.some((d) => d === "no-store" || d === "no-cache")) return 0;
  for (const d of directives) {
    const m = /^max-age\s*=\s*"?(\d+)"?$/.exec(d);
    if (m?.[1] !== undefined) {
      return Math.min(Number(m[1]) * 1000, CIMD_MAX_TTL_MS);
    }
  }
  return CIMD_DEFAULT_TTL_MS;
}
