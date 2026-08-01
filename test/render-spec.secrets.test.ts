import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  bakedSecretNames,
  preflightSecrets,
  requiredSecretNames,
} from "../src/deploy/preflight.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  gatewayNamespace,
  gatewayParameterPath,
} from "../src/secrets/parameters/namespace.ts";
import { RESOLVER_ENV } from "../src/secrets/parameters/resolver.ts";
import { serveFake } from "./helpers/serve-fake.ts";

/**
 * The deploy side of the runtime-secrets change.
 *
 * Two things have to be true at once, and they are the two halves of "there is
 * only one way to manage a secret":
 *
 *   1. A store-backed spec carries exactly ONE credential — the one the gateway
 *      needs to reach the store. If a per-secret value were still baked, a
 *      rotation in the store would be silently outranked by the stale copy, and
 *      we would have two ways again.
 *   2. A reference to a secret that does not exist still fails the DEPLOY, not a
 *      request at 3am. That is the preflight, and it must reach that verdict
 *      without reading a single value.
 */

const CONFIG_YAML = (extra = "", bundles = "") => `
version: 1
gateway:
  name: strad
  env: test
  secrets:
    provider: gcp-parameter-store
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
${bundles ? `bundles:\n${bundles}` : ""}servers:
  - slug: granola
    kind: remote-http
    url: https://mcp.granola.example.com/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${GRANOLA_TOKEN}"
${extra}`;

// =============================================================================
// Preflight: existence, checked by name, with no value read
// =============================================================================

describe("preflight", () => {
  it("collects the names the gateway must resolve at runtime", () => {
    const config = parseConfig(CONFIG_YAML());
    const names = requiredSecretNames(config);
    expect(names).toContain("GRANOLA_TOKEN"); // from the config
    expect(names).toContain("STRAD_TOKENS"); // read at boot from env
  });

  it("keeps a supplementary image's own env OUT of the runtime set", () => {
    // Those are container env vars on a component the gateway does not run, so
    // no runtime resolution can reach them. They are baked, and listed separately.
    const config = parseConfig(
      CONFIG_YAML(
        `  - slug: shop
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-shop
    entitlements: [admin]
    env:
      SHOP_PASSWORD: "\${SHOP_PASSWORD}"
    consoleEnv:
      ADMIN_KEY: "\${SECRETS_ADMIN_KEY_JSON}"
`,
        "  - name: bundle-shop\n",
      ),
    );
    expect(requiredSecretNames(config)).not.toContain("SHOP_PASSWORD");
    expect(bakedSecretNames(config)).toEqual([
      "SECRETS_ADMIN_KEY_JSON",
      "SHOP_PASSWORD",
    ]);
  });

  it("passes when every referenced name exists, and reads no value to say so", async () => {
    const fake = createFakeGcp();
    let revealed = 0;
    const guarded = {
      list: fake.store.list.bind(fake.store),
      reveal: async (p: string) => {
        revealed += 1;
        return fake.store.reveal(p);
      },
    };
    for (const [name, value] of [
      ["GRANOLA_TOKEN", "gran-secret"],
      ["STRAD_TOKENS", "[]"],
      ["STRAD_INTERNAL_TOKEN", "internal"],
    ]) {
      await fake.store.create({
        path: gatewayParameterPath("test", name!),
        secret: true,
        value: value!,
      });
    }

    const config = parseConfig(CONFIG_YAML());
    const result = await preflightSecrets(guarded, config);

    expect(result.missing).toEqual([]);
    expect(result.present).toEqual([
      "GRANOLA_TOKEN",
      "STRAD_INTERNAL_TOKEN",
      "STRAD_TOKENS",
    ]);
    expect(result.namespace).toBe(gatewayNamespace("test"));
    expect(revealed).toBe(0);
  });

  it("reports a referenced-but-absent name", async () => {
    const fake = createFakeGcp();
    const config = parseConfig(CONFIG_YAML());
    const result = await preflightSecrets(fake.store, config);
    // The config's own ref AND the two boot keys a deployment cannot work
    // without: no STRAD_TOKENS means /mcp rejects everything, and no
    // STRAD_INTERNAL_TOKEN means core cannot reach its own bundles.
    expect(result.missing).toEqual([
      "GRANOLA_TOKEN",
      "STRAD_INTERNAL_TOKEN",
      "STRAD_TOKENS",
    ]);
  });

  it("does not demand the individually-optional boot keys", async () => {
    // A deployment with no console has no GOOGLE_CLIENT_SECRET, and that is a
    // correct deployment — failing it would be a false alarm on every deploy.
    const fake = createFakeGcp();
    for (const name of [
      "GRANOLA_TOKEN",
      "STRAD_TOKENS",
      "STRAD_INTERNAL_TOKEN",
    ]) {
      await fake.store.create({
        path: gatewayParameterPath("test", name),
        secret: true,
        value: "x",
      });
    }
    const config = parseConfig(CONFIG_YAML());
    const { missing } = await preflightSecrets(fake.store, config);
    expect(missing).toEqual([]);
  });

  it("DOES demand the two boot keys a deployment cannot work without", async () => {
    // Under the `env` provider these are `secret(key, required)` and a missing
    // one fails the deploy. The store path must hold the same line, or this is a
    // fail-closed regression wearing a preflight.
    const fake = createFakeGcp();
    await fake.store.create({
      path: gatewayParameterPath("test", "GRANOLA_TOKEN"),
      secret: true,
      value: "x",
    });
    const config = parseConfig(CONFIG_YAML());
    const { missing } = await preflightSecrets(fake.store, config);
    expect(missing).toContain("STRAD_TOKENS");
    expect(missing).toContain("STRAD_INTERNAL_TOKEN");
    expect(missing).not.toContain("GOOGLE_CLIENT_SECRET");
  });
});

