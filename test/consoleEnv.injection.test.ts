import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";
import { resolveServerView } from "../src/ui/resolve.ts";
import type { SecretBag } from "../src/secrets/index.ts";

/**
 * The seam between the two halves of `consoleEnv:` — and the bug that lived in
 * it while both halves had passing tests.
 *
 * appspec.ts resolves `consoleEnv:` at RENDER time and lands the VALUE on core
 * under the declared KEY. src/ui then reads it back at RUN time. Each side was
 * tested alone: appspec.consoleEnv.test.ts renders a spec and asserts the key is
 * on core, ui.secrets.test.ts hands the console a bag and asserts it resolves.
 * Neither noticed that the bag ui.secrets.test.ts handed over was one no
 * deployment produces — it was keyed by the REF NAME (`ADMIN_KEY`), while a real
 * core container holds the KEY (`SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON`). The
 * ref name is never injected anywhere, by design: it names the store-ADMIN
 * credential, and not broadcasting it is the entire reason `consoleEnv:` exists.
 *
 * So the console asked core's environment for a name guaranteed not to be in it,
 * and `/ui/secrets` in production said "the admin credential is not configured"
 * with the credential sitting in its own environment.
 *
 * These tests span BOTH halves: render the spec, then boot the console with the
 * environment that spec actually produces. Nothing here invents a bag.
 */

const CONFIG_YAML = `
version: 1
gateway:
  name: strad
  env: prod
auth:
  staticTokens: { enabled: true, store: env }
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
      SECRETS_PROJECT_ID: "strad-secrets-prod"
      SECRETS_NAMESPACES: "/strad/prod/mcp/"
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${SECRETS_VIEWER_KEY_JSON}"
    consoleEnv:
      SECRETS_PROJECT_ID: "strad-secrets-prod"
      SECRETS_NAMESPACES: "/strad/prod/mcp/"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${SECRETS_ADMIN_KEY_JSON}"
`;

const ADMIN_JSON = JSON.stringify({
  client_email: "strad-secrets-admin@demo.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nfake-admin\n-----END PRIVATE KEY-----",
});
const VIEWER_JSON = JSON.stringify({
  client_email: "strad-secrets-viewer@demo.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nfake-viewer\n-----END PRIVATE KEY-----",
});

/**
 * The DEPLOY job's environment: keyed by the `${NAME}` refs the config uses.
 * This bag exists only in CI. It is never the container's environment.
 */
const DEPLOY_ENV = {
  SECRETS_ADMIN_KEY_JSON: ADMIN_JSON,
  SECRETS_VIEWER_KEY_JSON: VIEWER_JSON,
};

const config = parseConfig(CONFIG_YAML);

function render() {
  return renderAppSpec({
    config,
    appName: "strad-prod",
    region: "nyc",
    image: {
      registry_type: "GHCR",
      registry: "tadasant",
      repository: "strad",
      tag: "0.1.29",
    },
    env: [],
    secrets: DEPLOY_ENV,
  });
}

/** A component's env vars, as the container sees them: a flat process.env. */
function containerEnv(component: string): SecretBag {
  const spec = render();
  const svc = spec.services.find((s) => s.name === component);
  if (!svc) throw new Error(`no component "${component}" in the spec`);
  const bag: Record<string, string> = {};
  for (const e of svc.envs) bag[e.key] = e.value;
  return bag;
}

