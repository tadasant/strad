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
 *
 * It also prints the byte count PER COMPONENT, and warns when the total is near
 * or past the largest spec this deployment is known to have deployed. Here that
 * stays a warning: `scripts/render-spec.ts` is where the same number is a hard
 * refusal, and by the time a spec reaches this script it has either passed that
 * gate or been let through by `--max-spec-bytes` — which is a deliberate act
 * this script has no business overruling. What it is for is the state prod was
 * in on 2026-08-30: headroom nobody had measured, somewhere between 1 and
 * 10,332 bytes. See `src/deploy/spec-size.ts` for the measurements behind
 * `LARGEST_ACCEPTED_SPEC_BYTES` and for why the refusal sits exactly there.
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
  const {
    name,
    components,
    bytes,
    compactBytes,
    componentBytes,
    sizeAdvisory,
  } = assertDeployableSpec(text, { expectedName });
  console.error(
    `[assert-spec] ${path}: "${name}", ${bytes} bytes, ` +
      `${components.length} component(s): ${components.join(", ")}.`,
  );
  // Where the bytes are, largest first. Names and numbers only — both are
  // config, and neither can carry a value out of a file that holds secrets.
  //
  // COMPACT bytes, including the total on this line, so the parts and the whole
  // share a unit. The figure on the line above is the file, which carries the
  // renderer's indentation as well.
  console.error(
    `[assert-spec] ${compactBytes} bytes compact: ` +
      componentBytes.map((c) => `${c.name} ${c.bytes}`).join(", "),
  );
  // A ::warning::, never an ::error::. The ceiling this is measured against is
  // an observation with a range around it, not a documented constant, so it
  // must not be able to fail a deploy that would have worked. See
  // LARGEST_ACCEPTED_SPEC_BYTES.
  if (sizeAdvisory) console.error(`::warning::${sizeAdvisory}`);
} catch (err) {
  if (!(err instanceof SpecFileError)) throw err;
  console.error(`::error::${path} is not deployable — ${err.message}`);
  process.exit(1);
}
