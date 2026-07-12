import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { resolveServerView } from "../src/ui/resolve.ts";
import {
  validateNote,
  validateSecretName,
  type SecretMeta,
  type SecretsAdmin,
} from "../src/ui/secretmanager-client.ts";
import { serverLooksSecrets } from "../src/ui/render.ts";

/**
 * The console's secrets manager — the ONLY write surface for a secret value in
 * all of strad, and the only place one can be read back.
 *
 * What is proven here, through the REAL Express app over a REAL socket:
 *
 *   1. The five write/read actions work: create (with a note), rotate, edit the
 *      note, reveal, delete.
 *   2. Every one of them is behind the SSO gate. Unauthenticated -> 401, and
 *      NOTHING is mutated.
 *   3. The console runs as the ADMIN service account, which is resolved from
 *      `consoleEnv:` — the scope appspec.ts puts on the core component alone.
 *      With no admin key injected, the page refuses to act rather than falling
 *      back to the MCP server's read-only credential.
 *   4. A value never reaches a URL. It travels in a POST body and comes back in
 *      one rendered panel; it is never a query param, so it cannot land in an
 *      access log, a Referer header, a proxy log or a bookmark.
 *   5. The console cannot act outside its managed namespace — strad's own
 *      `strad-staging-*` secrets live in the same project and must stay
 *      untouchable from here.
 */

const CANARY = "sk-live-CANARY-7f21ab-DO-NOT-LEAK";
const BOOTSTRAP = "bootstrap-secret-xyz";

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
  - slug: gcp-secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gcp-secrets
    entitlements: [admin]
    env:
      GCP_SECRETS_PROJECT_ID: "demo-project"
      GCP_SECRETS_NAMESPACES: "mcp-"
      GCP_SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${VIEWER_KEY}"
    consoleEnv:
      GCP_SECRETS_PROJECT_ID: "demo-project"
      GCP_SECRETS_NAMESPACES: "mcp-"
      GCP_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
