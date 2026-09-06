import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import { readStoreDiagnostics } from "../src/secrets/store-diagnostics.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import {
  ParameterStoreError,
  type Capabilities,
} from "../src/secrets/parameters/index.ts";
import { DeadlineError } from "../src/util/deadline.ts";

/**
 * What the console tells a human when something goes wrong, and what it will not
 * tell them.
 *
 * This is the suite for the gap issue #156 named. `errorSummary` exists to keep a
 * `JSON.parse` window out of an error message — V8 puts ~10 characters of the
 * input into the `SyntaxError` it throws, and a parameter payload IS a credential
 * on a non-secret parameter — and the console's own two catch-alls, `describe()`
 * and `renderUnexpected()`, printed `err.message` straight into the HTML page.
 * `currentEnvelope()` in parameters/gcp.ts was the one store read on the
 * console's five write paths with no `try` around its decode, so the two met.
 *
 * Every assertion below is on what a BROWSER receives, plus the one field this
 * failure is logged under. The canary is planted INSIDE the payload that will not
 * parse, so a regression prints it rather than merely printing something unhelpful.
 */

// The value planted in the payload, and the window V8 would surface around the
// break. `WINDOW` is the tighter assertion: a fix that truncated the message to
// 200 characters would still leak it, because the window is ten characters long.
const CANARY = "sk-live-CANARY-7f21ab-DO-NOT-LEAK";
const WINDOW = "sk-live-CA";

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

const ADMIN_KEY = JSON.stringify({
  client_email: "strad-secrets-admin@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
});
const VIEWER_KEY = JSON.stringify({
  client_email: "strad-secrets-viewer@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
});
const SECRETS = { ADMIN_KEY, VIEWER_KEY };

const ADMIN_CAPABILITIES: Capabilities = {
  readSecretValues: true,
  writeParameters: true,
  writeSecretValues: true,
  deleteParameters: true,
  probed: true,
};

/**
 * Swapped per test so one suite can exercise both console catch-alls.
 *
 * `describe()` is reached from the action handler's own catch; `renderUnexpected`
 * is only reached by throwing OUTSIDE it, and `capabilitiesFor()` in
 * `renderSecretsPage` is the call that does that.
 */
let capabilities: () => Promise<Capabilities> = () =>
  Promise.resolve(ADMIN_CAPABILITIES);

/**
 * Swapped in when a test needs the store to fail a particular way.
 *
 * A `Proxy` over the fake rather than a second implementation: only the one
 * method under test is replaced, so everything else on the page still renders
 * and the shot is of a real console rather than of a stub.
 */
let storeFault: ((method: string) => Error) | null = null;

let fake: FakeGcp;
let server: Server;
let baseUrl: string;

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

const runtime = new EnvSecretProvider(SECRETS);
const runtimeProviders = sharedSecretProviders({
  name: runtime.name,
  get: (name: string) => runtime.get(name),
  invalidate: () => {},
});

