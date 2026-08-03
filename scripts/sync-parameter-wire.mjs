/**
 * Vendor the parameter wire encoding into the secrets server tree.
 *
 *   npm run wire:sync            # write the copy
 *   npm run wire:sync -- --check # fail if the copy has drifted
 *
 * `servers/secrets` is its own npm project with its own lockfile and its own
 * compiler settings, so it cannot import `src/secrets/parameters/wire.ts` across
 * the boundary — the file has to live inside that tree. That is vendoring, and
 * vendoring rots unless something checks it, so `test/parameter-wire.sync.test.ts`
 * runs the --check mode in CI.
 *
 * Why it must not drift, specifically: both halves address the SAME GCP
 * parameter. An id fold that folds one character differently addresses a resource
 * the other half cannot see, and a reader that does not know the `encoding` field
 * exists hands a child process base64url TEXT as its credential and reports
 * success. Everything else in this subsystem fails loudly; this seam is the
 * exception (HACKS.md #33), which is why it gets a check rather than a comment.
 *
 * Edit src/secrets/parameters/wire.ts. Never edit the copy.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCE = join(root, "src", "secrets", "parameters", "wire.ts");

/** Every tree that has to address the same parameter the same way. */
export const TARGETS = ["servers/secrets/shared/src/parameter-wire.ts"];

const BANNER = `// GENERATED — DO NOT EDIT.
// Vendored from src/secrets/parameters/wire.ts by \`npm run wire:sync\`.
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
      console.log(`parameter wire: ${TARGETS.length} vendored copy in sync.`);
      return;
    }
    console.error(
      `::error::the parameter wire encoding is out of sync in:\n  ${stale.join("\n  ")}\n` +
        `Run \`npm run wire:sync\` and commit the result.`,
    );
    process.exit(1);
  }

  const want = rendered();
  for (const target of TARGETS) {
    const path = join(root, target);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, want);
  }
  console.log(`parameter wire: synced ${TARGETS.length} copy.`);
}

// Only run when invoked directly, so the test can import TARGETS/drifted().
if (process.argv[1] && process.argv[1].endsWith("sync-parameter-wire.mjs")) {
  main();
}
