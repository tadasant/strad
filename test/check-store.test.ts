import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { preflightSecrets } from "../src/deploy/preflight.ts";
import { checkStore, expectedStoreNames } from "../src/deploy/store-check.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  gatewayNamespace,
  gatewayParameterPath,
} from "../src/secrets/parameters/namespace.ts";
import { secretRef } from "../src/secrets/parameters/wire.ts";
import { RESOLVER_ENV } from "../src/secrets/parameters/resolver.ts";
import { ParameterStoreError } from "../src/secrets/parameters/types.ts";
import { serveFake } from "./helpers/serve-fake.ts";

/**
 * The pre-flip completeness check, and the gap in `preflightSecrets()` it exists
 * to close.
 *
 * The preflight is a deploy gate: it fails a deploy that references a secret the
 * store does not hold, and it forgives the boot keys a correct deployment may
 * legitimately lack. That second half is right for a deploy and wrong for a
 * provider flip — `GOOGLE_CLIENT_ID` is optional at boot and load-bearing for
 * `/ui` the moment `auth.google.enabled` is true, so a namespace missing it
 * passes preflight and takes the console's front door down.
 *
 * The first test in this file is that contrast, on one input.
 */

const NAMESPACE = gatewayNamespace("test");

/** A config shaped like a real one: a ${REF}, a bundle env:, a consoleEnv:. */
const CONFIG_YAML = `
version: 1
gateway:
  name: strad
  env: test
  secrets:
    provider: gcp-parameter-store
auth:
  staticTokens: { enabled: true, store: env }
  google:
    enabled: true
    hostedDomain: example.com
    roles: [admin]
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle-shop
servers:
  - slug: granola
    kind: remote-http
    url: https://mcp.granola.example.com/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${GRANOLA_TOKEN}"
  - slug: shop
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-shop
    entitlements: [admin]
    env:
      SHOP_PASSWORD: "\${SHOP_PASSWORD}"
    consoleEnv:
      ADMIN_KEY: "\${SECRETS_ADMIN_KEY_JSON}"
`;

const config = parseConfig(CONFIG_YAML);

/**
 * Everything except the one name under test.
 *
 * The values are distinctive sentinels rather than realistic-looking ones, and
 * that is load-bearing: the leak assertion is `not.toContain(value)` over the
 * whole output, so a short generic value like `[]` or `session` would fail the
 * moment ordinary output happened to contain it — a false alarm on the one test
 * nobody should learn to ignore.
 */
const SEEDED = [
  ["GRANOLA_TOKEN", "leak-canary-granola-9f2a"],
  ["STRAD_TOKENS", "leak-canary-tokens-9f2a"],
  ["STRAD_INTERNAL_TOKEN", "leak-canary-internal-9f2a"],
  ["ADMIN_BOOTSTRAP_TOKEN", "leak-canary-bootstrap-9f2a"],
  ["GOOGLE_CLIENT_SECRET", "leak-canary-google-9f2a"],
  ["CONSOLE_SESSION_SECRET", "leak-canary-session-9f2a"],
  ["OTEL_EXPORTER_OTLP_HEADERS", "leak-canary-otel-9f2a"],
  ["SENTRY_DSN", "leak-canary-sentry-9f2a"],
  ["SHOP_PASSWORD", "leak-canary-shop-9f2a"],
] as const;

async function seededFake(): Promise<ReturnType<typeof createFakeGcp>> {
  const fake = createFakeGcp();
  for (const [name, value] of SEEDED) {
    await fake.store.create({
      path: gatewayParameterPath("test", name),
      secret: true,
      value,
    });
  }
  return fake;
}

describe("the gap this closes", () => {
  it("names GOOGLE_CLIENT_ID where preflightSecrets() passes the same store", async () => {
    const fake = await seededFake(); // every name but GOOGLE_CLIENT_ID

    // The deploy gate: green. GOOGLE_CLIENT_ID is optional at boot, so it is
    // reported and never counted, and this deploy ships.
    const preflight = await preflightSecrets(fake.store, config);
    expect(preflight.missing).toStrictEqual([]);

    // The pre-flip check: red, by name. With auth.google.enabled that absence is
    // a front-door outage on /ui, not a dormant one.
    const check = await checkStore(fake.store, config);
    expect(check.missing).toStrictEqual(["GOOGLE_CLIENT_ID"]);
    expect(check.namespace).toBe(NAMESPACE);
  });

  it("counts the supplementary env: names preflight leaves out", async () => {
    // Not a gap in preflight — those are baked at render time and render-spec
    // fails on a missing one. But under the store provider they are READ FROM THE
    // STORE, so they must be seeded before the flip, and nothing checked that.
    const fake = createFakeGcp();
    const check = await checkStore(fake.store, config);
    expect(check.expected).toContain("SHOP_PASSWORD");

    const preflight = await preflightSecrets(fake.store, config);
    expect(preflight.missing).not.toContain("SHOP_PASSWORD");
    expect(check.missing).toContain("SHOP_PASSWORD");
  });
});

