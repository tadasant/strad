import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The host half of STRAD_ENV_COPIES: the per-slug names the renderer baked once
 * are back in `process.env` before any other module of this host runs, and so
 * in every child process it spawns. Exercised against the BUILT module in a
 * real child `node`, because "first import, as a side effect" is a property of
 * module evaluation that an in-process import cannot show.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function bootWith(
  env: Record<string, string>,
): Record<string, string | undefined> {
  const script = `
    await import(${JSON.stringify(join(root, "dist", "env-copies.js"))});
    const { execFileSync } = await import("node:child_process");
    const child = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"]);
    process.stdout.write(child);
  `;
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out) as Record<string, string | undefined>;
}

describe("env-copies, at boot", () => {
  it("restores every copy, removes the list, and a child process inherits the result", () => {
    const env = bootWith({
      TOKEN: "fake-token",
      A__CLIENT_ID: "fake-id",
      STRAD_ENV_COPIES: "TOKEN=SLACK__,SLACK_READONLY__;A__CLIENT_ID=B__CLIENT_ID",
    });
    expect(env.SLACK__TOKEN).toBe("fake-token");
    expect(env.SLACK_READONLY__TOKEN).toBe("fake-token");
    expect(env.B__CLIENT_ID).toBe("fake-id");
    expect(env.STRAD_ENV_COPIES).toBeUndefined();
  });

  it("refuses to boot on a list it cannot read", () => {
    expect(() => bootWith({ STRAD_ENV_COPIES: "TOKEN=" })).toThrow();
  });

  it("is the first import of the host, so nothing reads the environment before it", () => {
    const source = readFileSync(join(root, "src", "index.ts"), "utf8");
    const firstImport = /^import\s[^;]*;/m.exec(source)?.[0];
    expect(firstImport).toBe('import "./env-copies.js";');
  });
});
