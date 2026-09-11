import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec, type ImageRef } from "../src/deploy/appspec.ts";

/**
 * Deploying a BRANCH to staging means running the branch's own config against
 * the branch's own images. The core image was always a render-time argument;
 * the bundle image was not — it is written into the config, on 24
 * `image:` lines. `supplementaryImages` is the override that closes that gap.
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

function render(...supplementaryImages: string[]) {
  return renderAppSpec({
    config: parseConfig(CONFIG),
    appName: "strad-staging",
    region: "nyc",
    image: CORE,
    env: [],
    supplementaryImages,
  });
}

const bundleOf = (spec: ReturnType<typeof render>) =>
  spec.services.find((s) => s.name === "bundle")!;

describe("supplementaryImages override", () => {
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
      supplementaryImages: ["ghcr.io/tadasant/strad-bundle:branch-x"],
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
      supplementaryImages: [
        "registry.digitalocean.com/strad/strad-bundle:branch-x",
      ],
    });
    expect(spec.services.find((s) => s.name === "bundle")!.image).toEqual({
      registry_type: "DOCR",
      repository: "strad-bundle",
      tag: "branch-x",
    });
  });
});

/**
 * TWO first-party images in one config, which is what prod became when the
 * `craigslist` slug arrived on `ghcr.io/tadasant/strad-bundle-internal`
 * alongside `ghcr.io/tadasant/strad-bundle`. A single-valued override could pin
 * one of them, so the other was pinned BY HAND in the production config — and a
 * hand-written sha does not move when a new image publishes. The deploy stays
 * green and prod runs the previous code, which is the same class of silent
 * wrong-version failure the override exists to end.
 *
 * The property under test is therefore not "two overrides both apply". It is
 * that adding the second one cannot make the first one's failure quiet.
 */
const TWO_REPOSITORIES = `
version: 1
gateway:
  name: strad
  env: prod
  publicUrl: https://strad.tadasant.com
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
  - name: bundle-internal
servers:
  - slug: a
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /a
    entitlements: [admin]
  - slug: craigslist
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle-internal:latest
    bundle: bundle-internal
    path: /craigslist
    entitlements: [admin]
`;

