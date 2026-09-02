import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { assertDeployableSpec } from "../src/deploy/spec-file.ts";
import {
  APP_INSTANCE_SIZES,
  LEGACY_APP_INSTANCE_SIZES,
  assertKnownInstanceSizes,
  isKnownInstanceSize,
  isLegacyInstanceSize,
  legacyInstanceSizes,
  unknownInstanceSizes,
} from "../src/deploy/instance-size.ts";

const BASE = `
version: 1
gateway: { name: strad, env: prod }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
`;

/** A bundle carrying a server, so it renders a component. */
function withBundleSize(slug: string): string {
  return `${BASE}
bundles:
  - { name: bundle-api, instanceSizeSlug: ${slug} }
servers:
  - { slug: bundled, kind: builtin, module: "./servers/echo.js", bundle: bundle-api, entitlements: [admin] }
`;
}

describe("the accepted plan list", () => {
  // The lists are transcribed from DigitalOcean's pricing page, and the prose in
  // servers/interface.md, HACKS.md #75 and limitations.md #75 all say "fourteen"
  // and "ten". Counts are load-bearing in this repo, and a test that only
  // iterates the array under test would let one silently go missing.
  it("is 14 current plans and 10 legacy ones", () => {
    expect(APP_INSTANCE_SIZES).toHaveLength(14);
    expect(LEGACY_APP_INSTANCE_SIZES).toHaveLength(10);
  });

  it("is exactly the pricing page's two tables", () => {
    expect([...APP_INSTANCE_SIZES]).toEqual([
      "apps-s-1vcpu-0.5gb",
      "apps-s-1vcpu-1gb-fixed",
      "apps-s-1vcpu-1gb",
      "apps-s-1vcpu-2gb",
      "apps-s-2vcpu-4gb",
      "apps-d-1vcpu-0.5gb",
      "apps-d-1vcpu-1gb",
      "apps-d-1vcpu-2gb",
      "apps-d-1vcpu-4gb",
      "apps-d-2vcpu-4gb",
      "apps-d-2vcpu-8gb",
      "apps-d-4vcpu-8gb",
      "apps-d-4vcpu-16gb",
      "apps-d-8vcpu-32gb",
    ]);
    expect([...LEGACY_APP_INSTANCE_SIZES]).toEqual([
      "basic-xxs",
      "basic-xs",
      "basic-s",
      "basic-m",
      "professional-xs",
      "professional-s",
      "professional-m",
      "professional-1l",
      "professional-l",
      "professional-xl",
    ]);
  });

  it("has no slug in both lists", () => {
    const overlap = APP_INSTANCE_SIZES.filter((s: string) =>
      (LEGACY_APP_INSTANCE_SIZES as readonly string[]).includes(s),
    );
    expect(overlap).toEqual([]);
  });

  it("splits current from legacy, and knows neither covers a made-up name", () => {
    for (const slug of LEGACY_APP_INSTANCE_SIZES) {
      expect(isLegacyInstanceSize(slug)).toBe(true);
      expect(isKnownInstanceSize(slug)).toBe(true);
    }
    for (const slug of APP_INSTANCE_SIZES) {
      expect(isLegacyInstanceSize(slug)).toBe(false);
      expect(isKnownInstanceSize(slug)).toBe(true);
    }
    expect(isKnownInstanceSize("apps-s-1vcpu-512mb")).toBe(false);
    expect(isLegacyInstanceSize("apps-s-1vcpu-512mb")).toBe(false);
    expect(isKnownInstanceSize("")).toBe(false);
  });
});

