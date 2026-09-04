import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";

/**
 * ONE `/mcp` SERVER, N PARAMETER STORES — the config half.
 *
 * `mcpStores:` is the agent-facing twin of `consoleStores:`, and the reason it
 * needed a prerequisite is the capability probe. A `Capabilities` used to come
 * from ONE `projectId` and every gate in the secrets server read it with no
 * project in the question. Consolidating stores onto that would have let one IAM
 * over-grant on the most permissive project switch `get_secret_value` on for
 * every store in the list — production included — and it would have failed
 * quiet: the tool would simply start working. The tree's own suite
 * (servers/secrets/shared/test/multi-store.test.ts) proves the runtime half.
 * This file owns the config half:
 *
 *   1. The credential is NAMED, never inlined, and lands by the one scope that
 *      reaches the bundle. No admin key can arrive by this route.
 *   2. Two stores may not share one viewer key, may not share one project id,
 *      and may not claim one path. Each is refused by the schema, so it is
 *      inexpressible rather than merely discouraged.
 *   3. The rendered descriptor carries project ids, namespaces and key NAMES —
 *      and no credential.
 *   4. A config with no `mcpStores:` renders exactly as it did before.
 */

const VIEWER_STAGING = key("staging-viewer@strad.iam.gserviceaccount.com");
const VIEWER_PROD = key("prod-viewer@strad.iam.gserviceaccount.com");
const ADMIN = key("admin@strad.iam.gserviceaccount.com");

function key(email: string): string {
  return JSON.stringify({
    client_email: email,
    private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  });
}

const SECRETS = {
  STAGING_VIEWER_KEY: VIEWER_STAGING,
  PROD_VIEWER_KEY: VIEWER_PROD,
  SECRETS_ADMIN_KEY: ADMIN,
  PROD_ADMIN_KEY: key("prod-admin@strad.iam.gserviceaccount.com"),
};

/**
 * The shape a migrated deployment writes: one slug, one bundle, two stores, two
 * viewer keys — and the console's admin key still on `consoleEnv:`, where it
 * reaches core and stops.
 */
const TWO_STORES = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
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
      SECRETS_CONSOLE_URL: "https://strad.example/ui/secrets"
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${STAGING_VIEWER_KEY}"
      STRAD_PROD_SECRETS_VIEWER_KEY_JSON: "\${PROD_VIEWER_KEY}"
    consoleEnv:
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${SECRETS_ADMIN_KEY}"
    mcpStores:
      - project: strad-secrets-staging
        label: strad staging
        namespaces: ["/strad/staging/mcp/"]
        viewerKeyVar: SECRETS_SERVICE_ACCOUNT_KEY_JSON
      - project: strad-secrets-prod
        label: strad prod
        namespaces: ["/strad/prod/mcp/"]
        viewerKeyVar: STRAD_PROD_SECRETS_VIEWER_KEY_JSON