// =============================================================================
// render-spec, as a subprocess, against the fake store behind real HTTP
// =============================================================================

let fake: ReturnType<typeof createFakeGcp>;
let served: Awaited<ReturnType<typeof serveFake>>;

beforeAll(async () => {
  fake = createFakeGcp();
  served = await serveFake(fake);
  await fake.store.create({
    path: gatewayParameterPath("test", "GRANOLA_TOKEN"),
    secret: true,
    value: "gran-secret-value",
  });
  await fake.store.create({
    path: gatewayParameterPath("test", "STRAD_TOKENS"),
    secret: true,
    value: "[]",
  });
  await fake.store.create({
    path: gatewayParameterPath("test", "STRAD_INTERNAL_TOKEN"),
    secret: true,
    value: "internal-shared",
  });
});

afterAll(async () => {
  await served?.close();
});

/**
 * Render in a subprocess — ASYNCHRONOUSLY.
 *
 * The store the subprocess talks to is served by an Express app in THIS process,
 * so a blocking `execFileSync` would deadlock: the parent's event loop would be
 * parked waiting for a child whose first request the parent is the one that has
 * to answer.
 */
const run = promisify(execFile);

interface RenderedSpec {
  services: {
    name: string;
    envs: { key: string; value?: string; type?: string }[];
  }[];
}

async function render(yaml: string): Promise<{
  ok: boolean;
  spec?: RenderedSpec;
  stderr: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "strad-secrets-"));
  const cfg = join(dir, "cfg.yaml");
  writeFileSync(cfg, yaml);
  try {
    const { stdout } = await run(
      process.execPath,
      [
        "--experimental-transform-types",
        "scripts/render-spec.ts",
        "--config",
        cfg,
        "--image",
        "ghcr.io/tadasant/strad:0.1.0",
        "--app",
        "strad-test",
      ],
      {
        encoding: "utf8",
        env: {
          // A DELIBERATELY hostile environment: every secret a baking render
          // would want is present as an env var. A store-backed render must
          // ignore them all, because baking one would give a rotated secret a
          // stale twin that wins.
          GRANOLA_TOKEN: "STALE-ENV-VALUE",
          STRAD_TOKENS: "STALE-ENV-VALUE",
          STRAD_INTERNAL_TOKEN: "STALE-ENV-VALUE",
          GOOGLE_CLIENT_SECRET: "STALE-ENV-VALUE",
          PATH: process.env.PATH ?? "",
          [RESOLVER_ENV.projectId]: fake.endpoints.projectId,
          [RESOLVER_ENV.location]: fake.endpoints.location,
          [RESOLVER_ENV.keyJson]: fake.endpoints.keyJson,
          [RESOLVER_ENV.pmApiBase]: `${served.base}/pm`,
          [RESOLVER_ENV.smApiBase]: `${served.base}/sm`,
          [RESOLVER_ENV.tokenUrl]: `${served.base}/token`,
        },
      },
    );
    return {
      ok: true,
      spec: JSON.parse(stdout) as RenderedSpec,
      stderr: "",
    };
  } catch (err) {
    const e = err as { stderr?: string };
    return { ok: false, stderr: e.stderr ?? "" };
  }
}

