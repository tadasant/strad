import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createRegisterTools } from './tools.js';
import {
  DEFAULT_TTL_SECONDS,
  NonceLedger,
  deriveKey,
  verifyDownloadToken,
} from './download-link.js';
import type { DownloadLinkConfig } from './tools/download-file.js';
import type { OpenDmResult } from './slack-client/lib/open-dm.js';
import type { SlackFileStream } from './slack-client/lib/download-file.js';
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
   * Open a file from Slack for streaming (requires authenticated URL).
   *
   * Returns the live body rather than a Buffer — an attachment may be hundreds
   * of megabytes and this process must never hold one whole.
   */
  openFile(fileUrl: string): Promise<SlackFileStream>;

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

  async openFile(fileUrl: string): Promise<SlackFileStream> {
    const { openFile } = await import('./slack-client/lib/download-file.js');
    return openFile(this.headers, fileUrl);
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
  /**
   * What `slack_download_file` needs to hand out a signed link, and what
   * {@link createMCPServer}'s `handleDownload` needs to honour one.
   *
   * ABSENT IS A SUPPORTED STATE, not a misconfiguration to throw on: the
   * standalone image runs this server with no strad around it. The tool then
   * says the deployment cannot serve attachments rather than minting a URL that
   * nothing answers.
   *
   * `publicSlug` is the GATEWAY's slug — `slack-zimmer`, not the `/slack` mount
   * path. See `deriveKey` in `src/download-link.ts` for why the distinction is
   * load-bearing rather than cosmetic.
   */
  download?: {
    publicSlug: string;
    publicBaseUrl: string;
    internalToken: string;
    /**
     * The Slack bot token this mount serves, folded into the signing key as a
     * fingerprint so two workspaces on one `STRAD_INTERNAL_TOKEN` cannot honour
     * each other's links. See `deriveKey` in `src/download-link.ts`.
     */
    workspaceToken: string;
    ttlSeconds?: number;
  };
}

/** What the host serves for `GET /<mount>/download/:token`. */
export type DownloadOutcome =
  | {
      ok: true;
      filename: string;
      contentType: string;
      contentLength?: number;
      body: ReadableStream<Uint8Array>;
    }
  | { ok: false; status: number; error: string };

function defaultClientFactory(): ISlackClient {
  const botToken = process.env.SLACK_BOT_TOKEN;

  if (!botToken) {
    throw new Error('SLACK_BOT_TOKEN environment variable must be configured');
  }

  return new SlackClient(botToken);
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

  const downloadLink: DownloadLinkConfig | undefined = options.download && {
    publicSlug: options.download.publicSlug,
    publicBaseUrl: options.download.publicBaseUrl.replace(/\/$/, ''),
    key: deriveKey(
      options.download.internalToken,
      options.download.publicSlug,
      options.download.workspaceToken
    ),
    ttlSeconds: options.download.ttlSeconds ?? DEFAULT_TTL_SECONDS,
  };

  // One ledger for the life of the process, shared by every request: single-use
  // is a property of the MOUNT, and a per-request set would remember nothing.
  const ledger = new NonceLedger();

  const registerHandlers = async (server: Server, clientFactory?: ClientFactory) => {
    const factory = clientFactory || defaultClientFactory;
    const registerTools = createRegisterTools(factory, undefined, { downloadLink });
    registerTools(server);
  };

  /**
   * Honour one signed link: check it, ask Slack, hand back the open body.
   *
   * NOTHING IS BUFFERED AND NOTHING TOUCHES DISK. The returned `body` is Slack's
   * response stream; the host pipes it straight to the caller.
   *
   * `files.info` is called again rather than trusted from mint time, so a file
   * deleted in between is a clean 404 instead of a stale URL fetched with a live
   * token.
   */
  const handleDownload = async (
    token: string,
    clientFactory?: ClientFactory
  ): Promise<DownloadOutcome> => {
    if (!downloadLink) {
      return { ok: false, status: 404, error: 'This deployment does not serve file downloads.' };
    }

    const verified = verifyDownloadToken({ key: downloadLink.key, token });
    if (!verified.ok) return { ok: false, status: verified.status, error: verified.error };

    // Claimed BEFORE the Slack call so two concurrent requests cannot both win,
    // and released below if the call does not produce bytes.
    if (!ledger.claim(verified.nonce, verified.expiresAtMs)) {
      return {
        ok: false,
        status: 403,
        error:
          'This download link has already been used. Call slack_download_file again for a fresh one.',
      };
    }

    try {
      const client = (clientFactory || defaultClientFactory)();
      const info = await client.getFileInfo(verified.fileId);
      const url = info.url_private_download || info.url_private;
      if (!url) {
        return { ok: false, status: 404, error: 'That file is no longer downloadable from Slack.' };
      }

      const stream = await client.openFile(url);
      return {
        ok: true,
        filename: info.name || info.title || verified.fileId,
        contentType: stream.contentType || info.mimetype || 'application/octet-stream',
        // ONLY the length Slack's own response declared. `files.info`'s `size` is
        // metadata about the file, not a promise about this body, and the two can
        // disagree — a declared Content-Length that the bytes then miss is a
        // malformed response, which is worse than declaring no length at all.
        contentLength: stream.contentLength,
        body: stream.body,
      };
    } catch (error) {
      ledger.release(verified.nonce);
      throw error;
    }
  };

  return { server, registerHandlers, handleDownload };
}
