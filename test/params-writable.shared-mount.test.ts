import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";

/**
 * ONE WRITER PER MOUNT (src/config/schema.ts).
 *
 * `x-twitter` and `x-twitter-rw` are one mount: same bundle, same path, one
 * process, one X client. X's refresh token is single-use, so the pair must hold
 * ONE copy of it — owned, written back and consented on by exactly one slug —
 * or the two copies fall out of step and the slower one dies. The shapes below
 * are the ways a config could give the twin its own copy; each is refused.
 *
 * The runtime half — the two slugs' calls sharing one token provider, one
 * refresh at a time — is proven in the x-twitter tree:
 * `servers/x-twitter/tests/functional/shared-credential.test.ts`.
 */

const CONNECTOR = (scopes: string) => `    oauth:
      provider: generic
      label: X
      authorizeUrl: https://x.com/i/oauth2/authorize
      tokenUrl: https://api.x.com/2/oauth2/token
      clientAuth: basic
      scopes: [${scopes}]
      clientIdVariable: X_OAUTH_CLIENT_ID
      clientSecretVariable: X_OAUTH_CLIENT_SECRET
      refreshTokenVariable: X_OAUTH_REFRESH_TOKEN
`;

const OWNER = `  - slug: x-twitter
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /x-twitter
    entitlements: [admin]
    params: true
    paramsWritable: [X_OAUTH_REFRESH_TOKEN]
${CONNECTOR("tweet.read, users.read, bookmark.read, bookmark.write, offline.access")}    tools:
      allow: [get_my_account, get_bookmarks]
`;

const twin = (extra = "", path = "/x-twitter") => `  - slug: x-twitter-rw
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: ${path}
    entitlements: [admin]
${extra}`;

const config = (...servers: string[]) => `
version: 1
gateway: { name: strad, env: test, publicUrl: "https://strad.example" }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
servers:
${servers.join("")}`;

describe("one writer per mount", () => {
  it("accepts the shape the example config ships: the owner holds the credential, the twin declares none", () => {
    const parsed = parseConfig(config(OWNER, twin()));
    const rw = parsed.servers.find((s) => s.slug === "x-twitter-rw");
    expect(rw).toBeDefined();
  });

  it("refuses the twin listing the owner's variable under paramsWritable:", () => {
    expect(() =>
      parseConfig(
        config(
          OWNER,
          twin(
            "    params: true\n    paramsWritable: [X_OAUTH_REFRESH_TOKEN]\n",
          ),
        ),
      ),
    ).toThrow(
      /servers "x-twitter" and "x-twitter-rw" both list "X_OAUTH_REFRESH_TOKEN" under paramsWritable:/,
    );
  });

  it("compares the claim case-insensitively, as the store does", () => {
    expect(() =>
      parseConfig(
        config(
          OWNER,
          twin(
            "    params: true\n    paramsWritable: [x_oauth_refresh_token]\n",
          ),
        ),
      ),
    ).toThrow(/both list "x_oauth_refresh_token" under paramsWritable:/);
  });

  it("refuses the twin carrying its own consent for the owner's variable", () => {
    expect(() =>
      parseConfig(
        config(
          OWNER,
          twin(
            "    params: true\n" +
              CONNECTOR(
                "tweet.read, users.read, bookmark.read, bookmark.write, offline.access",
              ),
          ),
        ),
      ),
    ).toThrow(
      /server "x-twitter-rw" declares an oauth: connector whose refreshTokenVariable is "X_OAUTH_REFRESH_TOKEN", which "x-twitter"/,
    );
  });

  it("leaves servers on DIFFERENT paths alone: two mounts are two credentials", () => {
    expect(() =>
      parseConfig(
        config(
          OWNER,
          twin(
            "    params: true\n    paramsWritable: [X_OAUTH_REFRESH_TOKEN]\n",
            "/x-twitter-other",
          ),
        ),
      ),
    ).not.toThrow();
  });
});