describe("expectedStoreNames", () => {
  it("expects every core boot key, optional-at-boot included", () => {
    const names = expectedStoreNames(config);
    // The two preflight demands…
    expect(names).toContain("STRAD_TOKENS");
    expect(names).toContain("STRAD_INTERNAL_TOKEN");
    // …and the five it waves through.
    expect(names).toContain("ADMIN_BOOTSTRAP_TOKEN");
    expect(names).toContain("GOOGLE_CLIENT_ID");
    expect(names).toContain("GOOGLE_CLIENT_SECRET");
    expect(names).toContain("CONSOLE_SESSION_SECRET");
    expect(names).toContain("OTEL_EXPORTER_OTLP_HEADERS");
    // …plus the config's own ref and the bundle's env.
    expect(names).toContain("GRANOLA_TOKEN");
    expect(names).toContain("SHOP_PASSWORD");
  });

  it("does NOT expect a consoleEnv: name — that one must stay out of the store", () => {
    // It carries the console's store-ADMIN credential. Filing it here would let
    // the weaker resolver credential read the stronger one.
    expect(expectedStoreNames(config)).not.toContain("SECRETS_ADMIN_KEY_JSON");
  });

  it("reports a consoleEnv: name that IS in the store, as its own finding", async () => {
    const fake = await seededFake();
    await fake.store.create({
      path: gatewayParameterPath("test", "SECRETS_ADMIN_KEY_JSON"),
      secret: true,
      value: "leak-canary-adminkey-9f2a",
    });
    const check = await checkStore(fake.store, config);
    expect(check.environmentOnly).toStrictEqual(["SECRETS_ADMIN_KEY_JSON"]);
    expect(check.adminCredentialsInStore).toStrictEqual([
      "SECRETS_ADMIN_KEY_JSON",
    ]);
    // Not present (nothing reads it there) and not missing (it should not be
    // there at all). Counting it as either would name the wrong fix.
    expect(check.present).not.toContain("SECRETS_ADMIN_KEY_JSON");
    expect(check.missing).not.toContain("SECRETS_ADMIN_KEY_JSON");
  });

  it("still expects a name declared under BOTH env: and consoleEnv:", async () => {
    // The exclusion is per-NAME, not per-map: one server can read `${SHARED}`
    // from the store via env: while another declares it under consoleEnv:.
    // Subtracting the console set wholesale would drop it from the count, and a
    // missing name would go unreported by the one function whose job is to count
    // everything.
    const shared = parseConfig(
      CONFIG_YAML.replace(
        `      ADMIN_KEY: "\${SECRETS_ADMIN_KEY_JSON}"`,
        `      ADMIN_KEY: "\${SECRETS_ADMIN_KEY_JSON}"\n      SHARED_KEY: "\${SHOP_PASSWORD}"`,
      ),
    );
    expect(expectedStoreNames(shared)).toContain("SHOP_PASSWORD");

    const fake = createFakeGcp();
    const check = await checkStore(fake.store, shared);
    expect(check.missing).toContain("SHOP_PASSWORD");
    expect(check.environmentOnly).toStrictEqual(["SECRETS_ADMIN_KEY_JSON"]);
  });
});

