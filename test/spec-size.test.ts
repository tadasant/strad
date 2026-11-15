import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec, type AppSpec } from "../src/deploy/appspec.ts";
import { bakeConfigEnv } from "../src/deploy/config-inline.ts";
import { bakedSecretNames } from "../src/deploy/preflight.ts";
import { waivedNames } from "../src/deploy/unseeded.ts";
import { sizeAdvisory } from "../src/deploy/spec-file.ts";
import {
  formatSpecSizeError,
  formatSpecSizeWarning,
  serializeSpec,
  specSizeReport,
  specSizeWarnAt,
  LARGEST_ACCEPTED_SPEC_BYTES,
  SPEC_SIZE_ADVISORY_FRACTION,
} from "../src/deploy/spec-size.ts";

/**
 * The size of the spec that reaches App Platform.
 *
 * The property under test is not "a number is computed" — it is that the number
 * describes the bytes actually written, and that the verdict never refuses a
 * size prod is observed to have deployed. See src/deploy/spec-size.ts for where
 * the ceiling's two data points come from.
 */

const spec = (envs: { key: string; value: string }[][]): AppSpec => ({
  name: "strad-prod",
  region: "nyc",
  services: envs.map((list, i) => ({
    name: i === 0 ? "core" : `bundle-${i}`,
    image: {
      registry_type: "GHCR" as const,
      registry: "tadasant",
      repository: "strad",
      tag: "sha-a",
    },
    instance_size_slug: "apps-s-1vcpu-1gb",
    instance_count: 1,
    envs: list.map((e) => ({
      ...e,
      scope: "RUN_TIME" as const,
      type: "GENERAL" as const,
    })),
  })),
});

/** A spec whose serialized size is at least `bytes`, padded on one env var. */
function specOfAtLeast(bytes: number): AppSpec {
  return spec([[{ key: "STRAD_CONFIG_YAML", value: "y".repeat(bytes) }]]);
}

describe("the ceiling", () => {
  it("is the largest spec App Platform is observed to have accepted", () => {
    // 131,010 bytes: prod runs 33286223074, 33287528135 and 33291566037, all on
    // 2026-08-30. This is the whole safety argument — the guard cannot refuse a
    // size that has deployed — so it is asserted rather than left to a comment.
    expect(LARGEST_ACCEPTED_SPEC_BYTES).toBe(131_010);
  });

  it("sits below the smallest spec App Platform is observed to have refused", () => {
    // 141,342 bytes, run 33330369567, `400 … "App spec": size limit exceeded`.
    expect(LARGEST_ACCEPTED_SPEC_BYTES).toBeLessThan(141_342);
  });

  it("is NOT 128 KiB, which is above the largest accepted size", () => {
    // The obvious guess, and wrong by 62 bytes in the direction that lets an
    // oversize spec through on nothing but the roundness of the number.
    expect(LARGEST_ACCEPTED_SPEC_BYTES).toBeLessThan(131_072);
  });
});

describe("the two consumers agree on the band, not just on the ceiling", () => {
  // `render-spec` and `assert-spec` advertise themselves as sharing one number,
  // and a `>` on one side against a `>=` on the other would quietly give them
  // different boundaries: one warning at exactly 104,808 bytes and the other,
  // a step later on the same spec, saying nothing.
  const boundary = specSizeWarnAt(LARGEST_ACCEPTED_SPEC_BYTES);

  it("both speak up at exactly the band boundary", () => {
    expect(boundary).toBe(104_808);
    expect(sizeAdvisory(boundary)).toBeDefined();

    // A spec whose size lands exactly on the boundary of its own ceiling: pick
    // the ceiling from the bytes rather than the other way round.
    const s = specOfAtLeast(2_000);
    const bytes = specSizeReport(s).bytes;
    const limit = Math.ceil(bytes / SPEC_SIZE_ADVISORY_FRACTION);
    expect(specSizeWarnAt(limit)).toBe(bytes);
    expect(specSizeReport(s, limit).verdict).toBe("warn");
  });

  it("both stay quiet one byte below it", () => {
    expect(sizeAdvisory(boundary - 1)).toBeUndefined();

    const s = specOfAtLeast(2_000);
    const bytes = specSizeReport(s).bytes;
    // One byte of band above the spec, so it sits just under the boundary.
    const limit = Math.ceil((bytes + 1) / SPEC_SIZE_ADVISORY_FRACTION);
    expect(specSizeWarnAt(limit)).toBeGreaterThan(bytes);
    expect(specSizeReport(s, limit).verdict).toBe("ok");
  });
});

