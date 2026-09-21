import { createHash, randomBytes } from "node:crypto";
import type { Sealer } from "../session.ts";

/**
 * RFC 7591 Dynamic Client Registration, with no client table.
 *
 * ## Why registration is load-bearing rather than optional
 *
 * claude.ai's custom-connector dialog takes a URL and nothing else. There is no
 * screen where a human pastes a client id, and no screen on strad where one
 * could be minted for them — so a connector that cannot register itself cannot
 * be added at all. DCR is one of the two mechanisms that turn "paste this URL"
 * into a working client, and it is the reason this file exists. The other is a
 * client id metadata document (`cimd.ts`), which the MCP authorization spec
 * prefers and which a client uses when the metadata document advertises it;
 * DCR stays for every client that does not.
 *
 * ## The registration IS the client id
 *
 * strad has no datastore (see `keys.ts`), so there is nothing to write a client
 * row into. Instead the client id is a SEALED registration record: the metadata
 * a registration established, signed with a key only this process holds. Every
 * later request that carries the id carries the record with it, so `/authorize`
 * can check a redirect URI against what was registered without looking anything
 * up, and any replica can answer for a registration any other replica issued.
 *
 * It is signed and not encrypted because there is nothing secret in it: a
 * client's own name and its own redirect URIs are values it sent us and reads
 * back in the registration response. What matters is that it cannot CHANGE
 * them — adding a redirect URI to a client id is how you steal an authorization
 * code, and the MAC is what stops it.
 *
 * ## The registration policy, and why it is open
 *
 * Registration is OPEN: no initial access token, no allowlist of clients, no
 * human step. That is the norm for MCP, and here it is also the only setting
 * that satisfies the requirement above — an allowlist that admitted claude.ai
 * would have to be edited for the next client, by a human, in a config file.
 *
 * Open registration is safe here because REGISTERING GRANTS NOTHING. A client
 * id is not a credential and it is not an entitlement; it is a name plus a set
 * of redirect URIs. To get a token the holder still has to send a real human
 * through Google, that human still has to be a member of the configured
 * Workspace domain, and that human still has to approve the client by name on
 * strad's own consent screen. An attacker who registers a client has arranged
 * to be told "no" in a slightly more personalised way.
 *
 * What IS checked is the shape of the redirect URIs, because those are where an
 * authorization code is delivered:
 *
 *   - `https:` only, or `http:` on a loopback host — the RFC 8252 §7.3 rule for
 *     a native client that listens on `127.0.0.1`. Plain `http:` to anywhere
 *     else would put a code on the wire in the clear.
 *   - No fragment. A fragment in a redirect URI is a code the client cannot
 *     read and a comparison that can never be exact.
 *   - No userinfo. `https://claude.ai@attacker.example/cb` reads as the first
 *     host and resolves to the second.
 *   - A bounded count, a bounded length, and a bounded TOTAL, because every one
 *     of them rides inside every client id, which rides inside a URL.
 */

/** The sealed record. Small on purpose: it is inside every client id. */
export interface ClientRecord {
  v: 1;
  /** A short non-secret id, for logs and the consent screen. */
  id: string;
  /** The client's own `client_name`, when it sent one. Display only. */
  name?: string;
  /** The registered redirect URIs, exactly as registered. */
  uris: string[];
  /** Issued-at, epoch seconds. */
  iat: number;
  /**
   * A client id does not expire. `Sealer.unseal` demands an `exp` in the
   * future, so this is the far horizon rather than a lifetime: a registration
   * is killed by rotating `STRAD_OAUTH_KEY`, which is the only revocation a
   * stateless record can have, and re-registering is one unattended POST.
   */
  exp: number;
}

/** RFC 7591 §3.2.1 — what a successful registration answers with. */
export interface ClientRegistrationResponse {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  scope: string;
}

export type RegistrationOutcome =
  | { ok: true; response: ClientRegistrationResponse; record: ClientRecord }
  | { ok: false; error: RegistrationError; description: string };

/** RFC 7591 §3.2.2 error codes. */
export type RegistrationError =
  "invalid_redirect_uri" | "invalid_client_metadata";

