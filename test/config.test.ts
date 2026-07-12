import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec, parseImage } from "../src/deploy/appspec.ts";
import { resolveRefs } from "../src/secrets/index.ts";

const BASE = `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
`;

describe("config validation", () => {
  it("accepts a config with zero servers — the shipped default", () => {
    const cfg = parseConfig(BASE);
    expect(cfg.servers).toEqual([]);
  });

  it("rejects a server granting an undefined role", () => {
    // Otherwise the entitlement check silently denies forever and the operator
    // has no idea why.
    expect(() =>
      parseConfig(`${BASE}
servers:
  - slug: a
    kind: remote-http
    url: https://example.com/mcp
    entitlements: [ghost]
`),
    ).toThrow(/unknown role "ghost"/);
  });

  it("rejects duplicate slugs", () => {
    expect(() =>
      parseConfig(`${BASE}
servers:
  - { slug: a, kind: remote-http, url: "https://e.com/mcp", entitlements: [admin] }
  - { slug: a, kind: remote-http, url: "https://e.com/mcp", entitlements: [admin] }
`),
    ).toThrow(/duplicate server slug: a/);
  });

  it("rejects two container images in one bundle — a component runs one image", () => {
    expect(() =>
      parseConfig(`${BASE}
bundles:
  - name: bundle-x
servers:
  - { slug: a, kind: supplementary-image, image: "ghcr.io/o/a:1", bundle: bundle-x, entitlements: [admin] }
  - { slug: b, kind: supplementary-image, image: "ghcr.io/o/b:1", bundle: bundle-x, entitlements: [admin] }
`),
    ).toThrow(/one component runs one image/);
  });

  it("rejects a supplementary image in the core bundle", () => {
    expect(() =>
      parseConfig(`${BASE}
servers:
  - { slug: a, kind: supplementary-image, image: "ghcr.io/o/a:1", bundle: core, entitlements: [admin] }
`),
    ).toThrow(/cannot live in the "core" bundle/);
  });

  it("rejects a bundle that is used but never declared", () => {
    expect(() =>
      parseConfig(`${BASE}
servers:
  - { slug: a, kind: builtin, module: "./servers/echo.js", bundle: bundle-ghost, entitlements: [admin] }
`),
    ).toThrow(/not declared under bundles/);
  });

  it("rejects a slug with an underscore — it would break tool namespacing", () => {
    expect(() =>
      parseConfig(`${BASE}
servers:
  - { slug: bad_slug, kind: remote-http, url: "https://e.com/mcp", entitlements: [admin] }
`),
    ).toThrow();
  });
});

describe("secret refs", () => {
  it("substitutes ${NAME}", () => {
    expect(resolveRefs("Bearer ${TOK}", { TOK: "abc" })).toBe("Bearer abc");
  });

  it("throws rather than shipping the literal placeholder as a credential", () => {
    expect(() => resolveRefs("Bearer ${MISSING}", {})).toThrow(
      /unresolved secret reference/,
    );
  });
});

describe("renderAppSpec", () => {
  const cfg = parseConfig(`${BASE}
bundles:
  - { name: bundle-api, instanceSizeSlug: apps-s-1vcpu-0.5gb }
  - { name: bundle-browser, instanceSizeSlug: apps-s-1vcpu-1gb }
servers:
  - { slug: local, kind: builtin, module: "./servers/echo.js", bundle: core, entitlements: [admin] }
  - { slug: bundled, kind: builtin, module: "./servers/echo.js", bundle: bundle-api, entitlements: [admin] }
  - { slug: eggs, kind: supplementary-image, image: "ghcr.io/tadasant/eggs:2", bundle: bundle-browser, entitlements: [admin] }
  - { slug: far, kind: remote-http, url: "https://e.com/mcp", entitlements: [admin] }
`);

  const spec = renderAppSpec({
    config: cfg,
    appName: "strad-staging",
    region: "nyc",
    image: parseImage("ghcr.io/tadasant/strad:0.1.0"),
    env: [],
  });

  it("creates a component per container-bearing bundle, and none for remote-http", () => {
    // `far` is someone else's server on the internet: no component.
    // `local` runs inside core: no component of its own.
    expect(spec.services.map((s) => s.name).sort()).toEqual([
      "bundle-api",
      "bundle-browser",
      "core",
    ]);
  });

  it("gives ONLY core a public route", () => {
    const core = spec.services.find((s) => s.name === "core")!;
    expect(core.http_port).toBe(8080);
    expect(core.internal_ports).toBeUndefined();

    for (const s of spec.services.filter((s) => s.name !== "core")) {
      // http_port is what mints the public route. Internal components must not
      // have one — and setting both to the same value is an API hard-reject.
      expect(s.http_port).toBeUndefined();
      expect(s.internal_ports).toEqual([8080]);
    }
  });

  it("binds each bundle's PRIVATE_URL into core", () => {
    const core = spec.services.find((s) => s.name === "core")!;
    const envs = Object.fromEntries(core.envs.map((e) => [e.key, e.value]));
    expect(envs.STRAD_BUNDLE_URL_BUNDLE_API).toBe("${bundle-api.PRIVATE_URL}");
    expect(envs.STRAD_BUNDLE_URL_BUNDLE_BROWSER).toBe(
      "${bundle-browser.PRIVATE_URL}",
    );
  });

  it("runs the strad image in bundle mode for a builtin bundle", () => {
    const b = spec.services.find((s) => s.name === "bundle-api")!;
    expect(b.image.repository).toBe("strad");
    const envs = Object.fromEntries(b.envs.map((e) => [e.key, e.value]));
    expect(envs.STRAD_MODE).toBe("bundle");
    expect(envs.STRAD_BUNDLE).toBe("bundle-api");
  });

  it("runs the supplementary image for an image bundle", () => {
    const b = spec.services.find((s) => s.name === "bundle-browser")!;
    expect(b.image).toEqual({
      registry_type: "GHCR",
      registry: "tadasant",
      repository: "eggs",
      tag: "2",
    });
    expect(b.instance_size_slug).toBe("apps-s-1vcpu-1gb");
  });

  it("never writes its own ingress rules — App Platform generates them", () => {
    expect(spec).not.toHaveProperty("ingress");
  });
});

describe("parseImage", () => {
  it("parses a ghcr ref", () => {
    expect(parseImage("ghcr.io/tadasant/strad:0.1.0")).toEqual({
      registry_type: "GHCR",
      registry: "tadasant",
      repository: "strad",
      tag: "0.1.0",
    });
  });

  it("defaults the tag to latest", () => {
    expect(parseImage("ghcr.io/tadasant/strad").tag).toBe("latest");
  });

  it("does not mistake a registry port for a tag", () => {
    expect(parseImage("localhost:5000/strad").tag).toBe("latest");
  });
});
