/**
 * Move a deployment's `${NAME}` secrets out of the deploy environment and into
 * the parameter store, once, so `gateway.secrets.provider` can be flipped.
 *
 * This is the migration step that has no other home. The console can write the
 * gateway namespace and is the right tool for one value, but it is SSO-gated and
 * driven by a human — and the flip needs a set of names moved together, from
 * values that live in CI's environment and nowhere a human can copy them from.
 * The `secrets` MCP server cannot do it either: its namespace fence is
 * `/strad/{env}/mcp/` on purpose, and widening it to reach the gateway namespace
 * would hand an agent every credential the deployment holds.
 *
 * So: a script, run from the deploy workflow, reading the same
 * `strad-<env>-*` values `render-spec` would have baked.
 *
 * Usage:
 *   node --experimental-transform-types scripts/seed-store.ts \
 *     --config <path> [--commit] [--rotate] [--set NAME=VALUE]... [--delete NAME]...
 *
 * DRY RUN BY DEFAULT. Without `--commit` it prints exactly what it would write
 * and writes nothing, because the failure mode of a seeder is a store full of
 * wrong values that everything downstream then trusts.
 *
 * ## Which names
 *
 * `requiredSecretNames()` — the config's own `${NAME}` refs plus the core boot
 * keys — minus any `consoleEnv:` name, which is deploy-environment-only by
 * design (filing the console's store-ADMIN credential inside the store would let
 * the weaker resolver read the stronger one). A name with no value in the
 * environment is REPORTED AND SKIPPED, not invented: a deployment legitimately
 * has no `GOOGLE_CLIENT_SECRET` until someone provisions one.
 *
 * A `supplementary-image` server's `env:` is deliberately NOT included. Those are
 * another container's environment, `render-spec` reads them from the store OR the
 * environment, and moving 21 third-party credentials into a store is a decision
 * to take deliberately rather than as a side effect of enabling the flip.
 * `--set NAME=VALUE` adds a name the environment does not carry. It is for
 * non-secret canaries: the value passes through a workflow input and appears in
 * the run's log, so never use it for a credential.
 *
 * ## Existing names
 *
 * Skipped, unless `--rotate`. Re-seeding by default would make every deploy
 * overwrite the store with whatever the environment happened to hold, which is
 * the exact inversion of what the migration is for — the store is meant to
 * become the source of truth, not a mirror of the thing it replaces.
 *
 * ## Verification
 *
 * With a resolver credential configured, every name written is read back through
 * `resolve()` — the same `:render` path the gateway uses — and compared to the
 * source by SHA-256. That is what catches a value that stored fine and cannot be
 * rendered, which is the failure that takes a whole namespace down (see
 * `HACKS.md` #36). Digests are compared, never printed; no value is printed in
 * any mode.
 *
 * ## Exit codes
 *
 *   0  seeded (or, in dry-run, reported)
 *   1  a finding: a write failed, or a written name did not read back identical
 *   2  called wrong
 *   3  the store could not be reached — no admin credential in the environment
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { parseConfig } from "../src/config/load.ts";
import {
  consoleEnvNames,
  requiredSecretNames,
} from "../src/deploy/preflight.ts";
import {
  createGcpParameterStore,
  gatewayNamespace,
  gatewayParameterPath,
  parseAdminAccount,
  resolverFromEnv,
} from "../src/secrets/parameters/index.ts";
import { errorSummary } from "../src/secrets/provider/snapshot.ts";

/**
 * The ADMIN credential, and it is deliberately its own variable rather than the
 * resolver's. The resolver cannot write — that is the property that lets it live
 * in the gateway container — so a seeder built on it would fail at the first
 * `create`. This one runs in CI, for the length of one job.
 */
const SEED_ENV = {
  projectId: "STRAD_PARAMS_PROJECT_ID",
  keyJson: "STRAD_STORE_ADMIN_KEY_JSON",
} as const;

function usage(message: string): never {
  console.error(`::error::${message}`);
  console.error(
    "usage: seed-store --config <path> [--commit] [--rotate] " +
      "[--set NAME=VALUE] [--delete NAME]",
  );
  process.exit(2);
}

