import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logDebug } from '../logging.js';

/**
 * The seed table: which strategy to reach for FIRST on a prefix we already know
 * a bare fetch cannot serve. Everything else is learned at runtime.
 */
const SEED_CONFIG = `# Scraping Strategy Configuration

This file defines which scraping strategy to use for different URL prefixes (firecrawl, brightdata, native).

| prefix        | default_strategy | notes                                      |
| ------------- | ---------------- | ------------------------------------------ |
| yelp.com/biz/ | brightdata       | Yelp business pages need anti-bot measures |
`;

/**
 * Where the learned strategy table lives.
 *
 * Priority:
 * 1. STRAD_FETCH_STRATEGY_CONFIG_PATH
 * 2. a per-server directory under the OS temp dir, seeded on first use
 *
 * FORK DELTA — the env var is NAMESPACED (upstream reads a bare
 * `STRATEGY_CONFIG_PATH`, which is not a name to claim on a container shared with
 * nineteen other mounts), and the "copy the packaged default in" branch is gone:
 * it resolved a path three directories above the built module, which no layout
 * this tree ships has ever contained, so every deployment took the fallback. The
 * fallback IS the default now, written out plainly.
 *
 * NOTE ON PERSISTENCE. The temp dir does not survive a container replacement, so
 * what is learned is learned per container. That is a cache, not a database, and
 * losing it costs one extra strategy attempt on the next scrape.
 */
export async function getStrategyConfigPath(): Promise<string> {
  const envPath = process.env.STRAD_FETCH_STRATEGY_CONFIG_PATH;
  if (envPath) {
    return envPath;
  }

  const tempDir = join(tmpdir(), 'strad-fetch');
  const tempConfigPath = join(tempDir, 'scraping-strategies.md');

  try {
    await fs.access(tempConfigPath);
    return tempConfigPath;
  } catch {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(tempConfigPath, SEED_CONFIG, 'utf-8');
    logDebug('getStrategyConfigPath', `Initialized strategy config at: ${tempConfigPath}`);
    return tempConfigPath;
  }
}