describe("specSizeReport", () => {
  it("measures the exact text that gets written, not a second serialization", () => {
    const s = specOfAtLeast(1_000);
    const report = specSizeReport(s);
    expect(report.json).toBe(serializeSpec(s));
    expect(report.bytes).toBe(Buffer.byteLength(report.json, "utf8"));
  });

  it("counts bytes, not characters", () => {
    // A spec is UTF-8 on the wire and a config may hold any of it — an em dash
    // in a `description:` is three bytes and one character, and a guard that
    // counted characters would under-report every one of them.
    const report = specSizeReport(
      spec([[{ key: "K", value: "—".repeat(100) }]]),
    );
    expect(report.bytes).toBe(Buffer.byteLength(report.json, "utf8"));
    expect(report.bytes).toBeGreaterThan(report.json.length);
  });

  it("passes a spec at exactly the ceiling, and refuses one byte past it", () => {
    // The boundary that matters: 131,010 IS a size that deployed, three times.
    // An off-by-one in this comparison refuses a spec App Platform has taken.
    const s = specOfAtLeast(2_000);
    const size = specSizeReport(s).bytes;
    expect(specSizeReport(s, size).verdict).not.toBe("over");
    expect(specSizeReport(s, size - 1).verdict).toBe("over");
  });

  it("warns inside the band and stays quiet below it", () => {
    const limit = 100_000;
    const warnAt = Math.floor(limit * SPEC_SIZE_ADVISORY_FRACTION);
    const under = specSizeReport(specOfAtLeast(50_000), limit);
    expect(under.verdict).toBe("ok");
    expect(under.warnAt).toBe(warnAt);

    const inside = specSizeReport(specOfAtLeast(85_000), limit);
    expect(inside.bytes).toBeGreaterThanOrEqual(warnAt);
    expect(inside.bytes).toBeLessThanOrEqual(limit);
    expect(inside.verdict).toBe("warn");
  });

  it("ranks components and their variables by the bytes they eat", () => {
    const report = specSizeReport(
      spec([
        [
          { key: "SMALL", value: "x" },
          { key: "STRAD_CONFIG_YAML", value: "y".repeat(5_000) },
          { key: "MIDDLING", value: "z".repeat(500) },
        ],
        [{ key: "ONE_SECRET", value: "s".repeat(100) }],
      ]),
    );
    expect(report.components.map((c) => c.name)).toEqual(["core", "bundle-1"]);
    expect(report.components[0]!.largest.map((e) => e.key)).toEqual([
      "STRAD_CONFIG_YAML",
      "MIDDLING",
      "SMALL",
    ]);
    expect(report.components[0]!.count).toBe(3);
    expect(report.components[0]!.envBytes).toBeGreaterThan(5_000);
  });

  it("survives a component with no env at all", () => {
    const report = specSizeReport(spec([[]]));
    expect(report.verdict).toBe("ok");
    expect(report.components[0]!.largest).toEqual([]);
    expect(report.components[0]!.envBytes).toBe(0);
  });
});