const MAX_REDIRECT_URIS = 8;
const MAX_URI_CHARS = 512;
const MAX_NAME_CHARS = 128;

/**
 * The bound that actually matters: the TOTAL length of the registered redirect
 * URIs.
 *
 * Every one of them rides inside the `client_id`, and the `client_id` rides in
 * the `/oauth/authorize` QUERY STRING on a real browser navigation. Eight URIs
 * at 512 characters each is a legal registration under the two caps above and a
 * five-kilobyte client id — which is a request line long enough to be refused
 * by a proxy nobody in this flow controls, in a way no error message would
 * explain.
 *
 * A kilobyte is comfortably more than any real client needs (claude.ai's
 * callback is forty characters) and keeps the client id under about 1.5 kB.
 * It is checked as a sum rather than per entry so that the registration a
 * client gets back is one the authorization endpoint can actually be reached
 * with.
 */
const MAX_URIS_TOTAL_CHARS = 1024;

/** A registration is valid for a hundred years, which is "does not expire". */
const CLIENT_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

const GRANT_TYPES = ["authorization_code", "refresh_token"];
const RESPONSE_TYPES = ["code"];

/**
 * Validate a registration request and mint the client id.
 *
 * `body` is whatever JSON the caller POSTed — every field is treated as unknown
 * and nothing is trusted into the record without a check.
 */
export function registerClient(
  body: unknown,
  sealer: Sealer,
  scope: string,
  now: number = Date.now(),
): RegistrationOutcome {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refuse("invalid_client_metadata", "the body must be a JSON object");
  }
  const meta = body as Record<string, unknown>;

  const rawUris = meta.redirect_uris;
  if (!Array.isArray(rawUris) || rawUris.length === 0) {
    return refuse(
      "invalid_redirect_uri",
      "redirect_uris is required and must be a non-empty array",
    );
  }
  if (rawUris.length > MAX_REDIRECT_URIS) {
    return refuse(
      "invalid_redirect_uri",
      `at most ${MAX_REDIRECT_URIS} redirect_uris`,
    );
  }

  const uris: string[] = [];
  for (const candidate of rawUris) {
    if (typeof candidate !== "string" || candidate.length > MAX_URI_CHARS) {
      return refuse(
        "invalid_redirect_uri",
        `every redirect_uri must be a string of at most ${MAX_URI_CHARS} characters`,
      );
    }
    const problem = redirectUriProblem(candidate);
    if (problem) return refuse("invalid_redirect_uri", problem);
    if (!uris.includes(candidate)) uris.push(candidate);
  }
  const total = uris.reduce((sum, uri) => sum + uri.length, 0);
  if (total > MAX_URIS_TOTAL_CHARS) {
    return refuse(
      "invalid_redirect_uri",
      `the redirect_uris total ${total} characters; at most ` +
        `${MAX_URIS_TOTAL_CHARS} may be registered at once, because every one ` +
        `of them travels inside the client_id.`,
    );
  }

  // The three fields a client may assert about the flow it wants.
  //
  // The auth method is refused by name: a client that expects to authenticate
  // with a secret and is registered without one fails at the token endpoint,
  // with a human watching.
  //
  // `grant_types` and `response_types` are NARROWED rather than refused, as
  // RFC 7591 §2 allows ("the authorization server MAY … replace"). Real
  // clients list grants strad has never heard of — claude.ai's metadata
  // document names the JWT-bearer grant, VS Code's the device grant — and
  // refusing the whole registration over a grant the client was never going to
  // use here is a connector that cannot be added. The response names what was
  // actually registered. What IS refused is a client that does not do the one
  // flow strad serves.
  const auth = meta.token_endpoint_auth_method;
  if (auth !== undefined && auth !== "none") {
    return refuse(
      "invalid_client_metadata",
      'strad registers public clients only: token_endpoint_auth_method must be "none"',
    );
  }
  const grantProblem = mustInclude(
    meta.grant_types,
    "authorization_code",
    "grant_types",
  );
  if (grantProblem) return refuse("invalid_client_metadata", grantProblem);
  const responseProblem = mustInclude(
    meta.response_types,
    "code",
    "response_types",
  );
  if (responseProblem)
    return refuse("invalid_client_metadata", responseProblem);

  const rawName = meta.client_name;
  if (rawName !== undefined && typeof rawName !== "string") {
    return refuse("invalid_client_metadata", "client_name must be a string");
  }
  const name =
    typeof rawName === "string" && rawName.trim() !== ""
      ? rawName.trim().slice(0, MAX_NAME_CHARS)
      : undefined;

  const record: ClientRecord = {
    v: 1,
    id: randomBytes(6).toString("hex"),
    ...(name ? { name } : {}),
    uris,
    iat: Math.floor(now / 1000),
    exp: now + CLIENT_TTL_MS,
  };

  return {
    ok: true,
    record,
    response: {
      client_id: sealer.seal(record),
      client_id_issued_at: record.iat,
      ...(name ? { client_name: name } : {}),
      redirect_uris: uris,
      grant_types: GRANT_TYPES,
      response_types: RESPONSE_TYPES,
      token_endpoint_auth_method: "none",
      scope,
    },
  };
}