describe("unknownInstanceSizes", () => {
  it("finds apps-s-1vcpu-512mb — the name that took prod deploys down", () => {
    // It reads like a real name and is not one: the 512 MiB plan is
    // `apps-s-1vcpu-0.5gb`. The config schema accepts any string, so this is the
    // first thing between such a value and `doctl apps update`.
    const bad = unknownInstanceSizes(
      parseConfig(withBundleSize("apps-s-1vcpu-512mb")),
    );
    expect(bad).toEqual([{ bundle: "bundle-api", slug: "apps-s-1vcpu-512mb" }]);
  });

  it("catches a bundle that carries no server, and so renders no component", () => {
    // The deferred half of the failure. A declared-but-empty bundle is never
    // sent to DigitalOcean at all, so a render-only check would stay silent
    // until some later change placed a server on it — weeks after the merge.
    const cfg = parseConfig(`${BASE}
bundles:
  - { name: bundle-empty, instanceSizeSlug: apps-s-1vcpu-512mb }
`);
    expect(unknownInstanceSizes(cfg)).toEqual([
      { bundle: "bundle-empty", slug: "apps-s-1vcpu-512mb" },
    ]);
  });

  it("reports every bad bundle, not just the first", () => {
    const cfg = parseConfig(`${BASE}
bundles:
  - { name: bundle-a, instanceSizeSlug: apps-s-1vcpu-512mb }
  - { name: bundle-b, instanceSizeSlug: apps-s-1vcpu-2gb }
  - { name: bundle-c, instanceSizeSlug: professional-xxl }
`);
    expect(unknownInstanceSizes(cfg).map((b) => b.bundle)).toEqual([
      "bundle-a",
      "bundle-c",
    ]);
  });

  it.each(APP_INSTANCE_SIZES)("accepts the current plan %s", (slug: string) => {
    expect(unknownInstanceSizes(parseConfig(withBundleSize(slug)))).toEqual([]);
  });

  it.each(LEGACY_APP_INSTANCE_SIZES)(
    "accepts the legacy plan %s",
    (slug: string) => {
      // A legacy name is a name DigitalOcean has, on an app old enough to use
      // it. Refusing one would make a valid config for such an app
      // undeployable; it is reported as a warning instead.
      expect(unknownInstanceSizes(parseConfig(withBundleSize(slug)))).toEqual(
        [],
      );
      expect(legacyInstanceSizes(parseConfig(withBundleSize(slug)))).toEqual([
        { bundle: "bundle-api", slug },
      ]);
    },
  );

  it("accepts apps-s-1vcpu-0.5gb — the live strad-prod bundle-internal size", () => {
    const cfg = parseConfig(withBundleSize("apps-s-1vcpu-0.5gb"));
    expect(unknownInstanceSizes(cfg)).toEqual([]);
    expect(legacyInstanceSizes(cfg)).toEqual([]);
  });

  it("accepts the apps-s-1vcpu-1gb default a bundle gets for free", () => {
    const cfg = parseConfig(`${BASE}
bundles:
  - { name: bundle-api }
servers:
  - { slug: bundled, kind: builtin, module: "./servers/echo.js", bundle: bundle-api, entitlements: [admin] }
`);
    expect(cfg.bundles?.[0]?.instanceSizeSlug).toBe("apps-s-1vcpu-1gb");
    expect(unknownInstanceSizes(cfg)).toEqual([]);
  });

  it("says nothing about a config that declares no bundles", () => {
    const cfg = parseConfig(BASE);
    expect(unknownInstanceSizes(cfg)).toEqual([]);
    expect(legacyInstanceSizes(cfg)).toEqual([]);
  });
});

