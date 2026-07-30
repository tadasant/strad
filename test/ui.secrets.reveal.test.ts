import { generateKeyPairSync } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  probeCapabilities,
  PROBE_PERMISSIONS,
  type Capabilities,
} from "../src/secrets/parameters/index.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import { revealPosture } from "../src/ui/reveal.ts";

/**
 * REVEAL: a feature flag over an IAM boundary, and what happens when they
 * disagree.
 *
 * The model under test, stated once:
 *
 *   - `SECRETS_REVEAL_ENABLED` decides what the console OFFERS. Absent = off.
 *   - `secretmanager.versions.access` on the console's service account decides
 *     what is POSSIBLE. Probed, not declared.
 *   - Both must say yes. The narrower one always wins.
 *
 * All four combinations are exercised through the REAL Express app, because the
 * property that matters is not "the button is hidden" — it is that a hand-crafted
 * POST to /ui/secrets/reveal is refused. A hidden control is presentation; the
 * refusal is the gate.
 */

const BOOTSTRAP = "bootstrap-secret-xyz";
const NS = "/strad/test/mcp/secrets/static/";
const CANARY = "sk-live-CANARY-DO-NOT-LEAK";

const KEY = JSON.stringify({
  client_email: "strad-secrets-admin@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
});
const SECRETS = { ADMIN_KEY: KEY };

function configWithReveal(flag: boolean | undefined) {
  const line =
    flag === undefined ? "" : `\n      SECRETS_REVEAL_ENABLED: "${flag}"`;
  return parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${NS}"
    consoleEnv:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${NS}"${line}
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
`);
}

const CAN_READ: Capabilities = {
  readSecretValues: true,
  writeParameters: true,
  writeSecretValues: true,
  deleteParameters: true,
  probed: true,
};
/** Prod's target shape: writes, but no `secretmanager.versions.access`. */
const WRITE_ONLY: Capabilities = { ...CAN_READ, readSecretValues: false };
/** The probe could not run. Fails closed, but says so distinctly. */
const UNPROBED: Capabilities = {
  readSecretValues: false,
  writeParameters: false,
  writeSecretValues: false,
  deleteParameters: false,
  probed: false,
  reason: "cloudresourcemanager.googleapis.com is not enabled",
};

// --- the posture, as a unit -------------------------------------------------

describe("the reveal posture", () => {
  it("allows reveal only when the flag AND the credential agree", () => {
    expect(revealPosture(true, CAN_READ).allowed).toBe(true);
    expect(revealPosture(false, CAN_READ).allowed).toBe(false);
    expect(revealPosture(true, WRITE_ONLY).allowed).toBe(false);
    expect(revealPosture(false, WRITE_ONLY).allowed).toBe(false);
  });

  it("reports flag-off-but-capable as DRIFT, naming the IAM fix", () => {
    // Prod's state until its admin SA is downgraded: hiding the button is worth
    // something, and the page must not let a reader believe it is a boundary.
    const p = revealPosture(false, CAN_READ);
    if (p.allowed) throw new Error("unreachable");
    expect(p.drift).toBe(true);
    expect(p.detail).toContain("secretmanager.versions.access");
    expect(p.detail).toContain("not yet a boundary");
  });

  it("reports flag-on-but-incapable as DRIFT the other way", () => {
    const p = revealPosture(true, WRITE_ONLY);
    if (p.allowed) throw new Error("unreachable");
    expect(p.drift).toBe(true);
    expect(p.detail).toContain("Google would refuse");
  });

  it("aligned off is not drift — off by config AND impossible by IAM", () => {
    const p = revealPosture(false, WRITE_ONLY);
    if (p.allowed) throw new Error("unreachable");
    expect(p.drift).toBe(false);
    expect(p.detail).toContain("write-only");
  });

  it("an unrunnable probe fails closed, distinctly from a denial", () => {
    const on = revealPosture(true, UNPROBED);
    if (on.allowed) throw new Error("unreachable");
    expect(on.label).toBe("unverified");
    expect(on.detail).toContain("cloudresourcemanager");
    // Not reported as a denial: the fix is enabling an API, not granting IAM.
    expect(on.detail).not.toContain("holds no");
  });
});

// --- the probe itself -------------------------------------------------------

describe("the capability probe", () => {
  // A REAL key pair: the probe signs a JWT before it can call anything, so a
  // placeholder string would fail at node:crypto and never reach the stub — which
  // would make every assertion below pass for the wrong reason.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = {
    client_email: "sa@demo.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };

  function stub(handler: (url: string, init?: RequestInit) => Response) {
    return ((url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(handler(String(url), init))) as typeof fetch;
  }

  const tokenOk = (_url: string) =>
    new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("derives each capability from the permissions Google returns", async () => {
    const caps = await probeCapabilities({
      projectId: "demo",
      account,
      tokenUrl: "https://token.example/token",
      crmApiBase: "https://crm.example",
      fetchImpl: stub((url) => {
        if (url.startsWith("https://token.example")) return tokenOk(url);
        return new Response(
          JSON.stringify({
            permissions: [
              PROBE_PERMISSIONS.createParameter,
              PROBE_PERMISSIONS.writeParameter,
              PROBE_PERMISSIONS.createSecret,
              PROBE_PERMISSIONS.writeSecretValue,
              // The IAM half of a secret create: `create()` grants the
              // parameter's own principal secretAccessor on its secret. It is a
              // WRITE that moves no value, which is why prod's write-without-read
              // role includes it and still reads nothing.
              PROBE_PERMISSIONS.readSecretIamPolicy,
              PROBE_PERMISSIONS.bindSecret,
              PROBE_PERMISSIONS.deleteParameter,
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });

    // Write-without-read: exactly prod's target shape.
    expect(caps.probed).toBe(true);
    expect(caps.readSecretValues).toBe(false);
    expect(caps.writeSecretValues).toBe(true);
    expect(caps.writeParameters).toBe(true);
    expect(caps.deleteParameters).toBe(true);
  });

  it("a secret write needs BOTH stores, not just Parameter Manager", async () => {
    const caps = await probeCapabilities({
      projectId: "demo",
      account,
      tokenUrl: "https://token.example/token",
      crmApiBase: "https://crm.example",
      fetchImpl: stub((url) =>
        url.startsWith("https://token.example")
          ? tokenOk(url)
          : new Response(
              JSON.stringify({
                permissions: [
                  PROBE_PERMISSIONS.createParameter,
                  PROBE_PERMISSIONS.writeParameter,
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
      ),
    });
    expect(caps.writeParameters).toBe(true);
    expect(caps.writeSecretValues).toBe(false);
  });

  it("never throws, and fails closed when the API is unreachable", async () => {
    const caps = await probeCapabilities({
      projectId: "demo",
      account,
      tokenUrl: "https://token.example/token",
      crmApiBase: "https://crm.example",
      fetchImpl: stub((url) =>
        url.startsWith("https://token.example")
          ? tokenOk(url)
          : new Response("SERVICE_DISABLED", { status: 403 }),
      ),
    });
    expect(caps.probed).toBe(false);
    expect(caps.readSecretValues).toBe(false);
    expect(caps.writeParameters).toBe(false);
    expect(caps.reason).toContain("403");
  });
});

// --- through the real app ---------------------------------------------------

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};
const auth = { authorization: `Bearer ${BOOTSTRAP}` };
const servers: Server[] = [];

afterAll(() => {
  for (const s of servers) s.close();
});

async function appWith(
  flag: boolean | undefined,
  caps: Capabilities,
): Promise<string> {
  const config = configWithReveal(flag);
  const fake = createFakeGcp();
  await fake.store.create({
    path: `${NS}SEEDED_KEY`,
    secret: true,
    value: CANARY,
    note: "Seeded secret.",
  });
  const app = createApp({
    config,
    registry: await Registry.build({
      config,
      secrets: new EnvSecretProvider(SECRETS),
      mode: "core",
      env,
    }),
    tokenStore: tokenStoreFromConfig(config, env),
    mode: "core",
    env,
    secrets: SECRETS,
    parametersStore: () => fake.store,
    capabilities: () => Promise.resolve(caps),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

async function revealPost(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/ui/secrets/reveal`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ path: `${NS}SEEDED_KEY` }),
    redirect: "manual",
  });
}