/** The record a client id stands for, or null for one we did not issue. */
export function readClient(
  clientId: string | undefined,
  sealer: Sealer,
): ClientRecord | null {
  const record = sealer.unseal<ClientRecord>(clientId);
  if (!record) return null;
  // The MAC proves we sealed it; it does not prove the shape.
  if (typeof record.id !== "string" || record.id === "") return null;
  if (!Array.isArray(record.uris) || record.uris.length === 0) return null;
  if (record.uris.some((u) => typeof u !== "string")) return null;
  return record;
}

/**
 * The redirect URI to deliver this authorization to, or null.
 *
 * EXACT STRING MATCH against what was registered — not a prefix, not a host
 * comparison, not a normalised one. RFC 6749 §3.1.2.3 allows an omitted
 * `redirect_uri` only when exactly one is registered, and that is the one case
 * where the argument may be absent.
 */
export function resolveRedirectUri(
  record: Pick<ClientRecord, "uris">,
  requested: string | undefined,
): string | null {
  if (requested === undefined || requested === "") {
    return record.uris.length === 1 ? (record.uris[0] ?? null) : null;
  }
  return record.uris.includes(requested) ? requested : null;
}

/**
 * The binding between a grant and the client it was issued to.
 *
 * A hash rather than the client id itself, because the id carries the whole
 * registration and is a few hundred characters — and every authorization code
 * and refresh token would otherwise carry a second copy of it. It is a public
 * value compared against a public value, so a plain digest is the right tool.
 */
export function clientFingerprint(clientId: string): string {
  return createHash("sha256").update(clientId, "utf8").digest("base64url");
}

/** Why this string is not an acceptable redirect URI, or null if it is. */
export function redirectUriProblem(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return `redirect_uri ${JSON.stringify(candidate)} is not an absolute URI`;
  }
  if (url.hash) return "a redirect_uri may not carry a fragment";
  if (url.username || url.password) {
    return "a redirect_uri may not carry userinfo";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return null;
  return "a redirect_uri must be https, or http on a loopback address";
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

/**
 * Would a code sent here land on the human's own machine rather than a website?
 *
 * Wider than `isLoopback`, which decides where plain `http:` is ALLOWED: this
 * decides where the consent screen WARNS, and an `https` redirect to
 * `127.0.0.2` or `x.localhost` (which browsers resolve to loopback) lands on
 * the same machine as `127.0.0.1` does.
 */
export function isLoopbackRedirect(uri: string): boolean {
  let host: string;
  try {
    host = new URL(uri).hostname;
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

/**
 * Why a declared `grant_types` / `response_types` rules out strad's one flow,
 * or null. Absent is fine: RFC 7591 §2 defaults both to the code flow.
 */
function mustInclude(
  value: unknown,
  required: string,
  field: string,
): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return `${field} must be an array of strings`;
  }
  if (!value.includes(required)) {
    return `${field} must include ${JSON.stringify(required)}: it is the only flow this server serves`;
  }
  return null;
}

function refuse(
  error: RegistrationError,
  description: string,
): RegistrationOutcome {
  return { ok: false, error, description };
}
