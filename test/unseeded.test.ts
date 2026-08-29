import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { preflightSecrets } from "../src/deploy/preflight.ts";
import {
  referencingSlugs,
  unusedWaivers,
  waivedBy,
  waivedNames,
} from "../src/deploy/unseeded.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import { gatewayParameterPath } from "../src/secrets/parameters/namespace.ts";
import { RESOLVER_ENV } from "../src/secrets/parameters/resolver.ts";
import { serveFake } from "./helpers/serve-fake.ts";

/**
 * THE TRADE, TESTED FROM BOTH ENDS.
 *
 * Adding a server whose credential nobody had seeded yet used to red the entire
 * strad deploy, which put a human gate in front of every new server: seed the
 * token, THEN merge the PR. `mayBeUnseeded:` removes that gate — and the whole
 * risk of removing it is that "a secret nobody seeded" stops being loud.
 *
 * So every test here is one half of a pair:
 *
 *   - a name a human LISTED renders, warns, and degrades exactly one slug;
 *   - a name nobody listed still exits 1, in every path that used to.
 *
 * If the second column ever goes quiet, this feature has traded a loud early
 * failure for a silent late one — which is the failure shape this repo has
 * already been bitten by (HACKS.md, the mis-spelled `slug:`).
 */

const ENV = "test";

const CONFIG = (opts: {
  /** Lines appended to the `apify` server entry. */
  apify?: string;
  /** Extra whole server entries. */
  extra?: string;
}): string => `
version: 1
gateway:
  name: strad
  env: ${ENV}
  secrets:
    provider: gcp-parameter-store
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: granola
    kind: remote-http
    url: https://mcp.granola.example.com/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${GRANOLA_TOKEN}"
  - slug: apify
    kind: remote-http
    url: https://mcp.apify.example.com/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${APIFY_TOKEN}"
${opts.apify ?? ""}${opts.extra ?? ""}`;

/** The shape prod would write: one deferred credential on one new slug. */
const WAIVED = CONFIG({ apify: "    mayBeUnseeded: [APIFY_TOKEN]\n" });
/** The same config with the waiver absent — today's behaviour, unchanged. */
const UNWAIVED = CONFIG({});

// =============================================================================
// The waiver itself
// =============================================================================

