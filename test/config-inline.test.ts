import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
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
      if (!/^strad\..*\.ya?ml$/.test(name)) continue;
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

      expect(got.rawBytes).toBe(Buffer.byteLength(raw, "utf8"));
      expect(got.inlinedBytes).toBe(Buffer.byteLength(got.yaml, "utf8"));
      // Smaller WHEN it inlined. Not "always smaller": a config small enough
      // that the round trip cannot beat it is a supported outcome, and demanding
      // otherwise would red an unrelated PR that adds a three-line config.
      if (got.keptRawBecause === undefined) {
        expect(got.inlinedBytes).toBeLessThan(got.rawBytes);
      } else {
        expect(got.yaml).toBe(raw);
      }
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

  it("keeps the raw text when the config does not parse, rather than throwing", () => {
    // A malformed config is parseConfig's error to report, with the message
    // built for it — not this function's to turn into a stack trace.
    const raw = "gateway:\n  name: [unclosed\n";
    const got = inlineConfigYaml(raw);
    expect(got.yaml).toBe(raw);
    expect(got.keptRawBecause).toBe(
      "the config file did not parse (YAMLParseError)",
    );
  });

  it("never puts the config's own text in the reason it kept it", () => {
    // `yaml` quotes the source in its messages, and the source is a document
    // that may hold a credential. Only the error's NAME travels.
    const got = inlineConfigYaml("gateway:\n  name: [s3cret-tok\n");
    expect(got.keptRawBecause).not.toContain("s3cret-tok");
  });

  // THE SAFETY NET ITSELF. Everything above rests on the deep-equal check
  // catching a round trip that changed a value, so the branch has to be
  // exercised by an input that really does change one — not merely asserted.
  //
  // Both cases below lose a TYPE the emitted document has no way to carry. The
  // 1.1 directive does not survive re-emission, so `yes` and `2024-01-01` go in
  // as a boolean and a Date and come back as a string and a string; `!!binary`
  // parses to a Buffer that re-emits as a plain string.
  it.each([
    [
      "a %YAML 1.1 document, where `yes` is a boolean and a date is a timestamp",
      "%YAML 1.1\n---\nflag: yes\nts: 2024-01-01\n",
    ],
    ["a !!binary value, which parses to a Buffer", "a: !!binary aGk=\n"],
  ])("keeps the raw text for %s", (_label, raw) => {
    const got = inlineConfigYaml(raw);
    expect(got.yaml).toBe(raw);
    expect(got.keptRawBecause).toBe(
      "the re-emitted document does not hold the same values",
    );
  });

  it.each([
    ["a multi-document stream", "a: 1\n---\nb: 2\n"],
    ["duplicate keys", "a: 1\na: 2\n"],
  ])("keeps the raw text for %s", (_label, raw) => {
    const got = inlineConfigYaml(raw);
    expect(got.yaml).toBe(raw);
    expect(got.keptRawBecause).toBe(
      "the config file did not parse (YAMLParseError)",
    );
  });

  it("carries anchors and aliases through as the values they expand to", () => {
    const raw =
      "defaults: &d\n  timeout: 30\n" +
      "one:\n  <<: *d\n  name: a\n" +
      "two: *d\n";
    const got = inlineConfigYaml(raw);
    // Whether it inlined or fell back, the values the gateway reads are equal.
    expect(parseYaml(got.yaml)).toEqual(parseYaml(raw));
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
  // Rendered in beforeAll, not at collection time: a render-spec failure should
  // arrive as a named test failure, not as a file-level collection error with no
  // test to point at.
  let baked: string;
  const raw = readFileSync("strad.config.yaml", "utf8");

  beforeAll(() => {
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
    ) as {
      services: { name: string; envs: { key: string; value: string }[] }[];
    };
    const core = rendered.services.find((s) => s.name === "core")!;
    baked = core.envs.find((e) => e.key === "STRAD_CONFIG_YAML")!.value;
  });

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
