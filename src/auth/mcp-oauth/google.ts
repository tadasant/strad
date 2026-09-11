import { createHash, randomBytes } from "node:crypto";
import { withRequestDeadline } from "../../util/deadline.ts";
import {
  AuthError,
  verifyGoogleIdToken,
  type GoogleIdentity,
} from "../google.ts";
import type { GrantIdentity } from "./grants.ts";

/**
 * The identity leg of strad's authorization server: Google, driven for a GRANT
 * rather than for a session.
 *
 * ## Why this is not `GoogleOAuthProvider`
 *
 * The console's provider (`src/auth/google.ts`) asks Google one question — "who
 * is this, right now" — and throws the answer away once it has minted a cookie.
 * This flow needs a second thing: a handle it can use to ask that question
 * AGAIN, an hour later and every hour after that, without the human present.
 * That handle is Google's own refresh token, which only comes back when the
 * authorization request says `access_type=offline`, and reliably only when it
 * also says `prompt=consent`.
 *
 * Adding those two parameters to the console's flow would be a change to the
 * console: it would ask every human for consent on every sign-in, and it would
 * accumulate offline grants for a door that has no use for one. So the two
 * flows share the OAuth CLIENT and the ID-token verifier, and differ in what
 * they ask Google for.
 *
 * ## One verifier, still
 *
 * `verifyGoogleIdToken` is imported, not reimplemented. It is the only RS256 /
 * JWKS / issuer / audience check in the repo and the comment on it asks for it
 * to stay that way — this module adds the WORKSPACE test on top of it and
 * nothing else.
 *
 * ## The Workspace test is two checks, not one
 *
 * `hd` is the one that matters and the console's reasoning still holds: a
 * personal gmail.com account can set its profile email to `x@tadasant.com` and
 * have `email_verified` be true for it, and only `hd` proves membership. The
 * email SUFFIX is checked as well here, because this door hands out a
 * long-lived grant rather than a twelve-hour cookie, and the two claims
 * disagreeing is a state worth refusing rather than resolving. They agree for
 * every real Workspace account.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GOOGLE_TIMEOUT_MS = 10_000;

/** The scopes strad asks for. Identity only — this flow grants no capability. */
const SCOPES = "openid email profile";

/** A refusal a human should be shown in words, not as an error code. */
export class HostedDomainRefused extends Error {
  constructor(
    readonly expectedDomain: string,
    readonly email: string | undefined,
  ) {
    super(
      `this gateway is restricted to ${expectedDomain} accounts` +
        (email ? `, and ${email} is not one` : ""),
    );
  }
}

/** What a completed authorization gives us. */
export interface GoogleGrant {
  identity: GrantIdentity;
  /** Google's refresh token. The grant's durable handle. Secret. */
  refreshToken: string;
}

export interface PendingGoogleAuth {
  state: string;
  codeVerifier: string;
  url: string;
}

/**
 * The seam the routes drive. A real round trip needs accounts.google.com, so
 * the end-to-end tests substitute this whole interface rather than stubbing
 * `fetch` — everything downstream of it is the real code path.
 */
export interface McpGoogleProvider {
  beginAuth(redirectUri: string): PendingGoogleAuth;
  completeAuth(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<GoogleGrant>;
  /** Re-ask "who is this" using a refresh token. Throws when the grant is dead. */
  refresh(refreshToken: string): Promise<GrantIdentity>;
  /** Kill the grant at Google. Never throws; revocation is best-effort. */
  revoke(refreshToken: string): Promise<boolean>;
}

export interface McpGoogleOptions {
  clientId: string;
  clientSecret: string;
  /** The Workspace domain a grant's holder must belong to. */
  hostedDomain: string;
}

export class GoogleGrantProvider implements McpGoogleProvider {
  constructor(private readonly opts: McpGoogleOptions) {}

  beginAuth(redirectUri: string): PendingGoogleAuth {
    const state = randomBytes(16).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", this.opts.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // The two that make this a GRANT rather than a sign-in. Without
    // `access_type=offline` there is no refresh token at all; without
    // `prompt=consent` Google returns one only on a user's FIRST authorization
    // of this client, so a human who had already signed in to the console would
    // complete the flow and get a grant with no handle behind it.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    // A hint to the account chooser, and NOT the enforcement — see
    // `enforceDomain`, which runs on the verified claims.
    url.searchParams.set("hd", this.opts.hostedDomain);

    return { state, codeVerifier, url: url.toString() };
  }

