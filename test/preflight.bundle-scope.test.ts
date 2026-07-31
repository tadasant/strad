import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";
import { bundleScopeProblems } from "../src/deploy/preflight.ts";

/**
 * `bundleScopeProblems` and its render-time sibling, directly.
 *
 * One bundle is one container is one `process.env`. Two servers sharing a bundle
 * and claiming one variable with different values is therefore a wrong answer
 * rather than an error — the renderer merges them last-wins and says nothing.
 *
 * The staging config exercises the happy path already
 * (test/staging-config.multi-store.test.ts). This file exercises the cases a real
 * config does not contain, which is where a check of this shape actually breaks:
 * the legal collision it must NOT flag, the disabled server it must ignore, and
 * the third claimant it must still report.
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

describe("bundleScopeProblems", () => {
  it("flags one key claimed with different values in one bundle", () => {
    const problems = bundleScopeProblems(
      config(
        server("a", "b1", { SECRETS_PROJECT_ID: "store-a" }) +
          server("b", "b1", { SECRETS_PROJECT_ID: "store-b" }),
      ),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("SECRETS_PROJECT_ID");
    expect(problems[0]).toContain('"a" and "b"');
  });

  it("does NOT flag the same key with the SAME value — that is the normal case", () => {
    // Capability variants declare their credentials identically on purpose, so
    // that disabling one cannot strip the secret from its siblings. Flagging
    // this would make the check unusable on the real config.
    expect(
      bundleScopeProblems(
        config(
          server("gmail-ro", "b1", { GMAIL_KEY: "${K}" }) +
            server("gmail-rw", "b1", { GMAIL_KEY: "${K}" }),
        ),
      ),
    ).toEqual([]);
  });

  it("does NOT flag two bundles, which is the whole point of the escape hatch", () => {
    expect(
      bundleScopeProblems(
        config(
          server("a", "b1", { SECRETS_PROJECT_ID: "store-a" }) +
            server("b", "b2", { SECRETS_PROJECT_ID: "store-b" }),
        ),
      ),
    ).toEqual([]);
  });

  it("ignores a disabled server, because the renderer does too", () => {
    // A disabled server contributes no env to the component, so reporting it
    // would be a problem nobody can act on — and it would block disabling a
    // server as a way OUT of a collision.
    expect(
      bundleScopeProblems(
        config(
          server("a", "b1", { SECRETS_PROJECT_ID: "store-a" }) +
            server(
              "b",
              "b1",
              { SECRETS_PROJECT_ID: "store-b" },
              "    enabled: false\n",
            ),
        ),
      ),
    ).toEqual([]);
  });

  it("still reports a THIRD claimant, rather than going quiet after the first", () => {
    const problems = bundleScopeProblems(
      config(
        server("a", "b1", { K: "1" }) +
          server("b", "b1", { K: "2" }) +
          server("c", "b1", { K: "3" }),
      ),
    );
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain('"a" and "b"');
    expect(problems.join("\n")).toContain('"a" and "c"');
  });
});

describe("a managed parameter may not shadow a sibling on the same bundle", () => {
  // The half `bundleScopeProblems` structurally cannot cover: a parameter's
  // VALUE only exists at render time, and its NAME comes from a path a human
  // types into the console. So a parameter created under one slug's namespace
  // could silently repoint another slug's variable on the same component. The
  // renderer is the only place that can see it.
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
