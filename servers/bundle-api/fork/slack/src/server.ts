import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createRegisterTools } from './tools.js';
import type { OpenDmResult } from './slack-client/lib/open-dm.js';
import type { Channel, DmList, Message, SlackFile, User, UserSearch } from './types.js';

/**
 * Slack API client interface
 * Defines all methods for interacting with the Slack Web API
 */
export interface ISlackClient {
  /**
   * Get all channels the bot has access to
   */
  getChannels(options?: { types?: string; excludeArchived?: boolean }): Promise<Channel[]>;

  /**
   * Get information about a specific channel
   */
  getChannel(channelId: string): Promise<Channel>;

  /**
   * Get message history from a channel
   */
  getMessages(
    channelId: string,
    options?: {
      limit?: number;
      cursor?: string;
      oldest?: string;
      latest?: string;
    }
  ): Promise<{
    messages: Message[];
    hasMore: boolean;
    nextCursor?: string;
  }>;

  /**
   * Get all replies in a thread
   */
  getThread(
    channelId: string,
    threadTs: string,
    options?: {
      limit?: number;
      cursor?: string;
    }
  ): Promise<{
    messages: Message[];
    hasMore: boolean;
    nextCursor?: string;
  }>;

  /**
   * Post a new message to a channel
   */
  postMessage(
    channelId: string,
    text: string,
    options?: {
      threadTs?: string;
      replyBroadcast?: boolean;
    }
  ): Promise<Message>;

  /**
   * Update an existing message
   */
  updateMessage(channelId: string, ts: string, text: string): Promise<Message>;

  /**
   * Add a reaction to a message
   */
  addReaction(channelId: string, timestamp: string, emoji: string): Promise<void>;

  /**
   * Get file metadata from Slack
   */
  getFileInfo(fileId: string): Promise<SlackFile>;

  /**
   * Download a file from Slack (requires authenticated URL)
   */
  downloadFile(fileUrl: string): Promise<Buffer>;

  /**
   * Upload text content as a snippet/file to a channel
   */
  uploadSnippet(
    content: string,
    options: {
      channelId: string;
      filename?: string;
      title?: string;
      threadTs?: string;
    }
  ): Promise<SlackFile>;

  /**
   * Get one workspace member by ID
   */
  getUser(userId: string): Promise<User>;

  /**
   * Search workspace members by handle, display name, real name or email.
   * `truncated` reports whether the whole directory was read.
   */
  findUsers(query: string): Promise<UserSearch>;

  /**
   * Resolve an email address to a member, or null if nobody has it
   */
  lookupUserByEmail(email: string): Promise<User | null>;

  /**
   * Get the DM channel id for a user, opening the conversation if needed
   */
  openDm(userId: string): Promise<OpenDmResult>;

  /**
   * Get the EXISTING DM channel id for a user, or null — opens nothing.
   * Throws rather than returning null when the scan was cut short.
   */
  findDmChannel(userId: string): Promise<string | null>;

  /**
   * List the DM conversations the bot is part of
   */
  getDms(options?: { includeGroupDms?: boolean; limit?: number }): Promise<DmList>;
}

/**
 * Slack API client implementation
 */
export class SlackClient implements ISlackClient {
  private baseUrl = 'https://slack.com/api';
  private headers: Record<string, string>;

  constructor(private botToken: string) {
    this.headers = {
      Authorization: `Bearer ${botToken}`,
    };
  }

  async getChannels(options?: { types?: string; excludeArchived?: boolean }): Promise<Channel[]> {
    const { getChannels } = await import('./slack-client/lib/get-channels.js');
    return getChannels(this.baseUrl, this.headers, options);
  }

  async getChannel(channelId: string): Promise<Channel> {
    const { getChannel } = await import('./slack-client/lib/get-channel.js');
    return getChannel(this.baseUrl, this.headers, channelId);
  }

