import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { connect, type Connector } from "./client.js";
import { loadConfig, type SshConfig } from "./config.js";
import { parseToolGroups, registerTools, type ToolGroup } from "./tools.js";

export interface CreateMCPServerOptions {
  version: string;
  /**
   * The strad slug this instance serves — `ssh-ci-runner`, say. Reported by
   * `ssh_connection_info` and in every error, so an agent holding several SSH
   * slugs can always tell which machine it is talking to.
   */
  label?: string;
  /**
   * The environment this instance reads. Defaults to `process.env`.
   *
   * The bundle host passes an INJECTED VIEW: a store-served instance's own
   * namespace and no bare name from the container. Nothing in this tree reaches
   * past it,
   * which is what makes one instance per host possible inside one process.
   */
  env?: NodeJS.ProcessEnv;
  /** Injected in tests; production reads `env`. */
  config?: SshConfig;
  /** Injected in tests; production opens a real SSH connection. */
  connector?: Connector;
  toolGroups?: ToolGroup[];
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, so the bundle host mounts it exactly like the others.
 *
 * CREDENTIALS ARE LAZY. The image ships none, and this server shares a process
 * with every other mount in the bundle — so a missing or malformed value is one
 * slug's failed tool call, never a boot failure. `tools/list` answers with no
 * configuration at all. The configuration is re-read on every call, so a value
 * seeded in the store after boot is used on the next call.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const label = options.label ?? "ssh";
  const env = (): NodeJS.ProcessEnv => options.env ?? process.env;

  const server = new Server(
    { name: "strad-ssh", version: options.version },
    { capabilities: { tools: {} } },
  );

  const registerHandlers = async (target: Server): Promise<void> => {
    registerTools(
      target,
      {
        label,
        env,
        config: () => options.config ?? loadConfig(env()),
        connector: options.connector ?? connect,
      },
      options.toolGroups ?? parseToolGroups(env().ENABLED_TOOLGROUPS),
    );
  };

  return { server, registerHandlers };
}
