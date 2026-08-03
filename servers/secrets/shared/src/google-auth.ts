import { createSign } from "node:crypto";

/**
 * Access-token minting for this tree.
 *
 * The same JWT-bearer exchange `parameter-manager.ts` does inline, factored out
 * so the capability probe and the write client do not each grow a third copy.
 * `parameter-manager.ts` keeps its own: that file's claim is that it contains no
 * verb but GET, and it is reviewed by reading it top to bottom, so it does not
 * take a dependency that could smuggle one in.
 *
 * This is a separate npm tree from `src/` and cannot import it. That is the same
 * reason `parameter-wire.ts` is vendored rather than imported.
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export const SCOPE_CLOUD_PLATFORM =
  "https://www.googleapis.com/auth/cloud-platform";
export const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

/** A token minter that caches until a minute before expiry. */
export function tokenMinter(cfg: {
  account: ServiceAccount;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
}): () => Promise<string> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const tokenUrl = cfg.tokenUrl ?? DEFAULT_TOKEN_URL;
  let cached: { token: string; expiresAt: number } | undefined;

  return async () => {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      iss: cfg.account.client_email,
      scope: SCOPE_CLOUD_PLATFORM,
      aud: tokenUrl,
      iat,
      exp: iat + 3600,
    };
    const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
      JSON.stringify(claims),
    )}`;
    // A key that travelled through an env var may carry literal "\n".
    const pem = cfg.account.private_key.includes("\\n")
      ? cfg.account.private_key.replace(/\\n/g, "\n")
      : cfg.account.private_key;
    const sig = toB64Url(
      createSign("RSA-SHA256").update(input).sign(pem, "base64"),
    );

    const res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${input}.${sig}`,
      }),
    });
    if (!res.ok) {
      // Status only. A token exchange body carries no secret value, and the
      // private key that signed the assertion is never interpolated anywhere.
      throw new GoogleAuthError(
        `token exchange failed: ${res.status} ${res.statusText}`,
        res.status,
      );
    }
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      throw new GoogleAuthError("token exchange returned no access_token", 502);
    }
    cached = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return cached.token;
  };
}

export function b64url(input: string): string {
  return toB64Url(Buffer.from(input, "utf8").toString("base64"));
}

function toB64Url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
