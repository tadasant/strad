/**
 * strad's layer over the vendored AppSignal server — the only file in this tree
 * strad authored, and the only module the bundle host imports from it.
 *
 * Everything above `strad/` is pulsemcp/mcp-servers' `experimental/appsignal/
 * shared/src`, carrying the delta in servers/appsignal/README.md. This file is
 * where strad's rules about hosting it live, so a re-vendor of the upstream
 * tree cannot quietly revert them:
 *
 *   CREDENTIALS ARE INJECTED, NOT READ FROM process.env. Upstream builds its
 *   client from `process.env.APPSIGNAL_API_KEY`. The bundle hosts several mounts
 *   in one process, each with its own view of the environment
 *   (`<SLUG>__APPSIGNAL_API_KEY` ahead of the bare name), so this layer builds
 *   the client from the env it was HANDED, per call.
 *
 *   ONE APP PER MOUNT. Upstream's app selection (`get_apps`, `select_app_id`,
 *   `change_app_id`) writes one module-wide variable, and the bundle builds a
 *   fresh MCP server per request: a selection would leak between slugs and
 *   between callers, and the tool list would change under the gateway's
 *   `tools:` policy. So strad always runs upstream's LOCKED mode — the app is
 *   `APPSIGNAL_APP_ID`, required, scoped to each call with `runWithAppId` — and
 *   serves exactly the twenty tools locked mode serves.
 *
 *   custom_graphql_query IS READ-ONLY. Upstream forwards any document, and
 *   AppSignal's schema has mutations (archive alerts and triggers, bulk-update
 *   incidents, create apps, …). This mount's other nineteen tools only read, so
 *   the escape hatch is narrowed to `query` operations here, before anything is
 *   sent, rather than left as the one tool that can write.
 *
 *   THE KEY STAYS OUT OF RESULTS. Upstream sends the key in the GraphQL URL's
 *   query string, the only form AppSignal's GraphQL API accepts, so any error
 *   that quotes the request URL would quote the key. Every text result is
 *   scrubbed of it.
 */

import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { z } from 'zod';
import { parse, Kind } from 'graphql';

import { AppsignalClient, type IAppsignalClient } from '../appsignal-client/appsignal-client.js';
import { runWithAppId } from '../state.js';
import { getGraphqlSchemaTool } from '../tools/get-graphql-schema.js';
import { getGraphqlSchemaDetailsTool } from '../tools/get-graphql-schema-details.js';
import { getExceptionIncidentTool } from '../tools/get-exception-incident.js';
import { getExceptionIncidentSampleTool } from '../tools/get-exception-incident-sample.js';
import { getLogIncidentTool } from '../tools/get-log-incident.js';
import { searchLogsTool } from '../tools/search-logs.js';
import { getAnomalyIncidentTool } from '../tools/get-anomaly-incident.js';
import { getLogIncidentsTool } from '../tools/get-log-incidents.js';
import { getExceptionIncidentsTool } from '../tools/get-exception-incidents.js';
import { getAnomalyIncidentsTool } from '../tools/get-anomaly-incidents.js';
import { getPerfIncidentsTool } from '../tools/get-perf-incidents.js';
import { getPerfIncidentTool } from '../tools/get-perf-incident.js';
import { getPerfIncidentSampleTool } from '../tools/get-perf-incident-sample.js';
import { getPerfIncidentSampleTimelineTool } from '../tools/get-perf-incident-sample-timeline.js';
import { getSlowRequestsTool } from '../tools/get-slow-requests.js';
import { getDeployMarkersTool } from '../tools/get-deploy-markers.js';
import { getMetricsTool } from '../tools/get-metrics.js';
import { getPerfSamplesTool } from '../tools/get-perf-samples.js';
import { getMetricsTimeseriesTool } from '../tools/get-metrics-timeseries.js';
import { customGraphqlQueryTool } from '../tools/custom-graphql-query.js';

/** An AppSignal personal API token. */
export const APPSIGNAL_API_KEY = 'APPSIGNAL_API_KEY';

/** The app this mount reads. Required: strad never runs upstream's app selection. */
export const APPSIGNAL_APP_ID = 'APPSIGNAL_APP_ID';

/**
 * The variables that MAKE an instance of this server. The bundle host hands
 * this list to its per-slug discovery, which mounts one instance per slug the
 * container carries a complete set of them for.
 */
export const APPSIGNAL_ENV_NAMES = [APPSIGNAL_API_KEY, APPSIGNAL_APP_ID] as const;

export type Env = Readonly<Record<string, string | undefined>>;

const HOW_TO_GET_IT =
  'An AppSignal personal API token is under Personal settings -> Personal API token in AppSignal; ' +
  "the app ID is the 24-character id in the app's URL, https://appsignal.com/<org>/sites/<app id>/…";

/** Which required variables are absent. Empty means configured, not working. */
export function missingCredentials(env: Env): string[] {
  return APPSIGNAL_ENV_NAMES.filter((name) => !env[name]);
}

/** What one upstream tool factory returns. */
interface UpstreamTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: unknown) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

type ClientFactory = () => IAppsignalClient;

/** The two tools that read the schema shipped in this tree, and never AppSignal. */
const LOCAL_TOOLS = new Set(['get_graphql_schema', 'get_graphql_schema_details']);

/**
 * Upstream's locked-mode surface, in upstream's registration order: the two
 * schema tools, then the eighteen that read one app.
 */