describe("mayBeUnseeded, as a config fact", () => {
  it("waives a name every referencing server waives", () => {
    const waived = waivedNames(parseConfig(WAIVED));
    expect([...waived.keys()]).toEqual(["APIFY_TOKEN"]);
    expect(waived.get("APIFY_TOKEN")).toEqual(["apify"]);
    // The sibling's credential is untouched. A waiver is not a mode.
    expect(waived.has("GRANOLA_TOKEN")).toBe(false);
  });

  it("waives NOTHING when one referencing server did not waive it", () => {
    // Unanimity, and this is the case that makes it matter: `other` needs the
    // same token and said nothing about deferring it. Honouring one server's
    // waiver would ship `other` dead — the fleet-wide failure this feature
    // removes, spelt differently and one layer further down.
    const config = parseConfig(
      CONFIG({
        apify: "    mayBeUnseeded: [SHARED_TOKEN]\n",
        extra: `  - slug: other
    kind: remote-http
    url: https://other.example.com/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${SHARED_TOKEN}"
`,
      }).replace("Bearer ${APIFY_TOKEN}", "Bearer ${SHARED_TOKEN}"),
    );
    expect(referencingSlugs(config).get("SHARED_TOKEN")).toEqual(
      new Set(["apify", "other"]),
    );
    expect(waivedNames(config).has("SHARED_TOKEN")).toBe(false);
  });

  it("attributes a waiver to the slug that wrote it, unanimity aside", () => {
    // What the GATEWAY asks: is this slug's unresolvable name one it declared?
    // The other server needing it too does not make this slug's deferral a
    // fault — it makes the DEPLOY refuse, which is the other half's job.
    const config = parseConfig(
      CONFIG({
        apify: "    mayBeUnseeded: [SHARED_TOKEN]\n",
        extra: `  - slug: other
    kind: remote-http
    url: https://other.example.com/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${SHARED_TOKEN}"
`,
      }).replace("Bearer ${APIFY_TOKEN}", "Bearer ${SHARED_TOKEN}"),
    );
    expect(waivedBy(config, "apify")).toEqual(new Set(["SHARED_TOKEN"]));
    expect(waivedBy(config, "other")).toEqual(new Set());
  });

  it("sees a supplementary image's env: and consoleEnv: refs too", () => {
    const config = parseConfig(`
version: 1
gateway:
  name: strad
  env: ${ENV}
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle-shop
servers:
  - slug: shop
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-shop
    entitlements: [admin]
    env:
      SHOP_PASSWORD: "\${SHOP_PASSWORD}"
    consoleEnv:
      ADMIN_KEY: "\${SHOP_ADMIN_KEY}"
    headers:
      X-Auth: "\${SHOP_PROXY_TOKEN}"
    mayBeUnseeded: [SHOP_PASSWORD, SHOP_ADMIN_KEY, SHOP_PROXY_TOKEN]
`);
    expect(unusedWaivers(config)).toEqual([]);
    expect([...waivedNames(config).keys()].sort()).toEqual([
      "SHOP_ADMIN_KEY",
      "SHOP_PASSWORD",
      "SHOP_PROXY_TOKEN",
    ]);
  });

  it("does not let a ${...} in a description invent a reference", () => {
    // NAMED FIELDS only. A waiver that attached to prose would let a slug defer
    // a credential it never asks for, and the reference it really uses would
    // keep failing while the config looked like it had been handled.
    const config = parseConfig(
      CONFIG({
        apify: '    description: "reads ${APIFY_TOKEN} from the store"\n',
      }),
    );
    expect(referencingSlugs(config).get("APIFY_TOKEN")).toEqual(
      new Set(["apify"]),
    );
  });
});

// =============================================================================
// The typo gate — the reason this does not reintroduce the silence it replaces
// =============================================================================

describe("a waiver that waives nothing is the typo", () => {
  it("names a waiver whose ${NAME} this server does not reference", () => {
    // The failure this gate exists for: a header saying `${APIFY_TOKN}` beside a
    // waiver saying `APIFY_TOKEN`. A per-SERVER flag would have degraded that
    // forever in silence. A per-NAME list cannot: the reference is unwaived, and
    // the useless entry is named.
    const config = parseConfig(
      CONFIG({ apify: "    mayBeUnseeded: [APIFY_TOKEN]\n" }).replace(
        "Bearer ${APIFY_TOKEN}",
        "Bearer ${APIFY_TOKN}",
      ),
    );
    const problems = unusedWaivers(config);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('server "apify"');
    expect(problems[0]).toContain("APIFY_TOKEN");
    // And the reference it was written for is still unwaived, so the deploy
    // still fails on it. Both halves, not just the diagnostic.
    expect(waivedNames(config).has("APIFY_TOKN")).toBe(false);
  });

  it("says nothing about a waiver on a DISABLED server", () => {
    // A disabled server references nothing, so every waiver on it matches
    // nothing — and failing the deploy for that would red a build for the
    // ordinary act of switching a server off with its waiver left in place. The
    // typo behind `enabled: false` costs nothing while it is off and fails
    // loudly the moment it is switched on.
    const config = parseConfig(
      CONFIG({
        apify: "    enabled: false\n    mayBeUnseeded: [APIFY_TOKEN]\n",
      }),
    );
    expect(unusedWaivers(config)).toEqual([]);
    expect(waivedNames(config).has("APIFY_TOKEN")).toBe(false);
  });

  it("says nothing about a waiver that matches", () => {
    expect(unusedWaivers(parseConfig(WAIVED))).toEqual([]);
    expect(unusedWaivers(parseConfig(UNWAIVED))).toEqual([]);
  });
});

