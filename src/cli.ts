import { parseArgs } from "node:util";
import { mintToken } from "./auth/tokens.ts";
import { configPathFromEnv, loadConfig } from "./config/load.ts";
import { renderAppSpec, parseImage, type EnvVar } from "./deploy/appspec.ts";

/**
 * strad CLI.
 *
 *   strad token mint --label "tadas laptop" --roles admin
 *   strad spec render --image ghcr.io/tadasant/strad:0.1.0 --app strad-staging
 */

const [, , command, subcommand, ...rest] = process.argv;

async function main() {
  switch (`${command} ${subcommand}`) {
    case "token mint":
      return tokenMint(rest);
    case "spec render":
      return specRender(rest);
    default:
      usage();
      process.exit(1);
  }
}

function usage() {
  console.error(
    [
      "strad — a self-hosted MCP platform",
      "",
      "  strad token mint --label <label> --roles <a,b> [--env staging]",
      "      Mint a system token. The plaintext is printed ONCE and is",
      "      unrecoverable; only its SHA-256 is ever stored.",
      "",
      "  strad spec render --image <ref> --app <name> [--region nyc] [--domain <fqdn>]",
      "      Render a DigitalOcean App Platform spec from strad.config.yaml.",
      "",
    ].join("\n"),
  );
}

async function tokenMint(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      label: { type: "string" },
      roles: { type: "string" },
      env: { type: "string" },
    },
  });

  const config = await loadConfig(configPathFromEnv()).catch(() => null);
  const env = values.env ?? config?.gateway.env ?? "dev";
  const roles = (values.roles ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  if (roles.length === 0) {
    console.error("--roles is required (e.g. --roles admin)");
    process.exit(1);
  }

  const { plaintext, record } = mintToken({
    env,
    label: values.label ?? "unnamed",
    roles,
  });

  // stderr for the human, stdout for the machine — so `strad token mint > x`
  // captures exactly the record and none of the chatter.
  console.error("");
  console.error("  Token (shown once, cannot be recovered):");
  console.error("");
  console.error(`    ${plaintext}`);
  console.error("");
  console.error("  Append this record to STRAD_TOKENS (a JSON array):");
  console.error("");

  console.log(JSON.stringify(record, null, 2));
}

async function specRender(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      image: { type: "string" },
      app: { type: "string" },
      region: { type: "string" },
      domain: { type: "string", multiple: true },
    },
  });

  if (!values.image || !values.app) {
    console.error("--image and --app are required");
    process.exit(1);
  }

  const config = await loadConfig(configPathFromEnv());

  // Secret VALUES never appear here. CI substitutes them into the spec at
  // deploy time, straight from GCP Secret Manager into the App Platform API.
  // A rendered spec is safe to print in a build log.
  const env: EnvVar[] = [];

  const spec = renderAppSpec({
    config,
    appName: values.app,
    region: values.region ?? "nyc",
    image: parseImage(values.image),
    env,
    domains: values.domain?.map((d) => ({
      domain: d,
      type: "PRIMARY" as const,
    })),
  });

  console.log(JSON.stringify({ spec }, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