let values: {
  config?: string;
  commit?: boolean;
  rotate?: boolean;
  set?: string[];
  delete?: string[];
};
try {
  ({ values } = parseArgs({
    options: {
      config: { type: "string" },
      commit: { type: "boolean" },
      rotate: { type: "boolean" },
      set: { type: "string", multiple: true },
      delete: { type: "string", multiple: true },
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

const config = (() => {
  try {
    return parseConfig(raw, values.config);
  } catch (err) {
    usage(`${values.config} does not parse: ${(err as Error).message}`);
  }
})();

/** `--set NAME=VALUE`, parsed. The NAME half is echoed; the value never is. */
const overrides = new Map<string, string>();
for (const entry of values.set ?? []) {
  const eq = entry.indexOf("=");
  if (eq <= 0)
    usage(`--set expects NAME=VALUE, got "${entry.split("=")[0]}=…"`);
  overrides.set(entry.slice(0, eq), entry.slice(eq + 1));
}

const namespace = gatewayNamespace(config.gateway.env);
const projectId = process.env[SEED_ENV.projectId];
const { account, reason } = parseAdminAccount(process.env[SEED_ENV.keyJson]);
if (!projectId || !account) {
  console.error(
    !projectId || !process.env[SEED_ENV.keyJson]
      ? `::error::no store credential: set ${SEED_ENV.projectId} and ` +
          `${SEED_ENV.keyJson} to the store ADMIN service account's key.`
      : // `reason` reports by SHAPE — never by content.
        `::error::${SEED_ENV.keyJson} is set but unusable: it ${reason}.`,
  );
  process.exit(3);
}

const store = createGcpParameterStore({ projectId, account });

/** consoleEnv: names are environment-only, and the store must never hold one. */
const consoleOnly = new Set(consoleEnvNames(config));
const wanted = [
  ...new Set([...requiredSecretNames(config), ...overrides.keys()]),
]
  .filter((name) => !consoleOnly.has(name))
  .sort();

const digest = (v: string) => createHash("sha256").update(v).digest("hex");

const held = new Set(
  (
    await store.list(namespace).catch((err: unknown) => {
      console.error(
        `::error::could not list ${namespace}: ${errorSummary(err)}. Nothing was written.`,
      );
      process.exit(3);
    })
  )
    .filter((m) => m.hasValue)
    .map((m) => m.variable),
);

const toCreate: string[] = [];
const toRotate: string[] = [];
const absent: string[] = [];
const alreadyThere: string[] = [];

for (const name of wanted) {
  const value = overrides.get(name) ?? process.env[name];
  if (value === undefined || value === "") {
    absent.push(name);
    continue;
  }
  if (!held.has(name)) toCreate.push(name);
  else if (values.rotate) toRotate.push(name);
  else alreadyThere.push(name);
}

const report = (label: string, names: string[]) => {
  if (names.length > 0) console.log(`  ${label}:\n    ${names.join("\n    ")}`);
};

console.log(
  `${values.config}: ${wanted.length} name(s) the gateway reads from ${namespace}`,
);
report("create", toCreate);
report("rotate", toRotate);
report("already seeded (use --rotate to overwrite)", alreadyThere);
report("no value in the environment — SKIPPED", absent);

/**
 * `--delete` removes a name from the namespace.
 *
 * A seeder that cannot unseed is half a tool: a name written under the wrong
 * spelling, or one that should never have moved into the store, otherwise has no
 * remedy short of the console. It is also how the `envFallback` half of the chain
 * is demonstrated — drop a name the environment still carries and the running
 * gateway falls through to it.
 *
 * It is NOT derived from the config. Deleting is the one action here with no
 * undo, so every name is named explicitly on the command line, and a name the
 * store does not hold is reported rather than treated as an error.
 */
const toDelete = (values.delete ?? []).filter((name) => {
  if (held.has(name)) return true;
  console.log(`  not in the namespace, nothing to delete: ${name}`);
  return false;
});
report("DELETE", toDelete);

if (!values.commit) {
  console.log(
    `${values.config}: dry run, nothing written. Re-run with --commit.`,
  );
  process.exit(0);
}

const written = new Map<string, string>();
let failures = 0;

for (const name of toCreate) {
  const value = (overrides.get(name) ?? process.env[name])!;
  try {
    await store.create({
      path: gatewayParameterPath(config.gateway.env, name),
      secret: true,
      value,
      note: "seeded from the deploy environment by scripts/seed-store.ts",
    });
    written.set(name, digest(value));
    console.log(`  created ${name}`);
  } catch (err) {
    failures++;
    console.error(`::error::create ${name} failed: ${errorSummary(err)}`);
  }
}

for (const name of toRotate) {
  const value = (overrides.get(name) ?? process.env[name])!;
  try {
    await store.rotate(gatewayParameterPath(config.gateway.env, name), value);
    written.set(name, digest(value));
    console.log(`  rotated ${name}`);
  } catch (err) {
    failures++;
    console.error(`::error::rotate ${name} failed: ${errorSummary(err)}`);
  }
}

for (const name of toDelete) {
  try {
    await store.destroy(gatewayParameterPath(config.gateway.env, name));
    console.log(`  deleted ${name}`);
  } catch (err) {
    failures++;
    console.error(`::error::delete ${name} failed: ${errorSummary(err)}`);
  }
}

// READ IT BACK, as the gateway would. A value that stored fine and cannot
// `:render` is the failure that takes the whole namespace down with it, and it
// is invisible to every check that only asks whether a name exists.
if (written.size > 0) {
  const resolver = resolverFromEnv(process.env);
  if (!resolver) {
    console.log(
      "  verify: skipped — no resolver credential (STRAD_PARAMS_RESOLVER_*) " +
        "in the environment. The names above are written but unproven.",
    );
  } else {
    const resolved = await resolver.resolve(namespace).catch((err: unknown) => {
      console.error(
        `::error::the resolver could not render ${namespace}: ${errorSummary(err)}. ` +
          `Every name in it resolves to nothing until this is fixed.`,
      );
      return null;
    });
    if (resolved === null) failures++;
    else {
      const mismatched = [...written.entries()]
        .filter(([name, want]) => {
          const got = resolved[name];
          return got === undefined || digest(got) !== want;
        })
        .map(([name]) => name);
      failures += mismatched.length;
      console.log(
        `  verify: ${written.size - mismatched.length} of ${written.size} ` +
          `read back byte-identical through :render`,
      );
      report("DID NOT ROUND-TRIP", mismatched);
    }
  }
}

if (failures > 0) {
  console.log(`${values.config}: ${failures} problem(s)`);
  process.exit(1);
}
console.log(`${values.config}: seeded`);
process.exit(0);
