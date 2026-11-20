import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import { parameterId } from "../src/secrets/parameters/index.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * A parameter ZIMMER wrote, in a store the console fronts.
 *
 * Zimmer writes into its own stores with its own client
 * (`tadasant/zimmer` `app/services/parameter_store/write_client.rb`): the same
 * id fold, the same envelope, the same `__REF__` at `versions/latest` — but
 * labelled `managed-by=zimmer`, with no `secret` label, no `encoding` (the
 * Secret Manager bytes are literal), and its first version minted as `v1`.
 *
 * The console's listing read `managed-by=strad` and nothing else, so such a
 * parameter was invisible on the page, while a create at its path still met
 * Google's `409 ALREADY_EXISTS`. A human rotating
 * `/zimmer/production/secrets/static/OPENROUTER_API_KEY` got "That parameter
 * already exists." with no row to rotate and no other route to a new version.
 *
 * Proven here, through the real Express app over a real socket:
 *
 *   1. the page lists the Zimmer-written parameter;
 *   2. a create at its path refuses with a 409 that OFFERS a new version of that
 *      path, rather than a dead end, and that form works;
 *   3. a rotate through strad leaves a value the resolver reads back;
 *   4. a delete through strad removes the Secret Manager half too — Zimmer
 *      stamps no `secret` label, and a delete keyed on that label alone would
 *      orphan the secret and turn the next create into the same dead end.
 */

const BOOTSTRAP = "bootstrap-secret-xyz";
const NS = "/zimmer/production/secrets/";
const PATH = `${NS}static/OPENROUTER_API_KEY`;
const OLD_VALUE = "sk-or-v1-OLD-canary";
const NEW_VALUE = "sk-or-v1-NEW-canary";

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
      SECRETS_PROJECT_ID: "zimmer-secrets-prod"
      SECRETS_NAMESPACES: "${NS}"
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${VIEWER_KEY}"
    consoleEnv:
      ZIMMER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
    consoleStores:
      - project: zimmer-secrets-prod
        label: Zimmer production
        namespaces: ["${NS}"]
        adminKeyVar: ZIMMER_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
        namespacesStrict: true
`);

const key = (email: string) =>
  JSON.stringify({
    client_email: email,
    private_key:
      "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
  });
const SECRETS = {
  ADMIN_KEY: key("zimmer-secrets-admin@zimmer.iam.gserviceaccount.com"),
  VIEWER_KEY: key("zimmer-secrets-viewer@zimmer.iam.gserviceaccount.com"),
};

const ADMIN_CAPABILITIES = {
  readSecretValues: true,
  writeParameters: true,
  writeSecretValues: true,
  deleteParameters: true,
  probed: true,
};

let fake: FakeGcp;

/** Seed `path` exactly as Zimmer's `WriteClient#upsert` leaves it. */
function seedZimmerWritten(path: string, value: string): string {
  const id = parameterId(path);
  const project = fake.endpoints.projectId;
  fake.secrets.set(id, [value]); // literal bytes — Zimmer does not encode
  fake.secretPolicies.set(id, [
    {
      role: "roles/secretmanager.secretAccessor",
      members: [fake.principalOf(id)],
    },
  ]);
  const envelope = JSON.stringify({
    path,
    secret: true,
    value: `__REF__("//secretmanager.googleapis.com/projects/${project}/secrets/${id}/versions/latest")`,
  });
  fake.parameters.set(id, {
    labels: { "managed-by": "zimmer" },
    versions: [
      {
        id: "v1",
        data: Buffer.from(envelope, "utf8").toString("base64"),
        createTime: "2026-11-01T00:00:00.000Z",
      },
    ],
  });
  return id;
}

let server: Server;
let baseUrl: string;
const auth = { authorization: `Bearer ${BOOTSTRAP}` };

beforeAll(async () => {
  fake = createFakeGcp();
  const env: NodeJS.ProcessEnv = {
    ALLOW_DEV_AUTH: "true",
    ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
    STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
    STRAD_TOKENS: "[]",
  };
  const runtime = new EnvSecretProvider(SECRETS);
  const providers = sharedSecretProviders({
    name: runtime.name,
    get: (name: string) => runtime.get(name),
    invalidate: () => {},
  });
  const registry = await Registry.build({
    config: CONFIG,
    secrets: providers,
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
    secretProvider: providers,
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

beforeEach(() => {
  fake.parameters.clear();
  fake.secrets.clear();
  fake.secretPolicies.clear();
  fake.store.forget?.();
});

const post = (path: string, fields: Record<string, string>) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ project: "zimmer-secrets-prod", ...fields }),
    redirect: "manual",
  });

