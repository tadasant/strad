import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { CORE_BOOT_ENV_KEYS } from "../src/secrets/provider/hydrate.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";
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
 *   4. The `env:`/`consoleEnv:` NAMING ASYMMETRY is what makes (2) work, and the
 *      config schema's collision rule is what catches (1) if someone collapses it.
 *
 * This is the config's half of the proof. The container's half — that the second
 * component boots and answers `/secrets` from its own environment — follows from
 * `loadConfig()` reading `process.env`, and is exercised against the real image
 * by the staging deploy.
 */

const RAW_STAGING_CONFIG = readFileSync(
  new URL("../infra/strad.staging.yaml", import.meta.url),
  "utf8",
);

const CONFIG = parseConfig(RAW_STAGING_CONFIG, "infra/strad.staging.yaml");

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

    // AND IT DECLARES ONLY THE KEYS THAT ARE NOT ALREADY BARE UNDER `env:`.
    //
    // `withNamespacedFallback` maps the namespaced form down with `??=` — a
    // fallback, not an override — and `env:`/`consoleEnv:` are merged before it
    // runs. So a namespaced key whose bare form `env:` already sets is INERT: it
    // reads as meaningful and does nothing. Assert the shape rather than trust
    // it, because the failure is invisible.
    for (const key of Object.keys(zimmer.consoleEnv)) {
      const bare = key.slice("ZIMMER_SECRETS_".length);
      expect(Object.keys(zimmer.env)).not.toContain(bare);
    }
  });

  it("resolves the console from the values that actually win, not the ones that look declarative", () => {
    // The regression this pins: if someone adds
    // `ZIMMER_SECRETS_SECRETS_PROJECT_ID` back alongside the bare `env:` key,
    // the config would suggest the console can be pointed somewhere else and it
    // could not. Diverge every namespaced key from its bare twin and assert
    // which one the console reads — a test that only checked key PREFIXES would
    // pass either way.
    const diverged = parseConfig(
      readFileSync(
        new URL("../infra/strad.staging.yaml", import.meta.url),
        "utf8",
      ).replace(
        'ZIMMER_SECRETS_SECRETS_REVEAL_ENABLED: "true"',
        'ZIMMER_SECRETS_SECRETS_REVEAL_ENABLED: "false"',
      ),
      "diverged.yaml",
    );
    const spec = renderAppSpec({
      config: diverged,
      appName: "strad-staging",
      region: "nyc",
      image: { registry_type: "GHCR", repository: "strad", tag: "test" },
      env: [],
      secrets: SECRETS,
    });
    const core = Object.fromEntries(
      spec.services
        .find((s) => s.name === "core")!
        .envs.map((e) => [e.key, e.value]),
    );
    const view = resolveServerView(diverged, "zimmer-secrets", core);
    if (view.kind !== "secrets") throw new Error("not a secrets view");

    // The namespaced flag has no bare twin under `env:`, so it DOES win.
    expect(view.revealEnabled).toBe(false);
    // And the project still comes from `env:`, which is the only place it is set.
    expect(view.projectId).toBe(ZIMMER_STORE);
  });

  it("passes the schema's env-collision rule, and the collapsed shape does not", () => {
    // THE COMPOSITION ASSERTION, and it is cheap insurance for both changes.
    //
    // The `superRefine` in src/config/schema.ts exists to catch exactly the shape
    // this config deliberately avoids. So this config passing it is not a
    // formality: a rule that collided `env:` GLOBALLY rather than per-bundle would
    // forbid the correct two-bundle configuration, and this is the only real
    // two-bundle config in the tree. If someone tightens that rule, this fails.
    expect(() => parseConfig(RAW_STAGING_CONFIG, "staging")).not.toThrow();

    // And the trap it exists for: one bundle, two secrets slugs. Both credentials
    // and the store id collide, and the message names them.
    let message = "";
    try {
      parseConfig(
        RAW_STAGING_CONFIG.replace(
          "bundle: bundle-zimmer-secrets",
          "bundle: bundle",
        ),
        "collapsed.yaml",
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("SECRETS_PROJECT_ID");
    expect(message).toContain("SECRETS_SERVICE_ACCOUNT_KEY_JSON");
    expect(message).toContain('share the "bundle" bundle');

    // Collapse it AND un-namespace `consoleEnv:` — the full "obvious way" — and
    // the ADMIN credential collision is named too. That is the one that would
    // otherwise render /ui/secrets against strad's project holding Zimmer's key.
    let bare = "";
    try {
      parseConfig(
        RAW_STAGING_CONFIG.replace(
          "bundle: bundle-zimmer-secrets",
          "bundle: bundle",
        ).replaceAll("ZIMMER_SECRETS_SECRETS_", "SECRETS_"),
        "bare.yaml",
      );
    } catch (err) {
      bare = (err as Error).message;
    }
    expect(bare).toContain("SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON");
    expect(bare).toContain("consoleEnv:");
  });

  it("entitles Zimmer's role to fenced parameter stores and credential-free slugs, and nothing else", () => {
    // Both directions must agree: the role names the slug, and the slug names
    // the role (src/gateway/entitlements.ts). Widening either one is how a
    // Zimmer session would reach the third-party accounts staging shares with
    // prod, so this is the assertion that has to bite.
    //
    // The list is THREE, and each earns it on a different ground:
    //   zimmer-secrets  Zimmer's own store, in its own GCP project.
    //   secrets         strad's staging store — a DIFFERENT project, fenced again
    //                   by its own SECRETS_NAMESPACES, and the one the
    //                   runtime-secrets migration is rehearsed against.
    //   echo            a builtin holding no credential at all; the only server
    //                   whose output is a value the gateway resolved at RUNTIME,
    //                   which is what makes a rotation observable over /mcp.
    const ALLOWED = ["echo", "secrets", "zimmer-secrets"];
    expect(CONFIG.roles.zimmer?.servers.slice().sort()).toEqual(ALLOWED);
    expect(
      CONFIG.servers
        .filter((s) => s.entitlements.includes("zimmer"))
        .map((s) => s.slug)
        .sort(),
    ).toEqual(ALLOWED);

    // And the property behind the list, derived from the config rather than
    // restated — so a NEW slug carrying a third-party credential cannot be added
    // to this role by editing the array above. A reachable slug must either front
    // a parameter store (its own project, its own namespace fence) or carry no
    // `${REF}` credential whatsoever.
    for (const slug of ALLOWED) {
      const server = CONFIG.servers.find((s) => s.slug === slug)!;
      const refs =
        server.kind === "supplementary-image"
          ? Object.values(server.env)
          : server.kind === "builtin"
            ? Object.values(server.options).filter(
                (v): v is string => typeof v === "string",
              )
            : [server.url, ...Object.values(server.headers)];
      const fronts =
        server.kind === "supplementary-image" &&
        server.env.SECRETS_PROJECT_ID !== undefined &&
        server.env.SECRETS_NAMESPACES !== undefined;
      // A reachable slug may hold a `${REF}` — `echo` deliberately does, because
      // returning a resolved value is the whole point of the observatory. What it
      // may NOT do is point at a name that carries a credential, because whatever
      // `echo` resolves it hands straight back over /mcp. So the check is not
      // "no refs", it is "no ref to anything this deployment treats as secret":
      // every name in a supplementary server's `env:`, plus the boot keys.
      const credentialNames = new Set([
        ...CONFIG.servers
          .flatMap((s) =>
            s.kind === "supplementary-image"
              ? Object.values(s.env).flatMap((v) => [
                  ...v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g),
                ])
              : [],
          )
          .map((m) => m[1]!),
        ...CORE_BOOT_ENV_KEYS,
      ]);
      const pointsAtACredential = refs
        .flatMap((v) => [...v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)])
        .some((m) => credentialNames.has(m[1]!));
      expect(
        fronts || !pointsAtACredential,
        `"${slug}" is reachable by the zimmer role and references a name this deployment holds a credential under`,
      ).toBe(true);
    }
  });
});
