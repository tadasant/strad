import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { inlineConfigYaml } from "../src/deploy/config-inline.ts";
import { parseConfig } from "../src/config/load.ts";

/**
 * The config document as it is BAKED into the app spec.
 *
 * Two properties, and the first is the only one that makes the second worth
 * having: the inlined document must mean exactly what the file means, and it
 * must be smaller. A spec that fits and configures a different gateway is not
 * a fix.
 *
 * The interesting cases are this repo's own configs, so they are the corpus:
 * every one of them is a real document with real prose in it, and the check
 * runs over each.
 */

/** Every config in the repo that render-spec could be pointed at. */
function repoConfigs(): { path: string; raw: string }[] {
  const roots = [".", "infra"];
  const found: { path: string; raw: string }[] = [];
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      if (!/^strad\..*\.ya?ml$|^strad\.config\.ya?ml$/.test(name)) continue;
      const path = join(root, name);
      found.push({ path, raw: readFileSync(path, "utf8") });
    }
  }
  return found;
}

describe("inlineConfigYaml", () => {
  it("finds this repo's configs, so the corpus below is not empty", () => {
    const paths = repoConfigs().map((c) => c.path);
    expect(paths.length).toBeGreaterThanOrEqual(3);
    expect(paths).toContain("infra/strad.staging.yaml");
  });

  for (const { path, raw } of repoConfigs()) {
    it(`${path}: inlines to the same document, smaller`, () => {
      const got = inlineConfigYaml(raw);

      // Lossless at the YAML level — BEFORE the schema, so a key Zod would
      // strip still has to survive.
      expect(parseYaml(got.yaml)).toEqual(parseYaml(raw));
      // And at the config level, which is what actually boots.
      expect(parseConfig(got.yaml, path)).toEqual(parseConfig(raw, path));

      expect(got.keptRawBecause).toBeUndefined();
      expect(got.inlinedBytes).toBeLessThan(got.rawBytes);
      expect(got.rawBytes).toBe(Buffer.byteLength(raw, "utf8"));
      expect(got.inlinedBytes).toBe(Buffer.byteLength(got.yaml, "utf8"));
    });
  }

  it("drops comments, which is where a strad config's bytes are", () => {
    const raw = [
      "# A long explanation of why this bundle is sized the way it is,",
      "# which the next person needs and the container does not.",
      "gateway:",
      "  name: strad # trailing prose too",
      "servers: []",
    ].join("\n");

    const got = inlineConfigYaml(raw);
    expect(got.yaml).not.toContain("#");
    expect(got.yaml).not.toContain("explanation");
    expect(parseYaml(got.yaml)).toEqual(parseYaml(raw));
  });

  it("keeps multi-line values intact rather than folding them", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END-----\n";
    const raw = `servers:\n  - key: ${JSON.stringify(key)}\n`;

    const got = inlineConfigYaml(raw);
    expect(
      (parseYaml(got.yaml) as { servers: { key: string }[] }).servers[0]!.key,
    ).toBe(key);
  });

  it("keeps the raw text when re-emitting would not save anything", () => {
    // Already minimal: the round trip cannot beat it.
    const raw = "a: 1\n";
    const got = inlineConfigYaml(raw);
    expect(got.yaml).toBe(raw);
    expect(got.keptRawBecause).toBe("the re-emitted document is no smaller");
  });

  it("keeps the raw text when the document does not parse, rather than throwing", () => {
    // A malformed config is parseConfig's error to report, with the message
    // built for it — not this function's to turn into a stack trace.
    const raw = "gateway:\n  name: [unclosed\n";
    const got = inlineConfigYaml(raw);
    expect(got.yaml).toBe(raw);
    expect(got.keptRawBecause).toMatch(/could not be re-emitted|did not parse/);
  });

  it("saves most of a prose-heavy config", () => {
    // The property the fix rests on, pinned against the config that actually
    // broke prod's deploy in shape if not in content: comments dominate, so
    // inlining is a large cut rather than a rounding error.
    const raw = readFileSync("infra/strad.staging.yaml", "utf8");
    const got = inlineConfigYaml(raw);
    expect(got.inlinedBytes).toBeLessThan(got.rawBytes / 2);
  });
});

/**
 * The end-to-end claim: what render-spec actually bakes is the inlined document,
 * and a gateway booting on it loads the same config.
 *
 * The stock config is the one used here for the same reason the spec-handoff
 * test uses it — it is the config whose `env`-provider render needs nothing but
 * the two required boot secrets. The SIZE property is asserted above, against
 * the real prose-heavy configs; this is about the wiring.
 */
describe("render-spec bakes the inlined document", () => {
  const rendered = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "scripts/render-spec.ts",
        "--config",
        "strad.config.yaml",
        "--image",
        "ghcr.io/tadasant/strad:0.1.0",
        "--app",
        "strad-example",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          STRAD_TOKENS: "test-token",
          STRAD_INTERNAL_TOKEN: "test-internal",
        },
      },
    ),
  ) as { services: { name: string; envs: { key: string; value: string }[] }[] };

  const core = rendered.services.find((s) => s.name === "core")!;
  const baked = core.envs.find((e) => e.key === "STRAD_CONFIG_YAML")!.value;
  const raw = readFileSync("strad.config.yaml", "utf8");

  it("bakes the inlined text, not the file", () => {
    expect(baked).toBe(inlineConfigYaml(raw).yaml);
    expect(baked.length).toBeLessThan(raw.length);
  });

  it("bakes a document the gateway loads to the same config", () => {
    // This is the boot path: src/config/load.ts parses STRAD_CONFIG_YAML with
    // exactly this function.
    expect(parseConfig(baked, "STRAD_CONFIG_YAML")).toEqual(
      parseConfig(raw, "strad.config.yaml"),
    );
  });
});
