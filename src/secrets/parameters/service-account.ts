import { createSign } from "node:crypto";
import { withRequestDeadline } from "../../util/deadline.ts";

/**
 * The signed-JWT bearer flow (RFC 7523), shared by every GCP client in strad.
 *
 * This module is deliberately STORE-NEUTRAL. It used to live inside
 * `src/ui/gcs-client.ts`, and the secrets clients imported `ServiceAccount` from
 * there — which read as "the secrets store is a GCS thing", and it is not. The
 * secrets store is Parameter Manager + Secret Manager; the GCS bucket browser is
 * a different feature that happens to also authenticate a service account. The
 * only thing they truly share is "sign a JWT with an RSA key, exchange it for an
 * access token", so that is the only thing that lives here.
 *
 * No SDK: the core gateway ships four runtime deps and stays that way. This is
 * `fetch` + `node:crypto` and strad's own deadline helper, nothing else.
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export type FetchLike = typeof fetch;

export const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * How long the exchange waits on Google before it is a failure.
 *
 * A DEFAULT, not a policy: a caller with a deadline of its own passes a
 * `fetchImpl` carrying its own signal, and this one gets out of the way of it —
 * `createGcpParameterStore` replaces the signal with the store's configured
 * `timeoutMs`, and `probeCapabilities` joins the console's six-second abandon.
 * What ten seconds is for is the caller that has no deadline: this mint sits
 * upstream of every GCP client in strad, so an unbounded exchange hangs a
 * SECRETS READ and a bucket listing rather than merely a login, and Node's
 * `fetch` would hold it for undici's 300s header timeout.
 */
const MINT_TIMEOUT_MS = 10_000;

/** The scope Parameter Manager and Secret Manager are reached with. */
export const SCOPE_CLOUD_PLATFORM =
  "https://www.googleapis.com/auth/cloud-platform";

export interface MintedToken {
  token: string;
  /** Epoch ms after which the token must be re-minted. */
  expiresAt: number;
}

export interface MintOptions {
  scope: string;
  tokenUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * An error carrying the HTTP status, so a caller can turn a 403 into a sentence.
 * It never carries a secret value — token exchange bodies do not contain one.
 */
export class ServiceAccountAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ServiceAccountAuthError";
  }
}

/**
 * Mint a short-lived OAuth2 access token from a service-account key.
 *
 * Build a JWT asserting the service account, sign it with the account's RSA
 * private key, and exchange it at Google's token endpoint. No metadata server,
 * no SDK.
 */
export async function mintAccessToken(
  account: ServiceAccount,
  opts: MintOptions,
): Promise<MintedToken> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tokenUrl = opts.tokenUrl ?? TOKEN_URL;

  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iss: account.client_email,
    scope: opts.scope,
    aud: tokenUrl,
    iat,
    exp: iat + 3600,
  };
  const signingInput = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify(claims),
  )}`;

  // A key that travelled through an env var carries "\n" as two characters.
  const pem = account.private_key.includes("\\n")
    ? account.private_key.replace(/\\n/g, "\n")
    : account.private_key;

  const signature = fromB64(
    createSign("RSA-SHA256").update(signingInput).sign(pem, "base64"),
  );

  const res = await withRequestDeadline(
    MINT_TIMEOUT_MS,
    (signal) =>
      fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: `${signingInput}.${signature}`,
        }),
        signal,
      }),
    // The module's own error, so `authReason` and the console's GcsError
    // mapping read it the way they read a 403. `408` because a stall is not
    // worth repeating: it is outside `TRANSIENT_STATUSES`
    // (`src/http/retry.ts`), so the store's retry loop reports the deadline
    // once instead of spending four of them on the same silent endpoint.
    () =>
      new ServiceAccountAuthError(
        `token exchange timed out after ${MINT_TIMEOUT_MS}ms`,
        408,
      ),
  );

  if (!res.ok) {
    throw new ServiceAccountAuthError(
      `token exchange failed: ${res.status} ${res.statusText}`,
      res.status,
    );
  }

  // Wrapped for the same reason `currentEnvelope` in gcp.ts is: `JSON.parse`
  // embeds a window of its input in the `SyntaxError` it throws, and the input
  // here is the token endpoint's 200 body — which carries `access_token`. The
  // parse error is DROPPED rather than chained; a `cause` travels.
  let json: { access_token?: string; expires_in?: number };
  try {
    json = (await res.json()) as { access_token?: string; expires_in?: number };
  } catch {
    throw new ServiceAccountAuthError(
      "token exchange returned a body that is not readable JSON",
      502,
    );
  }
  if (!json.access_token) {
    throw new ServiceAccountAuthError(
      "token exchange returned no access_token",
      502,
    );
  }
  return {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

/**
 * Parse a service-account key JSON.
 *
 * A malformed key is reported by SHAPE, never by content: the content is a
 * private key and must not reach a log or an error message.
 */
export function parseServiceAccount(raw: string | undefined): {
  account: ServiceAccount | null;
  reason?: string;
} {
  if (!raw) return { account: null, reason: "no key JSON provided" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { account: null, reason: "is not valid JSON" };
  }
  // `null`, `"str"` and `123` are all VALID JSON, so they clear the parse and
  // then throw on property access — a TypeError from the console's credential
  // diagnostics, which is the one place that exists to explain a bad key.
  if (typeof parsed !== "object" || parsed === null) {
    return { account: null, reason: "is not a JSON object" };
  }
  const key = parsed as Partial<ServiceAccount>;
  if (!key.client_email || !key.private_key) {
    return { account: null, reason: "is missing client_email / private_key" };
  }
  return {
    account: {
      client_email: key.client_email,
      private_key: key.private_key,
    },
  };
}

export function b64url(input: string): string {
  return fromB64(Buffer.from(input, "utf8").toString("base64"));
}

function fromB64(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
