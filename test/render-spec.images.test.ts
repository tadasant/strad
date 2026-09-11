import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The core image has been pinned to a tag that names one commit since #60.
 * The BUNDLE was not, and on 2026-07-31 that cost a week of a dead `secrets`
 * slug on both environments: `strad-bundle:latest` is written into every
 * `supplementary-image` entry, that block is byte-identical on every deploy, and
 * App Platform went on serving the digest it had resolved for the tag once — an
 * image from before the `/secrets` mount existed. `/healthz` stayed 200 and
 * `?servers=secrets` answered `{"tools":[]}`.
 *
 * These tests drive the real `scripts/render-spec.ts`, because the property is
 * about the SPEC that reaches App Platform, not about any function's return
 * value. Two halves:
 *
 *   - `--bundle-image` puts an immutable tag on every component that shares the
 *     bundle repository, which is what makes the spec change and the platform
 *     pull.
 *   - `--require-immutable-images` refuses to emit a spec that still ships a
 *     tag which moves. Both deploys pass it. Without the flag the same finding
 *     is a warning, for a render that has no commit tag to name — see
 *     HACKS.md #32.
 */

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
  - name: bundle-zimmer-secrets
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
  - slug: zimmer-secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-zimmer-secrets
    path: /secrets
    entitlements: [admin]
`;

const CORE = `ghcr.io/tadasant/strad:sha-${"a".repeat(40)}`;
const BUNDLE = `ghcr.io/tadasant/strad-bundle:sha-${"b".repeat(40)}`;

interface Rendered {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * `spawnSync`, not `execFileSync`: the warning path EXITS ZERO and says its
 * piece on stderr, and execFileSync hands back stderr only when the child
 * failed. A helper that could not see a successful run's stderr would make the
 * warning assertion below untestable — which is the assertion prod depends on.
 */
function render(args: string[], config: string = CONFIG): Rendered {
  const dir = mkdtempSync(join(tmpdir(), "strad-images-"));
  const cfg = join(dir, "cfg.yaml");
  writeFileSync(cfg, config);
  const out = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "scripts/render-spec.ts",
      "--config",
      cfg,
      "--image",
      CORE,
      "--app",
      "strad-staging",
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        STRAD_TOKENS: "[]",
        STRAD_INTERNAL_TOKEN: "internal",
      },
    },
  );
  return { stdout: out.stdout, stderr: out.stderr, status: out.status ?? 1 };
}

const tagsOf = (out: string): Record<string, string> =>
  Object.fromEntries(
    (
      JSON.parse(out) as {
        services: { name: string; image?: { tag?: string } }[];
      }
    ).services.map((s) => [s.name, s.image?.tag ?? "<none>"]),
  );

describe("render-spec, the bundle's tag", () => {
  it("puts the resolved commit tag on BOTH bundle components", () => {
    // Two components, one image, one override. `bundle-zimmer-secrets` was dead
    // in exactly the same way and for exactly the same reason, on a container of
    // its own — so a fix that only reached `bundle` would have left half of it.
    const out = render(["--bundle-image", BUNDLE]);
    expect(out.status).toBe(0);
    expect(tagsOf(out.stdout)).toEqual({
      core: `sha-${"a".repeat(40)}`,
      bundle: `sha-${"b".repeat(40)}`,
      "bundle-zimmer-secrets": `sha-${"b".repeat(40)}`,
    });
  });

  it("REFUSES to render `latest` under --require-immutable-images", () => {
    const out = render(["--require-immutable-images"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/2 component\(s\) would ship a mutable tag/);
    // Both components named, so the operator does not fix one and redeploy.
    expect(out.stderr).toMatch(/bundle -> tadasant\/strad-bundle:latest/);
    expect(out.stderr).toMatch(
      /bundle-zimmer-secrets -> tadasant\/strad-bundle:latest/,
    );
    // And says what to pass, or the operator is stuck reading source.
    expect(out.stderr).toMatch(/--bundle-image/);
  });

  it("accepts the same config once --bundle-image names a commit", () => {
    const out = render([
      "--bundle-image",
      BUNDLE,
      "--require-immutable-images",
    ]);
    expect(out.status).toBe(0);
    expect(out.stderr).not.toMatch(/mutable tag/);
  });

  it("WARNS, and still renders, without the flag", () => {
    // A render with no commit tag to name — local, or a config under
    // construction — cannot fix the tag it is warned about, and failing it would
    // gate nothing. Saying nothing is how this lasted a week. So: warn, name
    // every component, and emit the spec. The deploys pass the gate.
    const out = render([]);
    expect(out.status).toBe(0);
    expect(out.stderr).toMatch(
      /::warning::2 component\(s\) ship a mutable tag/,
    );
    expect(tagsOf(out.stdout).bundle).toBe("latest");
  });

  it("says nothing about images when every component names a build", () => {
    const out = render(["--bundle-image", BUNDLE]);
    expect(out.stderr).not.toMatch(/mutable tag/);
  });
});

/**
 * The fixture the flag was made repeatable for: ONE config, TWO first-party
 * image repositories. Prod became this the day the `craigslist` slug landed on
 * `ghcr.io/tadasant/strad-bundle-internal`, and `--require-immutable-images`
 * refuses a spec in which ANY component ships a moving tag — so with a
 * single-valued override the only way through was a sha written into the
 * production config by hand, which nothing moves when a new image publishes.
 * These two tests are the before and the after of exactly that.
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
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
  - slug: craigslist
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle-internal:latest
    bundle: bundle-internal
    path: /craigslist
    entitlements: [admin]
`;

