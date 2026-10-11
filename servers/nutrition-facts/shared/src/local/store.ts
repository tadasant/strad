/**
 * The two local datasets, loaded once, lazily, from the directory the image
 * build wrote them to.
 *
 * LAZY because this server shares a process with the rest of the bundle: a
 * container that never gets a nutrition call never spends the ~60 MB of heap
 * the parsed files take. A missing or unreadable file is not a boot failure —
 * the source reports `unavailable` with the path it looked in, and the other
 * sources still answer.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  DATA_VERSION,
  MENUSTAT_FILE,
  USDA_FILE,
  type MenuStatFile,
  type UsdaFile,
} from "../data/format.js";
import { MenuStatIndex } from "./menustat.js";
import { UsdaIndex } from "./usda.js";

/**
 * `<tree>/data`, where the Dockerfile's `npm run data` writes. From
 * `shared/build/local/store.js` that is three levels up.
 */
export function defaultDataDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");
}

/**
 * The data files `dir` lacks. The strad bundle host reads this at mount time:
 * a missing file is an image built wrong, every local lookup would report
 * `unavailable`, and that is worth a degraded mount rather than a quiet one.
 */
export function missingDataFiles(dir: string = defaultDataDir()): string[] {
  return [USDA_FILE, MENUSTAT_FILE].filter((f) => !existsSync(join(dir, f)));
}

type Loaded<T> = { ok: true; value: T } | { ok: false; reason: string };

async function loadJson<T extends { version: number }>(
  path: string,
): Promise<Loaded<T>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return {
      ok: false,
      reason: `local data file ${path} is missing; this image was built without it (see the nutrition-facts README, "How the data ships")`,
    };
  }
  try {
    const parsed = JSON.parse(gunzipSync(bytes).toString("utf-8")) as T;
    if (parsed.version !== DATA_VERSION) {
      return {
        ok: false,
        reason: `local data file ${path} is format v${parsed.version}; this server reads v${DATA_VERSION}`,
      };
    }
    return { ok: true, value: parsed };
  } catch (err) {
    return {
      ok: false,
      reason: `local data file ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export class LocalStore {
  private usda?: Promise<Loaded<UsdaIndex>>;
  private menustat?: Promise<Loaded<MenuStatIndex>>;

  constructor(private readonly dir: string) {}

  usdaIndex(): Promise<Loaded<UsdaIndex>> {
    this.usda ??= loadJson<UsdaFile>(join(this.dir, USDA_FILE)).then((r) =>
      r.ok ? { ok: true as const, value: new UsdaIndex(r.value) } : r,
    );
    return this.usda;
  }

  menustatIndex(): Promise<Loaded<MenuStatIndex>> {
    this.menustat ??= loadJson<MenuStatFile>(join(this.dir, MENUSTAT_FILE)).then(
      (r) => (r.ok ? { ok: true as const, value: new MenuStatIndex(r.value) } : r),
    );
    return this.menustat;
  }
}
