/**
 * Vendor the bundle telemetry bootstrap into every supplementary image.
 *
 *   npm run telemetry:sync          # write the copies
 *   npm run telemetry:sync -- --check   # fail if a copy has drifted
 *
 * Each supplementary image is its own Docker build context, so it cannot COPY a
 * file from the repo root — the bootstrap has to live INSIDE each image's
 * directory. That is vendoring, and vendoring rots unless something checks it,
 * so `test/telemetry.sync.test.ts` runs the --check mode in CI.
 *
 * Edit telemetry/bundle/instrument.mjs. Never edit a copy.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCE = join(root, "telemetry", "bundle", "instrument.mjs");

/** Every image that runs a Node process we want resource metrics from. */
export const TARGETS = [
  "servers/fetchpet/otel/instrument.mjs",
  "servers/pointsyeah/otel/instrument.mjs",
  "servers/good-eggs/otel/instrument.mjs",
  "servers/bundle-api/otel/instrument.mjs",
  "servers/onepassword/otel/instrument.mjs",
  "images/bundle-google/otel/instrument.mjs",
];

const BANNER = `// GENERATED — DO NOT EDIT.
// Vendored from telemetry/bundle/instrument.mjs by \`npm run telemetry:sync\`.
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
      console.log(`telemetry: ${TARGETS.length} vendored copies are in sync.`);
      return;
    }
    console.error(
      `::error::telemetry bootstrap is out of sync in:\n  ${stale.join("\n  ")}\n` +
        `Run \`npm run telemetry:sync\` and commit the result.`,
    );
    process.exit(1);
  }

  const want = rendered();
  for (const target of TARGETS) {
    const path = join(root, target);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, want);
  }
  console.log(`telemetry: synced ${TARGETS.length} copies.`);
}

// Only run when invoked directly, so the test can import TARGETS/drifted().
if (process.argv[1] && process.argv[1].endsWith("sync-telemetry.mjs")) main();
