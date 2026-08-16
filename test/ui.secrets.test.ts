import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { resolveServerView, serverLooksSecrets } from "../src/ui/resolve.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import { encodeSecretValue } from "../src/secrets/parameters/wire.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";

/**
 * The console's parameters manager — the ONLY write surface for a parameter in
 * all of strad, and (for a SECRET parameter) the only place its value can be read
 * back.
 *
 * What is proven here, through the REAL Express app over a REAL socket:
 *
 *   1. Both kinds work: a NON-SECRET parameter (value in Parameter Manager,
 *      readable) and a SECRET one (value in Secret Manager, referenced from
 *      Parameter Manager), across create / rotate / note / reveal / delete.
 *   2. Every action is behind the SSO gate. Unauthenticated -> 401, no mutation.
 *   3. The console runs as the ADMIN service account, resolved from `consoleEnv:`
 *      — the scope appspec.ts puts on the core component alone. With no admin key,
 *      it refuses rather than falling back to the MCP viewer credential.
 *   4. A value never reaches a URL. It travels in a POST body and comes back in
 *      one rendered panel; never a query param.
 *   5. The console cannot act outside its managed namespace.
 */

const CANARY = "sk-live-CANARY-7f21ab-DO-NOT-LEAK";
const BOOTSTRAP = "bootstrap-secret-xyz";
const NS = "/strad/test/mcp/secrets/static/";

const CONFIG = parseConfig(`
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
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${VIEWER_KEY}"
    consoleEnv:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${NS}"
      SECRETS_REVEAL_ENABLED: "true"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
`);

/**
 * The console's credential, as Google would report it: a full admin. This suite
 * covers the surface when reveal is BOTH offered and permitted — the staging
 * posture. test/ui.secrets.reveal.test.ts covers the other three combinations.
 */
const ADMIN_CAPABILITIES = {
  readSecretValues: true,
  writeParameters: true,
  writeSecretValues: true,
  deleteParameters: true,
  probed: true,
};

const ADMIN_KEY = JSON.stringify({
  client_email: "strad-secrets-admin@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
});
const VIEWER_KEY = JSON.stringify({
  client_email: "strad-secrets-viewer@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
});

const SECRETS = { ADMIN_KEY, VIEWER_KEY };

// --- the store seam: an in-memory Parameter + Secret Manager ----------------

let fake: FakeGcp;

async function resetStore(): Promise<void> {
  fake.parameters.clear();
  fake.secrets.clear();
  await fake.store.create({
    path: `${NS}SEEDED_EMAIL`,
    secret: false,
    value: "seed@demo.iam.gserviceaccount.com",
    note: "Seeded non-secret.",
  });
  await fake.store.create({
    path: `${NS}SEEDED_KEY`,
    secret: true,
    value: "seed-secret-value",
    note: "Seeded secret.",
  });
}

// --- units ------------------------------------------------------------------

describe("secrets view resolution", () => {
  it("resolves the ADMIN key from consoleEnv, never the MCP container's key", () => {
    const view = resolveServerView(CONFIG, "secrets", SECRETS);
    expect(view.kind).toBe("secrets");
    if (view.kind !== "secrets") throw new Error("unreachable");
    expect(view.projectId).toBe("demo-project");
    expect(view.namespaces).toEqual([NS]);
    expect(view.account?.client_email).toBe(
      "strad-secrets-admin@demo.iam.gserviceaccount.com",
    );
  });

  it("does NOT fall back to the viewer key when the admin key is absent", () => {
    // The viewer key IS resolvable here — and the console still refuses. A
    // fallback would silently run the console as the credential that cannot read
    // a secret value, and the "fix" for the resulting 403 would be to widen the
    // MCP server's IAM. That is the failure mode this asserts against.
    const view = resolveServerView(CONFIG, "secrets", { VIEWER_KEY });
    if (view.kind !== "secrets") throw new Error("unreachable");
    expect(view.account).toBeNull();
    expect(view.accountReason).toMatch(/ADMIN_SERVICE_ACCOUNT_KEY_JSON/);
  });

  it("serverLooksSecrets detects the server for the index card", () => {
    expect(serverLooksSecrets(CONFIG.servers[0]!)).toBe(true);
  });
});

