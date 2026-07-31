import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";
import { bundleScopeProblems } from "../src/deploy/preflight.ts";
import { resolveServerView } from "../src/ui/resolve.ts";

/**
 * ONE strad, TWO parameter stores.
 *
 * strad's `secrets` server is store-agnostic — it takes a project, a namespace
 * prefix list and a credential — so pointing a second slug at Zimmer's project
 * gives Zimmer the same console, the same MCP tools and the same viewer/admin
 * split, instead of a second parameters console written somewhere else.
 *
 * The mechanism is one line of config (`bundle:`) and the failure mode of
 * getting it wrong is SILENT, which is why this file exists. A store is
 * `process.env`: the secrets server reads `SECRETS_PROJECT_ID` from it and the
 * bundle host calls `loadConfig()` with no argument, so a container fronts
 * exactly one store. Two secrets slugs in one bundle would share it, and
 * `?servers=zimmer-secrets` would answer with strad's parameters — a wrong
 * answer, not an error.
 *
 * Four properties, each of which would be a silent misroute if it broke:
 *
 *   1. TWO BUNDLES, and each carries its OWN store's project, namespace and
 *      viewer key. Neither carries the other's.
 *   2. The CONSOLE resolves each slug to its own project and its own ADMIN
 *      identity — the half that renders in core, where every server's
 *      `consoleEnv:` is merged into one flat environment.
 *   3. NO ADMIN KEY ON ANY BUNDLE. The console's credential can read a secret
 *      value; the container that answers /mcp must never hold it.
 *   4. The `env:`/`consoleEnv:` NAMING ASYMMETRY is what makes (2) work, and
 *      `bundleScopeProblems` is what catches (1) if someone collapses it.
 *
 * This is the config's half of the proof. The container's half — that the second
 * component boots and answers `/secrets` from its own environment — follows from
 * `loadConfig()` reading `process.env`, and is exercised against the real image
 * by the staging deploy.
 */

const CONFIG = parseConfig(
  readFileSync(new URL("../infra/strad.staging.yaml", import.meta.url), "utf8"),
  "infra/strad.staging.yaml",
);

const STRAD_STORE = "strad-secrets-staging";
const ZIMMER_STORE = "zimmer-secrets-staging";

/**
 * A distinct, recognisable value per referenced name, so a swap between the two
 * stores is visible rather than merely absent. A `*_KEY_JSON` name gets a
 * well-formed service-account key whose `client_email` names the ref it came
 * from — the console parses these, and an identity is what this file is about.
 */
function dummy(name: string): string {
  if (!name.endsWith("_KEY_JSON")) return `value-of-${name}`;
  return JSON.stringify({
    client_email: `${name.toLowerCase()}@example.iam.gserviceaccount.com`,
    private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  });
}

const SECRETS: Record<string, string> = Object.fromEntries(
  CONFIG.servers
    .filter((s) => s.kind === "supplementary-image" && s.enabled)
    .flatMap((s) =>
      s.kind === "supplementary-image"
        ? [...Object.values(s.env), ...Object.values(s.consoleEnv)].flatMap(
            (v) =>
              [...v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
                (m) => [m[1]!, dummy(m[1]!)] as const,
              ),
          )
        : [],
    ),
);

const SPEC = renderAppSpec({
  config: CONFIG,
  appName: "strad-staging",
  region: "nyc",
  image: { registry_type: "GHCR", repository: "strad", tag: "test" },
  env: [],
  secrets: SECRETS,
});

function component(name: string): { key: string; value: string }[] {
  const svc = SPEC.services.find((s) => s.name === name);
  if (!svc) throw new Error(`no component "${name}" in the rendered spec`);
  return svc.envs.map((e) => ({ key: e.key, value: e.value }));
}

function envValue(name: string, key: string): string | undefined {
  return component(name).find((e) => e.key === key)?.value;
}

/** The core component's rendered environment, which is what the console reads. */
const CORE_ENV: Record<string, string> = Object.fromEntries(
  component("core").map((e) => [e.key, e.value]),
);

