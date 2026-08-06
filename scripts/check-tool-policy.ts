/**
 * Every `tools: allow` entry names a tool the mount really serves — checked
 * BEFORE the deploy, not after it.
 *
 * An allow list is exhaustive and fail-closed, so a typo'd or stale entry is
 * invisible: it narrows that slug's surface by one and errors nowhere. The
 * gateway does notice at runtime (`unmatchedAllowEntries()` on every
 * `tools/list`, emitted as `mcp.policy_unmatched_tools`) — but by then the
 * narrowed surface is what production is serving.
 *
 * Both halves of the earlier answer already run in CI, in jobs that never meet:
 * the bundle smoke test boots the real image and lists every mount's tools, and
 * the config check parses every config in the repo. This is the join.
 *
 * Usage (from CI, with the bundle container up):
 *   docker exec bundle-ci node /app/scripts/smoke.mjs --json > bundle-tools.json
 *   npm run policy:check -- --tools bundle-tools.json --config infra/strad.staging.yaml
 *
 *   --tools    the observer's document (smoke.mjs --json). Required.
 *   --config   a config to check. Repeatable; at least one.
 *   --image    which image the mounts came from. Defaults to the bundle image.
 *              Matched on registry, owner and repository — everything but the
 *              TAG, so CI's `:ci` matches a config's `:latest`.
 *
 * ## What it will not do
 *
 * Fail for a slug whose tools it could not enumerate. A remote-http server, a
 * server on an image this run did not boot, a mount that would not list, a mount
 * whose surface here is a credential-free floor — every one is SKIPPED with a
 * reason, and the reasons print on success too. A gate that reddens a good PR
 * gets disabled, and "not covered" must never read like "covered and clean".
 *
 * ## Exit codes
 *
 *   0  every entry that COULD be checked matches a served tool
 *   1  at least one entry names a tool its mount does not serve
 *   2  called wrong: no --tools/--config, unreadable file, a config that does not
 *      parse, or an observer document with no mounts in it (which would otherwise
 *      pass by checking nothing)
 *
 * Every finding is also a `::error file=…::` workflow command, so GitHub
 * annotates the config line an operator has to edit. Output is tool NAMES and
 * config structure — this script reads no secret and holds no credential.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseConfig } from "../src/config/load.ts";
import {
  checkToolSurface,
  formatFinding,
  parseObservedMounts,
  type ObservedMount,
} from "../src/deploy/tool-surface.ts";

const DEFAULT_IMAGE = "ghcr.io/tadasant/strad-bundle:latest";

function usage(message: string): never {
  console.error(`::error::${message}`);
  console.error(
    "usage: check-tool-policy --tools <path> --config <path> [--config <path>…] [--image <ref>]",
  );
  process.exit(2);
}

let values: { tools?: string; config?: string[]; image?: string };
try {
  ({ values } = parseArgs({
    options: {
      tools: { type: "string" },
      config: { type: "string", multiple: true },
      image: { type: "string" },
    },
  }));
} catch (err) {
  usage((err as Error).message);
}

if (!values.tools) usage("--tools is required (smoke.mjs --json)");
if (!values.config?.length) usage("--config is required (repeatable)");

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    usage(`cannot read ${path}: ${(err as Error).message}`);
  }
}

let mounts: Readonly<Record<string, ObservedMount>>;
try {
  mounts = parseObservedMounts(JSON.parse(read(values.tools)));
} catch (err) {
  usage(`${values.tools} is not a usable tool dump: ${(err as Error).message}`);
}

const image = values.image ?? DEFAULT_IMAGE;
console.log(
  `${image}: ${Object.keys(mounts).length} mount(s) observed — ` +
    Object.entries(mounts)
      .map(([path, mount]) =>
        mount.error
          ? `${path} (would not list)`
          : mount.partial
            ? `${path} (partial)`
            : `${path} ${mount.tools?.length ?? 0}`,
      )
      .sort()
      .join(", "),
);

let failed = 0;

for (const path of values.config) {
  const raw = read(path);
  let result;
  try {
    result = checkToolSurface(parseConfig(raw, path), { image, mounts });
  } catch (err) {
    usage(`${path} does not parse: ${(err as Error).message}`);
  }

  console.log(
    `\n${path}: ${result.checked.length} policy/policies checked against a served tool list, ` +
      `${result.skipped.length} skipped`,
  );
  for (const { slug, mount, entries } of result.checked) {
    console.log(`  ok      ${slug} — ${entries} entr(ies) vs ${mount}`);
  }
  // Printed on success too, and at the same volume. The point of the skip list
  // is that somebody reads it: a slug that quietly stopped being covered is the
  // way a check like this rots.
  for (const { slug, reason } of result.skipped) {
    console.log(`  skipped ${slug} — ${reason}`);
  }

  for (const finding of result.findings) {
    failed += 1;
    const message = formatFinding(finding);
    console.error(`::error file=${path}::${message}`);
    console.log(`  FAIL    ${message}`);
    const offered = mounts[finding.mount]?.tools ?? [];
    console.log(
      `            ${finding.mount} serves: ${[...offered].sort().join(", ")}`,
    );
  }
}

if (failed > 0) {
  console.log(
    `\n${failed} tools: entr(ies) name a tool no mount serves. Each one silently ` +
      `narrows (allow) or no longer subtracts from (deny) that slug's surface.`,
  );
  process.exit(1);
}
console.log("\nevery checkable tools: entry names a tool its mount serves");
process.exit(0);
