import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { unknownConfigKeys } from "../src/config/strict.ts";
import {
  connectorFor,
  connectorTier,
  requestedScopes,
  refreshTokenPath,
} from "../src/connectors/index.ts";

/**
 * The `oauth:` block is a CROSS-REPO INTERFACE.
 *
 * Six production slugs will be written against it, in a different repository, by
 * somebody who is reading the docs rather than this file. So the contract has to
 * be strict in the two directions that cost a human an afternoon:
 *
 *   1. A typo must fail the deploy gate rather than be silently stripped. Zod
 *      strips unknown keys by design (boot must stay lenient so a rollback is not
 *      an outage), so `scope:` for `scopes:` would otherwise parse clean and
 *      request nothing.
 *   2. A shape that renders but cannot work must be refused HERE, where the
 *      message can explain, rather than at 3am in a deploy log. The
 *      deploy-ordering trap is the big one: a `${GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN}`
 *      reference fails the WHOLE render — every other server's deploy with it —
 *      until the very thing it is waiting for arrives, and the thing it is
 *      waiting for cannot arrive until after a deploy.
 */

const BASE = (oauth: string, extra = ""): string => `
version: 1
gateway:
  name: strad
  env: test
  publicUrl: https://strad.example
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: google-sheets-personal-ro
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:1.0.0
    bundle: bundle
    path: /google-sheets-personal-ro
    entitlements: [admin]
${extra}    oauth:
${oauth}
`;

const SHEETS_RO = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SHEETS_RW = "https://www.googleapis.com/auth/spreadsheets";

const MINIMAL = `      provider: google
      account: personal@example.com
      scopes:
        - ${SHEETS_RO}
`;

describe("oauth: the shape", () => {
  it("needs only provider, account and scopes — the variables default to the Sheets set", () => {
    const config = parseConfig(BASE(MINIMAL));
    const entry = connectorFor(config, "google-sheets-personal-ro");
    expect(entry).not.toBeNull();
    expect(entry!.oauth).toMatchObject({
      provider: "google",
      account: "personal@example.com",
      scopes: [SHEETS_RO],
      clientIdVariable: "GOOGLE_SHEETS_OAUTH_CLIENT_ID",
      clientSecretVariable: "GOOGLE_SHEETS_OAUTH_CLIENT_SECRET",
      refreshTokenVariable: "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN",
    });
  });

  it("writes to this slug's own OAUTH kind, composed from config alone", () => {
    // The `oauth` kind is where a credential strad MINTED goes — the whole point
    // of the kind being separate from `static/`, which is what a human typed.
    const config = parseConfig(BASE(MINIMAL));
    expect(
      refreshTokenPath(
        config,
        connectorFor(config, "google-sheets-personal-ro")!,
      ),
    ).toBe(
      "/strad/test/mcp/google-sheets-personal-ro/oauth/GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN",
    );
  });

  it("derives the tier from the scopes rather than trusting a label", () => {
    expect(connectorTier([SHEETS_RO])).toBe("read-only");
    expect(connectorTier([SHEETS_RW])).toBe("read-write");
    // Mixed errs toward the alarming word: a human is about to consent.
    expect(connectorTier([SHEETS_RO, SHEETS_RW])).toBe("read-write");
    // NO SCOPES is read-WRITE. A generic connector may legitimately declare
    // none, and then strad knows nothing about what the credential can do —
    // `[].every()` is vacuously true, so the naive reading would print the
    // reassuring word in the one case with no evidence behind it.
    expect(connectorTier([])).toBe("read-write");
  });

  it("adds the identity scopes itself, and only those", () => {
    const config = parseConfig(BASE(MINIMAL));
    const entry = connectorFor(config, "google-sheets-personal-ro")!;
    expect(requestedScopes(entry.oauth)).toEqual([
      "openid",
      "email",
      SHEETS_RO,
    ]);
    // `profile` is deliberately absent: a name and a picture do not help decide
    // whether this is the right account.
    expect(requestedScopes(entry.oauth)).not.toContain("profile");
  });

  it("rejects a document with no scopes, and one with no account", () => {
    expect(() =>
      parseConfig(
        BASE(
          `      provider: google\n      account: a@b.com\n      scopes: []\n`,
        ),
      ),
    ).toThrow(/scopes/);
    expect(() =>
      parseConfig(
        BASE(`      provider: google\n      scopes: [${SHEETS_RO}]\n`),
      ),
    ).toThrow(/account/);
  });

  it("rejects a provider strad has no implementation for", () => {
    expect(() =>
      parseConfig(
        BASE(
          `      provider: microsoft\n      account: a@b.com\n      scopes: [${SHEETS_RO}]\n`,
        ),
      ),
    ).toThrow();
  });

  it("rejects an account that is not an email address", () => {
    expect(() =>
      parseConfig(
        BASE(
          `      provider: google\n      account: personal\n      scopes: [${SHEETS_RO}]\n`,
        ),
      ),
    ).toThrow(/account/);
  });
});