`;

function render(yaml: string) {
  return renderAppSpec({
    config: parseConfig(yaml),
    appName: "strad-test",
    region: "nyc",
    image: { registry_type: "GHCR", repository: "strad", tag: "test" },
    env: [],
    secrets: SECRETS,
  });
}

function envOf(yaml: string, component: string): Record<string, string> {
  const svc = render(yaml).services.find((s) => s.name === component);
  if (!svc) throw new Error(`no component "${component}"`);
  return Object.fromEntries(svc.envs.map((e) => [e.key, e.value]));
}

/** What `parseConfig` — and therefore `check-config` — says about a config. */
function problems(yaml: string): string[] {
  try {
    parseConfig(yaml, "test.yaml");
    return [];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

describe("mcpStores: the rendered descriptor", () => {
  it("puts every store on the bundle, with NO credential in it", () => {
    const env = envOf(TWO_STORES, "bundle");
    expect(env.SECRETS_STORES).toBeDefined();
    expect(JSON.parse(env.SECRETS_STORES!)).toEqual([
      {
        project: "strad-secrets-staging",
        label: "strad staging",
        namespaces: ["/strad/staging/mcp/"],
        viewerKeyVar: "SECRETS_SERVICE_ACCOUNT_KEY_JSON",
      },
      {
        project: "strad-secrets-prod",
        label: "strad prod",
        namespaces: ["/strad/prod/mcp/"],
        viewerKeyVar: "STRAD_PROD_SECRETS_VIEWER_KEY_JSON",
      },
    ]);

    // The descriptor NAMES the keys. It must not carry them: it is rendered
    // into an app spec a human reads, diffs and pastes into an issue.
    for (const secret of Object.values(SECRETS)) {
      expect(env.SECRETS_STORES).not.toContain(secret);
    }
    expect(env.SECRETS_STORES).not.toContain("PRIVATE KEY");
  });

  it("delivers each store's viewer key under the name its entry gave", () => {
    const env = envOf(TWO_STORES, "bundle");
    expect(env.SECRETS_SERVICE_ACCOUNT_KEY_JSON).toBe(VIEWER_STAGING);
    expect(env.STRAD_PROD_SECRETS_VIEWER_KEY_JSON).toBe(VIEWER_PROD);
    // The two keys are DIFFERENT identities. That is the whole point of the
    // per-store credential rule: one key on both projects would make the two
    // stores' probed capabilities identical by construction.
    expect(env.SECRETS_SERVICE_ACCOUNT_KEY_JSON).not.toBe(
      env.STRAD_PROD_SECRETS_VIEWER_KEY_JSON,
    );
  });

  it("keeps the console's admin key off the bundle entirely", () => {
    const bundle = envOf(TWO_STORES, "bundle");
    expect(JSON.stringify(bundle)).not.toContain(ADMIN);
    expect(bundle.SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON).toBeUndefined();
    // …and it IS on core, so this is a scoping assertion and not an
    // "the value was never resolved" one.
    expect(
      envOf(TWO_STORES, "core").SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON,
    ).toBe(ADMIN);
  });

  it("emits nothing at all for a server that declares no mcpStores:", () => {
    const singleStore = TWO_STORES.replace(
      / {4}mcpStores:[\s\S]*$/,
      `      SECRETS_PROJECT_ID: "strad-secrets-staging"\n` +
        `      SECRETS_NAMESPACES: "/strad/staging/mcp/"\n`,
    ).replace(
      '    consoleEnv:\n      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY}"\n',
      "",
    );
    const env = envOf(singleStore, "bundle");
    expect(env.SECRETS_STORES).toBeUndefined();
    expect(env.SECRETS_PROJECT_ID).toBe("strad-secrets-staging");
  });
});

describe("a store the agent reaches and the human cannot see", () => {
  /** Collect the render's warnings rather than its spec. */
  function warnings(yaml: string): string[] {
    const found: string[] = [];
    renderAppSpec({
      config: parseConfig(yaml),
      appName: "strad-test",
      region: "nyc",
      image: { registry_type: "GHCR", repository: "strad", tag: "test" },
      env: [],
      secrets: SECRETS,
      onWarning: (m) => found.push(m),
    });
    return found;
  }

  it("warns for an mcpStores: project no console page fronts", () => {
    // TWO_STORES has no consoleStores: and no SECRETS_PROJECT_ID, so BOTH of
    // its stores are agent-only. That is a legal posture and a loud one.
    const found = warnings(TWO_STORES).filter((m) => m.includes("mcpStores:"));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("strad-secrets-staging");
    expect(found[0]).toContain("strad-secrets-prod");
    expect(found[0]).toContain("a human cannot see or undo them");
  });

  it("is silent when every store has a console page", () => {
    const paired = TWO_STORES.replace(
      "    consoleEnv:",
      `    consoleStores:
      - project: strad-secrets-staging
        namespaces: ["/strad/staging/mcp/"]
        adminKeyVar: SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
      - project: strad-secrets-prod
        namespaces: ["/strad/prod/mcp/"]
        adminKeyVar: PROD_ADMIN_SERVICE_ACCOUNT_KEY_JSON
    consoleEnv:
      PROD_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${PROD_ADMIN_KEY}"`,
    );
    expect(warnings(paired).filter((m) => m.includes("mcpStores:"))).toEqual(
      [],
    );
  });

  it("counts the console's single-store fallback as a page", () => {
    const oneStore = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
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
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${STAGING_VIEWER_KEY}"
    consoleEnv:
      SECRETS_PROJECT_ID: "strad-secrets-staging"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${SECRETS_ADMIN_KEY}"
    mcpStores:
      - project: strad-secrets-staging
        namespaces: ["/strad/staging/mcp/"]
        viewerKeyVar: SECRETS_SERVICE_ACCOUNT_KEY_JSON
`;
    expect(warnings(oneStore).filter((m) => m.includes("mcpStores:"))).toEqual(
      [],
    );
  });
});

/**
 * THE FIELD NAMES ARE A SEAM, and nothing in either type system sees both ends.
 *
 * `renderAppSpec` writes `SECRETS_STORES` and the secrets tree — outside the core
 * TypeScript program, its own lockfile, its own image — reads it back. Rename a
 * field on one side and the other reads `undefined`: `loadConfig` throws, the
 * bundle host declines to mount the server, and the failure is legible but the
 * PR that caused it would have been green. Same argument as
 * test/env-prefix.markers.test.ts, and the same weak-but-correct assertion.
 */
describe("the descriptor's field names, in both trees", () => {
  const tree = readFileSync("servers/secrets/shared/src/config.ts", "utf8");
  const renderer = readFileSync("src/deploy/appspec.ts", "utf8");

  it("are spelled the same way by the renderer and the reader", () => {
    for (const name of [
      "SECRETS_STORES",
      "viewerKeyVar",
      "namespaces",
      "project",
      "label",
    ]) {
      expect(renderer).toContain(name);
      expect(tree).toContain(name);
    }
  });
});

describe("mcpStores: the collapses the schema refuses", () => {
  it("accepts the two-store shape", () => {
    expect(problems(TWO_STORES)).toEqual([]);
  });

  it("refuses two stores sharing one viewer key", () => {
    // This is the rule that keeps two stores' CAPABILITIES from being identical
    // by construction. One service account on two projects probes one answer.
    const collapsed = TWO_STORES.replace(
      "        viewerKeyVar: STRAD_PROD_SECRETS_VIEWER_KEY_JSON",
      "        viewerKeyVar: SECRETS_SERVICE_ACCOUNT_KEY_JSON",
    );
    expect(problems(collapsed).join("\n")).toContain(
      "both name viewerKeyVar: SECRETS_SERVICE_ACCOUNT_KEY_JSON",
    );
  });

  it("refuses two stores sharing one credential under two different env: keys", () => {
    // THE NAME IS NOT THE CREDENTIAL, THE REF IS. Two keys, one ${REF}: one
    // service account on two projects, two probes asking Google about the same
    // identity, and a per-store gate that faithfully reports staging's answer
    // for production because it genuinely IS production's answer for that key.
    // A name-only check waves this through; `consoleStores:` learned the same
    // lesson in #263.
    const oneIdentity = TWO_STORES.replace(
      '      STRAD_PROD_SECRETS_VIEWER_KEY_JSON: "${PROD_VIEWER_KEY}"',
      '      STRAD_PROD_SECRETS_VIEWER_KEY_JSON: "${STAGING_VIEWER_KEY}"',
    );
    expect(problems(oneIdentity).join("\n")).toContain(
      "both resolve their viewer credential from ${STAGING_VIEWER_KEY}",
    );
  });

  it("refuses a hand-written SECRETS_STORES under env:", () => {
    // The descriptor is DERIVED. Written by hand it reaches the container having
    // passed none of the rules in this block — including the one that keeps a
    // console admin key out of the /mcp container.
    const handWritten = TWO_STORES.replace(
      '      SECRETS_CONSOLE_URL: "https://strad.example/ui/secrets"',
      '      SECRETS_CONSOLE_URL: "https://strad.example/ui/secrets"\n' +
        `      SECRETS_STORES: '[{"project":"rogue","namespaces":["/rogue/"],"viewerKeyVar":"SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON"}]'`,
    );
    expect(problems(handWritten).join("\n")).toContain(
      "declares SECRETS_STORES under env:",
    );

    // …and refused on a server that declares no mcpStores: at all, which is the
    // shape a "only when the typed field is absent" rule would wave through.
    const noTypedField = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
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
      SECRETS_STORES: '[{"project":"rogue","namespaces":["/rogue/"],"viewerKeyVar":"K"}]'
      K: "\${STAGING_VIEWER_KEY}"
`;
    expect(problems(noTypedField).join("\n")).toContain(
      "declares SECRETS_STORES under env:",
    );
  });

  it("refuses two servers on one bundle both declaring mcpStores:", () => {
    // One container is one process.env, and the secrets tree reads
    // SECRETS_STORES by the BARE name — so the renderer's first-wins pass would
    // put one slug's store list on the box under both slugs, silently. Two slugs
    // on one PATH already throw at render time; this is the other half.
    const twoServers =
      TWO_STORES +
      `  - slug: zimmer-secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /zimmer-secrets
    entitlements: [admin]
    env:
      ZIMMER_VIEWER_KEY_JSON: "\${PROD_ADMIN_KEY}"
    mcpStores:
      - project: zimmer-secrets-prod
        namespaces: ["/zimmer/production/mcp/"]
        viewerKeyVar: ZIMMER_VIEWER_KEY_JSON
`;
    expect(problems(twoServers).join("\n")).toContain(
      'both declare mcpStores: on bundle "bundle"',
    );
  });

  it("refuses a viewerKeyVar this server's env: does not declare", () => {
    const typo = TWO_STORES.replace(
      "        viewerKeyVar: STRAD_PROD_SECRETS_VIEWER_KEY_JSON",
      "        viewerKeyVar: STRAD_PROD_SECRETS_VIEWER_KEY_JSN",
    );
    expect(problems(typo).join("\n")).toContain(
      "is not declared under this server's env:",
    );
  });

  it("refuses an adminKeyVar borrowed as a viewer key", () => {
    // Not a rule of its own — a consequence of two. `viewerKeyVar` must be an
    // `env:` key, and `consoleStores:` already refuses an `adminKeyVar` that is
    // an `env:` key on any server. Asserted because it is the property the
    // design claims, and a future edit to either rule could break it silently.
    const borrowed = TWO_STORES.replace(
      "        viewerKeyVar: STRAD_PROD_SECRETS_VIEWER_KEY_JSON",
      "        viewerKeyVar: SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
    );
    expect(problems(borrowed).join("\n")).toContain(
      "is not declared under this server's env:",
    );

    // And the other direction: moving the admin key into `env:` so the name
    // WOULD resolve trips the consoleStores: fence instead.
    const smuggled = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
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
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${SECRETS_ADMIN_KEY}"
    consoleEnv:
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${SECRETS_ADMIN_KEY}"
    consoleStores:
      - project: strad-secrets-prod
        namespaces: ["/strad/prod/mcp/"]
        adminKeyVar: SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
    mcpStores:
      - project: strad-secrets-prod
        namespaces: ["/strad/prod/mcp/"]
        viewerKeyVar: SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON
`;
    expect(problems(smuggled).join("\n")).toContain(
      "declares that same key under env:",
    );
  });

  it("refuses two stores claiming one path, in either prefix direction", () => {
    for (const ns of ["/strad/staging/mcp/", "/strad/"]) {
      const overlapping = TWO_STORES.replace(
        '        namespaces: ["/strad/prod/mcp/"]',
        `        namespaces: ["${ns}"]`,
      );
      expect(problems(overlapping).join("\n")).toContain(
        "overlap under mcpStores:",
      );
    }
  });

  it("refuses one project declared twice", () => {
    const twice = TWO_STORES.replace(
      "      - project: strad-secrets-prod",
      "      - project: strad-secrets-staging",
    );
    expect(problems(twice).join("\n")).toContain(
      'declares the project "strad-secrets-staging" twice',
    );
  });

  it("refuses mcpStores: alongside the single-store variables it replaces", () => {
    // The container would ignore them, so leaving them names a store this
    // server does not front — a comment that reads as configuration.
    const mixed = TWO_STORES.replace(
      '      SECRETS_CONSOLE_URL: "https://strad.example/ui/secrets"',
      '      SECRETS_CONSOLE_URL: "https://strad.example/ui/secrets"\n' +
        '      SECRETS_PROJECT_ID: "strad-secrets-staging"',
    );
    expect(problems(mixed).join("\n")).toContain(
      "declares mcpStores: AND SECRETS_PROJECT_ID under env:",
    );
  });
});
