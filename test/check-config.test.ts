import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import type { ServerConfig, StradConfig } from "../src/config/schema.ts";
import { unknownConfigKeys } from "../src/config/strict.ts";
import { consoleScopeProblems } from "../src/deploy/preflight.ts";

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

  it("exits 1 on a cross-field rule: two images in one bundle", async () => {
    // Each server entry is individually valid; the topology they describe is
    // not. This is a superRefine rule, so it is caught by the schema check —
    // named here for what it exercises, not for what it looks like.
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
    // A typo'd FLAG, in a tool whose job is catching typos. `parseArgs` throws
    // on an unknown option, and an unhandled throw would exit 1 — the code that
    // means "your config is broken" — with a stack trace.
    expect(await byArgs(["--conifg", "x"])).toBe(2);
    expect(await byArgs(["strad.config.yaml"])).toBe(2); // stray positional
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

  it("reports a real config as having no console-scope problem", async () => {
    const { code, stdout } = await check(BASE);
    expect(code).toBe(0);
    expect(stdout).not.toContain("does not land on the core component");
  });
});

// =============================================================================
// Check 4, driven directly — the CLI cannot falsify it
// =============================================================================

/**
 * A config carrying a server the SCHEMA would refuse.
 *
 * Only for asserting a downstream defence against a state the config gate now
 * blocks. Building it by hand keeps the deeper check honest: "unreachable
 * through the front door" is a reason to keep a fence, not to stop testing it.
 */
function withExtraServer(
  config: StradConfig,
  server: ServerConfig,
): StradConfig {
  return { ...config, servers: [...config.servers, server] };
}

describe("consoleScopeProblems", () => {
  // Through the CLI this check can only ever pass: the renderer and the check
  // walk the same servers, so the spec always carries the keys. Drive it with a
  // spec that has LOST the key, which is what a regression in appspec.ts would
  // actually look like.
  const config = parseConfig(BASE);

  const specWith = (coreKeys: string[]) => ({
    services: [
      { name: "core", envs: coreKeys.map((key) => ({ key })) },
      { name: "bundle", envs: [] },
    ],
  });

  it("says nothing when every consoleEnv key is on core", () => {
    expect(
      consoleScopeProblems(
        config,
        specWith([
          "SECRETS_PROJECT_ID",
          "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
        ]),
      ),
    ).toEqual([]);
  });

  it("catches a consoleEnv key the renderer failed to put on core", () => {
    const problems = consoleScopeProblems(
      config,
      specWith(["SECRETS_PROJECT_ID"]), // the admin key never landed
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON");
    expect(problems[0]).toContain("does not land on the core component");
  });

  it("catches two servers claiming one key with different values", () => {
    // core holds ONE flat environment, so the second declaration silently
    // overwrites the first and one console runs as the wrong identity.
    //
    // The config is assembled rather than parsed on purpose: `parseConfig` now
    // REJECTS this shape outright (the env collision block in
    // src/config/schema.ts), which is the earlier and better gate. This check
    // still has to hold, because it reads the RENDERED SPEC — a renderer that
    // dropped or merged a key would produce this state from a config that
    // validated cleanly, and nothing else would notice.
    const twoServers = withExtraServer(parseConfig(BASE), {
      kind: "supplementary-image",
      slug: "secrets-two",
      image: "ghcr.io/tadasant/strad-bundle:1.0.0",
      bundle: "bundle",
      path: "/secrets-two",
      entitlements: ["admin"],
      enabled: true,
      timeoutMs: 120_000,
      params: false,
      confirmations: false,
      skipConfirmations: false,
      confirmationHeaders: {},
      paramsWritable: [],
      paramsRefresh: [],
      mayBeUnseeded: [],
      env: {},
      headers: {},
      consoleEnv: {
        SECRETS_PROJECT_ID: "other-project",
        SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${OTHER_ADMIN_KEY}",
      },
      consoleStores: [],
      mcpStores: [],
      reaches: [],
      reachableFrom: [],
    });
    const problems = consoleScopeProblems(
      twoServers,
      specWith([
        "SECRETS_PROJECT_ID",
        "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
      ]),
    );
    expect(problems).toHaveLength(2);
    for (const p of problems) expect(p).toContain("silently overwrites");
  });

  it("does not flag two servers declaring one key with the SAME value", () => {
    // The staging config does exactly this on purpose: several servers repeat a
    // non-secret literal. Identical values collapse to the same environment.
    const twins = parseConfig(`${BASE}  - slug: secrets-twin
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:1.0.0
    bundle: bundle
    path: /secrets-twin
    entitlements: [admin]
    consoleEnv:
      SECRETS_PROJECT_ID: "demo"
`);
    expect(
      consoleScopeProblems(
        twins,
        specWith([
          "SECRETS_PROJECT_ID",
          "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
        ]),
      ),
    ).toEqual([]);
  });

  it("ignores a disabled server, which renders nothing", () => {
    const disabled = parseConfig(
      BASE.replace(
        "  - slug: secrets",
        "  - slug: secrets\n    enabled: false",
      ),
    );
    expect(consoleScopeProblems(disabled, specWith([]))).toEqual([]);
  });
});
