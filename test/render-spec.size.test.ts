import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LARGEST_ACCEPTED_SPEC_BYTES } from "../src/deploy/spec-size.ts";

/**
 * The size gate, driven through the real `scripts/render-spec.ts`.
 *
 * The unit tests next door check the arithmetic. What is checked HERE is the
 * property prod depends on: the script refuses to WRITE an oversize spec, and
 * still writes every spec that is not. A guard that computed the right verdict
 * and then emitted anyway would pass every test in spec-size.test.ts.
 *
 * The oversize config is built out of a long `description:` — a real, schema-
 * valid field on a server entry — rather than by lowering the ceiling with
 * `--max-spec-bytes`, so the refusal these tests see is the DEFAULT one that
 * prod will render against.
 */

const CORE = `ghcr.io/tadasant/strad:sha-${"a".repeat(40)}`;

const config = (description?: string) => `
version: 1
gateway:
  name: strad
  env: staging
  publicUrl: https://staging.strad.tadasant.com
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: deepwiki
    kind: remote-http
    url: https://mcp.deepwiki.com/mcp
    entitlements: [admin]
${description === undefined ? "" : `    description: "${description}"\n`}`;

interface Rendered {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * `spawnSync`, so a successful run's stderr is readable too — the warn band and
 * the headroom line both exit zero, and both are assertions below.
 */
function render(configText: string, args: string[] = []): Rendered {
  const dir = mkdtempSync(join(tmpdir(), "strad-size-"));
  const cfg = join(dir, "cfg.yaml");
  writeFileSync(cfg, configText);
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
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        STRAD_TOKENS: "[]",
        STRAD_INTERNAL_TOKEN: "internal",
      },
    },
  );
  return { stdout: out.stdout, stderr: out.stderr, status: out.status ?? 1 };
}

describe("render-spec, the size of what it emits", () => {
  it("emits an ordinary spec and reports its headroom", () => {
    const out = render(config());
    expect(out.status).toBe(0);
    const bytes = Buffer.byteLength(out.stdout, "utf8");
    expect(JSON.parse(out.stdout).name).toBe("strad-staging");
    // The number in the log is the number of the bytes actually written, or the
    // gate is measuring a document nobody deploys.
    expect(out.stderr).toContain(
      `[render-spec] spec: ${bytes} bytes of ${LARGEST_ACCEPTED_SPEC_BYTES} ` +
        `(${LARGEST_ACCEPTED_SPEC_BYTES - bytes} of headroom).`,
    );
    expect(out.stderr).not.toMatch(/::error::/);
    expect(out.stderr).not.toMatch(/::warning::the rendered app spec/);
  });

  it("REFUSES an oversize spec, and writes nothing", () => {
    // ~150,000 bytes of description: past the 141,342-byte spec App Platform
    // refused on 2026-08-30, so this is the shape of the render that took prod
    // down, not a synthetic one.
    const out = render(config("x".repeat(150_000)));
    expect(out.status).toBe(1);
    // Nothing on stdout. `doctl apps update --spec` is fed this stream, and a
    // truncated-but-present spec is worse than none.
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(
      /::error::the rendered app spec is [\d,]+ bytes/,
    );
    expect(out.stderr).toContain("131,010-byte ceiling");
  });

  it("names the driver in the refusal, which the DigitalOcean 400 does not", () => {
    const out = render(config("x".repeat(150_000)));
    expect(out.stderr).toMatch(/Where the bytes are:/);
    expect(out.stderr).toMatch(/core: [\d,]+ bytes of env over \d+ var\(s\)/);
    expect(out.stderr).toContain("STRAD_CONFIG_YAML");
    // And says what to do, rather than only that something is wrong.
    expect(out.stderr).toContain("--max-spec-bytes");
  });

  it("puts no config text in the refusal, only names and sizes", () => {
    // A config carries secrets in some deployments and this message lands in a
    // build log.
    const out = render(config("x".repeat(150_000)));
    expect(out.stderr).not.toContain("xxxx");
  });

  it("emits the same oversize spec when --max-spec-bytes allows it", () => {
    // The escape hatch. prod renders this script straight from `main`, so an
    // operator who learns App Platform takes more must be able to say so
    // without waiting on a PR here.
    const out = render(config("x".repeat(150_000)), [
      "--max-spec-bytes",
      "500000",
    ]);
    expect(out.status).toBe(0);
    expect(Buffer.byteLength(out.stdout, "utf8")).toBeGreaterThan(150_000);
    expect(JSON.parse(out.stdout).name).toBe("strad-staging");
  });

  it("warns, and still emits, inside the band below the ceiling", () => {
    // A spec under the ceiling is a spec App Platform is observed to take, so
    // this may never fail a deploy — but the two outages were both growth
    // nobody was watching, so it has to be said out loud.
    const out = render(config("x".repeat(50_000)), [
      "--max-spec-bytes",
      "60000",
    ]);
    expect(out.status).toBe(0);
    expect(out.stderr).toMatch(
      /::warning::the rendered app spec is [\d,]+ bytes, 8\d% of the 60,000-byte ceiling/,
    );
    expect(out.stderr).toMatch(/bytes of headroom left/);
    expect(JSON.parse(out.stdout).name).toBe("strad-staging");
  });

  it("refuses a --max-spec-bytes that is not a number, before doing any work", () => {
    const out = render(config(), ["--max-spec-bytes", "128kb"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(
      /::error::--max-spec-bytes must be a positive whole number of bytes/,
    );
    expect(out.stdout).toBe("");
  });

  it("still bakes the config WITHOUT its comments, and still emits it", () => {
    // Ask 1 of issue #137, asserted here alongside ask 2 because the two are
    // one budget: the comment stripping is what keeps prod under the ceiling
    // this gate enforces (prod's config file is 77,824 bytes and inlines to
    // 21,628). test/config-inline.test.ts owns the round-trip's correctness;
    // what this checks is that the render still reports the saving next to the
    // size it now also reports.
    const commented = `# a comment worth ${"y".repeat(400)} bytes\n${config()}`;
    const out = render(commented);
    expect(out.status).toBe(0);
    expect(out.stderr).toMatch(
      /\[render-spec\] STRAD_CONFIG_YAML: (\d+) bytes \((\d+) in the file; comments and formatting are not deployed\)\./,
    );
    const baked = (
      JSON.parse(out.stdout) as {
        services: { envs: { key: string; value: string }[] }[];
      }
    ).services[0]!.envs.find((e) => e.key === "STRAD_CONFIG_YAML")!.value;
    expect(baked).not.toContain("a comment worth");
  });
});
