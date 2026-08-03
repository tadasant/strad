/**
 * Tool for getting detailed information about a specific MCP server
 */

import { z } from "zod";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ClientFactory } from "../client.js";
import { truncateStrings, deepClone } from "../utils/truncation.js";

const PARAM_DESCRIPTIONS = {
  server_name:
    'The registry server name to look up. Example: "io.github.modelcontextprotocol/servers/everything". Use list_servers first if you only know a title or provider name.',
  version:
    'Specific version to retrieve. Use "latest" (default) for the most recent version, or specify a semver version like "1.0.0".',
  expand_fields:
    'Array of dot-notation paths to show in full. By default, strings longer than 200 characters and very deep objects are replaced with expansion hints. Examples: ["server.description", "server.readme"].',
} as const;

const getServerArgsSchema = z.object({
  server_name: z.string().min(1).describe(PARAM_DESCRIPTIONS.server_name),
  version: z.string().optional().default("latest").describe(PARAM_DESCRIPTIONS.version),
  expand_fields: z.array(z.string()).optional().describe(PARAM_DESCRIPTIONS.expand_fields),
});

interface GetServerResponse {
  server: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * Applies truncation to the response, expanding specified fields.
 */
function applyTruncation(response: GetServerResponse, expandFields?: string[]): GetServerResponse {
  const cloned = deepClone(response);
  return truncateStrings(cloned, expandFields || []) as GetServerResponse;
}

function formatServerDetailsAsJson(response: GetServerResponse): string {
  return JSON.stringify(response, null, 2);
}

export function getServerTool(_server: Server, clientFactory: ClientFactory) {
  return {
    name: "get_server",
    description:
      "Get detailed information about one MCP server from the PulseMCP Sub-Registry.\n\n" +
      "Returns a JSON object with `server` and optional `_meta` fields for the requested version. Use `version: \"latest\"` unless you need a historical version. Long strings and deep nested values are truncated by default; pass `expand_fields` with a dot path from the truncation hint to retrieve specific fields in full.\n\n" +
      "Example response:\n" +
      "{\n" +
      '  "server": { "name": "io.github.example/server", "version": "1.0.0", "repository": { "url": "https://github.com/example/server" } },\n' +
      '  "_meta": { "com.pulsemcp/server-version": { "isLatest": true, "status": "active" } }\n' +
      "}\n\n" +
      "Use cases: inspect install metadata after search, fetch README or package fields with `expand_fields`, compare a pinned version with latest, check source/repository metadata, and prepare registry sync records.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object" as const,
      properties: {
        server_name: {
          type: "string",
          description: PARAM_DESCRIPTIONS.server_name,
        },
        version: {
          type: "string",
          description: PARAM_DESCRIPTIONS.version,
          default: "latest",
        },
        expand_fields: {
          type: "array",
          items: { type: "string" },
          description: PARAM_DESCRIPTIONS.expand_fields,
        },
      },
      required: ["server_name"],
    },
    handler: async (args: unknown) => {
      try {
        const validatedArgs = getServerArgsSchema.parse(args);
        const client = clientFactory();

        const response = await client.getServer({
          serverName: validatedArgs.server_name,
          version: validatedArgs.version,
        });

        const filteredResponse = applyTruncation(response, validatedArgs.expand_fields);
        const jsonOutput = formatServerDetailsAsJson(filteredResponse);

        return {
          content: [
            {
              type: "text",
              text: jsonOutput,
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        return {
          content: [
            {
              type: "text",
              text: `Error getting server details: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
