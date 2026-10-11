import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { ENV, fatsecretConfig, fdcApiKey } from "./config.js";
import { defaultDataDir, LocalStore } from "./local/store.js";
import { Lookups } from "./lookup.js";
import { FatSecretClient, type ProxiedFetch } from "./remote/fatsecret.js";
import { FdcClient } from "./remote/fdc.js";
import { parseToolGroups, registerTools, type ToolGroup } from "./tools.js";

export interface CreateMCPServerOptions {
  version: string;
  /**
   * The environment this instance reads. Defaults to `process.env`. The bundle
   * host passes a mount-scoped view, so nothing here may reach past it.
   */
  env?: NodeJS.ProcessEnv;
  toolGroups?: ToolGroup[];
  /** Where `usda.json.gz` and `menustat.json.gz` are. Default `<tree>/data`. */
  dataDir?: string;
  /** Injected in tests: USDA FDC's fetch. Production uses the global. */
  fetch?: typeof fetch;
  /**
   * Injected in tests: FatSecret's transport. Production is undici's fetch with
   * a ProxyAgent for FATSECRET_PROXY_URL — FatSecret is never called directly.
   */
  fatsecretFetch?: ProxiedFetch;
  /** Injected in tests. */
  now?: () => number;
  /** Injected in tests: FatSecret's token URL and API base, FDC's base. */
  urls?: { fatsecretToken?: string; fatsecretApi?: string; fdc?: string };
  /** Injected in tests. Production is 4,500 a day. */
  fatsecretDailyBudget?: number;
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, so the bundle host mounts it like the others and builds
 * a fresh `Server` per request.
 *
 * THE STATE LIVES HERE, NOT IN THE PER-REQUEST SERVER: the parsed local data,
 * FatSecret's access token, both response caches and the daily call counter
 * are built once per factory call and shared by every request after it. A
 * per-request rebuild would re-parse 2 MB of data and spend a FatSecret token
 * request on every call.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    { name: "strad-nutrition-facts", version: options.version },
    { capabilities: { tools: {} } },
  );

  const env = () => options.env ?? process.env;
  const fetchImpl = options.fetch;
  const lookups = new Lookups({
    store: new LocalStore(
      options.dataDir ?? env()[ENV.dataDir]?.trim() ?? defaultDataDir(),
    ),
    fatsecret: new FatSecretClient({
      config: () => fatsecretConfig(env()),
      ...(options.fatsecretFetch ? { fetch: options.fatsecretFetch } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.urls?.fatsecretToken ? { tokenUrl: options.urls.fatsecretToken } : {}),
      ...(options.urls?.fatsecretApi ? { apiBase: options.urls.fatsecretApi } : {}),
      ...(options.fatsecretDailyBudget !== undefined
        ? { dailyBudget: options.fatsecretDailyBudget }
        : {}),
    }),
    fdc: new FdcClient({
      apiKey: () => fdcApiKey(env()),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      ...(options.urls?.fdc ? { base: options.urls.fdc } : {}),
    }),
    ...(options.now ? { now: options.now } : {}),
  });

  const registerHandlers = async (target: Server): Promise<void> => {
    registerTools(
      target,
      { lookups },
      options.toolGroups ?? parseToolGroups(env().ENABLED_TOOLGROUPS),
    );
  };

  return { server, registerHandlers };
}
