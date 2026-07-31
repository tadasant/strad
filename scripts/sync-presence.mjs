/**
 * Vendor the presence vocabulary into the bundle host tree.
 *
 *   npm run presence:sync            # write the copy
 *   npm run presence:sync -- --check # fail if the copy has drifted
 *
 * `servers/bundle/host` is its own npm project with its own lockfile and its own
 * compiler settings, so it cannot import `src/secrets/presence.ts` across the
 * boundary — the file has to live inside the host tree. That is vendoring, and
 * vendoring rots unless something checks it, so `test/presence.sync.test.ts`
 * runs the --check mode in CI.
 *
 * Why it must not drift, specifically: core and the bundle each classify values
 * the other cannot see, and the console renders both in one list. Two copies of
 * the placeholder table means one component calls `change-me` filler and the
 * other calls it a credential, on the same page, under the same word.
 *
 * Edit src/secrets/presence.ts. Never edit the copy.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCE = join(root, "src", "secrets", "presence.ts");

/** Every tree that has to speak the same five words. */
export const TARGETS = ["servers/bundle/host/src/presence.ts"];

const BANNER = `// GENERATED — DO NOT EDIT.
// Vendored from src/secrets/presence.ts by \`npm run presence:sync\`.
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
      console.log(`presence: ${TARGETS.length} vendored copy in sync.`);
      return;
    }
    console.error(
      `::error::the presence vocabulary is out of sync in:\n  ${stale.join("\n  ")}\n` +
        `Run \`npm run presence:sync\` and commit the result.`,
    );
    process.exit(1);
  }

  const want = rendered();
  for (const target of TARGETS) {
    const path = join(root, target);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, want);
  }
  console.log(`presence: synced ${TARGETS.length} copy.`);
}

// Only run when invoked directly, so the test can import TARGETS/drifted().
if (process.argv[1] && process.argv[1].endsWith("sync-presence.mjs")) main();
