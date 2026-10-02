import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { buildMonarchClient, IMonarchClient, type MonarchClient } from './monarch-client/client.js';
import { MonarchAuthError } from './monarch-client/graphql-transport.js';
import { MonarchAuthManager } from './monarch-client/auth-manager.js';
import {
  createFileSessionStore,
  defaultSessionPath,
  type SessionStore,
} from './monarch-client/session-store.js';
import { createRegisterTools } from './tools.js';

export type ClientFactory = () => Promise<IMonarchClient>;

export interface CreateMCPServerOptions {
  version: string;
  /** Override the session store (used by tests). */
  sessionStore?: SessionStore;
  /** Override the API endpoint (used by tests). */
  endpoint?: string;
  /** Override the fetch implementation (used by tests). */
  fetchImpl?: typeof fetch;
  /** Override the login endpoint (used by tests). */
  loginEndpoint?: string;
  /** Override the live environment credentials are read from (used by tests). */
  env?: NodeJS.ProcessEnv;
  /**
   * Make a runtime-set `MONARCH_COOKIE` durable. The strad bundle host wires
   * this to core's parameter write-back; see `MonarchAuthManager`.
   */
  persistCookie?: (cookie: string) => Promise<void>;
  /** Where `persistCookie` writes, for messages. */
  persistTarget?: string;
}

/**
 * Creates an MCP server instance for Monarch Money.
 *
 * The default client factory constructs a live `MonarchClient` per call, over
 * one shared `MonarchAuthManager` that resolves the credential per request
 * (`MONARCH_COOKIE` > `MONARCH_SESSION_TOKEN` > the session store) and
 * re-logs-in on a refusal when credentials are configured.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    {
      name: 'mcp-server-monarch-money',
      version: options.version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const sessionStore = options.sessionStore ?? createFileSessionStore();
  // ONE per server, not per request: it holds the login single-flight, the
  // cooldown after a failed login, and which environment credential a login
  // superseded. Credentials themselves are still read per request.
  const auth = new MonarchAuthManager({
    sessionStore,
    env: options.env,
    endpoint: options.endpoint,
    fetchImpl: options.fetchImpl,
    loginEndpoint: options.loginEndpoint,
    persistCookie: options.persistCookie,
    persistTarget: options.persistTarget,
  });

  const registerHandlers = async (server: Server, clientFactory?: ClientFactory) => {
    const factory: ClientFactory =
      clientFactory ??
      (async () => {
        const session = await sessionStore.load().catch(() => null);
        return buildMonarchClient({
          auth,
          session,
          endpoint: options.endpoint,
          fetchImpl: options.fetchImpl,
          onSessionChange: async (next) => {
            if (next === null) await sessionStore.clear();
            else await sessionStore.save(next);
          },
        });
      });

    const registerTools = createRegisterTools(factory, sessionStore, auth);
    registerTools(server);
  };

  return { server, registerHandlers, auth };
}

export {
  buildMonarchClient,
  MonarchAuthError,
  defaultSessionPath,
  type IMonarchClient,
  type MonarchClient,
  type SessionStore,
};
