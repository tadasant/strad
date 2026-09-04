import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ParameterManagerReadClient,
  type ParametersReader,
} from "./parameter-manager.js";
import { loadConfig, type SecretsConfig, type SecretsStore } from "./config.js";
import { registerTools } from "./tools.js";
import {
  NO_CAPABILITIES,
  probeCapabilities,
  type Capabilities,
  type CapabilityLookup,
} from "./capabilities.js";
import { createWriteClient, type ParametersWriter } from "./write-client.js";
import type { GatewayRefresh } from "./tools.js";

export interface CreateMCPServerOptions {
  version: string;
  /** Injected in tests; production reads the environment. */
  config?: SecretsConfig;
  readerFactory?: (store: SecretsStore) => ParametersReader;
  /**
   * How to make the strad gateway re-read the store now.
   *
   * Supplied by the bundle host, which is the process that can reach core
   * (`STRAD_CORE_URL` + `STRAD_INTERNAL_TOKEN`); this tree cannot. Absent
   * means the `refresh_gateway` tool is not offered and a write's result says
   * the gateway will pick the value up within its TTL — never that it did.
   */
  refreshGateway?: GatewayRefresh;
  /**
   * Test seam: override the capability probe, PER PROJECT. Production asks
   * Google once per store, on the first listing that needs an answer, and caches
   * each for the lifetime of the factory — an IAM grant does not change
   * mid-request, and the tool LIST must be stable within a session or a client's
   * cached listing goes stale in a confusing way.
   */
  capabilities?: CapabilityLookup;
  writerFactory?: (store: SecretsStore) => ParametersWriter;
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, so the collapsed bundle host can mount it exactly like
 * the others.
 *
 * Credentials are read LAZILY, at registerHandlers time, because the image ships
 * none — strad injects them onto the component at deploy time.
 *
 * NOTHING IS SHARED BETWEEN TWO STORES. Each store gets its own read client, its
 * own write client and its own probe, keyed by project id — the same key the
 * console has used since it went multi-store (`capabilitiesFor` in
 * src/ui/index.ts). A cache keyed any less specifically would be the collapse
 * itself: one store's answer served for another's project.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    { name: "secrets-mcp-server", version: options.version },
    { capabilities: { tools: {} } },
  );

  // Process-lifetime memos, and they have to live OUT here.
  //
  // The bundle host serves this mount statelessly: a fresh `Server` and a fresh
  // `registerHandlers` call PER HTTP REQUEST. Anything declared inside that
  // function is therefore per-request, and a memo that is per-request is not a
  // memo — it is a round trip to Google (an OAuth token mint plus
  // `projects:testIamPermissions`) added to every single `tools/list`, which is
  // what made this mount's listing several times slower than its peers'.
  //
  // Keyed by PROJECT ID, all three. Two stores are two projects, two
  // credentials, two capabilities and two clients; the key is what keeps them
  // apart.
  const probed = new Map<string, Promise<Capabilities>>();
  const writers = new Map<string, ParametersWriter>();
  const readers = new Map<string, ParametersReader>();

  const registerHandlers = async (
    target: Server,
    readerFactory?: (store: SecretsStore) => ParametersReader,
  ): Promise<void> => {
    const config = options.config ?? loadConfig();

    const factory =
      readerFactory ??
      options.readerFactory ??
      ((store: SecretsStore): ParametersReader => {
        if (!store.account) {
          throw new Error(
            `${store.viewerKeyVar} is not configured; this server cannot list ` +
              `parameters in "${store.project}" without a (viewer) credential.`,
          );
        }
        const held = readers.get(store.project);
        if (held) return held;
        const client = new ParameterManagerReadClient({
          projectId: store.project,
          account: store.account,
          apiBase: config.apiBase,
          tokenUrl: config.tokenUrl,
        });
        readers.set(store.project, client);
        return client;
      });

    // ONE PROBE PER STORE per process. Memoised rather than per-request: the
    // answer is a property of one credential on one project, and re-asking on
    // every tools/list would add a round trip per store to every listing for a
    // value that changes when a human edits IAM. A revoked permission still
    // fails closed at Google.
    //
    // A project this server does not front never reaches here — tools.ts asks
    // only about a store it resolved a path to — but the lookup fails closed on
    // one anyway, because a capability question with no answer must not read as
    // a yes.
    const capabilities: CapabilityLookup =
      options.capabilities ??
      ((project: string) => {
        const store = config.stores.find((s) => s.project === project);
        if (!store) {
          return Promise.resolve({
            ...NO_CAPABILITIES,
            reason: `"${project}" is not a store this server fronts`,
          });
        }
        let answer = probed.get(project);
        if (!answer) {
          answer = store.account
            ? probeCapabilities({
                projectId: store.project,
                account: store.account,
                tokenUrl: config.tokenUrl,
              })
            : Promise.resolve({
                ...NO_CAPABILITIES,
                reason: `no credential is configured for "${project}" (${store.viewerKeyVar} is unset)`,
              });
          probed.set(project, answer);
        }
        return answer;
      });

    // The mutating client is built LAZILY and only ever reached through that
    // store's capability check in tools.ts. Constructing it is not the
    // permission; the probe is — and the probe it must pass is the one for THIS
    // store's project.
    const writerFactory =
      options.writerFactory ??
      ((store: SecretsStore): ParametersWriter => {
        if (!store.account) {
          throw new Error(
            `no credential is configured for "${store.project}" (${store.viewerKeyVar} is unset)`,
          );
        }
        const held = writers.get(store.project);
        if (held) return held;
        const client = createWriteClient({
          projectId: store.project,
          account: store.account,
          pmApiBase: config.apiBase,
          tokenUrl: config.tokenUrl,
        });
        writers.set(store.project, client);
        return client;
      });

    registerTools(target, {
      config,
      reader: factory,
      capabilities,
      writer: writerFactory,
      refreshGateway: options.refreshGateway,
    });
  };

  return { server, registerHandlers };
}
