import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { unknownConfigKeys } from "../src/config/strict.ts";

/**
 * The loud-failure gate for a config file.
 *
 * The bug this exists to prevent is not a config that is WRONG — Zod already
 * catches those. It is a config that is IGNORED. `consoleEnvs:` for
 * `consoleEnv:` is valid YAML, parses clean, renders clean, deploys clean, and
 * produces a console with no admin credential. Every check that existed before
 * this one passed it.
 *
 * So the assertions below are mostly about what a check DOES NOT say: that a
 * typo is not silence, that a rendering config is not automatically a correct
 * one, and that the check itself needs no credential to reach that verdict.
 */

const run = promisify(execFile);

const BASE = `
version: 1
gateway:
  name: strad
  env: test
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:1.0.0
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "demo"
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${VIEWER_KEY}"
    consoleEnv:
      SECRETS_PROJECT_ID: "demo"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
`;

async function check(
  yaml: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "strad-check-"));
  const cfg = join(dir, "cfg.yaml");
  writeFileSync(cfg, yaml);
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        "--experimental-transform-types",
        "scripts/check-config.ts",
        "--config",
        cfg,
      ],
      {
        encoding: "utf8",
        // NO environment. Not one secret, not one credential. If this check ever
        // needs one, a workflow in another repo has to be handed one to call it —
        // and a gate nobody can afford to run is not a gate.
        env: { PATH: process.env.PATH ?? "" },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout: string; stderr: string };
    return { code: e.code ?? -1, stdout: e.stdout, stderr: e.stderr };
  }
}

// =============================================================================
// The unknown-key diff, on its own
// =============================================================================

describe("unknownConfigKeys", () => {
  it("catches consoleEnvs: — the typo that renders clean and does nothing", () => {
    const yaml = BASE.replace("    consoleEnv:", "    consoleEnvs:");
    const unknown = unknownConfigKeys(yaml, parseConfig(yaml));

    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.key).toBe("consoleEnvs");
    expect(unknown[0]?.path).toBe("servers[0]");
    expect(unknown[0]?.suggestion).toBe("consoleEnv");
  });

  it("catches an unknown key anywhere in the tree, not just on a server", () => {
    const yaml = BASE.replace("  name: strad", "  name: strad\n  publikUrl: x");
    const unknown = unknownConfigKeys(yaml, parseConfig(yaml));

    expect(unknown.map((u) => `${u.path}.${u.key}`)).toEqual([
      "gateway.publikUrl",
    ]);
  });

  it("suggests the key that was meant, when the schema result carries it", () => {
    // The suggestion is best-effort by construction: it can only name keys the
    // PARSE RESULT holds at that node, so a required-or-defaulted key (this one)
    // is suggestable and an omitted optional one is not. The detection does not
    // depend on it — an unknown key is reported either way.
    const yaml = BASE.replace("    path: /secrets", "    paths: /secrets");
    const unknown = unknownConfigKeys(yaml, parseConfig(yaml));
    expect(unknown[0]?.key).toBe("paths");
    expect(unknown[0]?.suggestion).toBe("path");
  });

  it("says nothing about a config that is entirely known", () => {
    expect(unknownConfigKeys(BASE, parseConfig(BASE))).toEqual([]);
  });

  it("does not mistake a schema DEFAULT for an unknown key", () => {
    // The parse result has many keys the document never wrote (enabled, tools,
    // consoleEnv: {} …). The diff runs one way only, and this is why.
    const minimal = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: echo
    kind: builtin
    module: "@tadasant/strad-server-echo"
    entitlements: [admin]
`;
    expect(unknownConfigKeys(minimal, parseConfig(minimal))).toEqual([]);
  });

  it("leaves open maps open: env:/consoleEnv:/options: keys are not config keys", () => {
    // A server's env var names are the SERVER's vocabulary, not the schema's.
    // Flagging one would make the check unusable on any real config.
    const yaml = BASE.replace(
      '      SECRETS_PROJECT_ID: "demo"\n      SECRETS_SERVICE',
      '      ANY_NAME_AT_ALL: "x"\n      SECRETS_PROJECT_ID: "demo"\n      SECRETS_SERVICE',
    );
    expect(unknownConfigKeys(yaml, parseConfig(yaml))).toEqual([]);
  });

  it("reports every unknown key, not just the first", () => {
    const yaml = BASE.replace("    consoleEnv:", "    consoleEnvs:").replace(
      "  name: strad",
      "  name: strad\n  publikUrl: x",
    );
    expect(unknownConfigKeys(yaml, parseConfig(yaml))).toHaveLength(2);
  });
});

// =============================================================================
// The CI surface: exit codes and annotations
// =============================================================================

describe("check-config", () => {
  it("exits 0 on a valid config, with no credentials in its environment", async () => {
    const { code, stdout } = await check(BASE);
    expect(code).toBe(0);
    expect(stdout).toMatch(/ok$/m);
  });

  it("exits 1 and annotates on the consoleEnvs: typo", async () => {
    const { code, stdout, stderr } = await check(
      BASE.replace("    consoleEnv:", "    consoleEnvs:"),
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/^::error file=.*unknown config key: /m);
    expect(stderr).toContain('did you mean "consoleEnv"');
    expect(stdout).toMatch(/1 problem/);
  });

  it("exits 1 on a schema error", async () => {
    const { code, stderr } = await check(
      BASE.replace("entitlements: [admin]", "entitlements: [nonexistent]"),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("::error");
    expect(stderr).toContain("nonexistent");
  });

  it("exits 1 when the config cannot render", async () => {
    // Two different images in one bundle: valid per-server, unrenderable as a
    // container topology.
    const { code, stderr } = await check(
      `${BASE}  - slug: other
    kind: supplementary-image
    image: ghcr.io/tadasant/other-bundle:1.0.0
    bundle: bundle
    path: /other
    entitlements: [admin]
`,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("::error");
  });

  it("exits 2 when called wrong, so CI can tell a bad config from a bad call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strad-check-"));
    const nowhere = join(dir, "does-not-exist.yaml");
    const byArgs = async (args: string[]) => {
      try {
        await run(
          process.execPath,
          [
            "--experimental-transform-types",
            "scripts/check-config.ts",
            ...args,
          ],
          { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
        );
        return 0;
      } catch (err) {
        return (err as { code?: number }).code ?? -1;
      }
    };

    expect(await byArgs([])).toBe(2);
    expect(await byArgs(["--config", nowhere])).toBe(2);
  });

  it("prints referenced secret NAMES and no values", async () => {
    const { code, stdout } = await check(BASE);
    expect(code).toBe(0);
    expect(stdout).toContain("ADMIN_KEY");
    expect(stdout).toContain("VIEWER_KEY");
    // The dummy values the render used must never reach the log — a config check
    // that printed the spec would be a config check nobody could run on a PR.
    expect(stdout).not.toContain("dummy-value-for-");
  });

  it("catches a consoleEnv: key that fails to reach the core component", async () => {
    // The check that guards the injection bug itself. It passes today because
    // appspec.ts does land these on core; it exists so that stopping would fail
    // the config's own PR rather than one console page in production.
    const { code, stdout } = await check(BASE);
    expect(code).toBe(0);
    expect(stdout).not.toContain("does not land on the core component");
  });
});