// =============================================================================
// Preflight: three buckets, not two
// =============================================================================

describe("preflightSecrets", () => {
  /** A store holding the boot keys and `granola`'s token, and nothing else. */
  async function storeWithout(): Promise<ReturnType<typeof createFakeGcp>> {
    const fake = createFakeGcp();
    for (const name of [
      "GRANOLA_TOKEN",
      "STRAD_TOKENS",
      "STRAD_INTERNAL_TOKEN",
    ]) {
      await fake.store.create({
        path: gatewayParameterPath(ENV, name),
        secret: true,
        value: "x",
      });
    }
    return fake;
  }

  it("moves a waived, unseeded name out of `missing`", async () => {
    const fake = await storeWithout();
    const result = await preflightSecrets(fake.store, parseConfig(WAIVED));
    expect(result.missing).toEqual([]);
    expect(result.waived).toEqual(["APIFY_TOKEN"]);
    expect(result.waivedSlugs.APIFY_TOKEN).toEqual(["apify"]);
  });

  it("keeps an UNWAIVED, unseeded name in `missing`", async () => {
    const fake = await storeWithout();
    const result = await preflightSecrets(fake.store, parseConfig(UNWAIVED));
    expect(result.missing).toEqual(["APIFY_TOKEN"]);
    expect(result.waived).toEqual([]);
  });

  it("reports a waived name that IS seeded as present, not waived", async () => {
    // The waiver is permission to be absent, not a claim about being absent. A
    // seeded one is an ordinary secret and must read as one, or the summary
    // line would keep telling an operator to seed something they already have.
    const fake = await storeWithout();
    await fake.store.create({
      path: gatewayParameterPath(ENV, "APIFY_TOKEN"),
      secret: true,
      value: "seeded",
    });
    const result = await preflightSecrets(fake.store, parseConfig(WAIVED));
    expect(result.waived).toEqual([]);
    expect(result.present).toContain("APIFY_TOKEN");
  });

  it("still fails a name one server waived and another needs", async () => {
    const fake = await storeWithout();
    const config = parseConfig(
      CONFIG({
        apify: "    mayBeUnseeded: [SHARED_TOKEN]\n",
        extra: `  - slug: other
    kind: remote-http
    url: https://other.example.com/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${SHARED_TOKEN}"
`,
      }).replace("Bearer ${APIFY_TOKEN}", "Bearer ${SHARED_TOKEN}"),
    );
    const result = await preflightSecrets(fake.store, config);
    expect(result.waived).toEqual([]);
    expect(result.missing).toEqual(["SHARED_TOKEN"]);
  });

  it("never waives a BOOT key, whatever a server writes", async () => {
    // `STRAD_TOKENS` is read by the gateway process for itself and is named by
    // no server, so it has no referencing slug and cannot be waived. Without
    // this, a config could defer the key that makes /mcp reject everything.
    const fake = createFakeGcp();
    const config = parseConfig(
      CONFIG({ apify: "    mayBeUnseeded: [APIFY_TOKEN, STRAD_TOKENS]\n" }),
    );
    const result = await preflightSecrets(fake.store, config);
    expect(result.missing).toContain("STRAD_TOKENS");
    expect(result.missing).toContain("STRAD_INTERNAL_TOKEN");
    expect(result.waived).toEqual(["APIFY_TOKEN"]);
  });
});

// =============================================================================
// render-spec, as the deploy runs it: a subprocess against a real HTTP store
// =============================================================================

let fake: ReturnType<typeof createFakeGcp>;
let served: Awaited<ReturnType<typeof serveFake>>;

beforeAll(async () => {
  fake = createFakeGcp();
  served = await serveFake(fake);
  // Everything the deployment needs EXCEPT `APIFY_TOKEN`. That absence is the
  // subject of every render below.
  for (const [name, value] of [
    ["GRANOLA_TOKEN", "gran-secret-value"],
    ["STRAD_TOKENS", "[]"],
    ["STRAD_INTERNAL_TOKEN", "internal-shared"],
  ]) {
    await fake.store.create({
      path: gatewayParameterPath(ENV, name!),
      secret: true,
      value: value!,
    });
  }
});

