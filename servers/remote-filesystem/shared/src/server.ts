import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { loadConfig, type StoreConfig } from "./config.js";
import { GcsArtifactStore, type ArtifactStore } from "./store.js";
import { parseToolGroups, registerTools, type ToolGroup } from "./tools.js";
import {
  createUploadLeaseStore,
  handleUploadPost,
  type UploadLeaseStore,
} from "./upload-targets.js";

export type StoreFactory = () => ArtifactStore;

export interface CreateMCPServerOptions {
  version: string;
  /**
   * The env prefix every config key is read under. The bundle passes
   * `REMOTE_FILESYSTEM_TMP_PUBLIC`, which is what keeps this server off the bare
   * `GCS_*` names the `gcs` server owns in the same container. See config.ts.
   */
  envPrefix?: string;
  /**
   * The environment this instance reads. Defaults to `process.env`.
   *
   * The bundle host passes a SLUG-SCOPED VIEW, so a second slug of this server
   * can point at a second bucket from the same container. It layers OVER
   * `envPrefix` rather than replacing it: the prefix is what keeps this server
   * off the bare `GCS_*` names the `gcs` server owns in the same process, and the
   * view's fallback to a bare name would walk straight into them.
   */
  env?: NodeJS.ProcessEnv;
  /** Injected in tests; production reads the environment. */
  config?: StoreConfig;
  storeFactory?: StoreFactory;
  toolGroups?: ToolGroup[];
  uploadLeases?: UploadLeaseStore;
  /** Slug used in the public upload route. */
  uploadSlug?: string;
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
  const uploadLeases =
    options.uploadLeases ??
    createUploadLeaseStore({
      slug: options.uploadSlug ?? "remote-filesystem-tmp-public",
      config: options.config,
      envPrefix: options.envPrefix,
      env: options.env,
    });

  const resolveStoreFactory = (storeFactory?: StoreFactory): StoreFactory =>
    storeFactory ??
    options.storeFactory ??
    ((): ArtifactStore => {
      store ??= new GcsArtifactStore(
        options.config ?? loadConfig(options.envPrefix ?? "", options.env),
      );
      return store;
    });

  const registerHandlers = async (
    target: Server,
    storeFactory?: StoreFactory,
  ): Promise<void> => {
    registerTools(
      target,
      resolveStoreFactory(storeFactory),
      uploadLeases,
      options.toolGroups ??
        parseToolGroups((options.env ?? process.env).ENABLED_TOOLGROUPS),
    );
  };

  const handleUpload = async (
    token: string,
    body: Buffer,
    storeFactory?: StoreFactory,
  ) =>
    handleUploadPost(
      token,
      body,
      uploadLeases,
      resolveStoreFactory(storeFactory),
    );

  return { server, registerHandlers, handleUpload, uploadLeases };
}
