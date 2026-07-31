/**
 * Validate a strad config the way a deploy would, without deploying and without
 * a single credential.
 *
 * This is the CI gate for a config file — the counterpart to `render-spec.ts`,
 * which needs the real secrets and emits the real spec. This script needs
 * neither: it substitutes a dummy value for every `${NAME}` the config
 * references, renders, and throws the result away. So a workflow that calls it
 * needs no cloud auth, no secret access, and cannot leak anything, which is what
 * makes it safe to run on every pull request.
 *
 * Usage (from CI):
 *   node --experimental-transform-types scripts/check-config.ts \
 *     --config infra/strad.staging.yaml
 *
 * Exit codes:
 *   0  the config is valid
 *   1  the config has at least one problem (every problem is printed)
 *   2  the script was called wrong (missing --config, unreadable file)
 *
 * Every problem is also emitted as a `::error::` workflow command, so GitHub
 * annotates the run. Output is names and structure only — never a value.
 *
 * ## The four checks
 *
 *   1. SCHEMA. The same `parseConfig` the gateway boots with: types, required
 *      fields, and the cross-field rules in `superRefine` (an undefined role, two
 *      images in one bundle, a `tools:` block with neither allow nor deny).
 *   2. UNKNOWN KEYS. The check the others cannot do. Zod strips what it does not
 *      recognise, so `consoleEnvs:` for `consoleEnv:` passes every other check in
 *      this list and does nothing at runtime. See src/config/strict.ts.
 *   3. RENDER. The full `renderAppSpec` — a smoke test that the config the schema
 *      accepted can actually produce a spec, and the step that gives checks 4 a
 *      real spec to inspect rather than an assumption about one.
 *   4. CONSOLE SCOPE. Every key a server declares under `consoleEnv:` must reach
 *      the `core` component, and no two servers may claim one key with different
 *      values. Both are silent failures with a visible symptom much later: the
 *      first is a console reporting a credential missing that the config plainly
 *      declares, the second is a console running as the wrong identity.
 *   5. BUNDLE SCOPE. The same collision one layer in: two servers sharing a
 *      bundle may not claim one `env:` key with different values, because one
 *      bundle is one container with one environment. Declaring a key IDENTICALLY
 *      stays legal — capability variants do it on purpose.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseConfig } from "../src/config/load.ts";
import type { StradConfig } from "../src/config/schema.ts";
import { formatUnknownKey, unknownConfigKeys } from "../src/config/strict.ts";
import {
  collectSecretRefs,
  parseImage,
  renderAppSpec,
  type AppSpec,
} from "../src/deploy/appspec.ts";
import {
  bakedSecretNames,
  bundleScopeProblems,
  consoleScopeProblems,
} from "../src/deploy/preflight.ts";

function usage(message: string): never {
  console.error(`::error::${message}`);
  console.error(
    "usage: check-config --config <path> [--image <ref>] [--app <name>]",
  );
  process.exit(2);
}

// A typo'd flag is exit 2, not exit 1. `parseArgs` throws on an unknown option
// or a stray positional, and a tool whose whole job is catching typos should not
// answer `--conifg` with a stack trace and the exit code that means "your config
// is broken".
let values: { config?: string; image?: string; app?: string };
try {
  ({ values } = parseArgs({
    options: {
      config: { type: "string" },
      image: { type: "string" },
      app: { type: "string" },
    },
  }));
} catch (err) {
  usage((err as Error).message);
}

if (!values.config) usage("--config is required");

let raw: string;
try {
  raw = readFileSync(values.config, "utf8");
} catch (err) {
  usage(`cannot read ${values.config}: ${(err as Error).message}`);
}

const problems: string[] = [];
function problem(message: string): void {
  problems.push(message);
  console.error(`::error file=${values.config}::${message}`);
}

/** Everything that failed, then a one-line verdict. Never partial-credit. */
function verdict(): never {
  if (problems.length > 0) {
    console.log(
      `\n${values.config}: ${problems.length} problem(s)\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    process.exit(1);
  }
  console.log(`${values.config}: ok`);
  process.exit(0);
}

// --- 1. schema --------------------------------------------------------------
//
// A config that does not parse cannot be checked any further: there is nothing
// to diff against and nothing to render. Report and stop.
function parseOrReport(): StradConfig {
  try {
    return parseConfig(raw, values.config);
  } catch (err) {
    problem((err as Error).message);
    verdict();
  }
}
const config = parseOrReport();

// --- 2. unknown keys --------------------------------------------------------
for (const unknown of unknownConfigKeys(raw, config)) {
  problem(
    `unknown config key: ${formatUnknownKey(unknown)} — the schema does not ` +
      `define it, so it is silently ignored and does nothing`,
  );
}

// --- 3. render --------------------------------------------------------------
//
// Dummy values, one per referenced name. The point is to exercise the renderer's
// structure — the real values change nothing about whether a spec can be built,
// and requiring them would mean a check that only CI-with-credentials can run.
const dummySecrets: Record<string, string> = {};
for (const name of [
  ...bakedSecretNames(config),
  ...collectSecretRefs(config),
]) {
  dummySecrets[name] = `dummy-value-for-${name}`;
}

let spec: AppSpec | undefined;
try {
  spec = renderAppSpec({
    config,
    appName: values.app ?? "strad-check",
    region: "nyc",
    image: parseImage(values.image ?? "ghcr.io/tadasant/strad:0.0.0-check"),
    env: [],
    secrets: dummySecrets,
  });
} catch (err) {
  problem(`the config does not render: ${(err as Error).message}`);
}

// --- 4. console scope -------------------------------------------------------
if (spec) {
  for (const message of consoleScopeProblems(config, spec)) problem(message);
}

// --- 5. bundle scope --------------------------------------------------------
//
// No spec needed: the bundle grouping is in the config.
for (const message of bundleScopeProblems(config)) problem(message);

// --- what the deployment must seed ------------------------------------------
//
// Names, never values, and only on success: on a failed check this would bury
// the errors. This is the list the deploy environment has to be able to supply,
// so an operator can diff it against what is seeded.
if (problems.length === 0) {
  const referenced = [
    ...new Set([...bakedSecretNames(config), ...collectSecretRefs(config)]),
  ].sort();
  console.log(
    `${values.config}: ${config.servers.length} server(s), ` +
      `${referenced.length} referenced secret name(s)`,
  );
  if (referenced.length > 0) console.log(`  ${referenced.join("\n  ")}`);
}

verdict();
