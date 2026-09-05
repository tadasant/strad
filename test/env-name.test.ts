import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import {
  ENV_NAME_SOURCE,
  MAX_VARIABLE_LENGTH,
  SECRET_REF_SOURCE,
  isEnvName,
  secretRefRe,
  secretRefsIn,
  validateVariableName,
} from "../src/config/env-name.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * "What is a legal environment-variable name" is ONE rule, and this suite is
 * what keeps it one.
 *
 * The rule is enforced in three places that cannot see each other: the config
 * schema (which composes `/strad/{env}/mcp/{slug}/static/{VARIABLE}` out of it),
 * the reference scanners on both sides of the deploy boundary (which decide
 * which `${NAME}`s get baked and which get looked up), and the browser (an HTML
 * `pattern=` on the console's create form). A disagreement between any two of
 * them is silent and credential-shaped.
 *
 * Three properties:
 *
 *   1. THE `/g` TRAP. The reference form is global, and a shared global regex
 *      OBJECT carries `lastIndex` between calls — so the second scan of a string
 *      would start where the first stopped and miss a `${NAME}`. The module
 *      exports a SOURCE and a factory for exactly this reason; the assertion
 *      here is that repeating a scan repeats its answer.
 *   2. THE BROWSER GATE IS THE SERVER GATE. Rendered through the real Express
 *      console, the `pattern=` attribute a browser enforces and the regex the
 *      server enforces accept the same strings.
 *   3. THE VENDORED RESIDUAL. Three modules are copied byte-for-byte across an
 *      npm-tree boundary and cannot import this one, so they keep their own
 *      literal (`HACKS.md` #81). That literal is checked here, as text, because
 *      nothing else in the repo can see both spellings at once.
 */

describe("the rule itself", () => {
  it("accepts the shapes a variable name really takes", () => {
    for (const name of [
      "GRANOLA_TOKEN",
      "_LEADING_UNDERSCORE",
      "a",
      "_",
      "TELEGRAM_RO__TELEGRAM_API_HASH",
      "x9",
    ]) {
      expect(isEnvName(name)).toBe(true);
    }
  });

  it("refuses everything a shell, App Platform or a path would choke on", () => {
    for (const name of [
      "",
      "9LIVES",
      "HAS-DASH",
      "HAS SPACE",
      "HAS.DOT",
      "a/b",
      "../escape",
      "FOO\nBAR",
      "FOO$",
      "ünicode",
    ]) {
      expect(isEnvName(name)).toBe(false);
    }
  });

  it("caps a variable name where Parameter Manager does", () => {
    expect(MAX_VARIABLE_LENGTH).toBe(200);
    expect(validateVariableName("A".repeat(200))).toBeNull();
    expect(validateVariableName("A".repeat(201))).toMatch(/at most 200/);
    expect(validateVariableName("")).toMatch(/required/);
    expect(validateVariableName("9LIVES")).toMatch(
      /valid environment variable/,
    );
  });

  it("the reference form is the bare form, wrapped", () => {
    // Not a restatement: the `${…}` source EMBEDS the same character class, so a
    // widened bare form widens the reference form with it. Assert the containment
    // rather than a second copy of the class.
    expect(SECRET_REF_SOURCE).toContain(ENV_NAME_SOURCE);
  });
});

describe("the /g trap", () => {
  const value = "${A} then ${B} then ${A}";

  it("returns the same answer however many times it is asked", () => {
    const first = secretRefsIn(value);
    expect(first).toEqual(["A", "B"]);
    for (let i = 0; i < 5; i += 1) {
      expect(secretRefsIn(value)).toEqual(first);
    }
  });

  it("hands out a FRESH regex, never a shared one carrying lastIndex", () => {
    const a = secretRefRe();
    const b = secretRefRe();
    expect(a).not.toBe(b);
    expect(a.global).toBe(true);

    // The failure the factory exists to prevent, demonstrated on ONE object:
    // `test()` on a global regex advances `lastIndex`, so the second call is
    // answered from the middle of the string. A shared export would do this
    // across modules, silently.
    expect(a.test(value)).toBe(true);
    expect(a.lastIndex).toBeGreaterThan(0);
    // And a fresh one is not affected by it.
    expect(secretRefRe().test(value)).toBe(true);
    expect(secretRefRe().lastIndex).toBe(0);
  });

  it("is safe under interleaved scans", () => {
    // Two scans in flight over different strings must not see each other.
    const outer = secretRefsIn("${ONE} ${TWO}");
    const inner = secretRefsIn("${THREE}");
    expect(outer).toEqual(["ONE", "TWO"]);
    expect(inner).toEqual(["THREE"]);
    expect(secretRefsIn("${ONE} ${TWO}")).toEqual(outer);
  });

  it("finds no reference in text that only looks like one", () => {
    expect(secretRefsIn("${9LIVES}")).toEqual([]);
    expect(secretRefsIn("${HAS-DASH}")).toEqual([]);
    expect(secretRefsIn("$NOT_BRACED")).toEqual([]);
    expect(secretRefsIn("plain text")).toEqual([]);
  });
});

// --- the browser gate, through the real console -----------------------------

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
    consoleEnv:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${NS}"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
`);

const ADMIN_KEY = JSON.stringify({
  client_email: "strad-secrets-admin@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
});
const SECRETS = { ADMIN_KEY };

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

let fake: FakeGcp;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  fake = createFakeGcp();
  const secrets = sharedSecretProviders(new EnvSecretProvider(SECRETS));
  const app = createApp({
    config: CONFIG,
    registry: await Registry.build({
      config: CONFIG,
      secrets,
      mode: "core",
      env,
    }),
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    secrets: SECRETS,
    parametersStore: () => fake.store,
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

describe("the browser gate is the server gate", () => {
  it("renders a pattern= built from the shared source, not a second copy", async () => {
    const res = await fetch(`${baseUrl}/ui/secrets`, {
      headers: { authorization: `Bearer ${BOOTSTRAP}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    const match = /id="varname"[^>]*\spattern="([^"]*)"/.exec(html);
    expect(match, "the create form's variable-name input").not.toBeNull();
    const pattern = match![1]!;
    expect(pattern).toBe(ENV_NAME_SOURCE);

    // The attribute agreeing with the constant is only half of it: HTML anchors
    // `pattern` implicitly, so what a BROWSER enforces is the attribute between
    // `^(?:` and `)$`. Assert that compiled form accepts exactly what the server
    // accepts, over the same corpus both gates would ever see.
    const asBrowser = new RegExp(`^(?:${pattern})$`, "u");
    for (const candidate of [
      "GRANOLA_TOKEN",
      "_LEADING_UNDERSCORE",
      "a",
      "_",
      "x9",
      "TELEGRAM_RO__TELEGRAM_API_HASH",
      "",
      "9LIVES",
      "HAS-DASH",
      "HAS SPACE",
      "HAS.DOT",
      "a/b",
      "FOO\nBAR",
      "ünicode",
    ]) {
      expect(
        asBrowser.test(candidate),
        `browser and server disagree on ${JSON.stringify(candidate)}`,
      ).toBe(isEnvName(candidate));
      // And on the gate a human's typing actually reaches next.
      expect(validateVariableName(candidate) === null).toBe(
        asBrowser.test(candidate),
      );
    }
  });
});

// --- the residual the vendoring boundary leaves behind ----------------------

describe("the copies that cannot import the rule still spell it", () => {
  // These three are vendored byte-for-byte into `servers/bundle/host/src/` and
  // must stay import-free, so they keep a literal. `test/vendored.sync.test.ts`
  // proves each COPY matches its source; this proves each SOURCE matches the
  // shared constant, which is the half no manifest can see. Read as text: the
  // point is the spelling, not the value the module computes.
  const files = [
    "src/secrets/presence.ts",
    "src/secrets/param-route.ts",
    "src/secrets/env-prefix.ts",
  ];

  it.each(files)("%s", (path) => {
    const source = readFileSync(path, "utf8");
    // `A-Za-z_` appears once per spelling of the class and nowhere else in these
    // files (`A-Za-z0-9_` does not contain it). So every mention of the class
    // must also be a verbatim occurrence of ENV_NAME_SOURCE — a widened or
    // narrowed copy makes the two counts diverge.
    const mentions = source.split("A-Za-z_").length - 1;
    const verbatim = source.split(ENV_NAME_SOURCE).length - 1;
    expect(mentions).toBeGreaterThan(0);
    expect(verbatim).toBe(mentions);
  });
});