describe("more than one repository in one render", () => {
  const renderTwo = (...supplementaryImages: string[]) =>
    renderAppSpec({
      config: parseConfig(TWO_REPOSITORIES),
      appName: "strad-prod",
      region: "nyc",
      image: CORE,
      env: [],
      supplementaryImages,
    });

  const tags = (spec: ReturnType<typeof renderTwo>) =>
    Object.fromEntries(spec.services.map((s) => [s.name, s.image.tag]));

  it("pins BOTH images when both are named", () => {
    expect(
      tags(
        renderTwo(
          "ghcr.io/tadasant/strad-bundle:sha-aaa",
          "ghcr.io/tadasant/strad-bundle-internal:sha-bbb",
        ),
      ),
    ).toEqual({
      core: "branch-x",
      bundle: "sha-aaa",
      "bundle-internal": "sha-bbb",
    });
  });

  it("applies them by repository, not by the order they were passed", () => {
    expect(
      tags(
        renderTwo(
          "ghcr.io/tadasant/strad-bundle-internal:sha-bbb",
          "ghcr.io/tadasant/strad-bundle:sha-aaa",
        ),
      ),
    ).toEqual({
      core: "branch-x",
      bundle: "sha-aaa",
      "bundle-internal": "sha-bbb",
    });
  });

  it("leaves the second image on the config's tag when only the first is named", () => {
    // One override, one repository pinned, the other on whatever the config
    // says. Rendering it is fine; what must not happen is the deploy's
    // immutability gate being satisfied by it, which
    // `test/render-spec.images.test.ts` asserts end to end.
    expect(tags(renderTwo("ghcr.io/tadasant/strad-bundle:sha-aaa"))).toEqual({
      core: "branch-x",
      bundle: "sha-aaa",
      "bundle-internal": "latest",
    });
  });

  it("THROWS on an override that matches nothing EVEN WHEN A SIBLING MATCHED", () => {
    // THE most important assertion in this file. If a matched sibling could
    // satisfy the check, the silent-stale-pin failure would simply move from
    // the config into the flag: the override for a renamed or disabled
    // repository would stop applying, nothing would say so, and the component
    // would ship the config's tag under a deploy that believed it had pinned it.
    expect(() =>
      renderTwo(
        "ghcr.io/tadasant/strad-bundle:sha-aaa",
        "ghcr.io/tadasant/typo-bundle:sha-bbb",
      ),
    ).toThrow(/matched no supplementary server/);
    // And names the one that failed, not the pair.
    expect(() =>
      renderTwo(
        "ghcr.io/tadasant/strad-bundle:sha-aaa",
        "ghcr.io/tadasant/typo-bundle:sha-bbb",
      ),
    ).toThrow(/"ghcr.io\/tadasant\/typo-bundle:sha-bbb"/);
  });

  it("names EVERY unmatched override, so a second typo is not a second deploy", () => {
    let message = "";
    try {
      renderTwo(
        "ghcr.io/tadasant/typo-one:sha-aaa",
        "ghcr.io/tadasant/typo-two:sha-bbb",
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/typo-one:sha-aaa/);
    expect(message).toMatch(/typo-two:sha-bbb/);
  });

  it("still rejects a mutable tag when it arrives as the second override", () => {
    expect(() =>
      renderTwo(
        "ghcr.io/tadasant/strad-bundle:sha-aaa",
        "ghcr.io/tadasant/strad-bundle-internal:latest",
      ),
    ).toThrow(/resolves to the tag "latest"/);
    // Tag-less, the shape parseImage silently resolves to :latest.
    expect(() =>
      renderTwo(
        "ghcr.io/tadasant/strad-bundle:sha-aaa",
        "ghcr.io/tadasant/strad-bundle-internal",
      ),
    ).toThrow(/resolves to the tag "latest"/);
  });

  it("THROWS on an override naming the CORE's repository, which has its own flag", () => {
    // Core and builtin components are never overridden, so this matches nothing
    // — and must say so rather than quietly repointing the gateway.
    expect(() =>
      renderTwo(
        "ghcr.io/tadasant/strad-bundle:sha-aaa",
        "ghcr.io/tadasant/strad:sha-ddd",
      ),
    ).toThrow(
      /"ghcr.io\/tadasant\/strad:sha-ddd" matched no supplementary server/,
    );
  });

  it("THROWS when the only slug on an override's repository is disabled", () => {
    // The coupling this rule creates, pinned: turning off the last slug on a
    // repository means dropping its override in the same change, or the render
    // fails. That is the point — the alternative is a deploy that believes it
    // pinned an image nothing runs.
    const config = parseConfig(
      TWO_REPOSITORIES.replace(
        "    bundle: bundle-internal\n",
        "    bundle: bundle-internal\n    enabled: false\n",
      ),
    );
    expect(() =>
      renderAppSpec({
        config,
        appName: "strad-prod",
        region: "nyc",
        image: CORE,
        env: [],
        supplementaryImages: [
          "ghcr.io/tadasant/strad-bundle:sha-aaa",
          "ghcr.io/tadasant/strad-bundle-internal:sha-bbb",
        ],
      }),
    ).toThrow(/strad-bundle-internal:sha-bbb" matched no supplementary server/);
  });

  it("THROWS on an empty entry, naming it as empty rather than as :latest", () => {
    expect(() =>
      renderTwo("ghcr.io/tadasant/strad-bundle:sha-aaa", ""),
    ).toThrow(/holds an empty entry/);
  });

  it("THROWS on two overrides naming one repository, rather than picking one", () => {
    expect(() =>
      renderTwo(
        "ghcr.io/tadasant/strad-bundle:sha-aaa",
        "ghcr.io/tadasant/strad-bundle:sha-ccc",
        "ghcr.io/tadasant/strad-bundle-internal:sha-bbb",
      ),
    ).toThrow(/name the same repository/);
  });

  it("reports each component's own tag as STRAD_VERSION", () => {
    // Telemetry names what is running, per container. With one image these were
    // always equal; with two, a shared value would mislabel one of them.
    const spec = renderTwo(
      "ghcr.io/tadasant/strad-bundle:sha-aaa",
      "ghcr.io/tadasant/strad-bundle-internal:sha-bbb",
    );
    const version = (name: string) =>
      spec.services
        .find((s) => s.name === name)!
        .envs.find((e) => e.key === "STRAD_VERSION")?.value;
    expect(version("bundle")).toBe("sha-aaa");
    expect(version("bundle-internal")).toBe("sha-bbb");
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
          ? // Both maps, exactly as scripts/render-spec.ts collects them:
            // `consoleEnv:` refs resolve from the SAME bag (onto core only).
            [...Object.values(s.env), ...Object.values(s.consoleEnv)].flatMap(
              (v) =>
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
      supplementaryImages: ["ghcr.io/tadasant/strad-bundle:branch-x"],
    });
    // Still exactly three components — the count this repo cares most about, and
    // the one a bundle-image change could silently split.
    expect(spec.services.map((s) => s.name)).toEqual([
      "core",
      "bundle",
      "bundle-zimmer-secrets",
    ]);
    // Nothing anywhere in the rendered spec still points at the bundle's
    // `:latest` — that is the whole "no config edit needed" claim. Note that
    // covers BOTH bundles: the override is repository-scoped, and both run the
    // same bundle image, so a branch deploy must move them together or the
    // second store would answer from `:latest` while the first ran the branch.
    const images = spec.services.map(
      (s) => `${s.image.repository}:${s.image.tag}`,
    );
    expect(images).not.toContain("strad-bundle:latest");
    expect(images.filter((i) => i === "strad-bundle:branch-x")).toHaveLength(2);
  });
});
