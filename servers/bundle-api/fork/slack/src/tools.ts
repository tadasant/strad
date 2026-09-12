import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ClientFactory } from './server.js';
import { logWarning } from './logging.js';
import { getChannelsTool } from './tools/get-channels.js';
import { getChannelTool } from './tools/get-channel.js';
import { getThreadTool } from './tools/get-thread.js';
import { postMessageTool } from './tools/post-message.js';
import { replyToThreadTool } from './tools/reply-to-thread.js';
import { updateMessageTool } from './tools/update-message.js';
import { reactToMessageTool } from './tools/react-to-message.js';
import { downloadFileTool, type DownloadLinkConfig } from './tools/download-file.js';
import { uploadSnippetTool } from './tools/upload-snippet.js';
import { findUserTool } from './tools/find-user.js';
import { getDmsTool } from './tools/get-dms.js';
import { getDmTool } from './tools/get-dm.js';
import { sendDmTool } from './tools/send-dm.js';

/**
 * Tool groups for permission-based access control
 */
export type ToolGroup = 'readonly' | 'write';

const ALL_TOOL_GROUPS: ToolGroup[] = ['readonly', 'write'];

/**
 * Parse enabled tool groups from environment variable
 */
export function parseEnabledToolGroups(enabledGroupsParam?: string): ToolGroup[] {
  if (!enabledGroupsParam) {
    return ALL_TOOL_GROUPS;
  }

  const requestedGroups = enabledGroupsParam.split(',').map((g) => g.trim().toLowerCase());
  const validGroups = requestedGroups.filter((g): g is ToolGroup =>
    ALL_TOOL_GROUPS.includes(g as ToolGroup)
  );

  if (validGroups.length === 0) {
    logWarning(
      'parseEnabledToolGroups',
      `No valid tool groups found in "${enabledGroupsParam}". Valid groups: ${ALL_TOOL_GROUPS.join(', ')}`
    );
    return ALL_TOOL_GROUPS;
  }

  return validGroups;
}

/**
 * Generic tool interface
 */
interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

/**
 * Per-mount wiring a tool may need beyond a Slack client.
 *
 * Threaded as a third argument so the twelve tools that need none of it keep
 * their two-parameter signatures unchanged — a narrower function is assignable
 * to a wider one, which is what keeps this additive.
 */
export interface ToolContext {
  downloadLink?: DownloadLinkConfig;
}

type ToolFactory = (
  server: Server,
  clientFactory: ClientFactory,
  ctx: ToolContext
) => Tool;

interface ToolDefinition {
  factory: ToolFactory;
  groups: ToolGroup[];
}

/**
 * All available tools with their group assignments
 */
const ALL_TOOLS: ToolDefinition[] = [
  // Read-only tools
  { factory: getChannelsTool, groups: ['readonly', 'write'] },
  { factory: getChannelTool, groups: ['readonly', 'write'] },
  { factory: getThreadTool, groups: ['readonly', 'write'] },
  { factory: downloadFileTool, groups: ['readonly', 'write'] },
  { factory: getDmsTool, groups: ['readonly', 'write'] },
  { factory: getDmTool, groups: ['readonly', 'write'] },
  { factory: findUserTool, groups: ['readonly', 'write'] },
  // Write tools
  { factory: postMessageTool, groups: ['write'] },
  { factory: replyToThreadTool, groups: ['write'] },
  { factory: updateMessageTool, groups: ['write'] },
  { factory: reactToMessageTool, groups: ['write'] },
  { factory: uploadSnippetTool, groups: ['write'] },
  { factory: sendDmTool, groups: ['write'] },
];

/**
 * Creates a function to register all tools with the server
 */
export function createRegisterTools(
  clientFactory: ClientFactory,
  enabledGroups?: ToolGroup[],
  ctx: ToolContext = {}
) {
  const groups = enabledGroups || parseEnabledToolGroups(process.env.ENABLED_TOOLGROUPS);

  return (server: Server) => {
    // Filter tools by enabled groups and create instances
    const tools = ALL_TOOLS.filter((def) => def.groups.some((g) => groups.includes(g))).map((def) =>
      def.factory(server, clientFactory, ctx)
    );

    // List available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    });

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }

      return await tool.handler(args);
    });
  };
}

/**
 * Backward compatibility export
 */
export function registerTools(server: Server) {
  const factory = () => {
    throw new Error(
      'No client factory provided - use createRegisterTools for dependency injection'
    );
  };
  const register = createRegisterTools(factory);
  register(server);
}
