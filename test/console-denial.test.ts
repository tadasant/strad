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
 * Both once answered `console_unavailable`, under one message — "the dev bypass
 * is not usable" — that asserted the second diagnosis even in the first case,
 * where the bypass was live. Telling them apart cost a control experiment
 * against a second instance the operator controlled: send a deliberately wrong
 * token to a box whose bypass is known-live, and compare. This file is that
 * control experiment, run as a test.
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

const servers: Server[] = [];

async function boot(env: NodeJS.ProcessEnv): Promise<string> {
  const app = createApp({
    config: CONFIG,
    registry: await Registry.build({
      config: CONFIG,
      secrets: new EnvSecretProvider({}),
      mode: "core",
      env,
    }),
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    // No Google OAuth on any of these: the bypass is the only door, which is
    // the deployment shape the two denials are about.
    googleProvider: null,
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

beforeAll(async () => {
  [activeUrl, inactiveUrl, stagingUrl, prodUrl] = await Promise.all([
    boot(ACTIVE_ENV),
    boot(INACTIVE_ENV),
    boot(STAGING_ENV),
    boot(PROD_ENV),
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
    // The control experiment #4390 had to build by hand, as one assertion. The
    // code has to carry it: a caller that has to parse prose, or diff a body
    // against a known-good instance, is back where it started.
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

  it("discloses NOTHING new on a deployment whose bypass is fail-closed", async () => {
    // Real production: ALLOW_DEV_AUTH rode along on a copied spec, but the
    // separate production acknowledgement did not. The bypass is off, and the
    // answer is byte-identical to what it was before this change.
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
    // The old wall said "entry is via the console dev bypass — present the
    // bootstrap token" even where no token could ever be accepted.
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
});