// --- through the real Express app -------------------------------------------

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  fake = createFakeGcp();
  const registry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(new EnvSecretProvider(SECRETS)),
    mode: "core",
    env,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    secrets: SECRETS,
    parametersStore: () => fake.store,
    capabilities: () => Promise.resolve(ADMIN_CAPABILITIES),
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

const auth = { authorization: `Bearer ${BOOTSTRAP}` };

async function post(
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = auth,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

describe("the parameters console, end to end", () => {
  it("lists both kinds with their notes — a secret value never appears", async () => {
    await resetStore();
    const res = await fetch(`${baseUrl}/ui/secrets`, { headers: auth });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("SEEDED_EMAIL");
    expect(html).toContain("SEEDED_KEY");
    expect(html).toContain("Seeded non-secret.");
    expect(html).toContain("Seeded secret.");
    expect(html).toContain("secret"); // the kind badge
    expect(html).not.toContain("seed-secret-value");
  });

  it("CREATE non-secret: the value goes to Parameter Manager and is readable", async () => {
    await resetStore();
    const res = await post("/ui/secrets/create", {
      variable: "GCS_CLIENT_EMAIL",
      note: "The service-account email. Not a secret.",
      value: "svc@demo.iam.gserviceaccount.com",
    });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(
      `Created GCS_CLIENT_EMAIL (non-secret) at ${NS}GCS_CLIENT_EMAIL.`,
    );
    // Stored in Parameter Manager (its payload holds the literal), not Secret Manager.
    expect(fake.pmPayloads().join("\n")).toContain(
      "svc@demo.iam.gserviceaccount.com",
    );
    expect(await fake.store.reveal(`${NS}GCS_CLIENT_EMAIL`)).toBe(
      "svc@demo.iam.gserviceaccount.com",
    );
  });

  it("CREATE secret: the value goes to Secret Manager and never a PM payload", async () => {
    await resetStore();
    const res = await post("/ui/secrets/create", {
      variable: "GCS_PRIVATE_KEY",
      secret: "on",
      note: "The private key. Rotate quarterly.",
      value: CANARY,
    });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(
      `Created GCS_PRIVATE_KEY (secret) at ${NS}GCS_PRIVATE_KEY.`,
    );
    expect(html).not.toContain(CANARY);
    // The value lives in Secret Manager — base64url-encoded, so it survives
    // `:render`'s substitution into the JSON payload — and the PM payload holds
    // only a __REF__. Neither spelling of the value may appear there.
    expect([...fake.secrets.values()].flat()).toContain(
      encodeSecretValue(CANARY),
    );
    expect(fake.pmPayloads().join("\n")).not.toContain(CANARY);
    expect(fake.pmPayloads().join("\n")).not.toContain(
      encodeSecretValue(CANARY),
    );
  });

  it("REVEAL: shows the secret value once, in the body, never in a URL", async () => {
    await resetStore();
    const res = await post("/ui/secrets/reveal", { path: `${NS}SEEDED_KEY` });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("seed-secret-value"); // the whole point of a reveal
    expect(res.headers.get("location")).toBeNull(); // POST, not a redirect
    expect(html).toContain("shown once");

    // A plain reload does not show it again.
    const again = await fetch(`${baseUrl}/ui/secrets`, { headers: auth });
    expect(await again.text()).not.toContain("seed-secret-value");
  });

  it("ROTATE and NOTE: a new value, and an editable note", async () => {
    await resetStore();
    await post("/ui/secrets/rotate", {
      path: `${NS}SEEDED_KEY`,
      value: "rotated-secret",
    });
    expect(await fake.store.reveal(`${NS}SEEDED_KEY`)).toBe("rotated-secret");

    const res = await post("/ui/secrets/note", {
      path: `${NS}SEEDED_KEY`,
      note: "Rotated by hand.",
    });
    const html = await res.text();
    expect(html).toContain("Note saved on SEEDED_KEY.");
    expect(html).not.toContain("rotated-secret");
  });

  it("DELETE: removes the parameter from both stores", async () => {
    await resetStore();
    const res = await post("/ui/secrets/delete", { path: `${NS}SEEDED_KEY` });
    expect(await res.text()).toContain("Deleted SEEDED_KEY");
    expect(await fake.store.list(NS)).toHaveLength(1); // only the non-secret one left
  });

  it("every write is behind the SSO gate: no token, no mutation", async () => {
    await resetStore();
    for (const action of ["create", "rotate", "note", "reveal", "delete"]) {
      const res = await post(
        `/ui/secrets/${action}`,
        { path: `${NS}SEEDED_KEY`, variable: "X", value: "x", note: "y" },
        {}, // no Authorization header, no cookie
      );
      expect(res.status).toBe(401);
    }
    expect(await fake.store.list(NS)).toHaveLength(2); // nothing moved
  });

  it("refuses a path that is not well formed", async () => {
    // The configured namespace list is a convenience, not the fence — the GCP
    // PROJECT is (servers/secrets/README.md). So what is refused here is a
    // malformed path, not merely an unlisted one.
    await resetStore();
    for (const path of [
      "strad/test/mcp/NOT_ABSOLUTE",
      "/strad/test/mcp//DOUBLE",
      "/strad/test/../escape/X",
      "/strad/test/mcp/bad name/X",
    ]) {
      const res = await post("/ui/secrets/delete", { path });
      expect(await res.text()).toMatch(
        /not (an absolute|a well-formed)|does not end in a valid variable name/,
      );
    }
    expect(await fake.store.list(NS)).toHaveLength(2);
  });

  it("refuses a path that FOLDS onto another parameter's id", async () => {
    // `parameterId` lowercases and collapses non-alphanumeric runs, so these are
    // all spellings of SEEDED_KEY's resource. `path` comes from a hidden form
    // field, so the spelling is the caller's to choose — and a delete under a
    // colliding spelling would destroy a parameter the caller did not name.
    await resetStore();
    const collisions = [
      `/STRAD/test/mcp/secrets/static/SEEDED_KEY`,
      `/strad/test/mcp/./secrets/static/SEEDED_KEY`,
      `/strad-test/mcp/secrets/static/SEEDED_KEY`,
    ];
    for (const path of collisions) {
      for (const action of ["delete", "reveal", "note"]) {
        const res = await post(`/ui/secrets/${action}`, { path, note: "x" });
        expect(res.status).toBeGreaterThanOrEqual(400);
      }
    }
    // Both seeded parameters survive, values intact.
    expect(await fake.store.list(NS)).toHaveLength(2);
    expect(await fake.store.reveal(`${NS}SEEDED_KEY`)).toBe(
      "seed-secret-value",
    );
  });

  it("refuses a path whose variable name is malformed", async () => {
    await resetStore();
    const res = await post("/ui/secrets/rotate", {
      path: `${NS}bad-variable!`,
      value: "v",
    });
    expect(await res.text()).toContain("valid variable name");
    expect(await fake.store.list(NS)).toHaveLength(2);
  });

  it("a missing variable name is a form error, not a 500 and not a write", async () => {
    await resetStore();
    const res = await post("/ui/secrets/create", { variable: "", value: "x" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("variable name is required");
    expect(await fake.store.list(NS)).toHaveLength(2);
  });

  it("the create form's variable pattern is a VALID regex under Chrome's v-flag parser", async () => {
    // An invalid `pattern` does not fail loudly — the browser stops validating and
    // the field silently accepts anything. Compile it under the `v` flag, as Chrome
    // does, so a bad pattern fails CI, not a user.
    const res = await fetch(`${baseUrl}/ui/secrets`, { headers: auth });
    const html = await res.text();
    const pattern = /pattern="([^"]+)"/.exec(html)?.[1];
    expect(pattern).toBeTruthy();
    expect(() => new RegExp(pattern!, "v")).not.toThrow();
    const re = new RegExp(`^${pattern}$`, "v");
    expect(re.test("REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL")).toBe(true);
    expect(re.test("1bad")).toBe(false);
  });
});
