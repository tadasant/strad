import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec, type ImageRef } from "../src/deploy/appspec.ts";

/**
 * Deploying a BRANCH to staging means running the branch's own config against
 * the branch's own images. The core image was always a render-time argument;
 * the bundle image was not — it is written into the config, on 23
 * `image:` lines. `supplementaryImage` is the override that closes that gap.
 *
 * The property that matters here is not "it swaps the tag". It is that it
 * swaps the tag OR THROWS. A branch deploy that silently fell back to
 * `strad-bundle:latest` would deploy the branch's routes against main's bundle
 * — new paths 404 — and would look like a successful deploy while doing it.
 */

const CORE: ImageRef = {
  registry_type: "GHCR",
  registry: "tadasant",
  repository: "strad",
  tag: "branch-x",
};

const CONFIG = `
version: 1
gateway:
  name: strad
  env: staging
  publicUrl: https://staging.strad.tadasant.com
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: a
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /a
    entitlements: [admin]
  - slug: b
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /b
    entitlements: [admin]
`;

function render(supplementaryImage?: string) {
  return renderAppSpec({
    config: parseConfig(CONFIG),
    appName: "strad-staging",
    region: "nyc",
    image: CORE,
    env: [],
    supplementaryImage,
  });
}

const bundleOf = (spec: ReturnType<typeof render>) =>
  spec.services.find((s) => s.name === "bundle")!;

describe("supplementaryImage override", () => {
  it("leaves the config's image alone when not passed", () => {
    expect(bundleOf(render()).image.tag).toBe("latest");
  });

  it("repoints matching supplementary components at the branch tag", () => {
    const bundle = bundleOf(
      render("ghcr.io/tadasant/strad-bundle:branch-feature-abc123"),
    );
    expect(bundle.image).toEqual({
      registry_type: "GHCR",
      registry: "tadasant",
      repository: "strad-bundle",
      tag: "branch-feature-abc123",
    });
  });

  it("reports the branch tag as STRAD_VERSION, so telemetry names what is running", () => {
    const bundle = bundleOf(
      render("ghcr.io/tadasant/strad-bundle:branch-feature-abc123"),
    );
    const version = bundle.envs.find((e) => e.key === "STRAD_VERSION");
    expect(version?.value).toBe("branch-feature-abc123");
  });

  it("does not touch the core image, which has its own flag", () => {
    const spec = render("ghcr.io/tadasant/strad-bundle:branch-x");
    expect(spec.services.find((s) => s.name === "core")!.image).toEqual(CORE);
  });

  it("THROWS when it matches nothing, rather than silently deploying :latest", () => {
    expect(() => render("ghcr.io/tadasant/typo-bundle:branch-x")).toThrow(
      /matched no supplementary server/,
    );
  });

  it("THROWS on a tag-less ref, which parseImage would resolve to :latest", () => {
    expect(() => render("ghcr.io/tadasant/strad-bundle")).toThrow(
      /resolves to the tag "latest"/,
    );
  });

  it("THROWS on an explicit :latest, the exact thing the flag exists to avoid", () => {
    expect(() => render("ghcr.io/tadasant/strad-bundle:latest")).toThrow(
      /resolves to the tag "latest"/,
    );
  });

  it("leaves a DIFFERENT supplementary repository on its configured tag", () => {
    // The override is repository-scoped. A second supplementary image keeps the
    // tag its config names — a branch build produces ONE bundle image, so there
    // is nothing branch-scoped to give it.
    const config = parseConfig(`
version: 1
gateway: { name: strad, env: staging }
auth: { staticTokens: { enabled: true, store: env } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
  - name: other
servers:
  - slug: a
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /a
    entitlements: [admin]
  - slug: z
    kind: supplementary-image
    image: ghcr.io/tadasant/some-other:v9
    bundle: other
    path: /z
    entitlements: [admin]
`);
    const spec = renderAppSpec({
      config,
      appName: "strad-staging",
      region: "nyc",
      image: CORE,
      env: [],
      supplementaryImage: "ghcr.io/tadasant/strad-bundle:branch-x",
    });
    expect(spec.services.find((s) => s.name === "bundle")!.image.tag).toBe(
      "branch-x",
    );
    expect(spec.services.find((s) => s.name === "other")!.image).toEqual({
      registry_type: "GHCR",
      registry: "tadasant",
      repository: "some-other",
      tag: "v9",
    });
  });

  it("matches a DOCR ref, where ImageRef carries no registry field", () => {
    // parseImage omits `registry` entirely for DOCR, so sameRepository compares
    // undefined against undefined. Left unnormalised that is still equal — but
    // this pins the behaviour rather than assuming it.
    const config = parseConfig(`
version: 1
gateway: { name: strad, env: staging }
auth: { staticTokens: { enabled: true, store: env } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
servers:
  - slug: a
    kind: supplementary-image
    image: registry.digitalocean.com/strad/strad-bundle:v1
    bundle: bundle
    path: /a
    entitlements: [admin]
`);
    const spec = renderAppSpec({
      config,
      appName: "strad-staging",
      region: "nyc",
      image: CORE,
      env: [],
      supplementaryImage:
        "registry.digitalocean.com/strad/strad-bundle:branch-x",
    });
    expect(spec.services.find((s) => s.name === "bundle")!.image).toEqual({
      registry_type: "DOCR",
      repository: "strad-bundle",
      tag: "branch-x",
    });
  });
});

describe("the real staging config", () => {
  it("is fully repointed by a single --bundle-image", () => {
    const config = parseConfig(
      readFileSync(
        new URL("../infra/strad.staging.yaml", import.meta.url),
        "utf8",
      ),
      "infra/strad.staging.yaml",
    );
    const secrets = Object.fromEntries(
      config.servers.flatMap((s) =>
        s.kind === "supplementary-image" && s.enabled
          ? Object.values(s.env).flatMap((v) =>
              [...v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
                (m) => [m[1]!, "x"] as const,
              ),
            )
          : [],
      ),
    );
    const spec = renderAppSpec({
      config,
      appName: "strad-staging",
      region: "nyc",
      image: CORE,
      env: [],
      secrets,
      supplementaryImage: "ghcr.io/tadasant/strad-bundle:branch-x",
    });
    // Still exactly two components — the count this repo cares most about, and
    // the one a bundle-image change could silently split.
    expect(spec.services.map((s) => s.name)).toEqual(["core", "bundle"]);
    // Nothing anywhere in the rendered spec still points at the bundle's
    // `:latest` — that is the whole "no config edit needed" claim.
    const images = spec.services.map(
      (s) => `${s.image.repository}:${s.image.tag}`,
    );
    expect(images).not.toContain("strad-bundle:latest");
    expect(images).toContain("strad-bundle:branch-x");
  });
});
