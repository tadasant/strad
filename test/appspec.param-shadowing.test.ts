import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";

/**
 * A managed parameter may not shadow a sibling's variable on the same bundle.
 *
 * One bundle is one container is one `process.env`. Two servers claiming one
 * variable with different values is a wrong answer rather than an error — the
 * renderer merges them last-wins and says nothing.
 *
 * The `env:`-against-`env:` half of that is caught by the schema
 * (`superRefine` in src/config/schema.ts), which is the right place: it fires at
 * boot as well as at the deploy gate. This file covers the half the schema
 * STRUCTURALLY cannot see. A `params: true` server's variables land on the same
 * component environment, but their NAMES come from paths in the store and their
 * VALUES do not exist until render time, so only `renderAppSpec` is in a position
 * to notice the collision.
 *
 * It is worth a check of its own rather than being folded into the config rule,
 * because it is reachable by a HUMAN ACTION rather than a config edit: the console
 * creates parameters, and a parameter's path decides its variable name.
 */

function config(servers: string): ReturnType<typeof parseConfig> {
  return parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true, store: env } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: b1
  - name: b2
servers:
${servers}`);
}

const IMAGE = "ghcr.io/tadasant/strad-bundle:latest";

function server(
  slug: string,
  bundle: string,
  env: Record<string, string>,
  extra = "",
): string {
  const lines = Object.entries(env).map(([k, v]) => `      ${k}: "${v}"`);
  return `  - slug: ${slug}
    kind: supplementary-image
    image: ${IMAGE}
    bundle: ${bundle}
    path: /${slug}
    entitlements: [admin]
${extra}    env:
${lines.join("\n") || '      NOTHING: "x"'}
`;
}

describe("a managed parameter may not shadow a sibling on the same bundle", () => {
  // The half the config schema structurally cannot cover: a parameter's VALUE
  // only exists at render time, and its NAME comes from a path a human types into
  // the console. So a parameter created under one slug's namespace could silently
  // repoint another slug's variable on the same component.
  const CONFIG = config(
    server("secrets", "b1", { SECRETS_PROJECT_ID: "store-a" }) +
      server(
        "filestore",
        "b1",
        { FILESTORE_BUCKET: "b" },
        "    params: true\n",
      ),
  );

  const render = (resolvedParams: Record<string, Record<string, string>>) =>
    renderAppSpec({
      config: CONFIG,
      appName: "app",
      region: "nyc",
      image: { registry_type: "GHCR", repository: "strad", tag: "t" },
      env: [],
      secrets: {},
      resolvedParams,
    });

  it("throws when one server's parameter collides with another's env: key", () => {
    expect(() =>
      render({ filestore: { SECRETS_PROJECT_ID: "hijacked" } }),
    ).toThrow(/SECRETS_PROJECT_ID is contributed by more than one server/);
  });

  it("throws regardless of declaration order", () => {
    // The colliding server is declared SECOND here and FIRST in the config
    // above; a running comparison would catch only one of the two orders.
    const reversed = config(
      server(
        "filestore",
        "b1",
        { FILESTORE_BUCKET: "b" },
        "    params: true\n",
      ) + server("secrets", "b1", { SECRETS_PROJECT_ID: "store-a" }),
    );
    expect(() =>
      renderAppSpec({
        config: reversed,
        appName: "app",
        region: "nyc",
        image: { registry_type: "GHCR", repository: "strad", tag: "t" },
        env: [],
        secrets: {},
        resolvedParams: { filestore: { SECRETS_PROJECT_ID: "hijacked" } },
      }),
    ).toThrow(/more than one server/);
  });

  it("allows a server's parameter to shadow its OWN env: key", () => {
    // That is the documented migration path off a hand-written ${REF}, and it is
    // a deliberate single-server override rather than one server clobbering
    // another.
    const spec = render({ filestore: { FILESTORE_BUCKET: "from-the-store" } });
    const bundle = spec.services.find((s) => s.name === "b1")!;
    const values = bundle.envs
      .filter((e) => e.key === "FILESTORE_BUCKET")
      .map((e) => e.value);
    expect(values.at(-1)).toBe("from-the-store");
  });

  it("allows the same variable name in two different bundles", () => {
    const twoBundles = config(
      server("secrets", "b1", { SECRETS_PROJECT_ID: "store-a" }) +
        server("filestore", "b2", { X: "y" }, "    params: true\n"),
    );
    expect(() =>
      renderAppSpec({
        config: twoBundles,
        appName: "app",
        region: "nyc",
        image: { registry_type: "GHCR", repository: "strad", tag: "t" },
        env: [],
        secrets: {},
        resolvedParams: { filestore: { SECRETS_PROJECT_ID: "store-b" } },
      }),
    ).not.toThrow();
  });
});