  async getMessages(
    channelId: string,
    options?: {
      limit?: number;
      cursor?: string;
      oldest?: string;
      latest?: string;
    }
  ): Promise<{
    messages: Message[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    const { getMessages } = await import('./slack-client/lib/get-messages.js');
    return getMessages(this.baseUrl, this.headers, channelId, options);
  }

  async getThread(
    channelId: string,
    threadTs: string,
    options?: {
      limit?: number;
      cursor?: string;
    }
  ): Promise<{
    messages: Message[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    const { getThread } = await import('./slack-client/lib/get-thread.js');
    return getThread(this.baseUrl, this.headers, channelId, threadTs, options);
  }

  async postMessage(
    channelId: string,
    text: string,
    options?: {
      threadTs?: string;
      replyBroadcast?: boolean;
    }
  ): Promise<Message> {
    const { postMessage } = await import('./slack-client/lib/post-message.js');
    return postMessage(this.baseUrl, this.headers, channelId, text, options);
  }

  async updateMessage(channelId: string, ts: string, text: string): Promise<Message> {
    const { updateMessage } = await import('./slack-client/lib/update-message.js');
    return updateMessage(this.baseUrl, this.headers, channelId, ts, text);
  }

  async addReaction(channelId: string, timestamp: string, emoji: string): Promise<void> {
    const { addReaction } = await import('./slack-client/lib/add-reaction.js');
    return addReaction(this.baseUrl, this.headers, channelId, timestamp, emoji);
  }

  async getFileInfo(fileId: string): Promise<SlackFile> {
    const { getFileInfo } = await import('./slack-client/lib/get-file-info.js');
    return getFileInfo(this.baseUrl, this.headers, fileId);
  }

  async downloadFile(fileUrl: string): Promise<Buffer> {
    const { downloadFile } = await import('./slack-client/lib/download-file.js');
    return downloadFile(this.headers, fileUrl);
  }

  async uploadSnippet(
    content: string,
    options: {
      channelId: string;
      filename?: string;
      title?: string;
      threadTs?: string;
    }
  ): Promise<SlackFile> {
    const { uploadSnippet } = await import('./slack-client/lib/upload-snippet.js');
    return uploadSnippet(this.baseUrl, this.headers, content, options);
  }

  async getUser(userId: string): Promise<User> {
    const { getUser } = await import('./slack-client/lib/get-user.js');
    return getUser(this.baseUrl, this.headers, userId);
  }

  async findUsers(query: string): Promise<UserSearch> {
    const { findUsers } = await import('./slack-client/lib/find-users.js');
    return findUsers(this.baseUrl, this.headers, query);
  }

  async lookupUserByEmail(email: string): Promise<User | null> {
    const { lookupUserByEmail } = await import('./slack-client/lib/lookup-user-by-email.js');
    return lookupUserByEmail(this.baseUrl, this.headers, email);
  }

  async openDm(userId: string): Promise<OpenDmResult> {
    const { openDm } = await import('./slack-client/lib/open-dm.js');
    return openDm(this.baseUrl, this.headers, userId);
  }

  async findDmChannel(userId: string): Promise<string | null> {
    const { findDmChannel } = await import('./slack-client/lib/open-dm.js');
    return findDmChannel(this.baseUrl, this.headers, userId);
  }

  async getDms(options?: { includeGroupDms?: boolean; limit?: number }): Promise<DmList> {
    const { getDms } = await import('./slack-client/lib/get-dms.js');
    return getDms(this.baseUrl, this.headers, options);
  }
}

export type ClientFactory = () => ISlackClient;

export interface CreateMCPServerOptions {
  version: string;
}

export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    {
      name: 'slack-workspace-mcp-server',
      version: options.version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const registerHandlers = async (server: Server, clientFactory?: ClientFactory) => {
    // Use provided factory or create default client
    const factory =
      clientFactory ||
      (() => {
        const botToken = process.env.SLACK_BOT_TOKEN;

        if (!botToken) {
          throw new Error('SLACK_BOT_TOKEN environment variable must be configured');
        }

        return new SlackClient(botToken);
      });

    const registerTools = createRegisterTools(factory);
    registerTools(server);
  };

  return { server, registerHandlers };
}
