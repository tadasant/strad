import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";
import { CORE_URL_ENV } from "../src/secrets/param-route.ts";

/**
 * `paramsWritable:` — what the schema refuses, and what the renderer refuses.
 *
 * These are the two gates in front of a route that WRITES to the parameter
 * store. The schema bounds what a name may be, so core can compose a path from
 * config strings rather than from a URL; the renderer bounds the TOPOLOGY, so a
 * credential with exactly one valid value at a time never has two processes
 * spending it.
 */

const IMAGE = {
  registry_type: "GHCR" as const,
  registry: "tadasant",
  repository: "strad",
  tag: "latest",
};

function config(server: string, bundles: string = "  - name: bundle\n") {
  return `
version: 1
gateway: { name: strad, env: staging }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
${bundles}servers:
${server}`;
}

const X = (extra: string, bundles?: string) =>
  config(
    `  - slug: x-twitter
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /x-twitter
    entitlements: [admin]
${extra}`,
    bundles,
  );

describe("the paramsWritable schema rule", () => {
  it("accepts a legal variable alongside params: true", () => {
    const cfg = parseConfig(
      X("    params: true\n    paramsWritable: [X_OAUTH_REFRESH_TOKEN]\n"),
    );
    expect(cfg.servers[0]).toMatchObject({
      params: true,
      paramsWritable: ["X_OAUTH_REFRESH_TOKEN"],
    });
  });

  it("defaults to an empty list, so no server can write by omission", () => {
    expect(parseConfig(X("")).servers[0]).toMatchObject({
      paramsWritable: [],
    });
  });

  it("refuses paramsWritable without params: true", () => {
    // Without the flag the server would be writing a namespace it does not
    // read — a credential going nowhere, which is the silent no-op this repo
    // keeps having to hunt down.
    expect(() =>
      parseConfig(X("    paramsWritable: [X_OAUTH_REFRESH_TOKEN]\n")),
    ).toThrow(/params: true/);
  });

  it("refuses a name that is not a legal environment variable", () => {
    // This is the fence that confines the write to the server's own
    // `/{slug}/static/` namespace. A name is a VARIABLE, never a path, so there
    // is no traversal to perform later — the composition simply cannot be given
    // one of these.
    for (const bad of [
      "../../gateway/static/STRAD_TOKENS",
      "X_OAUTH/REFRESH",
      "1_LEADING_DIGIT",
      "has space",
      "X-OAUTH-REFRESH",
    ]) {
      expect(() =>
        parseConfig(X(`    params: true\n    paramsWritable: ["${bad}"]\n`)),
      ).toThrow(/not a legal environment variable name/);
    }
  });

  it("refuses a duplicate entry", () => {
    expect(() =>
      parseConfig(
        X("    params: true\n    paramsWritable: [X_TOKEN, X_TOKEN]\n"),
      ),
    ).toThrow(/twice/);
  });

  it("refuses two entries that differ only in case", () => {
    // `parameterId` folds case before it hashes, so these name ONE parameter in
    // the store and TWO environment variables in the container: one would
    // resolve and its twin would 404 forever.
    expect(() =>
      parseConfig(
        X("    params: true\n    paramsWritable: [X_TOKEN, x_token]\n"),
      ),
    ).toThrow(/ONE parameter under two variable names/);
  });

  it("refuses a name past the store's length cap", () => {
    const long = `X_${"A".repeat(200)}`;
    expect(() =>
      parseConfig(X(`    params: true\n    paramsWritable: [${long}]\n`)),
    ).toThrow(/at most 200/);
  });
});

describe("the single-writer render check", () => {
  const WRITABLE =
    "    params: true\n    paramsWritable: [X_OAUTH_REFRESH_TOKEN]\n";

  it("renders a one-instance component", () => {
    const spec = renderAppSpec({
      config: parseConfig(X(WRITABLE)),
      appName: "strad-staging",
      region: "nyc",
      image: IMAGE,
      env: [],
    });
    expect(spec.services.find((s) => s.name === "bundle")?.instance_count).toBe(
      1,
    );
  });

  it("refuses to render two instances of a component that writes back", () => {
    // A rotating credential has exactly ONE valid value at a time. Two replicas
    // do not merely race — each refresh invalidates the other's token at the
    // upstream, and there is no merge that recovers it. Refusing the topology
    // costs a render; allowing it costs an outage nobody can diagnose.
    const cfg = parseConfig(
      X(WRITABLE, "  - name: bundle\n    instanceCount: 2\n"),
    );
    expect(() =>
      renderAppSpec({
        config: cfg,
        appName: "strad-staging",
        region: "nyc",
        image: IMAGE,
        env: [],
      }),
    ).toThrow(/instance_count 2.*paramsWritable/s);
  });

  it("still allows two instances of a component that writes nothing back", () => {
    const cfg = parseConfig(
      X("    params: true\n", "  - name: bundle\n    instanceCount: 2\n"),
    );
    const spec = renderAppSpec({
      config: cfg,
      appName: "strad-staging",
      region: "nyc",
      image: IMAGE,
      env: [],
    });
    expect(spec.services.find((s) => s.name === "bundle")?.instance_count).toBe(
      2,
    );
  });

  it("ignores a disabled server's allowlist", () => {
    // A server strad does not mount writes nothing, so it constrains nothing.
    const cfg = parseConfig(
      X(
        `    enabled: false\n${WRITABLE}`,
        "  - name: bundle\n    instanceCount: 2\n",
      ),
    );
    expect(() =>
      renderAppSpec({
        config: cfg,
        appName: "strad-staging",
        region: "nyc",
        image: IMAGE,
        env: [],
      }),
    ).not.toThrow();
  });
});

describe("core's private URL on the components that call it", () => {
  it("is bound on a supplementary component", () => {
    // The FIRST bundle -> core direction in strad. Without this binding the
    // write-back has nowhere to go, and the failure would be a container that
    // boots clean and silently keeps a credential it can never persist.
    const spec = renderAppSpec({
      config: parseConfig(
        X("    params: true\n    paramsWritable: [X_OAUTH_REFRESH_TOKEN]\n"),
      ),
      appName: "strad-staging",
      region: "nyc",
      image: IMAGE,
      env: [],
    });
    const bundle = spec.services.find((s) => s.name === "bundle");
    expect(bundle?.envs).toContainEqual({
      key: CORE_URL_ENV,
      value: "${core.PRIVATE_URL}",
      scope: "RUN_TIME",
      type: "GENERAL",
    });
  });

  it("is bound on a builtin bundle too", () => {
    const spec = renderAppSpec({
      config: parseConfig(
        config(
          `  - slug: hello
    kind: builtin
    module: "./servers/echo.js"
    bundle: bundle
    entitlements: [admin]
`,
        ),
      ),
      appName: "strad-staging",
      region: "nyc",
      image: IMAGE,
      env: [],
    });
    expect(
      spec.services.find((s) => s.name === "bundle")?.envs.map((e) => e.key),
    ).toContain(CORE_URL_ENV);
  });

  it("is NOT on core, which would be a component pointing at itself", () => {
    const spec = renderAppSpec({
      config: parseConfig(X("    params: true\n")),
      appName: "strad-staging",
      region: "nyc",
      image: IMAGE,
      env: [],
    });
    expect(
      spec.services.find((s) => s.name === "core")?.envs.map((e) => e.key),
    ).not.toContain(CORE_URL_ENV);
  });
});
