import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";
import { StradConfig } from "./schema.ts";
import { desugarDocument, type DesugarResult } from "./mcp-json.ts";

/**
 * Load and validate the config.
 *
 * Three sources, in priority order:
 *
 *   STRAD_CONFIG_YAML_GZ_B64 — the config document, inline, gzipped and
 *                       base64'd. What `render-spec` emits when that is the
 *                       smaller form, because an App Platform spec has a size
 *                       the API refuses past (src/deploy/config-inline.ts).
 *                       When it is set it WINS, and `STRAD_CONFIG_YAML` beside
 *                       it is the tripwire for an image too old to read it.
 *
 *   STRAD_CONFIG_YAML — the config document, inline. This is how a deployment
 *                       configures the stock OSS image: the image ships with
 *                       zero servers (by design), and the app spec supplies the
 *                       server list as an env var. No rebuild to add a server.
 *
 *   STRAD_CONFIG      — a path. This is how an image that BAKES its config in
 *                       works: tadasant-internal builds a strad image with its
 *                       private servers compiled in and its config alongside.
 *
 * Validation is strict and happens at boot. A config that names an undefined
 * role, or puts two container images in one bundle, is a deployment that
 * misbehaves in a way nobody notices for a week — so it refuses to start.
 *
 * ## Two dialects, one schema
 *
 * The document may also carry `mcpServers:` — draft SEP-2633's `mcp.json` — and
 * those entries are DESUGARED into `servers:` before the schema sees them. JSON
 * is a subset of YAML, so there is one parser here either way; the dialect is a
 * document transform, not a second parse. See `src/config/mcp-json.ts`. The YAML
 * interface is authoritative and a document that does not write `mcpServers:`
 * takes exactly the path it always did.
 */
export async function loadConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  onDialect?: (dialect: DesugarResult) => void,
): Promise<StradConfig> {
  return (await loadConfigDocument(path, env, onDialect)).config;
}

/**
 * The checked-in config, and the DOCUMENT it was parsed from.
 *
 * The document is what the runtime overlay merges into (src/config/overlay.ts):
 * a merge at the parsed level would bake one image version's defaults into a
 * stored entry, and this is the only place that still holds the pre-schema
 * shape. Everything else about the load is unchanged — `loadConfig` is this
 * function with the extra fields dropped, so the boot path it has always had is
 * the boot path it still has.
 */
export async function loadConfigDocument(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  onDialect?: (dialect: DesugarResult) => void,
): Promise<LoadedConfig> {
  const compressed = env[CONFIG_GZ_ENV];
  if (compressed && compressed.trim() !== "") {
    return documentFrom(
      decodeCompressedConfig(compressed),
      CONFIG_GZ_ENV,
      onDialect,
    );
  }

  const inline = env.STRAD_CONFIG_YAML;
  if (inline && inline.trim() !== "") {
    return documentFrom(inline, "STRAD_CONFIG_YAML", onDialect);
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `no config at ${path}. strad ships with zero servers by default; ` +
          `copy strad.config.example.yaml to get started.`,
      );
    }
    throw err;
  }

  return documentFrom(raw, path, onDialect);
}

/** The env var `render-spec` bakes the compressed config document into. */
export const CONFIG_GZ_ENV = "STRAD_CONFIG_YAML_GZ_B64";

/**
 * `STRAD_CONFIG_YAML_GZ_B64` back to the YAML text it was made from.
 *
 * Exported for `src/deploy/config-inline.ts`, which decodes every value it
 * emits with THIS function before emitting it — the render's round-trip check
 * and boot are the same code, so a value that passed the one reads the same in
 * the other.
 *
 * Strict where `Buffer.from(…, "base64")` is not: that skips characters it does
 * not recognise, so a value truncated or mangled in transit could still gunzip
 * if the damage fell in the right place. A value that does not re-encode to
 * itself is refused, and so is anything gzip itself refuses. Either is a boot
 * failure with the variable's name in it, never a fall-through to another
 * source: falling back would start a gateway on a config nobody deployed.
 */
export function decodeCompressedConfig(value: string): string {
  const text = value.trim();
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== text) {
    throw new Error(`${CONFIG_GZ_ENV} is not valid base64.`);
  }
  try {
    return gunzipSync(bytes).toString("utf8");
  } catch (err) {
    throw new Error(
      `${CONFIG_GZ_ENV} is base64 but not gzip ` +
        `(${err instanceof Error ? err.message : "unknown error"}).`,
    );
  }
}

export interface LoadedConfig {
  /** The validated config, exactly what `loadConfig` has always returned. */
  config: StradConfig;
  /**
   * The document the schema parsed: YAML in, `mcpServers:` already folded away.
   *
   * The DESUGARED one rather than the raw one, and that is the whole of how
   * these two features compose. Merging the overlay into the RAW document would
   * put the overlay on one side of the dialect and the file's own `mcpServers:`
   * entries on the other — two server lists, one of which the merge cannot see,
   * and a slug collision nothing would detect. Desugaring first means an entry
   * written in either dialect is an ordinary `servers:` entry by the time the
   * overlay looks at it.
   */
  document: unknown;
  /** Where it came from, for an error message. */
  source: string;
}

/** Parse, hand the caller what the dialect did, and keep the document. */
function documentFrom(
  raw: string,
  source: string,
  onDialect?: (dialect: DesugarResult) => void,
): LoadedConfig {
  const result = parseConfigWithDialect(raw, source);
  if (onDialect && result.dialect.used) onDialect(result.dialect);
  return { config: result.config, document: result.dialect.doc, source };
}

/**
 * The YAML document, before the schema OR the dialect has seen it.
 *
 * Exposed for `src/deploy/config-inline.ts`, which round-trips the document it
 * bakes into `STRAD_CONFIG_YAML` and must compare the text as WRITTEN — the
 * container re-runs the desugar for itself at boot.
 */
export function parseYamlDocument(raw: string): unknown {
  return parseYaml(raw);
}

/**
 * The document the schema actually parses: YAML in, `mcpServers:` folded away.
 *
 * Exposed for the strict check (src/config/strict.ts), which needs the source
 * shape to say which keys the schema dropped — and which has to diff against
 * THIS document rather than the raw one, because the raw one carries a key
 * (`mcpServers`) the schema has never heard of and a `servers:` list shorter
 * than the parsed one.
 */
export function configDocument(raw: string): DesugarResult {
  return desugarDocument(parseYamlDocument(raw));
}

export interface ParsedConfig {
  config: StradConfig;
  /** What the `mcp.json` dialect contributed. `used: false` for a plain config. */
  dialect: DesugarResult;
}

/**
 * Parse, and say what the dialect did.
 *
 * The dialect's own refusals are reported BEFORE the schema's, and on their own:
 * a document whose `mcpServers:` did not desugar has a `servers:` list missing
 * those entries, so every schema error after that point would be a consequence
 * of the first failure rather than a finding.
 */
export function parseConfigWithDialect(
  raw: string,
  path = "<inline>",
): ParsedConfig {
  const dialect = configDocument(raw);
  if (dialect.errors.length > 0) {
    throw new Error(
      `invalid mcp.json dialect at ${path}:\n` +
        dialect.errors.map((e) => `  - ${e}`).join("\n"),
    );
  }

  const result = StradConfig.safeParse(dialect.doc);

  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid config at ${path}:\n${problems}`);
  }

  return { config: result.data, dialect };
}

export function parseConfig(raw: string, path = "<inline>"): StradConfig {
  return parseConfigWithDialect(raw, path).config;
}

export function configPathFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.STRAD_CONFIG ?? "./strad.config.yaml";
}
