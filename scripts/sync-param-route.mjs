/**
 * Vendor the parameter write-back wire into the bundle host tree.
 *
 *   npm run paramroute:sync            # write the copy
 *   npm run paramroute:sync -- --check # fail if the copy has drifted
 *
 * `servers/bundle/host` is its own npm project with its own lockfile and its own
 * compiler settings, so it cannot import `src/secrets/param-route.ts` across the
 * boundary — the file has to live inside the host tree. That is vendoring, and
 * vendoring rots unless something checks it, so `test/param-route.sync.test.ts`
 * runs the --check mode in CI.
 *
 * Why it must not drift, specifically: core SERVES this route and the host is the
 * only thing that CALLS it. They are the two ends of one wire — the path shape,
 * the protocol number, the body — and a drift means a container that persists a
 * rotated credential to a URL core does not serve. That failure is loud on the
 * write (the mount degrades) and SILENT on the boot read, which falls back to the
 * baked environment and looks exactly like a deployment nobody has rotated yet.
 *
 * Edit src/secrets/param-route.ts. Never edit the copy.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCE = join(root, "src", "secrets", "param-route.ts");

/** Every tree that has to speak the same wire. */
export const TARGETS = ["servers/bundle/host/src/param-route.ts"];

const BANNER = `// GENERATED — DO NOT EDIT.
// Vendored from src/secrets/param-route.ts by \`npm run paramroute:sync\`.
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
      console.log(`param-route: ${TARGETS.length} vendored copy in sync.`);
      return;
    }
    console.error(
      `::error::the parameter write-back wire is out of sync in:\n  ${stale.join("\n  ")}\n` +
        `Run \`npm run paramroute:sync\` and commit the result.`,
    );
    process.exit(1);
  }

  const want = rendered();
  for (const target of TARGETS) {
    const path = join(root, target);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, want);
  }
  console.log(`param-route: synced ${TARGETS.length} copy.`);
}

// Only run when invoked directly, so the test can import TARGETS/drifted().
if (process.argv[1] && process.argv[1].endsWith("sync-param-route.mjs")) main();
