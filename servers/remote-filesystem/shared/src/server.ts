import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { loadConfig, type StoreConfig } from "./config.js";
import { GcsArtifactStore, type ArtifactStore } from "./store.js";
import { parseToolGroups, registerTools, type ToolGroup } from "./tools.js";

export type StoreFactory = () => ArtifactStore;

export interface CreateMCPServerOptions {
  version: string;
  /**
   * The env prefix every config key is read under. The bundle passes
   * `REMOTE_FILESYSTEM_TMP_PUBLIC`, which is what keeps this server off the bare
   * `GCS_*` names the `gcs` server owns in the same container. See config.ts.
   */
  envPrefix?: string;
  /** Injected in tests; production reads the environment. */
  config?: StoreConfig;
  storeFactory?: StoreFactory;
  toolGroups?: ToolGroup[];
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, so the bundle host mounts it exactly like the others.
 *
 * Config and credentials are read LAZILY, inside `registerHandlers`, because the
 * image ships none — strad injects them onto the component at deploy time, and a
 * server that threw at import time would take the whole bundle down with it.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    { name: "strad-remote-filesystem", version: options.version },
    { capabilities: { tools: {} } },
  );

  // Process-lifetime memo. The bundle host serves this mount statelessly — a
  // fresh Server and a fresh registerHandlers call per HTTP request — so a store
  // built inside that function would rebuild the GCS client, and re-mint an
  // OAuth token, on every single call.
  let store: ArtifactStore | undefined;

  const registerHandlers = async (
    target: Server,
    storeFactory?: StoreFactory,
  ): Promise<void> => {
    const factory =
      storeFactory ??
      options.storeFactory ??
      ((): ArtifactStore => {
        store ??= new GcsArtifactStore(
          options.config ?? loadConfig(options.envPrefix ?? ""),
        );
        return store;
      });

    registerTools(
      target,
      factory,
      options.toolGroups ?? parseToolGroups(process.env.ENABLED_TOOLGROUPS),
    );
  };

  return { server, registerHandlers };
}