  async completeAuth(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<GoogleGrant> {
    const json = await this.post(TOKEN_ENDPOINT, {
      code,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    });
    if (!json.id_token) throw new AuthError("google returned no id_token");
    if (!json.refresh_token) {
      // `access_type=offline` plus `prompt=consent` should make this
      // unreachable. If it ever is reached, failing here is right: a grant with
      // no Google refresh token behind it could not be re-verified on refresh
      // and could not be revoked, which are the two properties this flow is
      // built on.
      throw new AuthError(
        "google returned no refresh_token for an offline authorization",
      );
    }
    const identity = await this.identityFrom(json.id_token);
    return { identity, refreshToken: json.refresh_token };
  }

  async refresh(refreshToken: string): Promise<GrantIdentity> {
    const json = await this.post(TOKEN_ENDPOINT, {
      refresh_token: refreshToken,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      grant_type: "refresh_token",
    });
    if (!json.id_token) {
      throw new AuthError("google returned no id_token on refresh");
    }
    return this.identityFrom(json.id_token);
  }

  async revoke(refreshToken: string): Promise<boolean> {
    try {
      return await withRequestDeadline(
        GOOGLE_TIMEOUT_MS,
        async (signal) => {
          const res = await fetch(REVOKE_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: refreshToken }),
            signal,
          });
          // A 400 here is Google saying the token is already dead, which is the
          // outcome the caller wanted. Only a transport failure is a failure.
          return res.ok || res.status === 400;
        },
        () => new AuthError("google revocation timed out"),
      );
    } catch {
      return false;
    }
  }

  /** Verify the ID token, then apply the Workspace test. */
  private async identityFrom(idToken: string): Promise<GrantIdentity> {
    const claims = await verifyGoogleIdToken(idToken, this.opts.clientId);
    if (!claims.email || claims.email_verified !== true) {
      throw new AuthError("google account has no verified email");
    }
    enforceDomain(claims.hd, claims.email, this.opts.hostedDomain);
    return {
      sub: claims.sub,
      email: claims.email,
      hd: claims.hd as string,
      ...(claims.name ? { name: claims.name } : {}),
    };
  }

  private async post(
    url: string,
    form: Record<string, string>,
  ): Promise<{ id_token?: string; refresh_token?: string }> {
    return withRequestDeadline(
      GOOGLE_TIMEOUT_MS,
      async (signal) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(form),
          signal,
        });
        if (!res.ok) {
          throw new AuthError(`google token endpoint failed: ${res.status}`);
        }
        return (await res.json()) as {
          id_token?: string;
          refresh_token?: string;
        };
      },
      () =>
        new AuthError(
          `google token call timed out after ${GOOGLE_TIMEOUT_MS}ms`,
        ),
    );
  }
}

/**
 * THE constraint, in one function, called from both places it has to hold: the
 * authorization, and every refresh.
 *
 * Exported so the refusal is testable on its own and so there is exactly one
 * spelling of it. A wrong-domain account gets a `HostedDomainRefused`, which
 * the routes render as a readable page rather than as `error=access_denied`.
 */
export function enforceDomain(
  hd: string | undefined,
  email: string | undefined,
  expected: string,
): void {
  // Case-folded on BOTH sides. A domain name is case-insensitive, Google emits
  // `hd` lowercased, and an operator who writes `hostedDomain: Tadasant.com` in
  // the config would otherwise get a deployment where every single sign-in is
  // refused — with the refusal page saying the account is not a member of a
  // Workspace it plainly is.
  const want = expected.toLowerCase();
  if (!hd || hd.toLowerCase() !== want) {
    throw new HostedDomainRefused(expected, email);
  }
  if (!email || !email.toLowerCase().endsWith(`@${want}`)) {
    throw new HostedDomainRefused(expected, email);
  }
}

/** Build the provider from env, or null when credentials are not yet present. */
export function grantProviderFromEnv(
  hostedDomain: string,
  env: NodeJS.ProcessEnv = process.env,
): GoogleGrantProvider | null {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new GoogleGrantProvider({ clientId, clientSecret, hostedDomain });
}

/** The console's identity shape, for a caller that wants both. */
export type { GoogleIdentity };