describe("the store reads a Zimmer-written parameter as managed", () => {
  it("lists it, resolves it, and refuses a create at its path with a 409", async () => {
    seedZimmerWritten(PATH, OLD_VALUE);

    const listing = await fake.store.listDetailed!(NS);
    expect(listing.parameters.map((p) => [p.path, p.secret])).toEqual([
      [PATH, true],
    ]);
    expect(await fake.store.resolve(`${NS}static/`)).toEqual({
      OPENROUTER_API_KEY: OLD_VALUE,
    });

    await expect(
      fake.store.create({ path: PATH, secret: true, value: NEW_VALUE }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("still skips a parameter some other system labelled", async () => {
    const id = seedZimmerWritten(PATH, OLD_VALUE);
    fake.parameters.get(id)!.labels = { "managed-by": "terraform" };
    expect((await fake.store.listDetailed!(NS)).parameters).toEqual([]);
  });
});

describe("the console, end to end", () => {
  it("shows the Zimmer-written parameter as a row", async () => {
    seedZimmerWritten(PATH, OLD_VALUE);
    const res = await fetch(
      `${baseUrl}/ui/secrets?project=zimmer-secrets-prod&ns=${encodeURIComponent(NS)}`,
      { headers: auth },
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("OPENROUTER_API_KEY");
    expect(html).not.toContain(OLD_VALUE);
  });

  it("answers a colliding create with a way to add a new version, and that way works", async () => {
    seedZimmerWritten(PATH, OLD_VALUE);

    const res = await post("/ui/secrets/create", {
      ns: NS,
      prefix: "static/",
      variable: "OPENROUTER_API_KEY",
      secret: "on",
      value: NEW_VALUE,
    });
    const html = await res.text();
    expect(res.status).toBe(409);
    expect(html).toContain(`${PATH} already exists, so nothing was created.`);
    expect(html).toContain("Add a new version to OPENROUTER_API_KEY");
    // The offered form rotates THIS path in THIS store.
    expect(html).toMatch(
      new RegExp(
        `action="/ui/secrets/rotate" class="addform">\\s*<input type="hidden" name="path" value="${PATH}" />` +
          `<input type="hidden" name="ns" value="${NS}" /><input type="hidden" name="project" value="zimmer-secrets-prod" />`,
      ),
    );
    // The value the human typed is not echoed back into the page.
    expect(html).not.toContain(NEW_VALUE);
    // Nothing was written by the refused create.
    expect(fake.secrets.get(parameterId(PATH))).toEqual([OLD_VALUE]);

    const rotated = await post("/ui/secrets/rotate", {
      ns: NS,
      path: PATH,
      value: NEW_VALUE,
    });
    expect(rotated.status).toBe(200);
    expect(await rotated.text()).toContain(
      "Rotated OPENROUTER_API_KEY: a new value is now current.",
    );
    fake.store.forget?.();
    expect(await fake.store.resolve(`${NS}static/`)).toEqual({
      OPENROUTER_API_KEY: NEW_VALUE,
    });
  });

  it("deleting it removes the Secret Manager half, so a fresh create succeeds", async () => {
    const id = seedZimmerWritten(PATH, OLD_VALUE);

    const deleted = await post("/ui/secrets/delete", { ns: NS, path: PATH });
    expect(deleted.status).toBe(200);
    expect(fake.parameters.has(id)).toBe(false);
    expect(fake.secrets.has(id)).toBe(false);

    const created = await post("/ui/secrets/create", {
      ns: NS,
      prefix: "static/",
      variable: "OPENROUTER_API_KEY",
      secret: "on",
      value: NEW_VALUE,
    });
    expect(created.status).toBe(200);
  });

  it("explains a collision with a resource strad cannot read as a parameter", async () => {
    // Only the Secret Manager half: a write that stopped part-way.
    fake.secrets.set(parameterId(PATH), [OLD_VALUE]);

    const res = await post("/ui/secrets/create", {
      ns: NS,
      prefix: "static/",
      variable: "OPENROUTER_API_KEY",
      secret: "on",
      value: NEW_VALUE,
    });
    const html = await res.text();
    expect(res.status).toBe(409);
    expect(html).toContain("strad cannot read it as a parameter");
    expect(html).toContain(parameterId(PATH));
    expect(html).not.toContain("Add a new version to");
  });
});
