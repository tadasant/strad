/**
 * strad's layer over the vendored AppSignal server, through a real MCP client
 * over an in-memory transport — the same low-level `Server` the bundle host
 * builds per request.
 *
 * These suites are what fail if the delta in servers/appsignal/README.md is
 * reverted by a careless re-vendor: the per-call app scope, the read-only
 * escape hatch, the key kept out of results. They live at the tree root, not
 * in `shared/`, because a re-vendor overwrites `shared/`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APPSIGNAL_ENV_NAMES,
  TOOL_NAMES,
  createMCPServer,
  missingCredentials,
  refuseNonQuery,
  type CreateOptions,
} from '../shared/build/strad/index.js';
import { getEffectiveAppId, isAppIdLocked } from '../shared/build/state.js';

const KEY = 'test-appsignal-key-0123456789abcdef';
const APP = '674fa72ad2a5e4ed3afb6b2c';
const ENV = { APPSIGNAL_API_KEY: KEY, APPSIGNAL_APP_ID: APP };

/** Upstream's locked-mode surface: two schema tools and eighteen that read one app. */
const EXPECTED_TOOLS = [
  'get_graphql_schema',
  'get_graphql_schema_details',
  'get_exception_incident',
  'get_exception_incident_sample',
  'get_log_incident',
  'search_logs',
  'get_anomaly_incident',
  'get_log_incidents',
  'get_exception_incidents',
  'get_anomaly_incidents',
  'get_perf_incidents',
  'get_perf_incident',
  'get_perf_incident_sample',
  'get_perf_incident_sample_timeline',
  'get_slow_requests',
  'get_deploy_markers',
  'get_metrics',
  'get_perf_samples',
  'get_metrics_timeseries',
  'custom_graphql_query',
];

const clients: Client[] = [];

async function connect(options: Partial<CreateOptions> = {}): Promise<Client> {
  const created = createMCPServer({ version: 'test', env: ENV, ...options });
  const server = new Server({ name: 'strad-appsignal', version: 'test' }, { capabilities: { tools: {} } });
  await created.registerHandlers(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: 'test' });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

function text(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map((c) => c.text ?? '').join('\n');
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('the tool surface', () => {
  it('is exactly upstream locked mode: no app selection, twenty reads', async () => {
    expect([...TOOL_NAMES]).toEqual(EXPECTED_TOOLS);
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_TOOLS);
    for (const name of ['get_apps', 'select_app_id', 'change_app_id']) {
      expect(tools.map((t) => t.name)).not.toContain(name);
    }
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('still lists with no credential, and every AppSignal call names what is missing', async () => {
    expect(missingCredentials({})).toEqual([...APPSIGNAL_ENV_NAMES]);
    expect(missingCredentials({ APPSIGNAL_API_KEY: KEY })).toEqual(['APPSIGNAL_APP_ID']);
    const factory = vi.fn();
    const client = await connect({ env: {}, clientFactory: factory });
    expect((await client.listTools()).tools).toHaveLength(20);
    const result = await client.callTool({ name: 'get_exception_incidents', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('APPSIGNAL_API_KEY and APPSIGNAL_APP_ID');
    expect(factory).not.toHaveBeenCalled();
  });

  it('serves the shipped schema without a credential', async () => {
    const client = await connect({ env: {} });
    const result = await client.callTool({ name: 'get_graphql_schema', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('Query');
  });
});

describe('one app per mount', () => {
  it('scopes the app ID to the call, so two mounts in one process do not share one', async () => {
    const seen: string[] = [];
    const factory = (apiKey: string, appId: string) =>
      ({
        getDeployMarkers: async () => {
          // What upstream's guard reads, from inside the call.
          seen.push(`${appId}:${getEffectiveAppId()}:${isAppIdLocked()}`);
          await new Promise((r) => setTimeout(r, 5));
          seen.push(`${appId}:${getEffectiveAppId()}`);
          return [];
        },
      }) as never;
    const a = await connect({ env: { APPSIGNAL_API_KEY: KEY, APPSIGNAL_APP_ID: 'app-a' }, clientFactory: factory });
    const b = await connect({ env: { APPSIGNAL_API_KEY: KEY, APPSIGNAL_APP_ID: 'app-b' }, clientFactory: factory });
    await Promise.all([
      a.callTool({ name: 'get_deploy_markers', arguments: {} }),
      b.callTool({ name: 'get_deploy_markers', arguments: {} }),
    ]);
    expect(seen.sort()).toEqual(['app-a:app-a', 'app-a:app-a:true', 'app-b:app-b', 'app-b:app-b:true']);
    // Outside a call, upstream's own behaviour is untouched.
    expect(getEffectiveAppId()).toBe(process.env.APPSIGNAL_APP_ID || undefined);
  });
});

describe('custom_graphql_query is read-only', () => {
  it.each([
    'mutation { archiveAlert(id: "1", appId: "x") }',
    'query A { viewer { id } } mutation B { createApp(organizationSlug: "o", name: "n", environment: "e") { id } }',
    '# a comment\nsubscription { x }',
  ])('refuses %s before anything is sent', async (query) => {
    expect(refuseNonQuery(query)).not.toBeNull();
    const executeCustomQuery = vi.fn();
    const client = await connect({ clientFactory: () => ({ executeCustomQuery }) as never });
    const result = await client.callTool({ name: 'custom_graphql_query', arguments: { query } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('only runs read operations');
    expect(executeCustomQuery).not.toHaveBeenCalled();
  });

  it('runs a query, with the mount app ID injected for $appId', async () => {
    const executeCustomQuery = vi.fn(async () => ({ app: { id: APP } }));
    const client = await connect({ clientFactory: () => ({ executeCustomQuery }) as never });
    const query = 'query Q($appId: String!) { app(id: $appId) { id } }';
    expect(refuseNonQuery(query)).toBeNull();
    expect(refuseNonQuery('{ viewer { id } }')).toBeNull();
    const result = await client.callTool({ name: 'custom_graphql_query', arguments: { query } });
    expect(result.isError).toBeFalsy();
    expect(executeCustomQuery).toHaveBeenCalledWith(query, { appId: APP });
  });
});

describe("upstream's real client", () => {
  it('sends the key to appsignal.com only, and keeps it out of an error that quotes it', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        return new Response(JSON.stringify({ errors: [{ message: `bad token ${KEY}` }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );
    const client = await connect();
    const result = await client.callTool({ name: 'get_deploy_markers', arguments: {} });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).origin).toBe('https://appsignal.com');
    expect(text(result)).toContain('[redacted]');
    expect(text(result)).not.toContain(KEY);
  });
});
