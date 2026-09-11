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
 * annotates the run, and a finding that is worth saying but not worth failing on
 * — a legacy App Platform plan — is a `::warning::` on an otherwise clean exit 0.
 * Output is names and structure only — never a value.
 *
 * ## The checks
 *
 *   1. SCHEMA. The same `parseConfig` the gateway boots with: types, required
 *      fields, and the cross-field rules in `superRefine` (an undefined role, two
 *      images in one bundle, a `tools:` block with neither allow nor deny).
 *   2. UNKNOWN KEYS. The check the others cannot do. Zod strips what it does not
 *      recognise, so `consoleEnvs:` for `consoleEnv:` passes every other check in
 *      this list and does nothing at runtime. See src/config/strict.ts.
 *   3. INSTANCE SIZES. Every declared bundle must name an App Platform plan that
 *      exists. Over the DECLARATION, not the rendered spec: a bundle carrying no
 *      server renders no component, so a wrong slug on one reaches DigitalOcean
 *      only when some later change places a server there — after the merge. See
 *      src/deploy/instance-size.ts.
 *   4. RENDER. The full `renderAppSpec` — a smoke test that the config the schema
 *      accepted can actually produce a spec, and the step that gives check 5 a
 *      real spec to inspect rather than an assumption about one.
 *   5. CONSOLE SCOPE. Every key a server declares under `consoleEnv:` must reach
 *      the `core` component, and no two servers may claim one key with different
 *      values. Both are silent failures with a visible symptom much later: the
 *      first is a console reporting a credential missing that the config plainly
 *      declares, the second is a console running as the wrong identity.
 *   6. UNSEEDED-SECRET WAIVERS. A `mayBeUnseeded:` naming something the server
 *      does not reference waives nothing. See src/deploy/unseeded.ts.
 *
 * And one finding that is a WARNING rather than a problem: a server the
 * `mcp.json` dialect attached with no entitlements. See src/config/mcp-json.ts.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  parseConfigWithDialect,
  type ParsedConfig,
} from "../src/config/load.ts";
import { formatUnknownKey, unknownConfigKeys } from "../src/config/strict.ts";
import {
  collectSecretRefs,
  parseImage,
  renderAppSpec,
  type AppSpec,
} from "../src/deploy/appspec.ts";
import {
  bakedSecretNames,
  consoleScopeProblems,
} from "../src/deploy/preflight.ts";
import {
  formatLegacyInstanceSize,
  formatUnknownInstanceSize,
  legacyInstanceSizes,
  unknownInstanceSizes,
} from "../src/deploy/instance-size.ts";
import { unusedWaivers } from "../src/deploy/unseeded.ts";

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
function parseOrReport(): ParsedConfig {
  try {
    return parseConfigWithDialect(raw, values.config);
  } catch (err) {
    problem((err as Error).message);
    verdict();
  }
}
const { config, dialect } = parseOrReport();

// --- 1b. the mcp.json dialect's own findings --------------------------------
//
// A warning and never a problem. `entitlements: []` is what a pasted mcp.json
// MEANS — the format carries no notion of who a server is for — so a config
// that says it is a valid config, not a broken one. What it is not is something
// to discover from an empty tools/list a week later, so it is annotated on the
// run that introduced it. See src/config/mcp-json.ts.
for (const notice of dialect.notices) {
  console.error(`::warning file=${values.config}::${notice.message}`);
}

// --- 2. unknown keys --------------------------------------------------------
for (const unknown of unknownConfigKeys(raw, config)) {
  problem(
    `unknown config key: ${formatUnknownKey(unknown)} — the schema does not ` +
      `define it, so it is silently ignored and does nothing`,
  );
}

// --- 3. instance sizes ------------------------------------------------------
//
// Over `config.bundles`, BEFORE the render and independently of it. A bundle
// carrying no server renders no component, so a wrong slug on one is never sent
// to DigitalOcean until some later change places a server there — which is how
// `apps-s-1vcpu-512mb` sat in a prod config for a day and then failed a deploy
// after the merge. Checking the declaration rather than the spec is what makes
// this fire on the PR that writes the value.
for (const bad of unknownInstanceSizes(config)) {
  problem(formatUnknownInstanceSize(bad));
}
// Never a problem: a legacy plan is a real plan on an app old enough to use it,
// and a config cannot say when its app was created. See instance-size.ts.
for (const old of legacyInstanceSizes(config)) {
  console.error(
    `::warning file=${values.config}::${formatLegacyInstanceSize(old)}`,
  );
}

// --- 4. render --------------------------------------------------------------
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
    // A finding worth saying and not worth failing on — an unnameable slug, an
    // mcp store with no console page — reaches the run as an annotation and
    // leaves the exit code alone, the same way a legacy instance size does.
    onWarning: (message) =>
      console.error(`::warning file=${values.config}::${message}`),
  });
} catch (err) {
  problem(`the config does not render: ${(err as Error).message}`);
}

// --- 5. console scope -------------------------------------------------------
if (spec) {
  for (const message of consoleScopeProblems(config, spec)) problem(message);
}

// --- 6. unseeded-secret waivers ---------------------------------------------
//
// `mayBeUnseeded:` is the one config key that BUYS a hard failure away, so the
// key itself has to be typo-proof: a waiver naming something this server does
// not reference waives nothing, and the reference it was written for still reds
// the deploy. Checked here as well as in render-spec so a config in this repo
// answers for it in CI, one merge before a deploy asks.
for (const message of unusedWaivers(config)) problem(message);

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