describe("two parameter stores, one strad", () => {
  it("gives each store its own bundle, and neither bundle the other's store", () => {
    expect(envValue("bundle", "SECRETS_PROJECT_ID")).toBe(STRAD_STORE);
    expect(envValue("bundle-zimmer-secrets", "SECRETS_PROJECT_ID")).toBe(
      ZIMMER_STORE,
    );

    expect(envValue("bundle", "SECRETS_NAMESPACES")).toBe(
      "/strad/staging/mcp/",
    );
    expect(envValue("bundle-zimmer-secrets", "SECRETS_NAMESPACES")).toBe(
      "/zimmer/staging/mcp/static/",
    );

    // The viewer keys are the thing that must not cross. Each bundle holds
    // exactly its own store's, under the bare name its container reads.
    expect(envValue("bundle", "SECRETS_SERVICE_ACCOUNT_KEY_JSON")).toBe(
      dummy("SECRETS_VIEWER_KEY_JSON"),
    );
    expect(
      envValue("bundle-zimmer-secrets", "SECRETS_SERVICE_ACCOUNT_KEY_JSON"),
    ).toBe(dummy("ZIMMER_SECRETS_VIEWER_KEY_JSON"));
  });

  it("routes each slug to its own bundle, from the same path", () => {
    // The gateway resolves the private URL PER BUNDLE and only then appends
    // `path:` (src/gateway/registry.ts). That is why the same `/secrets` on two
    // bundles is two containers rather than one — and why the `bundle:` line is
    // the entire mechanism.
    const slugs = ["secrets", "zimmer-secrets"].map((slug) => {
      const s = CONFIG.servers.find((x) => x.slug === slug);
      if (s?.kind !== "supplementary-image")
        throw new Error(`${slug} is not a supplementary-image server`);
      return s;
    });
    const [strad, zimmer] = slugs as [(typeof slugs)[0], (typeof slugs)[0]];

    expect(strad.path).toBe("/secrets");
    expect(zimmer.path).toBe("/secrets");
    expect(strad.bundle).not.toBe(zimmer.bundle);

    // And core is handed a private URL for each, or the second slug has nothing
    // to reach.
    expect(CORE_ENV.STRAD_BUNDLE_URL_BUNDLE).toBe("${bundle.PRIVATE_URL}");
    expect(CORE_ENV.STRAD_BUNDLE_URL_BUNDLE_ZIMMER_SECRETS).toBe(
      "${bundle-zimmer-secrets.PRIVATE_URL}",
    );
  });

  it("renders each console page against its own store and its own admin identity", () => {
    const strad = resolveServerView(CONFIG, "secrets", CORE_ENV);
    const zimmer = resolveServerView(CONFIG, "zimmer-secrets", CORE_ENV);

    if (strad.kind !== "secrets" || zimmer.kind !== "secrets")
      throw new Error("both slugs must resolve to a secrets view");

    expect(strad.projectId).toBe(STRAD_STORE);
    expect(zimmer.projectId).toBe(ZIMMER_STORE);

    expect(zimmer.namespaces).toEqual(["/zimmer/staging/mcp/static/"]);
    expect(strad.namespaces).not.toContain("/zimmer/staging/mcp/static/");

    // THE CREDENTIAL, which is the half that fails silently. Bare `consoleEnv:`
    // names on the second slug would leave `/ui/secrets` rendering strad's
    // project while holding ZIMMER's admin key — a page that looks entirely
    // correct and acts on the wrong project.
    expect(strad.account?.client_email).toBe(
      "secrets_admin_key_json@example.iam.gserviceaccount.com",
    );
    expect(zimmer.account?.client_email).toBe(
      "zimmer_secrets_admin_key_json@example.iam.gserviceaccount.com",
    );
    expect(strad.accountReason).toBeUndefined();
    expect(zimmer.accountReason).toBeUndefined();
  });

  it("keeps every admin key off every bundle", () => {
    // `consoleEnv:` is resolved onto core alone; `env:` onto the bundle alone.
    // The ordinary way to give core a credential — a broadcast SECRET — would
    // have put the admin key on both containers, which is the whole reason
    // consoleEnv exists. Assert it for BOTH stores, on BOTH bundles.
    for (const bundle of ["bundle", "bundle-zimmer-secrets"]) {
      const keys = component(bundle).map((e) => e.key);
      expect(keys).not.toContain("SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON");
      expect(keys).not.toContain(
        "ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
      );
      // Nor the other store's viewer, which would be the same mistake one
      // notch quieter.
      const values = component(bundle).map((e) => e.value);
      const foreign = dummy(
        bundle === "bundle"
          ? "ZIMMER_SECRETS_VIEWER_KEY_JSON"
          : "SECRETS_VIEWER_KEY_JSON",
      );
      expect(values).not.toContain(foreign);
    }

    // Both admin keys DO land on core, under the keys the console reads.
    expect(CORE_ENV.SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON).toBe(
      dummy("SECRETS_ADMIN_KEY_JSON"),
    );
    expect(CORE_ENV.ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON).toBe(
      dummy("ZIMMER_SECRETS_ADMIN_KEY_JSON"),
    );
  });

  it("declares consoleEnv slug-namespaced and env bare, which is what makes the console right", () => {
    const zimmer = CONFIG.servers.find((s) => s.slug === "zimmer-secrets");
    if (zimmer?.kind !== "supplementary-image") throw new Error("no slug");

    // `env:` lands on this slug's own container, which holds nothing else, so
    // the bare names the server actually reads are correct there.
    for (const key of Object.keys(zimmer.env)) {
      expect(key.startsWith("SECRETS_")).toBe(true);
    }
    // `consoleEnv:` merges into ONE core environment shared with `secrets`, so
    // every key must be slug-namespaced or it collides.
    for (const key of Object.keys(zimmer.consoleEnv)) {
      expect(key.startsWith("ZIMMER_SECRETS_SECRETS_")).toBe(true);
    }
  });

  it("is clean under the bundle-scope check, and the collapsed shape is not", () => {
    expect(bundleScopeProblems(CONFIG)).toEqual([]);

    // The trap: the obvious way to write a second store. It parses, it renders,
    // and before this check it produced a container fronting one store under two
    // slugs with nothing reporting it.
    const collapsed = parseConfig(
      readFileSync(
        new URL("../infra/strad.staging.yaml", import.meta.url),
        "utf8",
      ).replace("bundle: bundle-zimmer-secrets", "bundle: bundle"),
      "collapsed.yaml",
    );
    const problems = bundleScopeProblems(collapsed);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("SECRETS_PROJECT_ID");
    expect(problems.join("\n")).toContain(
      "one bundle is one container with one environment",
    );
  });

  it("entitles Zimmer's own role to its store and to nothing else", () => {
    // Both directions must agree: the role names the slug, and the slug names
    // the role (src/gateway/entitlements.ts). Widening either one would hand a
    // Zimmer session the third-party accounts staging shares with prod.
    expect(CONFIG.roles.zimmer?.servers).toEqual(["zimmer-secrets"]);
    const zimmer = CONFIG.servers.find((s) => s.slug === "zimmer-secrets");
    expect(zimmer?.entitlements).toContain("zimmer");

    for (const server of CONFIG.servers) {
      if (server.slug === "zimmer-secrets") continue;
      expect(server.entitlements).not.toContain("zimmer");
    }
  });
});
