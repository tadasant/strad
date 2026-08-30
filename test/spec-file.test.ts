import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertDeployableSpec,
  LARGEST_ACCEPTED_SPEC_BYTES,
  sizeAdvisory,
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
    expect(() => assertDeployableSpec('"strad-staging"')).toThrow(
      /got a string/,
    );
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
      expect(() => assertDeployableSpec(text)).toThrow(/no top-level "name"/);
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

  // A rendered spec holds SECRET values, and a check that fails by printing the
  // thing it is checking would put them in a public run log.
  //
  // Every failure branch gets its own case, with the secret placed where THAT
  // branch reads. An earlier version of this test used a single input with a
  // blank `name`, which short-circuits into the one branch that structurally
  // cannot leak — it passed while three other branches quoted the file back:
  // V8 puts the first ten bytes of the input into a `SyntaxError` message, and
  // `JSON.stringify` on a non-string `name` or a non-array `services` dumped
  // the whole value.
  const SECRET = "s3cret-AKIAIOSFODNN7EXAMPLE-token";
  const leakCases: Array<[string, string]> = [
    // The parser quotes the head of the input.
    ["corrupt head", `${SECRET} {"name":"strad-staging"}`],
    // A scalar document, of a type whose value would print.
    ["scalar document", JSON.stringify(SECRET)],
    // `.name` is an object rather than a string.
    ["object name", spec({ name: { token: SECRET } })],
    // `services` is an object rather than an array.
    [
      "object services",
      spec({
        services: { core: { envs: [{ key: "STRAD_TOKENS", value: SECRET }] } },
      }),
    ],
    // A component with no name, alongside one carrying a value.
    [
      "nameless component",
      spec({
        services: [{ envs: [{ key: "STRAD_TOKENS", value: SECRET }] }],
      }),
    ],
    // The envelope, wrapping a spec that holds one.
    [
      "wrapped envelope",
      JSON.stringify({
        spec: { services: [{ name: "core", env: SECRET }] },
      }),
    ],
  ];

  it.each(leakCases)(
    "never puts spec content in a failure message (%s)",
    (_label, text) => {
      let message = "";
      try {
        assertDeployableSpec(text, { expectedName: "strad-staging" });
      } catch (err) {
        message = (err as Error).message;
      }
      // It must actually have failed — a case that passes proves nothing.
      expect(message).not.toBe("");
      expect(message).not.toContain(SECRET);
      // Not even a fragment: V8 quotes ten bytes, so a prefix check is the one
      // that catches the parser message.
      expect(message).not.toContain(SECRET.slice(0, 8));
    },
  );

  // V8 reports a parse failure two ways, and only one of them is safe to
  // forward. A fault mid-document carries a position and no content; a fault at
  // the head carries the first ten bytes and NO position. So the position is
  // mined out when it is there, and nothing is said when it is not — rather than
  // the message being passed through and the head case leaking.
  it("reports where a mid-document parse failed", () => {
    let message = "";
    try {
      assertDeployableSpec(spec().slice(0, 40));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not valid JSON \(40 bytes\)/);
    expect(message).toMatch(/gave up at byte 40/);
  });

  it("says nothing at all about a head-corrupted file beyond its size", () => {
    let message = "";
    try {
      assertDeployableSpec(`${SECRET} {"name":"x"}`);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not valid JSON \(\d+ bytes\)/);
    expect(message).not.toContain(SECRET.slice(0, 8));
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

  // A deploy always knows which app it rendered, and without --expect-name the
  // check waves through a valid spec belonging to somebody else. So the CLI has
  // no degraded mode to fall into by omission.
  it("refuses to run without --expect-name", () => {
    const got = run("no-expect.json", spec());
    expect(got.status).toBe(1);
    expect(got.stderr).toContain("usage: assert-spec");
    expect(got.stderr).toContain("--expect-name");
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
        //
        // An EXPLICIT environment, not a spread of `process.env`: render-spec
        // reads STRAD_*, OTEL_* and the GCP resolver keys straight out of it, so
        // a developer who happens to have any of those exported would exercise a
        // different render than CI does, and find out here rather than there.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
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

/**
 * The size report, and why it is a report rather than a gate.
 *
 * On 2026-08-30 prod's spec crossed a size DigitalOcean refuses, and the deploy
 * log said only `size limit exceeded`. Nothing measured the spec on the way past
 * — the last spec that deployed had 62 bytes of headroom and no one knew.
 *
 * DigitalOcean publishes no limit, so the number this compares against is an
 * observation with a range around it. Every assertion below is therefore about
 * a WARNING, and the last one pins that a large spec still passes the check.
 */
describe("spec size reporting", () => {
  it("attributes the bytes to components, largest first", () => {
    const got = assertDeployableSpec(
      JSON.stringify({
        name: "strad-staging",
        services: [
          { name: "core", envs: [] },
          { name: "bundle", envs: [{ key: "K", value: "v".repeat(500) }] },
        ],
      }),
    );
    expect(got.componentBytes.map((c) => c.name)).toEqual(["bundle", "core"]);
    expect(got.componentBytes[0]!.bytes).toBeGreaterThan(
      got.componentBytes[1]!.bytes,
    );
  });

  it("says nothing about a spec with room to spare", () => {
    expect(assertDeployableSpec(spec()).sizeAdvisory).toBeUndefined();
    expect(sizeAdvisory(1_000)).toBeUndefined();
  });

  it("warns as a spec approaches the largest one known to have deployed", () => {
    const near = sizeAdvisory(Math.round(LARGEST_ACCEPTED_SPEC_BYTES * 0.9));
    expect(near).toMatch(/largest one known to have deployed/);
    // The evidence travels with the claim: this is an inference from two runs,
    // not a documented constant, and the message has to say so.
    expect(near).toMatch(/documents no app-spec size limit/);
  });

  it("warns harder past that size, without claiming to know the ceiling", () => {
    const over = sizeAdvisory(LARGEST_ACCEPTED_SPEC_BYTES + 1);
    expect(over).toMatch(/larger than any spec this deployment is known/);
    expect(over).toMatch(/may be refused/);
    // Never "the limit is N".
    expect(over).not.toMatch(/128 ?KiB|131072/);
  });

  it("still ACCEPTS an oversized spec — the advisory is not a gate", () => {
    const big = JSON.stringify({
      name: "strad-staging",
      services: [
        {
          name: "core",
          envs: [{ key: "STRAD_CONFIG_YAML", value: "x".repeat(200_000) }],
        },
      ],
    });
    const got = assertDeployableSpec(big, { expectedName: "strad-staging" });
    expect(got.name).toBe("strad-staging");
    expect(got.sizeAdvisory).toBeDefined();
  });
});
