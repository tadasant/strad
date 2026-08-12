import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script, deliberately not part of the TS program.
import { drifted, TARGETS } from "../scripts/sync-env-prefix.mjs";

/**
 * The renderer names a variable; the bundle host is the only thing that reads it
 * back. Nothing else in the system sees both halves.
 *
 * `servers/bundle/host` is its own npm project with its own lockfile, so it
 * cannot import `src/secrets/env-prefix.ts` — the rule has to exist twice. Drift
 * between the two copies is the quietest failure in this subsystem: the value is
 * on the container, under a name the server does not look for, and the deploy is
 * green.
 *
 * If it fails: edit `src/secrets/env-prefix.ts` (never the copy), run
 * `npm run envprefix:sync`, and commit both.
 */
describe("the vendored env-prefix rule", () => {
  it("is byte-identical in every tree that speaks it", () => {
    expect(drifted()).toEqual([]);
  });

  it("covers every tree that reads a per-slug variable", () => {
    expect(TARGETS).toEqual(["servers/bundle/host/src/env-prefix.ts"]);
  });
});

/**
 * The host discovers a second instance of a tree by looking for that tree's
 * variables under a slug prefix. Rename a variable in the tree and say nothing
 * here, and discovery stops finding anything — silently, because "no per-slug
 * values" and "the names moved" look identical from the host.
 *
 * These trees are outside the core TS program, so this reads them as text rather
 * than importing them. A grep is a weak assertion and it is the right strength
 * for the thing being asserted: that two files still spell one name the same way.
 */
describe("the marker names the bundle host looks for", () => {
  const host = readFileSync("servers/bundle/host/src/index.ts", "utf8");

  it("are telegram's real credential variables", () => {
    const config = readFileSync(
      "servers/telegram/shared/src/config.ts",
      "utf8",
    );
    for (const name of [
      "TELEGRAM_API_ID",
      "TELEGRAM_API_HASH",
      "TELEGRAM_STRING_SESSION",
    ]) {
      expect(config).toContain(name);
      expect(host).toContain(name);
    }
  });

  it("are remote-filesystem's real prefix and bucket suffix", () => {
    const config = readFileSync(
      "servers/remote-filesystem/shared/src/config.ts",
      "utf8",
    );
    expect(config).toContain("REMOTE_FILESYSTEM_TMP_PUBLIC");
    expect(config).toContain('bucket: "GCS_BUCKET"');
    expect(host).toContain("REMOTE_FS_ENV_PREFIX}_GCS_BUCKET");
  });
});
