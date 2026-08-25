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
  - slug: google-sheets-tadas412-ro
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:1.0.0
    bundle: bundle
    path: /google-sheets-tadas412-ro
    entitlements: [admin]
${extra}    oauth:
${oauth}
`;

const SHEETS_RO = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SHEETS_RW = "https://www.googleapis.com/auth/spreadsheets";

const MINIMAL = `      provider: google
      account: tadas412@gmail.com
      scopes:
        - ${SHEETS_RO}
`;

describe("oauth: the shape", () => {
  it("needs only provider, account and scopes — the variables default to the Sheets set", () => {
    const config = parseConfig(BASE(MINIMAL));
    const entry = connectorFor(config, "google-sheets-tadas412-ro");
    expect(entry).not.toBeNull();
    expect(entry!.oauth).toMatchObject({
      provider: "google",
      account: "tadas412@gmail.com",
      scopes: [SHEETS_RO],
      clientIdVariable: "GOOGLE_SHEETS_OAUTH_CLIENT_ID",
      clientSecretVariable: "GOOGLE_SHEETS_OAUTH_CLIENT_SECRET",
      refreshTokenVariable: "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN",
    });
  });

  it("addresses this slug's own namespace, and composes the path from config alone", () => {
    const config = parseConfig(BASE(MINIMAL));
    expect(
      refreshTokenPath(
        config,
        connectorFor(config, "google-sheets-tadas412-ro")!,
      ),
    ).toBe(
      "/strad/test/mcp/google-sheets-tadas412-ro/static/GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN",
    );
  });

  it("derives the tier from the scopes rather than trusting a label", () => {
    expect(connectorTier([SHEETS_RO])).toBe("read-only");
    expect(connectorTier([SHEETS_RW])).toBe("read-write");
    // Mixed errs toward the alarming word: a human is about to consent.
    expect(connectorTier([SHEETS_RO, SHEETS_RW])).toBe("read-write");
  });

  it("adds the identity scopes itself, and only those", () => {
    const config = parseConfig(BASE(MINIMAL));
    const entry = connectorFor(config, "google-sheets-tadas412-ro")!;
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
          `      provider: google\n      account: tadas412\n      scopes: [${SHEETS_RO}]\n`,
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

  it("accepts the intended production shape: no env:, three variables it never names", () => {
    const config = parseConfig(BASE(MINIMAL));
    const server = config.servers[0]!;
    if (server.kind !== "supplementary-image") throw new Error("unreachable");
    // THE POINT: nothing for render-spec to fail on. A slug ships before its
    // token exists, mounts degraded, and becomes whole on the next deploy.
    expect(server.env).toEqual({});
  });
});