describe("what the refusal says", () => {
  const report = specSizeReport(
    spec([
      [{ key: "STRAD_CONFIG_YAML", value: "y".repeat(200_000) }],
      [{ key: "GRAFANA_TOKEN", value: "s".repeat(300) }],
    ]),
  );

  it("is over, and says the actual size and the ceiling", () => {
    expect(report.verdict).toBe("over");
    const message = formatSpecSizeError(report);
    expect(message).toContain(report.bytes.toLocaleString("en-US"));
    expect(message).toContain("131,010");
  });

  it("names the driver, because the 400 it replaces does not", () => {
    // The whole point. DigitalOcean's own error says "size limit exceeded" and
    // stops; a guard that only said it earlier would have moved the failure
    // without improving it.
    const message = formatSpecSizeError(report);
    expect(message).toContain("core");
    expect(message).toContain("STRAD_CONFIG_YAML");
    expect(message).toContain("bundle-1");
  });

  it("says how much over, and how to proceed anyway", () => {
    const message = formatSpecSizeError(report);
    expect(message).toContain(
      (report.bytes - report.limit).toLocaleString("en-US"),
    );
    expect(message).toContain("--max-spec-bytes");
  });

  it("quotes no env VALUE, only names and sizes", () => {
    // This runs in CI over a spec full of live secrets, and its output goes to
    // a build log. The refusal reports how big a variable is; never what it is.
    const message = formatSpecSizeError(report);
    expect(message).not.toContain("yyy");
    expect(message).not.toContain("sss");
  });
});

describe("the real staging config, which is the false-positive canary", () => {
  /**
   * tadasant-internal's prod deploy runs `scripts/render-spec.ts` straight from
   * `main` — no image publish, no version bump, no dispatch in between — so a
   * ceiling that trips on a real config turns a working pipeline into a broken
   * one within minutes of a merge. `infra/strad.staging.yaml` is the largest
   * real config this repo owns: 46 slugs across three components.
   *
   * Placeholder secret values, as the issue's own measurement used, so the
   * number is comparable and reproducible without credentials.
   */
  const raw = readFileSync(
    new URL("../infra/strad.staging.yaml", import.meta.url),
    "utf8",
  );
  const config = parseConfig(raw, "infra/strad.staging.yaml");
  const waived = waivedNames(config);
  const spec = renderAppSpec({
    config,
    appName: "strad-staging",
    region: "nyc",
    image: {
      registry_type: "GHCR",
      registry: "tadasant",
      repository: "strad",
      tag: `sha-${"a".repeat(40)}`,
    },
    env: bakeConfigEnv(raw).envs.map(({ key, value }) => ({
      key,
      value,
      scope: "RUN_TIME" as const,
      type: "GENERAL" as const,
    })),
    secrets: Object.fromEntries(
      bakedSecretNames(config)
        .filter((n) => !waived.has(n))
        .map((name) => [name, "x"]),
    ),
    // What render-spec hands it for a waived name the store does not hold.
    unseededRefs: new Set(waived.keys()),
  });

  it("renders well under the ceiling, and outside the warn band", () => {
    const report = specSizeReport(spec);
    expect(report.verdict).toBe("ok");
    expect(report.bytes).toBeLessThan(report.warnAt);
    // Half the ceiling, so this fails long before a deploy would — the point of
    // the canary is to catch growth here, not to ratify it.
    expect(report.bytes).toBeLessThan(LARGEST_ACCEPTED_SPEC_BYTES / 2);
  });

  it("carries the config gzipped, so it no longer dominates the spec", () => {
    // The config was the one variable that dominated the spec — 47% of it on
    // the render App Platform refused (src/deploy/config-inline.ts). Gzipped,
    // it is about a quarter of a spec whose secrets are one byte each. (Core is the largest component again here, but only
    // because every placeholder value is "x", so the bundle's per-slug names
    // all fold into STRAD_ENV_COPIES; real credentials do not shrink that way.)
    const report = specSizeReport(spec);
    const core = report.components.find((c) => c.name === "core")!;
    const config = core.largest[0]!;
    expect(config.key).toBe("STRAD_CONFIG_YAML_GZ_B64");
    expect(config.bytes).toBeLessThan(report.bytes / 3);
  });
});

describe("what the warning says", () => {
  const report = specSizeReport(specOfAtLeast(85_000), 100_000);

  it("names the headroom left rather than the overshoot", () => {
    expect(report.verdict).toBe("warn");
    const message = formatSpecSizeWarning(report);
    expect(message).toContain(
      (report.limit - report.bytes).toLocaleString("en-US"),
    );
    expect(message).toMatch(/headroom/);
    expect(message).toMatch(/8[0-9]% of the/);
  });

  it("quotes no env value either", () => {
    expect(formatSpecSizeWarning(report)).not.toContain("yyy");
  });
});