describe("assertKnownInstanceSizes", () => {
  it("throws naming the bundle, the slug, and every valid option", () => {
    let message = "";
    try {
      assertKnownInstanceSizes(
        parseConfig(withBundleSize("apps-s-1vcpu-512mb")),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('bundle "bundle-api"');
    expect(message).toContain(
      '"apps-s-1vcpu-512mb" names no App Platform plan',
    );
    // The real name for the size the operator meant, the far end of the current
    // list, the legacy list, and where the set came from.
    expect(message).toContain("apps-s-1vcpu-0.5gb");
    expect(message).toContain("apps-d-8vcpu-32gb");
    expect(message).toContain("basic-xxs");
    expect(message).toContain("professional-xl");
    expect(message).toContain(
      "https://docs.digitalocean.com/products/app-platform/details/pricing/",
    );
  });

  it("is silent on a config whose every bundle names a real plan", () => {
    expect(() =>
      assertKnownInstanceSizes(parseConfig(withBundleSize("apps-s-1vcpu-2gb"))),
    ).not.toThrow();
  });

  it("does not throw on a legacy plan", () => {
    expect(() =>
      assertKnownInstanceSizes(parseConfig(withBundleSize("professional-xs"))),
    ).not.toThrow();
  });
});

describe("the boot parse stays lenient", () => {
  // The whole reason this is a deploy gate rather than a schema rule. The
  // gateway runs `parseConfig` at boot, in every container, and the config
  // versions independently of the image — so a schema that refused a plan it had
  // not heard of would make an older image reject the config a newer one wrote,
  // over a field nothing at runtime reads.
  it("accepts a slug it does not recognise, and keeps it verbatim", () => {
    const cfg = parseConfig(withBundleSize("apps-s-99vcpu-1024gb"));
    expect(cfg.bundles?.[0]?.instanceSizeSlug).toBe("apps-s-99vcpu-1024gb");
  });
});

describe("check-config refuses a config naming no real plan", () => {
  // End to end through the script CI actually runs, because that is the claim:
  // a wrong slug fails on the pull request that writes it.
  function checkConfig(yaml: string): { status: number; output: string } {
    const dir = mkdtempSync(join(tmpdir(), "strad-instance-size-"));
    const file = join(dir, "strad.config.yaml");
    writeFileSync(file, yaml);
    // Both streams, on both outcomes: the errors land on stdout in the verdict
    // and the `::warning::` annotations only ever go to stderr.
    const run = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "scripts/check-config.ts",
        "--config",
        file,
      ],
      { encoding: "utf8" },
    );
    return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}` };
  }

  it("exits 1 on apps-s-1vcpu-512mb", () => {
    const { status, output } = checkConfig(
      withBundleSize("apps-s-1vcpu-512mb"),
    );
    expect(status).toBe(1);
    expect(output).toContain("1 problem(s)");
    expect(output).toContain('"apps-s-1vcpu-512mb" names no App Platform plan');
  }, 30_000);

  it("exits 1 for a bundle carrying no server", () => {
    const { status, output } = checkConfig(`${BASE}
bundles:
  - { name: bundle-empty, instanceSizeSlug: apps-s-1vcpu-512mb }
`);
    expect(status).toBe(1);
    expect(output).toContain('bundle "bundle-empty"');
  }, 30_000);

  it("exits 0 on a legacy plan, with a warning naming it", () => {
    const { status, output } = checkConfig(withBundleSize("professional-xs"));
    expect(status).toBe(0);
    expect(output).toContain("::warning");
    expect(output).toContain("legacy App Platform plan");
  }, 30_000);

  it("exits 0 and warns about nothing on a current plan", () => {
    const { status, output } = checkConfig(
      withBundleSize("apps-s-1vcpu-0.5gb"),
    );
    expect(status).toBe(0);
    expect(output).not.toContain("::warning");
  }, 30_000);
});

describe("render-spec refuses a plan that does not exist", () => {
  // Driven as a subprocess, the same way test/render-spec.images.test.ts drives
  // the sibling mutable-tag gate, and for the same reason: the property is about
  // the SPEC that reaches App Platform, not about a function's return value. A
  // reorder that moved the call below an early exit would pass every unit test
  // above and fail nothing.
  function render(yaml: string): {
    stdout: string;
    stderr: string;
    status: number;
  } {
    const dir = mkdtempSync(join(tmpdir(), "strad-render-size-"));
    const cfg = join(dir, "cfg.yaml");
    writeFileSync(cfg, yaml);
    const out = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "scripts/render-spec.ts",
        "--config",
        cfg,
        "--image",
        `ghcr.io/tadasant/strad:sha-${"a".repeat(40)}`,
        "--app",
        "strad-staging",
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

  it("exits non-zero and emits no spec for apps-s-1vcpu-512mb", () => {
    const out = render(withBundleSize("apps-s-1vcpu-512mb"));
    expect(out.status).not.toBe(0);
    expect(`${out.stdout}${out.stderr}`).toContain(
      '"apps-s-1vcpu-512mb" names no App Platform plan',
    );
    expect(out.stdout.trim()).toBe("");
  }, 30_000);

  it("renders a current plan into instance_size_slug, silently", () => {
    const out = render(withBundleSize("apps-s-1vcpu-0.5gb"));
    expect(out.status).toBe(0);
    const spec = JSON.parse(out.stdout) as {
      services: { name: string; instance_size_slug: string }[];
    };
    expect(
      spec.services.find((svc) => svc.name === "bundle-api")
        ?.instance_size_slug,
    ).toBe("apps-s-1vcpu-0.5gb");
    expect(out.stderr).not.toContain("legacy App Platform plan");
  }, 30_000);

  it("renders a legacy plan but warns, naming the bundle", () => {
    const out = render(withBundleSize("professional-xs"));
    expect(out.status).toBe(0);
    expect(out.stderr).toContain("::warning::");
    expect(out.stderr).toContain('bundle "bundle-api"');
    expect(out.stderr).toContain("before 7 May 2024");
  }, 30_000);
});

describe("assertDeployableSpec refuses a plan on the bytes doctl reads", () => {
  // The third holder of the check, and the only one that does not care who
  // rendered the spec — a hand-edited spec.json, or a future second renderer.
  function spec(slug: string): string {
    return JSON.stringify({
      name: "strad-staging",
      services: [{ name: "core", instance_size_slug: slug, http_port: 8080 }],
    });
  }

  it("throws naming the component and the slug", () => {
    expect(() => assertDeployableSpec(spec("apps-s-1vcpu-512mb"))).toThrow(
      /component "core" asks for instance size "apps-s-1vcpu-512mb"/,
    );
  });

  it("accepts a current plan and a legacy one alike", () => {
    // Legacy is the renderer's warning to make, not this one's refusal: this
    // check sees a spec, and a spec does not say when its app was created.
    expect(assertDeployableSpec(spec("apps-s-1vcpu-0.5gb")).components).toEqual(
      ["core"],
    );
    expect(assertDeployableSpec(spec("professional-xs")).components).toEqual([
      "core",
    ]);
  });

  it("says nothing about a component with no instance_size_slug", () => {
    const noSize = JSON.stringify({
      name: "strad-staging",
      services: [{ name: "core", http_port: 8080 }],
    });
    expect(assertDeployableSpec(noSize).components).toEqual(["core"]);
  });
});
