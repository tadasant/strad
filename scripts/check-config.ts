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
 *   3. RENDER. The full `renderAppSpec`, so a config that is individually valid
 *      but cannot produce a spec (a bundle with two images, a `:latest`
 *      supplementary override) fails here rather than mid-deploy.
 *   4. CONSOLE SCOPE. Every key a server declares under `consoleEnv:` must
 *      actually appear on the rendered `core` component. That is a real bug this
 *      repo shipped, in the other direction: the key was emitted and the console
 *      read it by the wrong name, and `/ui/secrets` reported a credential missing
 *      that was sitting in its own environment.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseConfig } from "../src/config/load.ts";
import { formatUnknownKey, unknownConfigKeys } from "../src/config/strict.ts";
import {
  collectSecretRefs,
  parseImage,
  renderAppSpec,
  type AppSpec,
} from "../src/deploy/appspec.ts";
import { bakedSecretNames } from "../src/deploy/preflight.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    image: { type: "string" },
    app: { type: "string" },
  },
});

function usage(message: string): never {
  console.error(`::error::${message}`);
  console.error(
    "usage: check-config --config <path> [--image <ref>] [--app <name>]",
  );
  process.exit(2);
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
let config;
try {
  config = parseConfig(raw, values.config);
} catch (err) {
  problem((err as Error).message);
  verdict();
}

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
  const core = spec.services.find((s) => s.name === "core");
  const onCore = new Set(core?.envs.map((e) => e.key) ?? []);
  for (const server of config.servers) {
    if (server.kind !== "supplementary-image" || !server.enabled) continue;
    for (const key of Object.keys(server.consoleEnv)) {
      if (onCore.has(key)) continue;
      problem(
        `server "${server.slug}" declares ${key} under consoleEnv: but it does ` +
          `not land on the core component — the console cannot read it`,
      );
    }
  }
}

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
