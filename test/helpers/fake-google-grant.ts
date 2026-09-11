import { randomUUID } from "node:crypto";
import {
  HostedDomainRefused,
  type GoogleGrant,
  type McpGoogleProvider,
  type PendingGoogleAuth,
} from "../../src/auth/mcp-oauth/google.ts";

/**
 * Google, for the `/mcp` OAuth flow, with nothing real behind it.
 *
 * The one thing these tests cannot drive is accounts.google.com, so this is the
 * seam — and it is deliberately the WHOLE provider rather than a stubbed
 * `fetch`. Everything downstream of it is the real code path: the real
 * authorization endpoint, the real transaction cookie, the real consent screen,
 * the real code and token minting, the real `/mcp` door.
 *
 * What it models that matters:
 *
 *   - An account is a `{ sub, email, hd }`. Set `account` to a non-member and
 *     `completeAuth` throws `HostedDomainRefused`, exactly as the real provider
 *     does on a verified id_token whose `hd` is wrong.
 *   - `refresh()` looks the grant up by the Google refresh token it issued, so
 *     `revoke()` — or a grant that has left the Workspace — makes the NEXT
 *     refresh fail. That is the property strad's non-expiring refresh token
 *     leans on, so a fake that always said yes would test nothing.
 */
export interface FakeGoogleGrant extends McpGoogleProvider {
  /** The identity the next `completeAuth` returns. */
  account: { sub: string; email: string; hd: string; name?: string };
  /** The domain a grant's holder must belong to. */
  hostedDomain: string;
  /** The `state` the last `beginAuth` minted. */
  lastState: string;
  /** The Google refresh token the last `completeAuth` issued. */
  lastRefreshToken: string;
  /** The redirect URI the last `beginAuth` was given. */
  lastRedirectUri: string;
  /** Every authorization URL handed back, newest last. */
  urls: string[];
  /** Google refresh tokens still live. */
  live: () => string[];
  /** Kill a grant as if the human revoked it in their Google account. */
  kill: (refreshToken: string) => void;
  /** Move an account out of the Workspace: every later refresh is refused. */
  moveOutOfWorkspace: (refreshToken: string) => void;
}

export function fakeGoogleGrant(
  hostedDomain = "tadasant.com",
): FakeGoogleGrant {
  const grants = new Map<
    string,
    { sub: string; email: string; hd: string; name?: string; live: boolean }
  >();
  let verifier = "";

  const fake: FakeGoogleGrant = {
    hostedDomain,
    account: {
      sub: "google-sub-1",
      email: `tadas@${hostedDomain}`,
      hd: hostedDomain,
    },
    lastState: "",
    lastRefreshToken: "",
    lastRedirectUri: "",
    urls: [],

    beginAuth(redirectUri: string): PendingGoogleAuth {
      fake.lastState = randomUUID();
      fake.lastRedirectUri = redirectUri;
      verifier = randomUUID();
      const url = `https://accounts.google.example/authorize?state=${fake.lastState}&redirect_uri=${encodeURIComponent(redirectUri)}&access_type=offline&prompt=consent&hd=${hostedDomain}`;
      fake.urls.push(url);
      return { state: fake.lastState, codeVerifier: verifier, url };
    },

    async completeAuth(
      _code: string,
      codeVerifier: string,
      redirectUri: string,
    ): Promise<GoogleGrant> {
      if (codeVerifier !== verifier) throw new Error("pkce mismatch at google");
      if (redirectUri !== fake.lastRedirectUri) {
        throw new Error("redirect_uri mismatch at google");
      }
      // The REAL provider applies the Workspace test inside completeAuth, on
      // the verified claims. The refusal has to come from the same place, or a
      // test of it would be testing the route's imagination.
      if (fake.account.hd !== hostedDomain) {
        throw new HostedDomainRefused(hostedDomain, fake.account.email);
      }
      const refreshToken = `google-rt-${randomUUID()}`;
      grants.set(refreshToken, { ...fake.account, live: true });
      fake.lastRefreshToken = refreshToken;
      return { identity: { ...fake.account }, refreshToken };
    },

    async refresh(refreshToken: string) {
      const grant = grants.get(refreshToken);
      if (!grant || !grant.live) {
        throw new Error("invalid_grant: this google grant is dead");
      }
      if (grant.hd !== hostedDomain) {
        throw new HostedDomainRefused(hostedDomain, grant.email);
      }
      const { live: _live, ...identity } = grant;
      return identity;
    },

    async revoke(refreshToken: string) {
      const grant = grants.get(refreshToken);
      if (grant) grant.live = false;
      return true;
    },

    live: () =>
      [...grants.entries()].filter(([, g]) => g.live).map(([token]) => token),
    kill: (refreshToken) => {
      const grant = grants.get(refreshToken);
      if (grant) grant.live = false;
    },
    moveOutOfWorkspace: (refreshToken) => {
      const grant = grants.get(refreshToken);
      if (grant) grant.hd = "elsewhere.example";
    },
  };

  return fake;
}
