import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertDeployableSpec,
  SpecFileError,
} from "../src/deploy/spec-file.ts";

/**
 * The check that stands between a rendered spec and `doctl apps update`.
 *
 * Every case here is a shape the deploy job can actually hand doctl, and the
 * first one is not hypothetical: on 2026-08-06 a concurrent job on the same
 * self-hosted machine truncated the staging spec to zero bytes between the
 * render and the PUT, doctl decoded that into a spec with no fields, and the
 * only diagnostic anybody got was DigitalOcean's `.name in body is required`.
 */

/** A minimally valid spec — what `renderAppSpec` produces, in miniature. */
function spec(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "strad-staging",
    region: "nyc",
    services: [{ name: "core" }, { name: "bundle" }],
    ...over,
  });
}

describe("assertDeployableSpec", () => {
  it("accepts a rendered spec and summarises it without its contents", () => {
    const got = assertDeployableSpec(spec(), {
      expectedName: "strad-staging",
    });
    expect(got.name).toBe("strad-staging");
    expect(got.components).toEqual(["core", "bundle"]);
    expect(got.bytes).toBe(Buffer.byteLength(spec(), "utf8"));
  });

  it("accepts a spec when no name is expected", () => {
    expect(assertDeployableSpec(spec()).name).toBe("strad-staging");
  });

  // THE OBSERVED FAILURE. An empty file is the shape doctl accepts in silence.
  it("rejects an empty file, and says what doctl would have done with it", () => {
    expect(() => assertDeployableSpec("")).toThrow(SpecFileError);
    expect(() => assertDeployableSpec("")).toThrow(/empty \(0 bytes\)/);
    expect(() => assertDeployableSpec("")).toThrow(
      /\.name in body is required/,
    );
  });

  it("rejects a whitespace-only file as empty", () => {
    expect(() => assertDeployableSpec("\n  \n")).toThrow(/empty \(4 bytes\)/);
  });

  // A writer caught mid-flight on the same path.
  it("rejects a truncated file as unparsable, with the byte count", () => {
    const half = spec().slice(0, 40);
    expect(() => assertDeployableSpec(half)).toThrow(/not valid JSON/);
    expect(() => assertDeployableSpec(half)).toThrow(/40 bytes/);
  });

  it("rejects JSON that is not an object", () => {
    expect(() => assertDeployableSpec("null")).toThrow(
      /does not hold a JSON object/,
    );
    expect(() => assertDeployableSpec("[]")).toThrow(/got an array/);
    expect(() => assertDeployableSpec('"strad-staging"')).toThrow(/got string/);
  });

  it("rejects the { spec: ... } envelope doctl wraps for itself", () => {
    const wrapped = JSON.stringify({ spec: JSON.parse(spec()) });
    expect(() => assertDeployableSpec(wrapped)).toThrow(
      /wrapped in a top-level "spec" key/,
    );
  });

  it("rejects a spec with no usable top-level name", () => {
    for (const name of [undefined, "", "   ", 42, null]) {
      const text =
        name === undefined
          ? JSON.stringify({ region: "nyc", services: [{ name: "core" }] })
          : spec({ name });
      expect(() => assertDeployableSpec(text)).toThrow(
        /no top-level "name"|\.name in body is required/,
      );
    }
  });

  // The near-miss, and the reason this is not `jq -e .name`. One second later
  // on the clock, staging's doctl would have read prod's COMPLETE spec.
  it("rejects another deployment's spec, naming both apps", () => {
    expect(() =>
      assertDeployableSpec(spec({ name: "strad-prod" }), {
        expectedName: "strad-staging",
      }),
    ).toThrow(
      /names app "strad-prod", but this deploy rendered "strad-staging"/,
    );
  });

  it("rejects a spec with no components, because an update is a full replace", () => {
    expect(() => assertDeployableSpec(spec({ services: [] }))).toThrow(
      /has no components \("services" is empty\)/,
    );
    expect(() =>
      assertDeployableSpec(JSON.stringify({ name: "strad-staging" })),
    ).toThrow(/has no components/);
    expect(() => assertDeployableSpec(spec({ services: {} }))).toThrow(
      /has no components/,
    );
  });

  it("rejects a component with no name", () => {
    expect(() =>
      assertDeployableSpec(spec({ services: [{ name: "core" }, {}] })),
    ).toThrow(/component 1 has no "name"/);
    expect(() =>
      assertDeployableSpec(spec({ services: [{ name: "core" }, "bundle"] })),
    ).toThrow(/component 1 has no "name"/);
  });

  // A rendered spec holds SECRET values. A check that fails by printing the
  // thing it is checking would put them in a public run log.
  it("never puts spec content in a failure message", () => {
    const secret = "s3cret-token-value";
    const text = spec({
      name: "",
      services: [
        { name: "core", envs: [{ key: "STRAD_TOKENS", value: secret }] },
      ],
    });
    let message = "";
    try {
      assertDeployableSpec(text, { expectedName: "strad-staging" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(secret);
  });
});

describe("scripts/assert-spec.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "strad-assert-spec-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(name: string, contents: string | null, expectName?: string) {
    const path = join(dir, name);
    if (contents !== null) writeFileSync(path, contents);
    const args = [
      "--experimental-transform-types",
      "scripts/assert-spec.ts",
      path,
    ];
    if (expectName) args.push("--expect-name", expectName);
    return spawnSync(process.execPath, args, { encoding: "utf8" });
  }

  it("exits 0 and reports the app and its components", () => {
    const got = run("ok.json", spec(), "strad-staging");
    expect(got.status).toBe(0);
    expect(got.stderr).toContain('"strad-staging"');
    expect(got.stderr).toContain("2 component(s): core, bundle");
  });

  it("exits 1 with a ::error:: annotation on an empty spec", () => {
    const got = run("empty.json", "", "strad-staging");
    expect(got.status).toBe(1);
    expect(got.stderr).toContain("::error::");
    expect(got.stderr).toMatch(/empty \(0 bytes\)/);
  });

  it("exits 1 when the spec belongs to another app", () => {
    const got = run(
      "other.json",
      spec({ name: "strad-prod" }),
      "strad-staging",
    );
    expect(got.status).toBe(1);
    expect(got.stderr).toContain("::error::");
    expect(got.stderr).toContain("strad-prod");
  });

  it("exits 1 when the file is missing entirely", () => {
    const got = run("absent.json", null, "strad-staging");
    expect(got.status).toBe(1);
    expect(got.stderr).toContain("::error::cannot read the rendered spec");
  });

  it("exits 1 with usage when given no path", () => {
    const got = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "scripts/assert-spec.ts"],
      { encoding: "utf8" },
    );
    expect(got.status).toBe(1);
    expect(got.stderr).toContain("usage: assert-spec");
  });

  // The end-to-end claim: the guard passes a spec this repo's own renderer
  // produced, not just a hand-written fixture.
  it("accepts a spec rendered by render-spec.ts", () => {
    const path = join(dir, "rendered.json");
    const rendered = execFileSync(
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
        // The stock config, because it is the one whose `env`-provider render
        // needs nothing but the two required boot secrets. A config with
        // supplementary servers would need every ${NAME} it references, and
        // this test is about the handoff, not about the renderer's inputs.
        env: {
          ...process.env,
          STRAD_TOKENS: "test-token",
          STRAD_INTERNAL_TOKEN: "test-internal",
        },
      },
    );
    writeFileSync(path, rendered);
    const got = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "scripts/assert-spec.ts",
        path,
        "--expect-name",
        "strad-example",
      ],
      { encoding: "utf8" },
    );
    expect(got.status).toBe(0);
    expect(got.stderr).toContain('"strad-example"');

    // And the same bytes, truncated the way a concurrent writer truncates them,
    // are refused.
    writeFileSync(path, "");
    const truncated = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "scripts/assert-spec.ts",
        path,
        "--expect-name",
        "strad-example",
      ],
      { encoding: "utf8" },
    );
    expect(truncated.status).toBe(1);
  });
});
