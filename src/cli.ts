import { parseArgs } from "node:util";
import { mintToken } from "./auth/tokens.ts";
import { configPathFromEnv, loadConfig } from "./config/load.ts";
import { errorText } from "./util/error-text.ts";

/**
 * strad CLI.
 *
 *   strad token mint --label "tadas laptop" --roles admin
 */

const [, , command, subcommand, ...rest] = process.argv;

async function main() {
  switch (`${command} ${subcommand}`) {
    case "token mint":
      return tokenMint(rest);
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
  // Said here because this command is where somebody lands when they need a
  // token, and on a store-backed deployment it is the harder of the two ways to
  // get one: this prints a record a human then has to file, and the console does
  // the filing. The env-var deployment has no console option, so the pointer is
  // conditional on what the config actually says.
  if (config?.auth.staticTokens.store === "parameter-store") {
    console.error(
      "  (This gateway stores its records in the parameter store — the console",
    );
    console.error(
      "   at /tokens mints and files one in a single step, with no redeploy.)",
    );
    console.error("");
  }

  console.log(JSON.stringify(record, null, 2));
}

main().catch((err: unknown) => {
  console.error(errorText(err));
  process.exit(1);
});
