/**
 * Assert a rendered App Platform spec is deployable, immediately before doctl
 * reads it.
 *
 * A render step that exits 0 having produced a spec App Platform will refuse is
 * the failure this closes: the deploy job stayed green through render, through
 * the credential attach and through `doctl apps list`, and the first thing that
 * said anything was wrong was a 400 from DigitalOcean naming a field
 * (".name in body is required") that the renderer always sets. See
 * `src/deploy/spec-file.ts` for what happened and why an empty file gets that
 * far.
 *
 * Usage (from CI):
 *   node --experimental-transform-types scripts/assert-spec.ts \
 *     "$RUNNER_TEMP/spec.json" --expect-name strad-staging
 *
 * `--expect-name` is REQUIRED, and that is the argument that matters. Without
 * it the check degrades to "is this a spec at all", and the expensive case — a
 * VALID spec belonging to another deployment, which would deploy green — passes.
 * The library keeps it optional because a caller may genuinely not know the
 * name; a deploy always does, so the deploy CLI insists.
 *
 * Prints the app name, the component names and the byte count to STDERR — the
 * spec itself holds secret values and is never echoed. Exits 1 with a
 * `::error::` annotation on any defect.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  assertDeployableSpec,
  SpecFileError,
} from "../src/deploy/spec-file.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "expect-name": { type: "string" },
  },
});

const path = positionals[0];
const expectedName = values["expect-name"];
if (!path || !expectedName) {
  console.error("usage: assert-spec <spec.json> --expect-name <app>");
  process.exit(1);
}

let text: string;
try {
  text = readFileSync(path, "utf8");
} catch (err) {
  console.error(
    `::error::cannot read the rendered spec at ${path}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

try {
  const { name, components, bytes } = assertDeployableSpec(text, {
    expectedName,
  });
  console.error(
    `[assert-spec] ${path}: "${name}", ${bytes} bytes, ` +
      `${components.length} component(s): ${components.join(", ")}.`,
  );
} catch (err) {
  if (!(err instanceof SpecFileError)) throw err;
  console.error(`::error::${path} is not deployable — ${err.message}`);
  process.exit(1);
}