describe("reveal, end to end", () => {
  it("staging shape (flag on, credential permits): the value is shown once", async () => {
    const url = await appWith(true, CAN_READ);
    const page = await (
      await fetch(`${url}/ui/secrets`, { headers: auth })
    ).text();
    expect(page).toContain('action="/ui/secrets/reveal"');
    expect(page).not.toContain(CANARY);

    const res = await revealPost(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(CANARY);
  });

  it("prod shape (flag absent, credential cannot): no control, POST refused", async () => {
    const url = await appWith(undefined, WRITE_ONLY);
    const page = await (
      await fetch(`${url}/ui/secrets`, { headers: auth })
    ).text();
    // The control is gone, replaced by an inert explanation.
    expect(page).not.toContain('action="/ui/secrets/reveal"');
    expect(page).toContain("reveal off");
    expect(page).toContain("This deployment, right now");
    expect(page).toContain("off by configuration");
    expect(page).toContain("write-only");

    // And the endpoint refuses a hand-crafted POST — the gate, not the button.
    const res = await revealPost(url);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain(CANARY);
  });

  it("flag off but credential CAN read: refused, and reported as drift", async () => {
    const url = await appWith(false, CAN_READ);
    const page = await (
      await fetch(`${url}/ui/secrets`, { headers: auth })
    ).text();
    expect(page).not.toContain('action="/ui/secrets/reveal"');
    expect(page).toContain("not yet a boundary");

    const res = await revealPost(url);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(CANARY);
  });

  it("flag on but credential CANNOT: withheld rather than offered and 403ed", async () => {
    const url = await appWith(true, WRITE_ONLY);
    const page = await (
      await fetch(`${url}/ui/secrets`, { headers: auth })
    ).text();
    expect(page).not.toContain('action="/ui/secrets/reveal"');
    expect(page).toContain("not permitted");

    const res = await revealPost(url);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(CANARY);
  });

  it("an unrunnable probe withholds reveal even with the flag on", async () => {
    const url = await appWith(true, UNPROBED);
    const page = await (
      await fetch(`${url}/ui/secrets`, { headers: auth })
    ).text();
    expect(page).not.toContain('action="/ui/secrets/reveal"');
    expect(page).toContain("unverified");

    expect((await revealPost(url)).status).toBe(403);
  });

  it("gating reveal does not disable the other four actions", async () => {
    // Prod still has to add and rotate. Withholding reveal must not turn the
    // console read-only, or the downgrade would break secret management.
    const url = await appWith(undefined, WRITE_ONLY);
    const res = await fetch(`${url}/ui/secrets/create`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        variable: "WRITE_STILL_WORKS",
        value: "v",
        secret: "on",
      }),
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("WRITE_STILL_WORKS");
  });
});