function upstreamTools(clientFactory: ClientFactory): UpstreamTool[] {
  // Every factory takes an McpServer it never reads (`_server`); none is built.
  const server = undefined as never;
  const tools = [
    getGraphqlSchemaTool(server, clientFactory),
    getGraphqlSchemaDetailsTool(server, clientFactory),
    getExceptionIncidentTool(server, clientFactory),
    getExceptionIncidentSampleTool(server, clientFactory),
    getLogIncidentTool(server, clientFactory),
    searchLogsTool(server, clientFactory),
    getAnomalyIncidentTool(server, clientFactory),
    getLogIncidentsTool(server, clientFactory),
    getExceptionIncidentsTool(server, clientFactory),
    getAnomalyIncidentsTool(server, clientFactory),
    getPerfIncidentsTool(server, clientFactory),
    getPerfIncidentTool(server, clientFactory),
    getPerfIncidentSampleTool(server, clientFactory),
    getPerfIncidentSampleTimelineTool(server, clientFactory),
    getSlowRequestsTool(server, clientFactory),
    getDeployMarkersTool(server, clientFactory),
    getMetricsTool(server, clientFactory),
    getPerfSamplesTool(server, clientFactory),
    getMetricsTimeseriesTool(server, clientFactory),
    customGraphqlQueryTool(server, clientFactory),
  ];
  return tools as unknown as UpstreamTool[];
}

/** The names this mount serves, for tests and for a deployment's allow list. */
export const TOOL_NAMES: readonly string[] = upstreamTools(() => {
  throw new Error('not called');
}).map((t) => t.name);

/**
 * Why a custom GraphQL document may not be sent, or null when it may.
 *
 * Parsed rather than pattern-matched: `mutation` can hide behind a comment, a
 * second operation, or an anonymous shorthand, and only the parser agrees with
 * AppSignal about which operations a document holds. A document that does not
 * parse is passed through so that AppSignal's own error reaches the caller.
 */
export function refuseNonQuery(query: string): string | null {
  let document;
  try {
    document = parse(query);
  } catch {
    return null;
  }
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION && definition.operation !== 'query') {
      return (
        `custom_graphql_query only runs read operations on this server, and this document ` +
        `contains a ${definition.operation}. Nothing was sent to AppSignal. Rewrite it as a ` +
        `query; a change to AppSignal is made in AppSignal itself.`
      );
    }
  }
  return null;
}

/** Remove the literal key from text this layer did not write. */
function scrubber(key: string | undefined): (text: string) => string {
  // Splitting on a short or empty string would shred every message.
  if (!key || key.length < 8) return (text) => text;
  return (text) => text.split(key).join('[redacted]');
}

export interface CreateOptions {
  version: string;
  /** ONE slug's view of the container environment. */
  env: Env;
  /** Injected in tests. Production builds upstream's client from `env`. */
  clientFactory?: (apiKey: string, appId: string) => IAppsignalClient;
}

export interface CreatedServer {
  /** Which required variables are absent; empty when the mount is configured. */
  missing: string[];
  registerHandlers: (server: unknown) => Promise<void>;
}

/** A `Server` from the tree's own SDK copy, as much of it as this file uses. */
interface ServerLike {
  setRequestHandler: (schema: unknown, handler: (request: never) => unknown) => void;
}

export function createMCPServer(options: CreateOptions): CreatedServer {
  const env = options.env;
  const build =
    options.clientFactory ?? ((apiKey: string, appId: string) => new AppsignalClient(apiKey, appId));

  // Read on each call, so a tool call reports a missing credential by name
  // instead of the mount refusing to list.
  const clientFactory: ClientFactory = () => {
    const missing = missingCredentials(env);
    if (missing.length > 0) {
      throw new Error(`${missing.join(' and ')} not configured. ${HOW_TO_GET_IT}`);
    }
    return build(env[APPSIGNAL_API_KEY]!, env[APPSIGNAL_APP_ID]!);
  };

  const tools = upstreamTools(clientFactory);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const listed = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toJsonSchemaCompat(z.object(t.inputSchema)) as { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  }));

  const call = async (name: string, args: unknown) => {
    const tool = byName.get(name);
    if (!tool) {
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }
    const missing = missingCredentials(env);
    if (missing.length > 0 && !LOCAL_TOOLS.has(name)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not configured for this AppSignal mount, so nothing was sent. ${HOW_TO_GET_IT}`,
          },
        ],
        isError: true,
      };
    }
    if (name === 'custom_graphql_query') {
      const query = (args as { query?: unknown } | undefined)?.query;
      const refused = typeof query === 'string' ? refuseNonQuery(query) : null;
      if (refused) {
        return { content: [{ type: 'text' as const, text: refused }], isError: true };
      }
    }
    const scrub = scrubber(env[APPSIGNAL_API_KEY]);
    try {
      const result = await runWithAppId(env[APPSIGNAL_APP_ID]!, () => tool.handler(args ?? {}));
      return {
        ...result,
        content: result.content.map((c) => (c.type === 'text' ? { ...c, text: scrub(c.text) } : c)),
      };
    } catch (error) {
      // Upstream throws on an argument its Zod schema rejects; the rest it
      // answers as text itself.
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: scrub(message) }], isError: true };
    }
  };

  return {
    missing: missingCredentials(env),
    registerHandlers: async (server: unknown): Promise<void> => {
      const s = server as ServerLike;
      s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
      s.setRequestHandler(
        CallToolRequestSchema,
        async (request: { params: { name: string; arguments?: Record<string, unknown> } }) =>
          await call(request.params.name, request.params.arguments)
      );
    },
  };
}