describe("render-spec, store-backed", () => {
  it("puts exactly ONE secret in the spec: the store credential", async () => {
    const result = await render(CONFIG_YAML());
    expect(result.ok).toBe(true);

    const secretKeys = result
      .spec!.services.flatMap((s) => s.envs)
      .filter((e) => e.type === "SECRET")
      .map((e) => e.key);

    expect([...new Set(secretKeys)]).toEqual([RESOLVER_ENV.keyJson]);
  });

  it("bakes NO per-secret value, even with one sitting in the environment", async () => {
    const result = await render(CONFIG_YAML());
    const rendered = JSON.stringify(result.spec);
    // The stale env values must not appear anywhere in the spec...
    expect(rendered).not.toContain("STALE-ENV-VALUE");
    // ...and neither must the real value from the store: GRANOLA_TOKEN is
    // resolved at runtime now, so it has no business in a deploy artifact.
    expect(rendered).not.toContain("gran-secret-value");
  });

  it("ships the store's ADDRESS as a visible GENERAL var, not a secret", async () => {
    const result = await render(CONFIG_YAML());
    const projectVar = result
      .spec!.services.flatMap((s) => s.envs)
      .find((e) => e.key === RESOLVER_ENV.projectId);
    // A project id is not a credential, and an operator should be able to see
    // which store a deployment is pointed at.
    expect(projectVar?.type).toBe("GENERAL");
  });

  /**
   * The one path where a resolved value's BYTES end up in a deploy artifact.
   *
   * A supplementary image is a container the gateway does not run, so its `env:`
   * cannot be resolved at runtime — `render-spec` reads it from the store and
   * BAKES it onto that component. That is the path all 23 supplementary names
   * take, and the values are the ones that broke: PEM keys and service-account
   * blobs, both full of the characters `:render` refuses.
   *
   * Everything else proving the encoding runs in-process against the double.
   * This runs the real `render-spec` in a SUBPROCESS, over real HTTP, and
   * compares the baked value to the original byte for byte — so an encode that
   * round-trips in a unit test but not through the deploy path fails here. It is
   * still strad's own double answering, which is the limit of what this repo can
   * prove; see the caveat in the PR body.
   */
  it("bakes a supplementary env value with its structural bytes intact", async () => {
    const PEM = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
      "-----END PRIVATE KEY-----",
      "",
    ].join("\n");
    const SA_JSON = JSON.stringify({
      type: "service_account",
      project_id: "strad-secrets-test",
      private_key: PEM,
      client_email: "svc@strad-secrets-test.iam.gserviceaccount.com",
    });

    await fake.store.create({
      path: gatewayParameterPath("test", "BAKED_PEM"),
      secret: true,
      value: PEM,
    });
    await fake.store.create({
      path: gatewayParameterPath("test", "BAKED_SA_JSON"),
      secret: true,
      value: SA_JSON,
    });

    const result = await render(
      CONFIG_YAML(
        `  - slug: gcs
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:0.1.0
    bundle: bundle
    path: /gcs
    entitlements: [admin]
    env:
      GCS_PRIVATE_KEY: "\${BAKED_PEM}"
      GCS_SA_JSON: "\${BAKED_SA_JSON}"
`,
        "  - name: bundle\n",
      ),
    );
    expect(result.stderr).toBe("");
    expect(result.ok).toBe(true);

    const envs = result.spec!.services.flatMap((s) => s.envs) as {
      key: string;
      value?: string;
    }[];
    // Byte for byte — newlines, braces, quotes and all. `toBe` rather than
    // `toContain`: a decode that dropped a trailing newline or mangled an
    // escape would still "contain" most of the key.
    expect(envs.find((e) => e.key === "GCS_PRIVATE_KEY")?.value).toBe(PEM);
    expect(envs.find((e) => e.key === "GCS_SA_JSON")?.value).toBe(SA_JSON);
    // And the base64url never leaks through as the value.
    expect(JSON.stringify(result.spec)).not.toContain(
      Buffer.from(PEM, "utf8").toString("base64url"),
    );
  });

  /**
   * The boot env a third-party container cannot fetch for itself.
   *
   * `hydrateBootEnv` is why this script stops baking the gateway's boot keys
   * under the store provider — and it runs in strad's process. A supplementary
   * image does not run strad and holds no store credential, so under the store
   * provider it was left with neither the value nor a way to get it. The symptom
   * was a bundle that stopped exporting telemetry about a minute after a green
   * deploy, with /healthz still 200 and every slug still listed.
   *
   * The values must come from the STORE, not from the deploy environment: the
   * hostile env below carries a stale twin of both names, and a render that
   * picked either up would hand a rotated secret a copy that outranks it.
   */
  it("bakes the bundle's boot env onto a supplementary component, from the store", async () => {
    await fake.store.create({
      path: gatewayParameterPath("test", "OTEL_EXPORTER_OTLP_HEADERS"),
      secret: true,
      value: "Authorization=Bearer otlp-from-the-store",
    });

    const result = await render(
      CONFIG_YAML(
        `  - slug: slack
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:0.1.0
    bundle: bundle
    entitlements: [admin]
    env:
      SLACK_BOT_TOKEN: "\${GRANOLA_TOKEN}"
`,
        "  - name: bundle\n",
      ),
    );
    expect(result.ok).toBe(true);

    const bundle = result.spec!.services.find((s) => s.name === "bundle")!;
    const at = (key: string) => bundle.envs.find((e) => e.key === key);

    expect(at("OTEL_EXPORTER_OTLP_HEADERS")?.value).toBe(
      "Authorization=Bearer otlp-from-the-store",
    );
    expect(at("OTEL_EXPORTER_OTLP_HEADERS")?.type).toBe("SECRET");
    expect(at("STRAD_INTERNAL_TOKEN")?.value).toBe("internal-shared");
    // Not the deploy environment's stale copy, which is sitting right there.
    expect(JSON.stringify(result.spec)).not.toContain("STALE-ENV-VALUE");
    // And the credential that reads the store still stops at the strad image.
    expect(at(RESOLVER_ENV.keyJson)).toBeUndefined();
  });

  it("FAILS the deploy when the config references a secret the store lacks", async () => {
    const result = await render(
      CONFIG_YAML(`  - slug: other
    kind: remote-http
    url: https://other.example.com/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${NEVER_SEEDED}"
`),
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("NEVER_SEEDED");
    expect(result.stderr).toContain(gatewayNamespace("test"));
    // The failure names what is missing and prints no value of anything.
    expect(result.stderr).not.toContain("gran-secret-value");
  });
});