describe("consoleEnv: render -> run", () => {
  it("lands the console's credential on core, under the declared KEY", () => {
    const core = containerEnv("core");

    expect(core.SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON).toBe(ADMIN_JSON);

    // The premise the console used to get wrong: the REF NAME is not injected.
    // It never is, anywhere — that is what keeps the admin key off the bundle.
    expect(core.SECRETS_ADMIN_KEY_JSON).toBeUndefined();
    expect(containerEnv("bundle").SECRETS_ADMIN_KEY_JSON).toBeUndefined();
  });

  it("resolves the admin account from the environment core actually gets", () => {
    const view = resolveServerView(config, "secrets", containerEnv("core"));

    expect(view.kind).toBe("secrets");
    if (view.kind !== "secrets") return;

    // The regression: this was null on a deployment where everything was
    // configured and seeded correctly, and the console rendered
    // "The console's admin credential is not configured."
    expect(view.accountReason).toBeUndefined();
    expect(view.account?.client_email).toBe(
      "strad-secrets-admin@demo.iam.gserviceaccount.com",
    );

    // The non-secret half of consoleEnv: still comes through.
    expect(view.projectId).toBe("strad-secrets-prod");
    expect(view.namespaces).toEqual(["/strad/prod/mcp/"]);
  });

  it("does not fall back to the MCP container's viewer credential", () => {
    // The bundle's viewer key is not on core at all, so there is nothing to fall
    // back TO — but assert the negative, because a "helpful" fallback here would
    // hand the console a credential that cannot read a secret value and turn a
    // legible error into a confusing 403.
    const core = containerEnv("core");
    expect(core.SECRETS_SERVICE_ACCOUNT_KEY_JSON).toBeUndefined();
    expect(Object.values(core)).not.toContain(VIEWER_JSON);
  });

  it("still says so when the credential genuinely is not injected", () => {
    // Core's env minus the admin key: the honest "not configured" case must keep
    // reporting itself, or the fix would have traded a false negative for a
    // false positive.
    const core = { ...containerEnv("core") } as Record<string, string>;
    delete core.SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON;

    const view = resolveServerView(config, "secrets", core);
    expect(view.kind).toBe("secrets");
    if (view.kind !== "secrets") return;
    expect(view.account).toBeNull();
    expect(view.accountReason).toMatch(/not injected on this deployment/);
  });

  it("never hands one server's console credential to another server's view", () => {
    // Core's environment is ONE namespace: consoleEnvVars() merges every enabled
    // supplementary server's consoleEnv into it. So `gcs-private`, which scopes
    // its credential to the bundle and declares no consoleEnv, must NOT resolve
    // the key `gcs` filed on core under the same name — or /ui/gcs-private would
    // browse a private bucket as the OTHER server's service account, silently.
    // The two already collide on the bare GCS_* names by design.
    const twoServers = parseConfig(`
version: 1
gateway: { name: strad, env: prod }
auth: { staticTokens: { enabled: true, store: env } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
servers:
  - slug: gcs
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gcs
    entitlements: [admin]
    env:
      GCS_BUCKET: "public_bucket"
      GCS_SERVICE_ACCOUNT_KEY_JSON: "\${GCS_A_KEY}"
    consoleEnv:
      GCS_BUCKET: "public_bucket"
      GCS_SERVICE_ACCOUNT_KEY_JSON: "\${GCS_A_KEY}"
  - slug: gcs-private
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gcs-private
    entitlements: [admin]
    env:
      GCS_BUCKET: "private_bucket"
      GCS_SERVICE_ACCOUNT_KEY_JSON: "\${GCS_B_KEY}"
`);
    const spec = renderAppSpec({
      config: twoServers,
      appName: "strad-prod",
      region: "nyc",
      image: {
        registry_type: "GHCR",
        registry: "tadasant",
        repository: "strad",
        tag: "0.1.29",
      },
      env: [],
      secrets: {
        GCS_A_KEY: JSON.stringify({
          client_email: "a@a.iam.gserviceaccount.com",
          private_key:
            "-----BEGIN PRIVATE KEY-----\na\n-----END PRIVATE KEY-----",
        }),
        GCS_B_KEY: JSON.stringify({
          client_email: "b@b.iam.gserviceaccount.com",
          private_key:
            "-----BEGIN PRIVATE KEY-----\nb\n-----END PRIVATE KEY-----",
        }),
      },
    });
    const core: Record<string, string> = {};
    for (const e of spec.services.find((s) => s.name === "core")!.envs) {
      core[e.key] = e.value;
    }
    // The premise: A's key IS on core, under the same key name B declares.
    expect(core.GCS_SERVICE_ACCOUNT_KEY_JSON).toContain("a@a.iam");

    const mine = resolveServerView(twoServers, "gcs", core);
    expect(mine.kind === "gcs" && mine.account?.client_email).toBe(
      "a@a.iam.gserviceaccount.com",
    );

    const theirs = resolveServerView(twoServers, "gcs-private", core);
    expect(theirs.kind).toBe("gcs");
    if (theirs.kind !== "gcs") return;
    expect(theirs.account).toBeNull();
    expect(theirs.accountReason).toMatch(/consoleEnv/);
  });

  it("keeps a bundle-scoped credential unreadable from the console", () => {
    // `env:` lands on the bundle only. The console must not resolve it — not via
    // the ref (not in core's bag) and not via the key (not on core either) — and
    // must keep pointing at the actual fix, which is `consoleEnv:`.
    const gcsConfig = parseConfig(`
version: 1
gateway: { name: strad, env: prod }
auth: { staticTokens: { enabled: true, store: env } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
servers:
  - slug: gcs
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gcs
    entitlements: [admin]
    env:
      GCS_BUCKET: "pulse_public"
      GCS_SERVICE_ACCOUNT_KEY_JSON: "\${GCS_KEY_JSON}"
`);
    const spec = renderAppSpec({
      config: gcsConfig,
      appName: "strad-prod",
      region: "nyc",
      image: {
        registry_type: "GHCR",
        registry: "tadasant",
        repository: "strad",
        tag: "0.1.29",
      },
      env: [],
      secrets: { GCS_KEY_JSON: "{}" },
    });
    const core: Record<string, string> = {};
    for (const e of spec.services.find((s) => s.name === "core")!.envs) {
      core[e.key] = e.value;
    }

    const view = resolveServerView(gcsConfig, "gcs", core);
    expect(view.kind).toBe("gcs");
    if (view.kind !== "gcs") return;
    expect(view.account).toBeNull();
    expect(view.accountReason).toMatch(/consoleEnv/);
  });
});