describe("--resolve: presence is not resolvability", () => {
  it("reports the credential that cannot render, by the shape a 403 has", async () => {
    // This is the resolver granted parameterViewer + secretAccessor: it lists the
    // namespace perfectly and renders nothing. The check has to distinguish that
    // from "the namespace is empty", because the fixes are unrelated.
    const fake = await seededFake();
    const cannotRender = {
      list: fake.store.list.bind(fake.store),
      resolve: () => {
        throw new ParameterStoreError(
          "GET https://parametermanager.googleapis.com/…:render",
          403,
        );
      },
    };
    const check = await checkStore(cannotRender, config, { resolve: true });
    expect(check.missing).toStrictEqual(["GOOGLE_CLIENT_ID"]);
    expect(check.render?.error).toBeTruthy();
    expect(check.render?.rendered).toStrictEqual([]);
    // Everything the namespace does hold is unproven, not absent.
    expect(check.render?.unrendered).toStrictEqual(check.present);
  });

  it("passes when the resolver can render what is there", async () => {
    const fake = await seededFake();
    const check = await checkStore(fake.store, config, { resolve: true });
    expect(check.render?.error).toBeUndefined();
    expect(check.render?.rendered).toStrictEqual(check.present);
    expect(check.render?.unrendered).toStrictEqual([]);
  });

  it("counts a value that is still a __REF__ pointer as UNRENDERED", async () => {
    // The issue-#49 state: the caller holds `render`, the call succeeds, and the
    // parameter's own principal cannot reach the secret — so what comes back is
    // the pointer. A pointer is a perfectly good non-empty string, so a check
    // that only asks "did I get something" reports the failure it exists to find
    // as a pass.
    const fake = await seededFake();
    const undereferenced = {
      list: fake.store.list.bind(fake.store),
      resolve: async () => ({
        GRANOLA_TOKEN: secretRef("strad-secrets-test", "granola"),
        STRAD_TOKENS: "[]",
      }),
    };
    const check = await checkStore(undereferenced, config, { resolve: true });
    expect(check.render?.rendered).toStrictEqual(["STRAD_TOKENS"]);
    expect(check.render?.unrendered).toContain("GRANOLA_TOKEN");
  });

  it("does not re-report a MISSING name as one that failed to render", async () => {
    // A half-seeded namespace mid-migration must not look twice as broken as it
    // is: a name is counted once, in the category that has a fix.
    const fake = await seededFake();
    const check = await checkStore(fake.store, config, { resolve: true });
    expect(check.render?.unrendered).not.toContain("GOOGLE_CLIENT_ID");
  });
});

// =============================================================================
// The script, as a subprocess, against the fake store behind real HTTP
// =============================================================================

let fake: ReturnType<typeof createFakeGcp>;
let served: Awaited<ReturnType<typeof serveFake>>;

beforeAll(async () => {
  fake = await seededFake();
  served = await serveFake(fake);
});

afterAll(async () => {
  await served?.close();
});

const run = promisify(execFile);

