/**
 * Ask Google what a secrets credential can actually do, and print the answer.
 *
 * This is `src/secrets/parameters/capabilities.ts` — the SAME probe the console
 * and the secrets MCP server run — behind a command line, so a deploy can report
 * the boundary it just deployed against.
 *
 * ## Why a deploy should run this
 *
 * The secrets surfaces are probe-derived: the MCP server lists `get_secret_value`
 * and the write tools only if the credential holds the permissions for them, and
 * the console offers reveal on the same basis. That is a good property, and it has
 * one bad consequence — an IAM grant that did not land looks exactly like a
 * deliberate narrowing. The surface is simply smaller, nothing errors, and the
 * only way to tell "prod, correctly locked down" from "staging, grant missed" is
 * to ask.
 *
 * So the staging deploy asks, and prints six booleans. That is the whole feature.
 *
 * ## It cannot leak
 *
 * The output is booleans and a diagnostic string. It never prints the key, and
 * `testIamPermissions` returns no secret material — only which permission names
 * the caller holds, which the caller could discover by attempting each operation.
 * The key itself arrives by env var and is never echoed.
 *
 * Usage:
 *   node --experimental-transform-types scripts/probe-capabilities.ts \
 *     --project strad-secrets-staging --key-env SECRETS_VIEWER_KEY_JSON \
 *     --label "staging MCP (viewer)"
 *
 * Exit codes:
 *   0  the probe completed — read the booleans
 *   1  the probe did NOT complete (see the reason; usually the Cloud Resource
 *      Manager API is not enabled on the project)
 *   2  the script was called wrong
 */
import { parseArgs } from "node:util";
import { probeCapabilities } from "../src/secrets/parameters/capabilities.ts";
import type { ServiceAccount } from "../src/secrets/parameters/service-account.ts";

/**
 * Plain stderr, no `::error::`. A narrowed or unverifiable credential is a fact
 * to report, not necessarily a failure — the caller decides how loud to be, and
 * a human running this at a terminal should not read workflow syntax.
 */
function fail(message: string, code: 1 | 2): never {
  console.error(message);
  process.exit(code);
}

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    "key-env": { type: "string" },
    label: { type: "string" },
  },
});

const projectId = values.project;
const keyEnv = values["key-env"];
const label = values.label ?? keyEnv ?? "credential";

if (!projectId || !keyEnv) {
  fail("usage: probe-capabilities.ts --project <id> --key-env <ENV_VAR>", 2);
}

const raw = process.env[keyEnv];
if (!raw) fail(`${keyEnv} is not set`, 2);

let account: ServiceAccount;
try {
  const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!parsed.client_email || !parsed.private_key) {
    // Name the SHAPE, never the content: this variable IS the credential.
    fail(`${keyEnv} is JSON but not a service-account key`, 2);
  }
  account = {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
  };
} catch {
  fail(`${keyEnv} is not parseable JSON`, 2);
}

const caps = await probeCapabilities({ projectId, account });

console.log(`capabilities of ${label} on ${projectId}:`);
console.log(`  probed:            ${caps.probed}`);
console.log(`  readSecretValues:  ${caps.readSecretValues}`);
console.log(`  writeParameters:   ${caps.writeParameters}`);
console.log(`  writeSecretValues: ${caps.writeSecretValues}`);
console.log(`  deleteParameters:  ${caps.deleteParameters}`);

if (!caps.probed) {
  // Distinct from "denied". Reporting an unanswerable question as a refusal is
  // how someone ends up widening IAM to fix an unenabled API.
  fail(`probe did not complete: ${caps.reason}`, 1);
}
