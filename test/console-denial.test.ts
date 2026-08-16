import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { consoleDenial } from "../src/auth/dev.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import { createApp } from "../src/http/app.ts";

/**
 * The two ways console auth says no, and why they must not look alike.
 *
 * A caller who cannot get in is in one of exactly two situations, and they call
 * for opposite next steps:
 *
 *   1. The dev bypass is LIVE and the token presented was wrong or missing.
 *      Fix the token.
 *   2. No console auth path is usable at all — no Google OAuth, and the bypass
 *      is switched off somewhere in its triple guard. Fix the deployment.
 *
 * One body answered both, and it asserted the second diagnosis — "the dev bypass
 * is not usable" — even where the bypass was live and its own `devBypass` field
 * said so. Telling them apart then took a control experiment against a second
 * instance the operator controlled: send a deliberately wrong token to a box
 * whose bypass is known-live, and compare. This file is that control experiment,
 * run as a test, so one request answers it instead.
 *
 * Four gateways stand in for four deployments, because the disclosure argument
 * is about WHICH deployments answer differently: a live bypass, one switched
 * off, staging (NODE_ENV=production with both dev-auth acknowledgements), and
 * real prod (the acknowledgement missing, so it fails closed). A fifth has
 * Google sign-in wired, where the question never arises.
 */

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test, publicUrl: "https://strad.example.com" }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`);

const BOOTSTRAP = "the-real-bootstrap-token";

/** The bypass is live: config flag, ALLOW_DEV_AUTH, and a bootstrap token. */
const ACTIVE_ENV: NodeJS.ProcessEnv = {
  STRAD_TOKENS: "[]",
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
};

/** Same config, same token — but ALLOW_DEV_AUTH is absent, so nothing opens. */
const INACTIVE_ENV: NodeJS.ProcessEnv = {
  STRAD_TOKENS: "[]",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
};

/** Staging's shape: NODE_ENV=production WITH both dev-auth acknowledgements. */
const STAGING_ENV: NodeJS.ProcessEnv = {
  STRAD_TOKENS: "[]",
  NODE_ENV: "production",
  ALLOW_DEV_AUTH: "true",
  ALLOW_DEV_AUTH_IN_PRODUCTION: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
};

/** Real production's shape: the prod acknowledgement is missing, so it is off. */
const PROD_ENV: NodeJS.ProcessEnv = {
  STRAD_TOKENS: "[]",
  NODE_ENV: "production",
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
};

/**
 * A deployment where Google sign-in can actually complete. The bypass is live
 * here too — that is the point: the OAuth path takes precedence, so the denial
 * is never reached and no bypass state is exposed.
 */
const GOOGLE_CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test, publicUrl: "https://strad.example.com" }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
  google:
    enabled: true
    hostedDomain: example.com
    roles: [admin]
roles:
  admin: { servers: ["*"] }
`);

const GOOGLE_ENV: NodeJS.ProcessEnv = {
  STRAD_TOKENS: "[]",
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  // Long enough to clear the session-key floor, so `sessions` is non-null.
  CONSOLE_SESSION_SECRET: "an-explicitly-rotated-console-key-for-tests",
};

/** Stands in for the provider at its one boundary: the URL it sends people to. */
const FAKE_GOOGLE = {
  beginAuth: () => ({
    state: "state-1",
    codeVerifier: "verifier-1",
    url: "https://accounts.google.com/o/oauth2/v2/auth?state=state-1",
  }),
  completeAuth: () => {
    throw new Error("not exercised here");
  },
};

const servers: Server[] = [];

