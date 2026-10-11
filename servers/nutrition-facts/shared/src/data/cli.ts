#!/usr/bin/env node
/**
 * Build the image's data files: `node build/data/cli.js --out <dir>`.
 *
 * Runs in the bundle Dockerfile's nutrition-facts stage, once per image build.
 * Downloads each pinned source (sources.ts), refuses one whose SHA-256 does not
 * match, and writes `usda.json.gz` and `menustat.json.gz` into `--out`.
 *
 * `--from <dir>` reads the downloads from a directory instead of the network,
 * by their URL's file name (MenuStat's as `menustat.csv`) — for building the
 * files on a machine that already has them.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  DATA_VERSION,
  MENUSTAT_FILE,
  USDA_FILE,
  type MenuStatFile,
  type SourceProvenance,
  type UsdaFile,
  type UsdaRecord,
} from "./format.js";
import { buildMenuStat } from "./menustat-build.js";
import { MENUSTAT_SOURCE, USDA_SOURCES, type PinnedSource } from "./sources.js";
import { buildUsda } from "./usda-build.js";
import { unzipTables } from "./zip.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function fetchPinned(
  source: PinnedSource,
  localName: string,
  from: string | undefined,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (from) {
    bytes = await readFile(join(from, localName));
  } else {
    let last: unknown;
    let got: Uint8Array | undefined;
    // Three tries: a public download host's transient 5xx should not fail an
    // image build on the first attempt. A digest mismatch is never retried.
    for (let attempt = 1; attempt <= 3 && !got; attempt++) {
      try {
        const res = await fetch(source.url, {
          signal: AbortSignal.timeout(180_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        got = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        last = err;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000 * attempt));
      }
    }
    if (!got) {
      throw new Error(`could not download ${source.url}: ${String(last)}`);
    }
    bytes = got;
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== source.sha256) {
    throw new Error(
      `${source.name}: SHA-256 ${digest} does not match the pinned ` +
        `${source.sha256} (${source.url}). The download changed under its URL; ` +
        `review the new release and update servers/nutrition-facts/shared/src/data/sources.ts.`,
    );
  }
  return bytes;
}

function provenance(s: PinnedSource): SourceProvenance {
  return { name: s.name, url: s.url, sha256: s.sha256, release: s.release };
}

async function main(): Promise<void> {
  const out = arg("--out");
  if (!out) throw new Error("usage: cli.js --out <dir> [--from <dir>]");
  const from = arg("--from");
  await mkdir(out, { recursive: true });

  const foods: UsdaRecord[] = [];
  for (const source of Object.values(USDA_SOURCES)) {
    const zip = await fetchPinned(source, basename(new URL(source.url).pathname), from);
    const records = buildUsda(unzipTables(zip));
    console.error(`[nutrition-facts] ${source.name}: ${records.length} foods`);
    foods.push(...records);
  }
  const usda: UsdaFile = {
    version: DATA_VERSION,
    built_at: new Date().toISOString(),
    sources: Object.values(USDA_SOURCES).map(provenance),
    foods,
  };
  await writeFile(join(out, USDA_FILE), gzipSync(JSON.stringify(usda), { level: 9 }));

  const csv = new TextDecoder("utf-8").decode(
    await fetchPinned(MENUSTAT_SOURCE, "menustat.csv", from),
  );
  const items = buildMenuStat(csv);
  console.error(`[nutrition-facts] ${MENUSTAT_SOURCE.name}: ${items.length} items`);
  const menustat: MenuStatFile = {
    version: DATA_VERSION,
    built_at: new Date().toISOString(),
    sources: [provenance(MENUSTAT_SOURCE)],
    items,
  };
  await writeFile(
    join(out, MENUSTAT_FILE),
    gzipSync(JSON.stringify(menustat), { level: 9 }),
  );
}

main().catch((err) => {
  console.error(`[nutrition-facts] data build failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