async function check(
  args: string[],
  env: Record<string, string> = {},
  configBody = CONFIG_YAML,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "strad-store-check-"));
  const cfg = join(dir, "cfg.yaml");
  writeFileSync(cfg, configBody);
  const argv = ["--experimental-transform-types", "scripts/check-store.ts"];
  // `--config <the temp file>` unless the caller is testing the flag handling.
  if (!args.includes("--no-config")) argv.push("--config", cfg);
  argv.push(...args.filter((a) => a !== "--no-config"));
  try {
    const { stdout, stderr } = await run(process.execPath, argv, {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        [RESOLVER_ENV.projectId]: fake.endpoints.projectId,
        [RESOLVER_ENV.location]: fake.endpoints.location,
        [RESOLVER_ENV.keyJson]: fake.endpoints.keyJson,
        [RESOLVER_ENV.pmApiBase]: `${served.base}/pm`,
        [RESOLVER_ENV.smApiBase]: `${served.base}/sm`,
        [RESOLVER_ENV.tokenUrl]: `${served.base}/token`,
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe("scripts/check-store.ts", () => {
  it("fails the pre-flip gate and names what is missing", async () => {
    const result = await check([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `::error file=`, // annotated for GitHub, on the config file
    );
    expect(result.stderr).toContain(`GOOGLE_CLIENT_ID is not in ${NAMESPACE}`);
    expect(result.stdout).toContain("9 of 10 expected name(s) present");
  });

  it("reports the same names without failing, in report mode", async () => {
    const result = await check(["--mode", "report"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("9 of 10 expected name(s) present");
    expect(result.stdout).toContain("GOOGLE_CLIENT_ID");
    expect(result.stdout).toContain("reported, not failed");
    // Reported, not annotated red: a partially-seeded namespace mid-migration is
    // the expected state, and a red X every day trains someone to ignore it.
    expect(result.stderr).not.toContain("::error");
    expect(result.stderr).toContain("::notice");
  });

  it("prints no value, in any mode, including the ones it rendered", async () => {
    for (const args of [[], ["--mode", "report"], ["--resolve"]]) {
      const result = await check(args);
      const output = `${result.stdout}${result.stderr}`;
      for (const [, value] of SEEDED) {
        expect(output).not.toContain(value);
      }
    }
  });

  it("proves the round trip with --resolve", async () => {
    const result = await check(["--resolve", "--mode", "report"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "9 of 9 present name(s) resolved to a value",
    );
  });

  it("exits 3 — not 1 — when there is no credential to ask with", async () => {
    // "The namespace is incomplete" and "I could not find out" call for opposite
    // responses. Seeding a namespace that was already fine is the mistake this
    // distinction prevents.
    const result = await check([], { [RESOLVER_ENV.keyJson]: "" });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(RESOLVER_ENV.keyJson);
  });

  it("says a key is UNUSABLE rather than unset, when it is set and broken", async () => {
    // Telling someone to set a variable they have already set is how a corrupt
    // key gets diagnosed as a missing one. The reason is by shape, never content.
    const result = await check([], {
      [RESOLVER_ENV.keyJson]: '{"client_email": "truncated"',
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("is set but unusable");
    expect(result.stderr).toContain("is not valid JSON");
  });

  it("exits 3 when the store cannot be reached at all", async () => {
    // list() throwing is not a verdict about what is seeded. Port 1 refuses.
    const result = await check([], {
      [RESOLVER_ENV.tokenUrl]: "http://127.0.0.1:1/token",
      [RESOLVER_ENV.pmApiBase]: "http://127.0.0.1:1/pm",
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("could not list the store");
    expect(result.stderr).toContain("not a report about what is seeded");
  });

  it("exits 2 on a config that does not parse", async () => {
    const result = await check(
      [],
      {},
      "version: 1\ngateway: [not, an, object]\n",
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("does not parse");
  });

  it("exits 2 on a typo'd flag, not 1", async () => {
    // A tool whose job is catching mistakes must not answer `--mode reprot` with
    // the exit code that means "your namespace is broken".
    expect((await check(["--mode", "reprot"])).code).toBe(2);
    expect((await check(["--no-config"])).code).toBe(2);
    expect(
      (await check(["--config", "/nope/nope.yaml", "--no-config"])).code,
    ).toBe(2);
  });

  it("honours an explicit --namespace", async () => {
    const result = await check([
      "--namespace",
      "/strad/nowhere/",
      "--mode",
      "report",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("0 of 10 expected name(s) present");
    expect(result.stdout).toContain("/strad/nowhere/");
  });

  it("refuses an empty --namespace instead of matching the whole project", async () => {
    // An empty prefix matches every parameter in the project, so staging's
    // STRAD_TOKENS would satisfy a prod check and the script would print
    // `complete` for the wrong reason.
    expect((await check(["--namespace="])).code).toBe(2);
    expect((await check(["--namespace=  "])).code).toBe(2);
  });

  it("fails the gate on a consoleEnv: name found in the namespace", async () => {
    // The opposite of a missing name, and still a finding: nothing reads the copy
    // there, and the resolver credential — the one the flip hands to the gateway
    // process — can.
    const inverted = await seededFake();
    await inverted.store.create({
      path: gatewayParameterPath("test", "SECRETS_ADMIN_KEY_JSON"),
      secret: true,
      value: "leak-canary-adminkey-9f2a",
    });
    const invertedServed = await serveFake(inverted);
    try {
      const result = await check([], {
        [RESOLVER_ENV.pmApiBase]: `${invertedServed.base}/pm`,
        [RESOLVER_ENV.smApiBase]: `${invertedServed.base}/sm`,
        [RESOLVER_ENV.tokenUrl]: `${invertedServed.base}/token`,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("IN THE STORE AND SHOULD NOT BE");
      expect(result.stderr).toContain(
        "SECRETS_ADMIN_KEY_JSON is a consoleEnv: name",
      );
      expect(result.stdout).not.toContain("leak-canary-adminkey-9f2a");
      expect(result.stderr).not.toContain("leak-canary-adminkey-9f2a");
    } finally {
      await invertedServed.close();
    }
  });
});
