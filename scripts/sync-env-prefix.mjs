/**
 * Vendor the slug/box-name mangling rule into the bundle host tree.
 *
 *   npm run envprefix:sync            # write the copy
 *   npm run envprefix:sync -- --check # fail if the copy has drifted
 *
 * `servers/bundle/host` is its own npm project with its own lockfile and its own
 * compiler settings, so it cannot import `src/secrets/env-prefix.ts` across the
 * boundary — the file has to live inside the host tree. That is vendoring, and
 * vendoring rots unless something checks it, so `test/env-prefix.sync.test.ts`
 * runs the --check mode in CI.
 *
 * Why it must not drift, specifically: the RENDERER names a variable
 * (`TELEGRAM_RO__TELEGRAM_API_HASH`) and the HOST is the only thing that reads it
 * back. Two copies of the rule means the credential is present on the container
 * and invisible to the server that needs it — the deploy is green, the boot log
 * is clean, and every tool call fails on a missing variable. There is no third
 * component to notice.
 *
 * Edit src/secrets/env-prefix.ts. Never edit the copy.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCE = join(root, "src", "secrets", "env-prefix.ts");

/** Every tree that has to agree on what a variable is called. */
export const TARGETS = ["servers/bundle/host/src/env-prefix.ts"];

const BANNER = `// GENERATED — DO NOT EDIT.
// Vendored from src/secrets/env-prefix.ts by \`npm run envprefix:sync\`.
// Edit the source, run the sync, and commit both. CI fails if these drift.
`;

export function rendered() {
  return BANNER + readFileSync(SOURCE, "utf8");
}

/** Paths whose vendored copy is missing or stale. */
export function drifted() {
  const want = rendered();
  return TARGETS.filter((target) => {
    const path = join(root, target);
    if (!existsSync(path)) return true;
    return readFileSync(path, "utf8") !== want;
  });
}

function main() {
  const check = process.argv.includes("--check");
  const stale = drifted();

  if (check) {
    if (stale.length === 0) {
      console.log(`env-prefix: ${TARGETS.length} vendored copy in sync.`);
      return;
    }
    console.error(
      `::error::the slug env-prefix rule is out of sync in:\n  ${stale.join("\n  ")}\n` +
        `Run \`npm run envprefix:sync\` and commit the result.`,
    );
    process.exit(1);
  }

  const want = rendered();
  for (const target of TARGETS) {
    const path = join(root, target);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, want);
  }
  console.log(`env-prefix: synced ${TARGETS.length} copy.`);
}

// Only run when invoked directly, so the test can import TARGETS/drifted().
if (process.argv[1] && process.argv[1].endsWith("sync-env-prefix.mjs")) main();