afterAll(async () => {
  await served?.close();
});

const run = promisify(execFile);

interface RenderedSpec {
  services: { name: string; envs: { key: string; type?: string }[] }[];
}

async function render(
  yaml: string,
): Promise<{ ok: boolean; spec?: RenderedSpec; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "strad-unseeded-"));
  const cfg = join(dir, "cfg.yaml");
  writeFileSync(cfg, yaml);
  try {
    const { stdout, stderr } = await run(
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
          [RESOLVER_ENV.projectId]: fake.endpoints.projectId,
          [RESOLVER_ENV.location]: fake.endpoints.location,
          [RESOLVER_ENV.keyJson]: fake.endpoints.keyJson,
          [RESOLVER_ENV.pmApiBase]: `${served.base}/pm`,
          [RESOLVER_ENV.smApiBase]: `${served.base}/sm`,
          [RESOLVER_ENV.tokenUrl]: `${served.base}/token`,
        },
      },
    );
    return { ok: true, spec: JSON.parse(stdout) as RenderedSpec, stderr };
  } catch (err) {
    const e = err as { stderr?: string };
    return { ok: false, stderr: e.stderr ?? "" };
  }
}

describe("render-spec and an unseeded secret", () => {
  it("RENDERS, and warns, when the name was declared mayBeUnseeded", async () => {
    const result = await render(WAIVED);
    expect(result.ok).toBe(true);

    // Greppable, by a fixed prefix, naming the credential and the slug. This
    // warning is the entire visible cost of the deploy no longer failing, so a
    // deploy log has to be searchable for exactly it.
    expect(result.stderr).toContain("::warning::unseeded secret APIFY_TOKEN");
    expect(result.stderr).toContain("apify");
    expect(result.stderr).toContain("INACTIVE");
    // And the summary counts it apart from the ones that resolved.
    expect(result.stderr).toContain("1 deliberately unseeded (APIFY_TOKEN)");
    // No `::error::` anywhere: a warning that also prints an error annotation
    // still reds a GitHub Actions run in the eye of anyone reading it.
    expect(result.stderr).not.toContain("::error::");
  });

  it("EXITS 1 on the same absent name with no waiver", async () => {
    const result = await render(UNWAIVED);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("::error::");
    expect(result.stderr).toContain("APIFY_TOKEN");
  });

  it("EXITS 1 on a waiver that names something unreferenced", async () => {
    // The typo path, at the deploy boundary. It fails before any store round
    // trip: it is a pure config question and there is nothing to ask.
    const result = await render(
      WAIVED.replace("Bearer ${APIFY_TOKEN}", "Bearer ${APIFY_TOKN}"),
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("::error::");
    expect(result.stderr).toContain("references no ${APIFY_TOKEN}");
  });

  it("leaves every OTHER server's deploy exactly as it was", async () => {
    // The point of the whole change: one slug's missing credential costs one
    // slug. `granola` is on the same spec, with the same single store
    // credential, and the config both servers ride on is byte-identical to the
    // failing render above but for the waiver.
    const waived = await render(WAIVED);
    expect(waived.ok).toBe(true);
    const core = waived.spec!.services.find((s) => s.name === "core")!;
    // Still exactly one secret in the spec — the store credential. A waiver
    // must not have quietly turned baking back on for anything.
    expect(
      core.envs.filter((e) => e.type === "SECRET").map((e) => e.key),
    ).toEqual([RESOLVER_ENV.keyJson]);
    // And the config both servers ride on is on the component, unaltered.
    expect(core.envs.map((e) => e.key)).toContain("STRAD_CONFIG_YAML");
  });

  it("never prints the value of a secret it DID resolve", async () => {
    const result = await render(WAIVED);
    expect(result.stderr).not.toContain("gran-secret-value");
    expect(result.stderr).not.toContain("internal-shared");
  });
});
