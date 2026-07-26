import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { StradConfig } from "./schema.ts";

/**
 * Load and validate the config.
 *
 * Two sources, in priority order:
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
 */
export async function loadConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StradConfig> {
  const inline = env.STRAD_CONFIG_YAML;
  if (inline && inline.trim() !== "") {
    return parseConfig(inline, "STRAD_CONFIG_YAML");
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

  return parseConfig(raw, path);
}

/**
 * The YAML document, before the schema has seen it.
 *
 * Exposed for the strict check (src/config/strict.ts), which needs the source
 * shape to say which keys the schema dropped.
 */
export function parseYamlDocument(raw: string): unknown {
  return parseYaml(raw);
}

export function parseConfig(raw: string, path = "<inline>"): StradConfig {
  const doc: unknown = parseYamlDocument(raw);
  const result = StradConfig.safeParse(doc);

  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid config at ${path}:\n${problems}`);
  }

  return result.data;
}

export function configPathFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.STRAD_CONFIG ?? "./strad.config.yaml";
}