beforeAll(async () => {
  fake = createFakeGcp();
  const registry = await Registry.build({
    config: CONFIG,
    secrets: runtimeProviders,
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
    secretProvider: runtimeProviders,
    parametersStore: () =>
      new Proxy(fake.store, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (!storeFault || typeof value !== "function") return value;
          const fault = storeFault;
          return (...args: unknown[]) => {
            if (prop === "list" || prop === "rotate" || prop === "reveal") {
              return Promise.reject(fault(String(prop)));
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }),
    capabilities: () => capabilities(),
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

afterEach(() => {
  capabilities = () => Promise.resolve(ADMIN_CAPABILITIES);
  storeFault = null;
});

const auth = { authorization: `Bearer ${BOOTSTRAP}` };

async function post(
  path: string,
  fields: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

/**
 * Seed one secret parameter, then overwrite its stored payload with a body that
 * `JSON.parse` refuses AND that carries a credential.
 *
 * The corruption is an UNQUOTED value, which is the one malformed shape V8
 * answers with a windowed message for: `Unexpected token 's', ..."value":sk-live-CA"...
 * is not valid JSON`. A truncation or a stray brace produces a positional message
 * with no window, so it would prove nothing.
 */
async function plantUnreadablePayload(): Promise<void> {
  fake.parameters.clear();
  fake.secrets.clear();
  await fake.store.create({
    path: `${NS}SEEDED_KEY`,
    secret: true,
    value: "seed-secret-value",
    note: "Seeded secret.",
  });

  const broken = `{"path":"${NS}SEEDED_KEY","secret":false,"value":${CANARY}}`;
  // Sanity: the payload really does produce a windowed message. If V8 ever stops
  // doing this the suite must say so rather than pass vacuously.
  let leaked = "";
  try {
    JSON.parse(broken);
  } catch (err) {
    leaked = (err as Error).message;
  }
  expect(leaked).toContain(WINDOW);

  for (const param of fake.parameters.values()) {
    const latest = param.versions.at(-1);
    if (latest) latest.data = Buffer.from(broken, "utf8").toString("base64");
  }
}

/**
 * What must never appear, wherever the console prints.
 *
 * The CLASS is not on this list, and that is deliberate — `errorSummary` prints
 * it on purpose, and a console that says "SyntaxError" and stops there is the
 * outcome issue #156 called worse than today. What is forbidden is the MESSAGE:
 * the value, the ten-character window V8 wraps around the break, and the shape
 * of the sentence that carries it.
 */
function expectNoLeak(text: string): void {
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain(WINDOW);
  expect(text).not.toContain("is not valid JSON");
}

describe("a stored payload that will not decode", () => {
  it("GET /ui/:server flashes strad's own sentence, not the parse window", async () => {
    await plantUnreadablePayload();
    const res = await fetch(`${baseUrl}/ui/secrets`, { headers: auth });
    const html = await res.text();

    expect(res.status).toBe(200);
    expectNoLeak(html);
    expect(html).toContain("not a strad envelope");
  });

  for (const [action, fields] of [
    ["rotate", { path: `${NS}SEEDED_KEY`, value: "a-new-value" }],
    ["note", { path: `${NS}SEEDED_KEY`, note: "a new note" }],
    ["reveal", { path: `${NS}SEEDED_KEY` }],
    ["delete", { path: `${NS}SEEDED_KEY` }],
  ] as const) {
    it(`POST /ui/:server/${action} answers 502 without the parse window`, async () => {
      await plantUnreadablePayload();
      const res = await post(`/ui/secrets/${action}`, fields);
      const html = await res.text();

      // 502 rather than 400: the caller's path was well-formed and the store's
      // answer was not, which is the store's failure and not theirs.
      expect(res.status).toBe(502);
      expectNoLeak(html);
      expect(html).toContain("not a strad envelope");
      // The sentence is only useful if it says what to do next.
      expect(html).toContain("Rotating writes a fresh version");
      // On THIS branch the error is a ParameterStoreError, so not even the
      // parse error's class reaches the page.
      expect(html).not.toContain("SyntaxError");
    });
  }

  it("logs the failure by class and resource, never by message", async () => {
    await plantUnreadablePayload();
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await readStoreDiagnostics({ store: fake.store, namespace: NS });
    } finally {
      console.error = original;
    }

    const logged = lines.join("\n");
    expect(logged).toContain("strad.store_diagnostics_failed");
    // `errorSummary` passes a ParameterStoreError's message through, because it
    // is method plus resource and nothing else.
    expect(logged).toContain("ParameterStoreError");
    expectNoLeak(logged);
  });
});

describe("the console's catch-all", () => {
  it("withholds an unexpected error's message and says why", async () => {
    await plantUnreadablePayload();
    // Thrown OUTSIDE the action handler's own try, so it reaches
    // `renderUnexpected` — the catch-all that used to render `err.message`.
    capabilities = () => {
      try {
        JSON.parse(`{"value":${CANARY}}`);
      } catch (err) {
        return Promise.reject(err as Error);
      }
      throw new Error("unreachable");
    };

    const res = await fetch(`${baseUrl}/ui/secrets`, { headers: auth });
    const html = await res.text();

    expect(res.status).toBe(500);
    expectNoLeak(html);
    // A class name alone would be a real loss for the operator. The page says
    // what was withheld and why, and it names the class.
    expect(html).toContain("Its message is withheld");
    expect(html).toContain("that payload is a credential");
  });
});

describe("the other failures an operator actually hits", () => {
  /**
   * Google's own refusal, and the console's own sentence for it.
   *
   * `ParameterStoreError` is the one shape whose message may be printed — method
   * plus resource — and the console STILL writes its own sentence for a 403,
   * because "GET projects/…/parameters/… failed: 403 Forbidden" does not tell an
   * operator that the fix is an IAM binding on the console's service account.
   */
  it("403: names the credential and what it is missing", async () => {
    await plantUnreadablePayload();
    storeFault = () =>
      new ParameterStoreError("GET parameters/x failed: 403 Forbidden", 403);

    const res = await post("/ui/secrets/rotate", {
      path: `${NS}SEEDED_KEY`,
      value: "a-new-value",
    });
    const html = await res.text();

    expect(res.status).toBe(403);
    expect(html).toContain("The store denied the request (403)");
    expect(html).toContain("needs write access");
  });

  it("timeout: says nothing was written, and answers 502 rather than 400", async () => {
    await plantUnreadablePayload();
    storeFault = () =>
      new DeadlineError("the store index timed out after 4000ms");

    const res = await post("/ui/secrets/rotate", {
      path: `${NS}SEEDED_KEY`,
      value: "a-new-value",
    });
    const html = await res.text();

    // 502, not the blanket 400 every non-store error used to get: a store that
    // did not answer is the store's failure, and behind an ingress a 4xx here
    // reads as the operator having typed something wrong.
    expect(res.status).toBe(502);
    expect(html).toContain("The store did not answer in time");
    expect(html).toContain("nothing was written");
    // The class name would have been `DeadlineError`, which says none of that.
    expect(html).not.toContain("DeadlineError");
  });

  it("a malformed path is still the caller's, and still says which rule it broke", async () => {
    await plantUnreadablePayload();
    const res = await post("/ui/secrets/rotate", {
      path: `${NS}not-a-variable`,
      value: "a-new-value",
    });
    const html = await res.text();

    // Validation runs before any request, so its text is strad's own and is
    // shown in full. A blanket `errorSummary` here would print
    // "ConsoleInputError" and leave the operator guessing.
    expect(res.status).toBe(400);
    expect(html).toContain("does not end in a valid variable name");
  });
});