`);

const ADMIN_KEY = JSON.stringify({
  client_email: "strad-secrets-admin@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
});
const VIEWER_KEY = JSON.stringify({
  client_email: "strad-secrets-viewer@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
});

const SECRETS = { ADMIN_KEY, VIEWER_KEY };

// --- an in-memory Secret Manager, standing in for Google --------------------

interface Stored {
  note?: string;
  versions: string[];
  createTime: string;
}

const store = new Map<string, Stored>();

function resetStore(): void {
  store.clear();
  store.set("mcp-existing-key", {
    note: "Seeded by the test.",
    versions: ["old-value"],
    createTime: "2026-01-01T00:00:00Z",
  });
}

const fakeAdmin: SecretsAdmin = {
  async list(namespace) {
    const out: SecretMeta[] = [];
    for (const [name, s] of store) {
      if (!name.startsWith(namespace)) continue;
      out.push({
        name,
        note: s.note,
        labels: { "managed-by": "strad" },
        createTime: s.createTime,
        latestVersion: s.versions.length
          ? String(s.versions.length)
          : undefined,
        latestVersionTime: s.versions.length
          ? "2026-07-12T00:00:00Z"
          : undefined,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
  async create({ name, value, note }) {
    if (store.has(name)) throw new Error("already exists");
    store.set(name, {
      note,
      versions: [value],
      createTime: "2026-07-12T00:00:00Z",
    });
    return { name, note, labels: {} };
  },
  async addVersion(name, value) {
    const s = store.get(name);
    if (!s) throw new Error("no such secret");
    s.versions.push(value);
  },
  async setNote(name, note) {
    const s = store.get(name);
    if (!s) throw new Error("no such secret");
    s.note = note || undefined;
  },
  async accessLatest(name) {
    const s = store.get(name);
    const v = s?.versions.at(-1);
    if (v === undefined) throw new Error("no version");
    return v;
  },
  async destroy(name) {
    store.delete(name);
  },
};

// --- units ------------------------------------------------------------------

describe("secrets view resolution", () => {
  it("resolves the ADMIN key from consoleEnv, never the MCP container's key", () => {
    const view = resolveServerView(CONFIG, "gcp-secrets", SECRETS);
    expect(view.kind).toBe("secrets");
    if (view.kind !== "secrets") throw new Error("unreachable");
    expect(view.projectId).toBe("demo-project");
    expect(view.namespaces).toEqual(["mcp-"]);
    expect(view.account?.client_email).toBe(
      "strad-secrets-admin@demo.iam.gserviceaccount.com",
    );
  });

  it("does NOT fall back to the viewer key when the admin key is absent", () => {
    // The viewer key IS resolvable here — and the console still refuses. A
    // fallback would silently run the console as the credential that cannot read
    // a value, and the "fix" for the resulting 403 would be to widen the MCP
    // server's IAM. That is the failure mode this asserts against.
    const view = resolveServerView(CONFIG, "gcp-secrets", { VIEWER_KEY });
    if (view.kind !== "secrets") throw new Error("unreachable");
    expect(view.account).toBeNull();
    expect(view.accountReason).toMatch(/ADMIN_SERVICE_ACCOUNT_KEY_JSON/);
  });

  it("serverLooksSecrets detects the server for the index card", () => {
    expect(serverLooksSecrets(CONFIG.servers[0]!)).toBe(true);
  });

  it("validates names against the namespace and the GCP charset", () => {
    expect(validateSecretName("mcp-ok_1", "mcp-")).toBeNull();
    expect(validateSecretName("other-key", "mcp-")).toMatch(
      /managed namespace/,
    );
    expect(validateSecretName("mcp-bad!", "mcp-")).toMatch(/letters, digits/);
    expect(validateSecretName("", "mcp-")).toMatch(/required/);
  });

  it("caps a note well under Secret Manager's 16 KiB annotation budget", () => {
    expect(validateNote("a short note")).toBeNull();
    expect(validateNote("x".repeat(4097))).toMatch(/at most 4096 bytes/);
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
  const registry = await Registry.build({
    config: CONFIG,
    secrets: SECRETS,
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
    secretsAdmin: () => fakeAdmin,
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

describe("the secrets console, end to end", () => {
  it("lists a secret with its name, note and version — and no value", async () => {
    resetStore();
    const res = await fetch(`${baseUrl}/ui/gcp-secrets`, { headers: auth });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("mcp-existing-key");
    expect(html).toContain("Seeded by the test.");
    expect(html).toContain("v1");
    expect(html).not.toContain("old-value");
  });

  it("CREATE: adds a secret with a note; the value goes to Secret Manager and nowhere else", async () => {
    resetStore();
    const res = await post("/ui/gcp-secrets/create", {
      name: "mcp-openai-api-key",
      note: "Billing account. Rotate quarterly.",
      value: CANARY,
    });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(store.get("mcp-openai-api-key")?.versions).toEqual([CANARY]);
    expect(store.get("mcp-openai-api-key")?.note).toBe(
      "Billing account. Rotate quarterly.",
    );

    // The page confirms the write and shows the note — never the value.
    expect(html).toContain("Created mcp-openai-api-key.");
    expect(html).toContain("Billing account. Rotate quarterly.");
    expect(html).not.toContain(CANARY);
  });

  it("REVEAL: shows the value once, in the page body, never in a URL", async () => {
    resetStore();
    await post("/ui/gcp-secrets/create", { name: "mcp-k", value: CANARY });

    const res = await post("/ui/gcp-secrets/reveal", { name: "mcp-k" });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(CANARY); // the whole point of a reveal
    // It arrived by POST and is rendered inline: no redirect, so no value can be
    // carried in a Location header or a query string.
    expect(res.headers.get("location")).toBeNull();
    expect(html).toContain("shown once");

    // And a plain reload of the page does not show it again.
    const again = await fetch(`${baseUrl}/ui/gcp-secrets`, { headers: auth });
    expect(await again.text()).not.toContain(CANARY);
  });

  it("ROTATE and NOTE: a new version, and an editable note", async () => {
    resetStore();
    await post("/ui/gcp-secrets/rotate", {
      name: "mcp-existing-key",
      value: "new-value",
    });
    expect(store.get("mcp-existing-key")?.versions).toEqual([
      "old-value",
      "new-value",
    ]);

    const res = await post("/ui/gcp-secrets/note", {
      name: "mcp-existing-key",
      note: "Rotated by hand on 2026-07-12.",
    });
    const html = await res.text();
    expect(store.get("mcp-existing-key")?.note).toBe(
      "Rotated by hand on 2026-07-12.",
    );
    expect(html).toContain("Note saved on mcp-existing-key.");
    expect(html).not.toContain("new-value");
  });

  it("DELETE: removes the secret and all of its versions", async () => {
    resetStore();
    const res = await post("/ui/gcp-secrets/delete", {
      name: "mcp-existing-key",
    });
    expect(store.has("mcp-existing-key")).toBe(false);
    expect(await res.text()).toContain("Deleted mcp-existing-key");
  });

  it("every write is behind the SSO gate: no token, no mutation", async () => {
    resetStore();
    for (const action of ["create", "rotate", "note", "reveal", "delete"]) {
      const res = await post(
        `/ui/gcp-secrets/${action}`,
        { name: "mcp-existing-key", value: "x", note: "y" },
        {}, // no Authorization header, no cookie
      );
      expect(res.status).toBe(401);
    }
    // Nothing moved.
    expect(store.get("mcp-existing-key")?.versions).toEqual(["old-value"]);
    expect(store.get("mcp-existing-key")?.note).toBe("Seeded by the test.");
    expect(store.size).toBe(1);
  });

  it("refuses to act outside the managed namespace — strad's own secrets are safe", async () => {
    resetStore();
    store.set("strad-staging-STRAD_TOKENS", {
      versions: ["[]"],
      createTime: "2026-01-01T00:00:00Z",
    });

    const res = await post("/ui/gcp-secrets/delete", {
      name: "strad-staging-STRAD_TOKENS",
    });
    // (The flash is HTML-escaped, so match a fragment with no apostrophe in it.)
    expect(await res.text()).toContain("outside this server");
    expect(store.has("strad-staging-STRAD_TOKENS")).toBe(true);

    // It is not even listed on the page.
    const page = await fetch(`${baseUrl}/ui/gcp-secrets`, { headers: auth });
    expect(await page.text()).not.toContain("STRAD_TOKENS");
  });

  it("the name field's HTML pattern is a VALID regex under Chrome's v-flag parser", async () => {
    // Caught by driving the real page with a real browser: `[A-Za-z0-9_-]+` is
    // rejected by Chrome's `v`-mode class parser ("Invalid character in character
    // class"), and an invalid `pattern` does not fail loudly — the browser just
    // stops validating, and the field silently accepts anything. The server-side
    // check still holds, but the user gets a round-trip instead of a hint.
    const res = await fetch(`${baseUrl}/ui/gcp-secrets`, { headers: auth });
    const html = await res.text();
    const pattern = /pattern="([^"]+)"/.exec(html)?.[1];
    expect(pattern).toBeTruthy();
    expect(() => new RegExp(pattern!, "v")).not.toThrow();
    // And it still means what it should.
    const re = new RegExp(`^${pattern}$`, "v");
    expect(re.test("mcp-openai_key-1")).toBe(true);
    expect(re.test("mcp bad")).toBe(false);
  });

  it("a bad name is a form error, not a 500 and not a write", async () => {
    resetStore();
    const res = await post("/ui/gcp-secrets/create", {
      name: "not-in-namespace",
      value: "x",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("must start with the managed namespace");
    expect(store.size).toBe(1);
  });
});
