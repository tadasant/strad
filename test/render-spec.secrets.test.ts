import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import express from "express";
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

/**
 * Put the in-memory fake behind an HTTP server so a SUBPROCESS can reach it.
 *
 * The fake is a `fetch` stub keyed on its own base URLs; this rewrites an
 * incoming request back onto those bases and hands it to the stub. That keeps
 * one implementation of the store's behaviour instead of two that drift.
 */
function serveFake(fake: ReturnType<typeof createFakeGcp>): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.raw({ type: () => true }));

  app.all(/.*/, (req, res) => {
    void (async () => {
      // /pm/... -> the fake's PM base, /sm/... -> its SM base, /token -> its token URL.
      const path = req.originalUrl;
      let target: string;
      if (path.startsWith("/token")) target = fake.endpoints.tokenUrl;
      else if (path.startsWith("/pm/"))
        target = `${fake.endpoints.pmApiBase}${path.slice("/pm".length)}`;
      else if (path.startsWith("/sm/"))
        target = `${fake.endpoints.smApiBase}${path.slice("/sm".length)}`;
      else {
        res.status(404).end();
        return;
      }

      const body =
        Buffer.isBuffer(req.body) && req.body.length > 0
          ? req.body.toString("utf8")
          : undefined;
      const upstream = await fake.fetchImpl(target, {
        method: req.method,
        body,
      });
      res
        .status(upstream.status)
        .type("application/json")
        .send(
          // The fake's Response is a duck type; text() is the honest accessor.
          await upstream.text(),
        );
    })();
  });

  return new Promise((resolve) => {
    const s: Server = app.listen(0, () => {
      const addr = s.address();
      if (typeof addr === "string" || !addr) throw new Error("no port");
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r) => {
            s.closeAllConnections();
            s.close(() => r());
          }),
      });
    });
  });
}

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

async function render(yaml: string): Promise<{
  ok: boolean;
  spec?: { services: { envs: { key: string; type?: string }[] }[] };
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
      spec: JSON.parse(stdout) as {
        services: { envs: { key: string; type?: string }[] }[];
      },
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