// =============================================================================
// The default path is untouched
// =============================================================================

describe("render-spec, env-backed (the default)", () => {
  it("still bakes the config's ${NAME} refs as SECRET env vars", () => {
    const dir = mkdtempSync(join(tmpdir(), "strad-secrets-env-"));
    const cfg = join(dir, "cfg.yaml");
    writeFileSync(
      cfg,
      // Drop the `secrets:` block to fall back to the default `env` provider.
      CONFIG_YAML().replace(
        "  secrets:\n    provider: gcp-parameter-store\n",
        "",
      ),
    );
    const out = execFileSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "scripts/render-spec.ts",
        "--config",
        cfg,
        "--image",
        "ghcr.io/tadasant/strad:0.1.0",
        "--app",
        "strad-test",
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          STRAD_TOKENS: "[]",
          STRAD_INTERNAL_TOKEN: "internal",
          GRANOLA_TOKEN: "gran",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const spec = JSON.parse(out) as {
      services: { envs: { key: string; type?: string }[] }[];
    };
    const secretKeys = new Set(
      spec.services
        .flatMap((s) => s.envs)
        .filter((e) => e.type === "SECRET")
        .map((e) => e.key),
    );
    expect(secretKeys).toContain("GRANOLA_TOKEN");
    expect(secretKeys).toContain("STRAD_TOKENS");
  });
});