async function boot(
  env: NodeJS.ProcessEnv,
  opts: {
    config?: typeof CONFIG;
    googleProvider?: Parameters<typeof createApp>[0]["googleProvider"];
  } = {},
): Promise<string> {
  const config = opts.config ?? CONFIG;
  const app = createApp({
    config,
    registry: await Registry.build({
      config,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env,
    }),
    tokenStore: tokenStoreFromConfig(config, env),
    mode: "core",
    env,
    // No Google OAuth on the four denial gateways: the bypass is the only door,
    // which is the deployment shape the two denials are about.
    googleProvider: opts.googleProvider ?? null,
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(srv);
  const addr = srv.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

let activeUrl: string;
let inactiveUrl: string;
let stagingUrl: string;
let prodUrl: string;
let googleReadyUrl: string;

beforeAll(async () => {
  [activeUrl, inactiveUrl, stagingUrl, prodUrl, googleReadyUrl] =
    await Promise.all([
      boot(ACTIVE_ENV),
      boot(INACTIVE_ENV),
      boot(STAGING_ENV),
      boot(PROD_ENV),
      boot(GOOGLE_ENV, {
        config: GOOGLE_CONFIG,
        googleProvider: FAKE_GOOGLE,
      }),
    ]);
});

afterAll(() => {
  for (const s of servers) s.close();
});

async function denial(url: string, token?: string) {
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  const res = await fetch(`${url}/console${qs}`, { redirect: "manual" });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("/console tells a wrong token apart from an unusable bypass", () => {
  it("answers a wrong token against a LIVE bypass with invalid_bootstrap_token", async () => {
    const { status, body } = await denial(activeUrl, "not-the-token");
    expect(status).toBe(401);
    expect(body.error).toBe("invalid_bootstrap_token");
    // The next step is "fix your token", and the body has to say so.
    expect(String(body.message)).toMatch(/ADMIN_BOOTSTRAP_TOKEN/);
    expect(body.devBypass).toBe("active");
  });

  it("answers a wrong token against an OFF bypass with console_unavailable, naming the guard", async () => {
    const { status, body } = await denial(inactiveUrl, "not-the-token");
    expect(status).toBe(401);
    expect(body.error).toBe("console_unavailable");
    // The next step is "fix the deployment", so the body names the guard that
    // is holding it shut rather than the caller's token.
    expect(body.devBypass).toBe("ALLOW_DEV_AUTH is not 'true'");
  });

  it("is DISTINGUISHABLE from the error code alone, which is the whole point", async () => {
    // The control experiment, as one assertion. The code has to carry it: a
    // caller that has to parse prose, or diff a body against a known-good
    // instance, is back where it started.
    const wrongTokenLiveBypass = await denial(activeUrl, "not-the-token");
    const anyTokenDeadBypass = await denial(inactiveUrl, "not-the-token");
    expect(wrongTokenLiveBypass.body.error).not.toBe(
      anyTokenDeadBypass.body.error,
    );
    expect(wrongTokenLiveBypass.body.message).not.toBe(
      anyTokenDeadBypass.body.message,
    );
  });

  it("never asserts 'not usable' about a bypass it also reports as active", async () => {
    const { body } = await denial(activeUrl, "not-the-token");
    expect(String(body.message)).not.toMatch(
      /not usable|not active|not configured/i,
    );
    // …and the honest version of that sentence is still there when it is true.
    const off = await denial(inactiveUrl, "not-the-token");
    expect(String(off.body.message)).toMatch(/not active/i);
  });

  it("says the same thing when no token is presented at all", async () => {
    // A bare GET is how a human first meets the console. It must say which of
    // the two worlds this deployment is in, not just "no".
    expect((await denial(activeUrl)).body.error).toBe(
      "invalid_bootstrap_token",
    );
    expect((await denial(inactiveUrl)).body.error).toBe("console_unavailable");
  });

  it("still lets the RIGHT token in — the diagnosis did not open a door", async () => {
    const res = await fetch(`${activeUrl}/console?token=${BOOTSTRAP}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { via: string }).via).toBe("dev-bypass");
  });
});

describe("the disclosure boundary: only a deployment that turned the bypass ON", () => {
  it("discloses on staging (NODE_ENV=production WITH both acknowledgements)", async () => {
    // Staging deliberately runs the bypass under NODE_ENV=production, so a
    // NODE_ENV gate would withhold this from the one operator it is for.
    const { body } = await denial(stagingUrl, "not-the-token");
    expect(body.error).toBe("invalid_bootstrap_token");
    expect(body.devBypass).toBe("active");
  });

  it("discloses NOTHING about the bypass on a deployment where it is fail-closed", async () => {
    // Real production: ALLOW_DEV_AUTH rode along on a copied spec, but the
    // separate production acknowledgement did not. The whole body is pinned,
    // because "we did not widen what a fail-closed prod says" is the claim the
    // disclosure argument rests on. It names the guard, and nothing else.
    const { status, body } = await denial(prodUrl, "not-the-token");
    expect(status).toBe(401);
    expect(body).toEqual({
      error: "console_unavailable",
      message:
        "Google OAuth is not configured and the console dev bypass is not active.",
      devBypass:
        "NODE_ENV=production requires ALLOW_DEV_AUTH_IN_PRODUCTION=true as well",
    });
  });

  it("says nothing about the token itself, on either branch", async () => {
    // Not the value, not a prefix, not a length, not how close an attempt came.
    for (const url of [activeUrl, stagingUrl, inactiveUrl, prodUrl]) {
      const { body } = await denial(url, "not-the-token");
      const json = JSON.stringify(body);
      expect(json).not.toContain(BOOTSTRAP);
      expect(json).not.toContain(String(BOOTSTRAP.length));
      expect(json).not.toContain("not-the-token");
    }
  });

  it("does not answer at all when Google sign-in can complete", async () => {
    // The precedence above the denial is what bounds this to OAuth-less
    // deployments: a gateway that can finish a Google login sends the caller
    // into it and never reaches consoleDenial(), so no bypass state is exposed.
    const res = await fetch(`${googleReadyUrl}/console`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("accounts.google.com");

    const ui = await fetch(`${googleReadyUrl}/ui`, { redirect: "manual" });
    expect(ui.status).toBe(302);
    expect(ui.headers.get("location") ?? "").toContain("/console/login");
  });

  it("leaves /mcp's opaque 401 exactly as it was", async () => {
    // The bypass is live on this gateway and the bootstrap token is correct for
    // /console. /mcp must still refuse it, with the one answer it gives every
    // failure — the invariant the disclosure argument leans on (HACKS.md #2).
    const res = await fetch(`${activeUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${BOOTSTRAP}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("invalid_bootstrap_token");
    expect(body).not.toContain("devBypass");
  });
});

describe("the /ui sign-in wall makes the same distinction", () => {
  it("tells a human with a live bypass to present the token", async () => {
    const res = await fetch(`${activeUrl}/ui`, { redirect: "manual" });
    const html = await res.text();
    expect(res.status).toBe(401);
    expect(html).toContain("Sign in required");
    expect(html).toContain("?token=");
  });

  it("does not tell a human to present a token that cannot possibly work", async () => {
    const res = await fetch(`${inactiveUrl}/ui`, { redirect: "manual" });
    const html = await res.text();
    expect(res.status).toBe(401);
    expect(html).toContain("Sign in required");
    // Advertising "present the bootstrap token as ?token=…" on a deployment
    // where no token can be accepted sends a human hunting for a credential
    // that was never the problem.
    expect(html).not.toContain("?token=");
    expect(html).toContain("ALLOW_DEV_AUTH is not &#39;true&#39;");
  });
});

describe("consoleDenial() as a unit", () => {
  const cfg = CONFIG;

  it("returns the active shape only when the bypass really is live", () => {
    expect(consoleDenial(cfg, ACTIVE_ENV).error).toBe(
      "invalid_bootstrap_token",
    );
    expect(consoleDenial(cfg, STAGING_ENV).error).toBe(
      "invalid_bootstrap_token",
    );
    for (const env of [INACTIVE_ENV, PROD_ENV, { STRAD_TOKENS: "[]" }]) {
      expect(consoleDenial(cfg, env).error).toBe("console_unavailable");
    }
  });

  it("carries the guard's own reason through when the bypass is off", () => {
    expect(consoleDenial(cfg, { ALLOW_DEV_AUTH: "true" }).devBypass).toBe(
      "ADMIN_BOOTSTRAP_TOKEN is not set",
    );
  });

  it("names the config flag, which is the guard an operator actually flips", () => {
    const off = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: false }
roles: {}
`);
    const denied = consoleDenial(off, ACTIVE_ENV);
    expect(denied.error).toBe("console_unavailable");
    expect(denied.devBypass).toBe("auth.consoleDevBypass.enabled is false");
  });
});