const INTERNAL = `ghcr.io/tadasant/strad-bundle-internal:sha-${"c".repeat(40)}`;

describe("render-spec, a config naming two first-party images", () => {
  it("BEFORE: one --bundle-image cannot satisfy --require-immutable-images", () => {
    const out = render(
      ["--bundle-image", BUNDLE, "--require-immutable-images"],
      TWO_REPOSITORIES,
    );
    expect(out.status).toBe(1);
    // One component left, and it is named — the second repository, still on the
    // tag the config gave it because nothing could rewrite it at render time.
    expect(out.stderr).toMatch(/1 component\(s\) would ship a mutable tag/);
    expect(out.stderr).toMatch(
      /bundle-internal -> tadasant\/strad-bundle-internal:latest/,
    );
  });

  it("AFTER: two --bundle-image occurrences pin both, in one render", () => {
    const out = render(
      [
        "--bundle-image",
        BUNDLE,
        "--bundle-image",
        INTERNAL,
        "--require-immutable-images",
      ],
      TWO_REPOSITORIES,
    );
    expect(out.status).toBe(0);
    expect(out.stderr).not.toMatch(/mutable tag/);
    expect(tagsOf(out.stdout)).toEqual({
      core: `sha-${"a".repeat(40)}`,
      bundle: `sha-${"b".repeat(40)}`,
      "bundle-internal": `sha-${"c".repeat(40)}`,
    });
  });

  it("refuses a second override that matches nothing, though the first did", () => {
    const out = render(
      [
        "--bundle-image",
        BUNDLE,
        "--bundle-image",
        `ghcr.io/tadasant/strad-bundle-intrenal:sha-${"c".repeat(40)}`,
      ],
      TWO_REPOSITORIES,
    );
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/matched no supplementary server/);
    expect(out.stderr).toMatch(/strad-bundle-intrenal/);
  });
});

describe("--bundle-image, the single-occurrence contract prod deploys on", () => {
  /**
   * .github/workflows/strad-deploy-prod.yml, in tadasant-internal, checks out
   * THIS repo at `main` and runs THIS script — so a change to how one
   * occurrence parses reaches production on merge, not on a release. Two things
   * that workflow depends on, pinned here.
   */
  it("still parses and applies a lone occurrence exactly as before", () => {
    const out = render([
      "--bundle-image",
      BUNDLE,
      "--require-immutable-images",
    ]);
    expect(out.status).toBe(0);
    expect(tagsOf(out.stdout)).toEqual({
      core: `sha-${"a".repeat(40)}`,
      bundle: `sha-${"b".repeat(40)}`,
      "bundle-zimmer-secrets": `sha-${"b".repeat(40)}`,
    });
  });

  it("still prints `usage: render-spec`, the string the deploy probes for", () => {
    // The prod workflow decides whether the checked-out tooling is capable by
    // running `render-spec.ts --require-immutable-images </dev/null` and
    // matching the literal `usage: render-spec`. Change that string and the
    // deploy hard-fails with "the tooling is too old", which it is not.
    const out = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "scripts/render-spec.ts",
        "--require-immutable-images",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(out.stderr).toContain("usage: render-spec");
  });

  it("names the empty argument when a resolve step hands it one", () => {
    // `--bundle-image ""` is a step whose output never got set. Read as "no
    // flag passed", it would fail a layer down naming the config's tag instead,
    // or — without the gate — deploy that tag in silence.
    const out = render(["--bundle-image", ""]);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/--bundle-image was passed an empty value/);
  });
});