describe("oauth: what the strict deploy gate catches", () => {
  it("reports a misspelled key inside the block rather than stripping it", () => {
    // `scope:` for `scopes:` is the exact shape of the bug this gate exists for:
    // valid YAML, a clean parse, and a connector that requests nothing.
    const raw = BASE(
      `      provider: google\n      account: a@b.com\n      scopes: [${SHEETS_RO}]\n      scope: whatever\n`,
    );
    const unknown = unknownConfigKeys(raw, parseConfig(raw));
    expect(unknown.map((u) => u.key)).toContain("scope");
    expect(unknown.find((u) => u.key === "scope")?.suggestion).toBe("scopes");
  });

  it("reports a misspelled variable key too", () => {
    const raw = BASE(
      `      provider: google\n      account: a@b.com\n      scopes: [${SHEETS_RO}]\n      refreshTokenVar: X\n`,
    );
    const unknown = unknownConfigKeys(raw, parseConfig(raw));
    expect(unknown.map((u) => u.key)).toContain("refreshTokenVar");
  });
});

describe("oauth: the refusals that keep a fleet deployable", () => {
  it("REFUSES a ${refresh token} reference in env: — the deploy-ordering trap", () => {
    expect(() =>
      parseConfig(
        BASE(
          MINIMAL,
          `    env:\n      GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "\${GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN}"\n`,
        ),
      ),
    ).toThrow(/render-spec exits 1 on the first unresolvable/);
  });

  it("refuses a reference to the client id too, which merely competes with the injection", () => {
    expect(() =>
      parseConfig(
        BASE(
          MINIMAL,
          `    env:\n      GOOGLE_SHEETS_OAUTH_CLIENT_ID: "\${GOOGLE_SHEETS_OAUTH_CLIENT_ID}"\n`,
        ),
      ),
    ).toThrow(/INJECTED from \/strad\/\{env\}\/mcp\//);
  });

  it("refuses two variables that fold to one parameter", () => {
    // `parameterId` lowercases before it hashes, so these are ONE stored value:
    // connecting would overwrite the connector's own input.
    expect(() =>
      parseConfig(
        BASE(
          `      provider: google\n      account: a@b.com\n      scopes: [${SHEETS_RO}]\n` +
            `      clientIdVariable: TOKEN\n      refreshTokenVariable: token\n`,
        ),
      ),
    ).toThrow(/folds case/);
  });

  it("refuses a variable name that is not a legal environment variable", () => {
    expect(() =>
      parseConfig(
        BASE(
          `      provider: google\n      account: a@b.com\n      scopes: [${SHEETS_RO}]\n` +
            `      refreshTokenVariable: "../../gateway/static/STRAD_TOKENS"\n`,
        ),
      ),
    ).toThrow(/not a legal environment variable name/);
  });

  it("refuses an identity scope written by hand", () => {
    expect(() =>
      parseConfig(
        BASE(
          `      provider: google\n      account: a@b.com\n      scopes: [openid, ${SHEETS_RO}]\n`,
        ),
      ),
    ).toThrow(/strad requests openid and email itself/);
  });

  it("refuses a duplicated scope", () => {
    expect(() =>
      parseConfig(
        BASE(
          `      provider: google\n      account: a@b.com\n      scopes: [${SHEETS_RO}, ${SHEETS_RO}]\n`,
        ),
      ),
    ).toThrow(/twice under oauth.scopes/);
  });

  it("refuses oauth: on a kind whose container nothing injects", () => {
    // A remote-http slug would get a Connect button, run a real consent, and
    // write a real refresh token that no render ever reads.
    const raw = `
version: 1
gateway: { name: strad, env: test, publicUrl: "https://strad.example" }
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: somewhere
    kind: remote-http
    url: https://example.com/mcp
    entitlements: [admin]
    oauth:
      provider: google
      account: a@b.com
      scopes: [${SHEETS_RO}]
`;
    expect(() => parseConfig(raw)).toThrow(
      /the credential would reach nothing/,
    );
  });

  it("refuses a connector that is not alone on path: /<its own slug>", () => {
    // The bundle host mounts a per-slug instance only at `/<slug>`, and a
    // connector's variables are emitted under the per-slug name alone. On any
    // other path they would be baked under a name nothing reads.
    expect(() =>
      parseConfig(
        BASE(MINIMAL).replace(
          "path: /google-sheets-personal-ro",
          "path: /google-sheets",
        ),
      ),
    ).toThrow(/Set path: \/google-sheets-personal-ro/);
  });

  it("refuses a connector ${NAME} hiding in consoleEnv: too", () => {
    // consoleEnv names are resolved from the deploy ENVIRONMENT, so a reference
    // here reintroduces the whole-fleet render failure by a quieter door.
    expect(() =>
      parseConfig(
        BASE(
          MINIMAL,
          `    consoleEnv:\n      SOMETHING: "\${GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN}"\n`,
        ),
      ),
    ).toThrow(/render-spec exits 1 on the first unresolvable/);
  });

  it("accepts the intended production shape: no env:, three variables it never names", () => {
    const config = parseConfig(BASE(MINIMAL));
    const server = config.servers[0]!;
    if (server.kind !== "supplementary-image") throw new Error("unreachable");
    // THE POINT: nothing for render-spec to fail on. A slug ships before its
    // token exists, mounts degraded, and becomes whole on the next deploy.
    expect(server.env).toEqual({});
  });
});

/**
 * `provider: generic` — the variant that carries its own endpoints.
 *
 * THE FAILURE THIS BLOCK IS ABOUT is the one the issue gate called out: Zod
 * strips an unknown key, so a misspelled field on a credential-shaped config
 * renders clean, deploys clean, and silently does the wrong thing. The design
 * answer is that every field a generic connector cannot work without is
 * REQUIRED on the variant, which turns a typo from a silent strip into a parse
 * error — and the tests below pin both halves: a well-formed declaration
 * survives with its fields intact, and each malformed one is REFUSED rather
 * than quietly defaulted.
 */
describe("oauth: provider generic", () => {
  const GENERIC = `      provider: generic
      label: Linear
      authorizeUrl: https://linear.app/oauth/authorize
      tokenUrl: https://api.linear.app/oauth/token
      scopes: [read]
      clientIdVariable: LINEAR_OAUTH_CLIENT_ID
      clientSecretVariable: LINEAR_OAUTH_CLIENT_SECRET
      refreshTokenVariable: LINEAR_OAUTH_TOKEN
`;

  it("survives parsing with every field intact", () => {
    // THE ANTI-STRIP ASSERTION. Each of these is read on the way out (to build
    // the consent URL) or on the way back (to exchange and store), and a value
    // Zod dropped would be an empty default nothing complains about.
    const config = parseConfig(BASE(GENERIC));
    const entry = connectorFor(config, "google-sheets-personal-ro");
    expect(entry!.oauth).toEqual({
      provider: "generic",
      label: "Linear",
      authorizeUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      scopes: ["read"],
      authorizeParams: {},
      clientAuth: "post",
      credential: "refresh_token",
      clientIdVariable: "LINEAR_OAUTH_CLIENT_ID",
      clientSecretVariable: "LINEAR_OAUTH_CLIENT_SECRET",
      refreshTokenVariable: "LINEAR_OAUTH_TOKEN",
    });
  });

  it("keeps authorizeParams, clientAuth and credential verbatim", () => {
    const config = parseConfig(
      BASE(
        GENERIC +
          `      clientAuth: basic
      credential: access_token
` +
          `      authorizeParams:
        access_type: offline
        prompt: consent
`,
      ),
    );
    const oauth = connectorFor(config, "google-sheets-personal-ro")!.oauth;
    expect(oauth).toMatchObject({
      clientAuth: "basic",
      credential: "access_token",
      authorizeParams: { access_type: "offline", prompt: "consent" },
    });
  });

  it("REFUSES a missing endpoint rather than defaulting one", () => {
    // The typo case, and the reason the fields are required: `authorizeURL` is
    // stripped, `authorizeUrl` is then absent, and absent is a hard error.
    const raw = BASE(
      `      provider: generic
      authorizeURL: https://linear.app/oauth/authorize
` +
        `      tokenUrl: https://api.linear.app/oauth/token
` +
        `      clientIdVariable: A
      clientSecretVariable: B
      refreshTokenVariable: C
`,
    );
    expect(() => parseConfig(raw)).toThrow(/authorizeUrl/);
  });

  it("REFUSES a generic connector that names no variables", () => {
    // Google's defaults are Google's. A Linear credential landing in
    // GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN is a wrong answer that renders clean.
    const raw = BASE(
      `      provider: generic
      authorizeUrl: https://linear.app/oauth/authorize
` +
        `      tokenUrl: https://api.linear.app/oauth/token
`,
    );
    expect(() => parseConfig(raw)).toThrow(/clientIdVariable/);
  });

  it("REFUSES a plain-http endpoint on a real host", () => {
    const raw = BASE(
      GENERIC.replace(
        "https://api.linear.app/oauth/token",
        "http://api.linear.app/oauth/token",
      ),
    );
    expect(() => parseConfig(raw)).toThrow(/https/);
  });

  it("REFUSES an authorizeParams key strad composes itself", () => {
    // `redirect_uri` and `code_challenge` are the two controls that keep an
    // authorization code from leaving the building.
    for (const key of ["redirect_uri", "code_challenge", "state"]) {
      const raw = BASE(
        GENERIC +
          `      authorizeParams:
        ${key}: anything
`,
      );
      expect(() => parseConfig(raw)).toThrow(/authorizeParams/);
    }
  });

  it("REFUSES an unknown provider by name", () => {
    const raw = BASE(
      `      provider: githubb
      authorizeUrl: https://x.example/a
` +
        `      tokenUrl: https://x.example/t
      clientIdVariable: A
` +
        `      clientSecretVariable: B
      refreshTokenVariable: C
`,
    );
    expect(() => parseConfig(raw)).toThrow();
  });

  it("reports a misspelled generic key rather than stripping it silently", () => {
    const raw = BASE(
      GENERIC +
        `      clientAuthMethod: basic
`,
    );
    const unknown = unknownConfigKeys(raw, parseConfig(raw));
    expect(unknown.map((u) => u.key)).toContain("clientAuthMethod");
  });

  it("ACCEPTS a connector variable that is also paramsWritable or paramsRefresh", () => {
    // The route addresses such a name through the highest kind the store holds
    // (`kindsOf` in src/http/params.ts), so the combination is how a consented
    // credential that rotates on use survives a restart.
    for (const field of ["paramsWritable", "paramsRefresh"]) {
      const raw = BASE(
        GENERIC,
        `    params: true\n    ${field}: [LINEAR_OAUTH_TOKEN]\n`,
      );
      expect(() => parseConfig(raw)).not.toThrow();
    }
  });

  it("adds no identity scopes, because it can prove no identity", () => {
    const config = parseConfig(BASE(GENERIC));
    const oauth = connectorFor(config, "google-sheets-personal-ro")!.oauth;
    // Google gets `openid email` added; a generic provider gets exactly what the
    // config named, because there is no standard proof to ask one for.
    expect(requestedScopes(oauth)).toEqual(["read"]);
  });

  it("allows `profile` as an ordinary capability scope", () => {
    // Google refuses it under oauth.scopes: because strad requests the identity
    // scopes itself. For a generic provider the name is just a name.
    const raw = BASE(GENERIC.replace("scopes: [read]", "scopes: [profile]"));
    expect(() => parseConfig(raw)).not.toThrow();
  });
});
