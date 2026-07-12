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

  it("rejects two DISTINCT container images in one bundle — a component runs one image", () => {
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

  it("accepts many supplementary servers sharing ONE image in one bundle", () => {
    // bundle-api hosts a fleet of pure-API servers from a single image, each on
    // its own path. Same image, many servers is exactly what must be allowed.
    const cfg = parseConfig(`${BASE}
bundles:
  - name: bundle-api
servers:
  - { slug: a, kind: supplementary-image, image: "ghcr.io/o/bundle:1", bundle: bundle-api, path: /a, entitlements: [admin] }
  - { slug: b, kind: supplementary-image, image: "ghcr.io/o/bundle:1", bundle: bundle-api, path: /b, entitlements: [admin] }
  - { slug: c, kind: supplementary-image, image: "ghcr.io/o/bundle:1", bundle: bundle-api, path: /c, entitlements: [admin] }
`);
    expect(cfg.servers.map((s) => s.slug)).toEqual(["a", "b", "c"]);
  });

  it("rejects a supplementary image sharing a bundle with a builtin", () => {
    // A supplementary image owns its component; a builtin needs the strad image,
    // and one component runs one image.
  it("accepts several servers sharing ONE image on distinct paths (bundle-google)", () => {
    const cfg = parseConfig(`${BASE}
bundles:
  - name: bundle-google
servers:
  - { slug: gmail, kind: supplementary-image, image: "ghcr.io/tadasant/strad-server-bundle-google:latest", bundle: bundle-google, path: /gmail, entitlements: [admin] }
  - { slug: gcal, kind: supplementary-image, image: "ghcr.io/tadasant/strad-server-bundle-google:latest", bundle: bundle-google, path: /google-calendar, entitlements: [admin] }
  - { slug: gdocs, kind: supplementary-image, image: "ghcr.io/tadasant/strad-server-bundle-google:latest", bundle: bundle-google, path: /google-docs, entitlements: [admin] }
`);
    expect(cfg.servers.map((s) => s.slug)).toEqual(["gmail", "gcal", "gdocs"]);
  });

  it("rejects two servers of one image on the SAME path — the gateway can't tell them apart", () => {
    expect(() =>
      parseConfig(`${BASE}
bundles:
  - name: bundle-google
servers:
  - { slug: gmail, kind: supplementary-image, image: "ghcr.io/o/g:1", bundle: bundle-google, path: /mcp, entitlements: [admin] }
  - { slug: gcal, kind: supplementary-image, image: "ghcr.io/o/g:1", bundle: bundle-google, path: /mcp, entitlements: [admin] }
`),
    ).toThrow(/distinct path/);
  });

  it("rejects mixing a supplementary image with a builtin in one bundle", () => {
    expect(() =>
      parseConfig(`${BASE}
bundles:
  - name: bundle-x
servers:
  - { slug: a, kind: supplementary-image, image: "ghcr.io/o/a:1", bundle: bundle-x, entitlements: [admin] }
  - { slug: b, kind: builtin, module: "./servers/echo.js", bundle: bundle-x, entitlements: [admin] }
`),
    ).toThrow(/mixes a supplementary image/);
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

describe("renderAppSpec — bundle-api (many servers, one image)", () => {
  const cfg = parseConfig(`${BASE}
bundles:
  - { name: bundle-api, instanceSizeSlug: apps-s-1vcpu-0.5gb }
servers:
  - { slug: slack, kind: supplementary-image, image: "ghcr.io/tadasant/strad-bundle-api:latest", bundle: bundle-api, path: /slack, entitlements: [admin], env: { SLACK_BOT_TOKEN: "\${SLACK_BOT_TOKEN}" } }
  - { slug: tailscale, kind: supplementary-image, image: "ghcr.io/tadasant/strad-bundle-api:latest", bundle: bundle-api, path: /tailscale, entitlements: [admin], env: { TAILSCALE_API_KEY: "\${TAILSCALE_API_KEY}" } }
  - { slug: google-flights, kind: supplementary-image, image: "ghcr.io/tadasant/strad-bundle-api:latest", bundle: bundle-api, path: /google-flights, entitlements: [admin] }
describe("renderAppSpec — one image, several servers (bundle-google)", () => {
  const cfg = parseConfig(`${BASE}
bundles:
  - { name: bundle-google, instanceSizeSlug: apps-s-1vcpu-1gb }
servers:
  - { slug: gmail, kind: supplementary-image, image: "ghcr.io/tadasant/strad-server-bundle-google:latest", bundle: bundle-google, path: /gmail, entitlements: [admin], env: { GMAIL_IMPERSONATE_EMAIL: "\${GMAIL_IMPERSONATE_EMAIL}" } }
  - { slug: gcal, kind: supplementary-image, image: "ghcr.io/tadasant/strad-server-bundle-google:latest", bundle: bundle-google, path: /google-calendar, entitlements: [admin], env: { GCAL_IMPERSONATE_EMAIL: "\${GCAL_IMPERSONATE_EMAIL}" } }
  - { slug: gdocs, kind: supplementary-image, image: "ghcr.io/tadasant/strad-server-bundle-google:latest", bundle: bundle-google, path: /google-docs, entitlements: [admin], env: { GOOGLE_DOCS_IMPERSONATE_EMAIL: "\${GOOGLE_DOCS_IMPERSONATE_EMAIL}" } }
`);

  const spec = renderAppSpec({
    config: cfg,
    appName: "strad-staging",
    region: "nyc",
    image: parseImage("ghcr.io/tadasant/strad:0.1.0"),
    env: [],
    // Supplementary env `${NAME}` refs resolve against the secrets bag (or throw
    // — see resolveMap). render-spec supplies these from the environment; a unit
    // test must supply them too.
    secrets: {
      SLACK_BOT_TOKEN: "xoxb-test-slack",
      TAILSCALE_API_KEY: "tskey-test-tailscale",
    },
  });

  it("renders exactly ONE internal component for the shared-image bundle", () => {
    expect(spec.services.map((s) => s.name).sort()).toEqual([
      "bundle-api",
      "core",
    ]);
    const b = spec.services.find((s) => s.name === "bundle-api")!;
    expect(b.http_port).toBeUndefined();
    expect(b.internal_ports).toEqual([8080]);
    expect(b.instance_size_slug).toBe("apps-s-1vcpu-0.5gb");
  });

  it("runs the one shared image, not the strad image", () => {
    const b = spec.services.find((s) => s.name === "bundle-api")!;
    expect(b.image).toEqual({
      registry_type: "GHCR",
      registry: "tadasant",
      repository: "strad-bundle-api",
      tag: "latest",
    });
  });

  it("unions every server's env onto the one component", () => {
    const b = spec.services.find((s) => s.name === "bundle-api")!;
    const envs = Object.fromEntries(b.envs.map((e) => [e.key, e.value]));
    // The literal ref resolves to the secret value; it must NOT survive verbatim.
    expect(envs.SLACK_BOT_TOKEN).toBe("xoxb-test-slack");
    expect(envs.TAILSCALE_API_KEY).toBe("tskey-test-tailscale");
    for (const e of b.envs.filter((e) =>
      ["SLACK_BOT_TOKEN", "TAILSCALE_API_KEY"].includes(e.key),
    )) {
      expect(e.type).toBe("SECRET");
    }
  });

  it("binds the bundle-api PRIVATE_URL into core", () => {
    const core = spec.services.find((s) => s.name === "core")!;
    const envs = Object.fromEntries(core.envs.map((e) => [e.key, e.value]));
    expect(envs.STRAD_BUNDLE_URL_BUNDLE_API).toBe("${bundle-api.PRIVATE_URL}");
  });

  it("collapses the three servers into ONE internal component", () => {
    expect(spec.services.map((s) => s.name).sort()).toEqual([
      "bundle-google",
      "core",
    ]);
    const b = spec.services.find((s) => s.name === "bundle-google")!;
    expect(b.http_port).toBeUndefined();
    expect(b.internal_ports).toEqual([8080]);
    expect(b.image.repository).toBe("strad-server-bundle-google");
  });

  it("unions the env of every server sharing the image", () => {
    const b = spec.services.find((s) => s.name === "bundle-google")!;
    const envs = Object.fromEntries(b.envs.map((e) => [e.key, e.value]));
    // All three servers' env vars land on the single component.
    expect(envs.GMAIL_IMPERSONATE_EMAIL).toBe("${GMAIL_IMPERSONATE_EMAIL}");
    expect(envs.GCAL_IMPERSONATE_EMAIL).toBe("${GCAL_IMPERSONATE_EMAIL}");
    expect(envs.GOOGLE_DOCS_IMPERSONATE_EMAIL).toBe(
      "${GOOGLE_DOCS_IMPERSONATE_EMAIL}",
    );
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
