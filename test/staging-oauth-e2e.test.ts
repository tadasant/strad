import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseClientMetadata } from "../src/auth/mcp-oauth/cimd.ts";
import { parseJwks } from "../src/auth/mcp-oauth/client-auth.ts";
import { resolveMcpOAuth } from "../src/auth/mcp-oauth/index.ts";
import {
  advertisedScopes,
  ceilingSlugs,
  ClientPolicies,
} from "../src/auth/mcp-oauth/policy.ts";
import { parseConfig } from "../src/config/load.ts";
import { fakeGoogleGrant } from "./helpers/fake-google-grant.ts";

/**
 * Staging's /mcp authorization server is the rehearsal for production's
 * switch-on (docs/operate/staging-oauth-e2e.md). These are the properties the
 * rehearsal rests on, checked where a PR can break them rather than where a
 * human spends a Google sign-in finding out:
 *
 *   - it can reach `echo` and nothing else, through every door: the global
 *     roles, each listed client, and no unlisted or registered client at all;
 *   - each test client's document, as committed, is one strad accepts, and the
 *     URL it is served at is the client id the config lists;
 *   - enabled without its Google client it does not run, so a deploy ahead of
 *     the secrets is the static-token gateway it was.
 */

const config = parseConfig(
  readFileSync(new URL("../infra/strad.staging.yaml", import.meta.url), "utf8"),
);
const oauth = config.auth.mcpOAuth;
const DOCS = "https://docs.strad.tadasant.com/oauth-test-clients/";

function doc(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../docs/public/oauth-test-clients/${name}`, import.meta.url),
      "utf8",
    ),
  );
}

describe("staging's /mcp authorization server", () => {
  it("is on, with every opt-in feature", () => {
    expect(oauth.enabled).toBe(true);
    expect(oauth.privateKeyJwt).toBe(true);
    expect(oauth.advertiseSlugScopes).toBe(true);
    expect(oauth.grants.enabled).toBe(true);
    expect(oauth.grants.store).toBe("gcs");
  });

  it("admits only the listed test clients", () => {
    expect(oauth.allowUnlistedClients).toBe(false);
    expect(oauth.dynamicRegistration).toBe(false);
    expect(oauth.clients.map((c) => c.clientId).sort()).toEqual([
      `${DOCS}staging-confidential.json`,
      `${DOCS}staging-public.json`,
    ]);
  });

  it("can reach echo and nothing else, from every policy", () => {
    const policies = new ClientPolicies(oauth);
    for (const policy of policies.all()) {
      expect(ceilingSlugs(policy, config)).toEqual(["echo"]);
    }
    expect(advertisedScopes(policies, config)).toEqual(["mcp", "slug:echo"]);
  });

  it("pins the confidential client to private_key_jwt and its key set", () => {
    const c = oauth.clients.find((x) =>
      x.clientId.endsWith("confidential.json"),
    );
    expect(c?.tokenEndpointAuthMethod).toBe("private_key_jwt");
    expect(c?.jwksUri).toBe(`${DOCS}staging-confidential.jwks.json`);
  });

  for (const name of ["confidential", "public", "unlisted"]) {
    it(`serves a ${name} test client document strad accepts`, () => {
      const id = `${DOCS}staging-${name}.json`;
      const parsed = parseClientMetadata(id, doc(`staging-${name}.json`), {
        privateKeyJwt: true,
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.client.uris).toEqual([
        "http://127.0.0.1:53682/callback",
        "http://127.0.0.1:53683/callback",
      ]);
    });
  }

  it("publishes a key set strad can read, with no private half", () => {
    const set = doc("staging-confidential.jwks.json") as {
      keys: Array<Record<string, unknown>>;
    };
    const parsed = parseJwks(set);
    expect(parsed.ok).toBe(true);
    for (const key of set.keys) {
      expect(key.d).toBeUndefined();
      expect(key.kid).toEqual(expect.any(String));
    }
  });

  it("does not run without the Google client, so a deploy ahead of it is unchanged", () => {
    const lines: string[] = [];
    const resolved = resolveMcpOAuth({
      config,
      env: { CONSOLE_SESSION_SECRET: "x".repeat(32) } as NodeJS.ProcessEnv,
      log: (l) => lines.push(l),
    });
    expect(resolved).toBeNull();
    expect(lines.join("\n")).toContain("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET");
  });

  it("runs once the Google client and a key exist", () => {
    const resolved = resolveMcpOAuth({
      config,
      env: { STRAD_OAUTH_KEY: "k".repeat(32) } as NodeJS.ProcessEnv,
      google: fakeGoogleGrant(),
      grantBlobs: async () => {
        throw new Error("not reached in this test");
      },
      log: () => {},
    });
    expect(resolved?.grants).not.toBeNull();
  });
});
