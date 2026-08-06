import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * The CI gate itself, end to end: an observer's document on one side, a config
 * on the other, and an exit code.
 *
 * The unit tests next door (tool-surface.test.ts) are about the verdict. These
 * are about the things a CI step is judged on and a library is not — that a
 * finding is exit 1 and an annotation with the entry in it, that an unusable
 * dump is exit 2 rather than a green run that checked nothing, and that the
 * skipped roster prints even when everything passes.
 */

const run = promisify(execFile);

const IMAGE = "ghcr.io/tadasant/strad-bundle:latest";

const CONFIG = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
servers:
  - slug: gmail-ro
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle
    path: /gmail
    entitlements: [admin]
    tools:
      allow:
        - list_email_conversations
        - get_email_conversation
  - slug: deepwiki
    kind: remote-http
    url: https://mcp.deepwiki.com/mcp
    entitlements: [admin]
    tools:
      allow: [ask_question]
`;

const TOOLS = {
  version: "1.0.0",
  mounts: {
    "/gmail": {
      tools: [
        "list_email_conversations",
        "get_email_conversation",
        "send_email",
      ],
    },
    "/secrets": { tools: ["list_parameters"], partial: "no credential here" },
  },
};

async function check(
  config: string,
  tools: unknown,
  extra: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "strad-policy-"));
  const cfg = join(dir, "cfg.yaml");
  const dump = join(dir, "tools.json");
  writeFileSync(cfg, config);
  writeFileSync(dump, JSON.stringify(tools));
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        "--experimental-transform-types",
        "scripts/check-tool-policy.ts",
        "--tools",
        dump,
        "--config",
        cfg,
        ...extra,
      ],
      // No environment, like check-config: this gate reads tool names and a
      // config, and holds no credential that could make it un-runnable anywhere.
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout: string; stderr: string };
    return { code: e.code ?? -1, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("check-tool-policy", () => {
  it("passes a good config, and still prints what it did NOT cover", async () => {
    const { code, stdout } = await check(CONFIG, TOOLS);

    expect(code).toBe(0);
    expect(stdout).toContain("ok      gmail-ro — 2 entr(ies) vs /gmail");
    expect(stdout).toContain(
      "every checkable tools: entry names a tool its mount serves",
    );
    // "Not covered" and "covered and clean" must not look alike, or the day a
    // slug stops being checkable is the day it silently stops being checked.
    expect(stdout).toContain("skipped deepwiki — kind: remote-http");
    expect(stdout).toContain("1 policy/policies checked");
  });

  it("fails, exit 1, naming the slug and the entry, on a misspelling", async () => {
    const typo = CONFIG.replace(
      "- get_email_conversation\n",
      "- get_email_conversaton\n",
    );
    const { code, stdout, stderr } = await check(typo, TOOLS);

    expect(code).toBe(1);
    // The GitHub annotation lands on the config file, with the fix in it.
    expect(stderr).toContain("::error file=");
    expect(stderr).toContain(
      'server "gmail-ro": tools.allow names "get_email_conversaton", which ' +
        '/gmail does not serve. Did you mean "get_email_conversation"?',
    );
    // And the run says what the mount really serves, so the fix needs no digging.
    expect(stdout).toContain("/gmail serves: get_email_conversation");
  });

  it("does not fail for a slug it could not enumerate", async () => {
    // gmail-ro's mount is absent from this dump entirely. That is "I could not
    // find out", not "the config is wrong", and the two call for opposite
    // responses.
    const { code, stdout } = await check(CONFIG, {
      mounts: { "/slack": { tools: ["slack_get_channels"] } },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("skipped gmail-ro — ");
    expect(stdout).toContain("mounts nothing at /gmail");
  });

  it("refuses a dump with no mounts in it — exit 2, not a green no-op", async () => {
    const { code, stderr } = await check(CONFIG, { mounts: {} });
    expect(code).toBe(2);
    expect(stderr).toContain("no mounts in the document");
  });

  it("is exit 2 when called wrong, never exit 1", async () => {
    const noArgs = await run(
      process.execPath,
      ["--experimental-transform-types", "scripts/check-tool-policy.ts"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    ).catch((err: { code?: number; stderr: string }) => err);

    expect((noArgs as { code?: number }).code).toBe(2);
    expect((noArgs as { stderr: string }).stderr).toContain(
      "--tools is required",
    );
  });
});
