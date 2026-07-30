/**
 * Is the parameter store COMPLETE for this config — every name, not just the
 * three a deploy would refuse to ship without?
 *
 * This is the check to run before flipping `gateway.secrets.provider` from `env`
 * to `gcp-parameter-store`, and every day of a one-server-at-a-time migration up
 * to that point. It is the credentialed counterpart to `check-config.ts`: same
 * shape, same exit-code discipline, same `::error file=…::` annotations — but
 * where that one needs no secrets at all, this one needs the resolver key,
 * because the question is about a live namespace.
 *
 * Usage:
 *   node --experimental-transform-types scripts/check-store.ts \
 *     --config infra/strad.staging.yaml [--mode report] [--resolve]
 *
 *   npm run store:check -- --config infra/strad.staging.yaml
 *
 * ## The two modes, and which is which
 *
 *   --mode require  (DEFAULT)  A missing name is a failure, exit 1. This is the
 *                              pre-flip gate and the CI-legible one. It is the
 *                              default deliberately: a checker that never fails
 *                              unless asked repeats the mistake it exists to fix.
 *   --mode report              The same enumeration, the same names, exit 0. This
 *                              is the daily driver mid-migration, where a
 *                              partially-seeded namespace is the expected state
 *                              and not an error. It answers "these N of M are in,
 *                              these are not" without pretending that is broken.
 *
 * Both modes print the same roster. The mode changes the verdict, never the
 * facts, so a day's report and the final gate cannot disagree about what is
 * seeded.
 *
 * ## --resolve
 *
 * Off by default. Presence is not resolvability: `:render` dereferences a
 * `__REF__` as the PARAMETER's own principal, and rendering at all requires
 * `parametermanager.parameterVersions.render` — the permission in
 * `roles/parametermanager.parameterAccessor`, which is not in
 * `parameterViewer`. So a namespace can be complete, the binding can look right,
 * and the gateway can still resolve every name to nothing. `--resolve` asks the
 * store to render what it found and reports which names came back — by NAME. No
 * value is printed, logged or written, in any mode.
 *
 * ## Exit codes
 *
 *   0  complete (require), or the report was produced (report)
 *   1  names are missing, or --resolve could not render them  [require only]
 *   2  called wrong: no --config, unreadable file, config does not parse
 *   3  the store could not be consulted at all — no resolver credential in the
 *      environment, or `list()` failed. Distinct from 1 on purpose: "the
 *      namespace is incomplete" and "I could not find out" call for opposite
 *      responses, and reporting the second as the first is how someone seeds a
 *      namespace that was already fine.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseConfig } from "../src/config/load.ts";
import { checkStore } from "../src/deploy/store-check.ts";
import { resolverFromEnv } from "../src/secrets/parameters/index.ts";
import { RESOLVER_ENV } from "../src/secrets/parameters/resolver.ts";
import { errorSummary } from "../src/secrets/provider/snapshot.ts";

function usage(message: string): never {
  console.error(`::error::${message}`);
  console.error(
    "usage: check-store --config <path> [--mode require|report] " +
      "[--namespace <path>] [--resolve]",
  );
  process.exit(2);
}

let values: {
  config?: string;
  mode?: string;
  namespace?: string;
  resolve?: boolean;
};
try {
  ({ values } = parseArgs({
    options: {
      config: { type: "string" },
      mode: { type: "string" },
      namespace: { type: "string" },
      resolve: { type: "boolean" },
    },
  }));
} catch (err) {
  usage((err as Error).message);
}

if (!values.config) usage("--config is required");
const mode = values.mode ?? "require";
if (mode !== "require" && mode !== "report") {
  usage(`--mode must be "require" or "report", not "${mode}"`);
}

let raw: string;
try {
  raw = readFileSync(values.config, "utf8");
} catch (err) {
  usage(`cannot read ${values.config}: ${(err as Error).message}`);
}

const config = (() => {
  try {
    return parseConfig(raw, values.config);
  } catch (err) {
    usage(`${values.config} does not parse: ${(err as Error).message}`);
  }
})();

// The SAME client the gateway container will hold, built from the SAME env vars,
// so a namespace this passes against is one that credential can read. A checker
// running as the console admin would answer a question nobody asked.
const store = resolverFromEnv(process.env);
if (!store) {
  console.error(
    `::error::no store credential in the environment: set ` +
      `${RESOLVER_ENV.projectId} and ${RESOLVER_ENV.keyJson} to the RESOLVER ` +
      `service account's key (never the console admin's).`,
  );
  process.exit(3);
}

const result = await checkStore(store, config, {
  namespace: values.namespace,
  resolve: values.resolve,
}).catch((err: unknown) => {
  // list() failed: the credential, the project or the network — not a verdict
  // about the namespace's contents.
  console.error(
    `::error::could not list the store: ${errorSummary(err)}. This is not a ` +
      `report about what is seeded.`,
  );
  process.exit(3);
});

// --- the roster -------------------------------------------------------------
//
// Names, counts and nothing else. The same output in both modes: only the
// verdict below depends on --mode.
const { namespace, expected, present, missing } = result;
console.log(
  `${values.config}: ${present.length} of ${expected.length} expected name(s) ` +
    `present in ${namespace}`,
);
if (present.length > 0)
  console.log(`  present:\n    ${present.join("\n    ")}`);
if (missing.length > 0)
  console.log(`  missing:\n    ${missing.join("\n    ")}`);

if (result.environmentOnly.length > 0) {
  // Not counted either way. A consoleEnv: name is read from the deploy
  // environment by design — but if one is IN the namespace, the resolver
  // credential can read the console's admin credential, and the three-role split
  // stops being a boundary.
  console.log(
    `  environment-only (consoleEnv:, never expected here):\n    ` +
      result.environmentOnly.join("\n    "),
  );
  for (const name of result.adminCredentialsInStore) {
    console.error(
      `::warning file=${values.config}::${name} is a consoleEnv: name and it is ` +
        `in ${namespace}. render-spec reads it from the deploy environment, so ` +
        `the copy here is unused — and readable by the weaker resolver credential.`,
    );
  }
}

const render = result.render;
if (render) {
  if (render.error) {
    console.log(`  render: FAILED — ${render.error}`);
  } else {
    console.log(
      `  render: ${render.rendered.length} of ${present.length} present name(s) ` +
        `resolved to a value`,
    );
    if (render.unrendered.length > 0) {
      console.log(`  did not render:\n    ${render.unrendered.join("\n    ")}`);
    }
  }
}

// --- the verdict ------------------------------------------------------------
const annotate = mode === "require" ? "error" : "notice";
for (const name of missing) {
  console.error(
    `::${annotate} file=${values.config}::${name} is not in ${namespace}`,
  );
}
if (render?.error) {
  console.error(
    `::${annotate} file=${values.config}::the resolver credential could not ` +
      `render ${namespace}: ${render.error}. ` +
      `\`:render\` needs parametermanager.parameterVersions.render, which is in ` +
      `roles/parametermanager.parameterAccessor and NOT in parameterViewer.`,
  );
} else if (render) {
  for (const name of render.unrendered) {
    console.error(
      `::${annotate} file=${values.config}::${name} exists but rendered no ` +
        `value — the parameter's own principal may not reach its secret.`,
    );
  }
}

// A render failure is ONE finding however many names it covers — the credential
// is wrong once, not once per parameter.
const renderFindings = render
  ? render.error
    ? 1
    : render.unrendered.length
  : 0;
const findings = missing.length + renderFindings;

if (mode === "report") {
  console.log(
    findings === 0
      ? `${values.config}: complete`
      : `${values.config}: ${findings} outstanding — reported, not failed (--mode report)`,
  );
  process.exit(0);
}

if (findings > 0) {
  console.log(`${values.config}: ${findings} problem(s)`);
  process.exit(1);
}
console.log(`${values.config}: complete`);
process.exit(0);
