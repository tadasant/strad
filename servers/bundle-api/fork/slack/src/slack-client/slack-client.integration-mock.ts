import type { ISlackClient } from '../server.js';
import type { OpenDmResult } from './lib/open-dm.js';
import type { SlackFileStream } from './lib/download-file.js';
import { compareMatches } from './lib/find-users.js';
import type {
  Channel,
  DirectMessage,
  DmList,
  Message,
  SlackFile,
  User,
  UserMatch,
  UserSearch,
} from '../types.js';

interface MockData {
  channels?: Channel[];
  messages?: Record<string, Message[]>; // channelId -> messages
  threads?: Record<string, Message[]>; // threadTs -> messages
  users?: User[];
  dms?: DirectMessage[]; // DM conversations, and the userId -> D… mapping
  [key: string]: unknown;
}

const DEFAULT_USERS: User[] = [
  {
    id: 'U0BFTSUN8MD',
    name: 'tadas',
    real_name: 'Tadas Antanavicius',
    is_bot: false,
    profile: { display_name: 'tadas', real_name: 'Tadas Antanavicius' },
  },
  {
    id: 'U123456789',
    name: 'mock.user',
    real_name: 'Mock User',
    is_bot: false,
    profile: { display_name: 'mock', real_name: 'Mock User' },
  },
];

const DEFAULT_DMS: DirectMessage[] = [
  {
    id: 'D0BGVRZRX4Z',
    isGroup: false,
    userId: 'U0BFTSUN8MD',
    user: DEFAULT_USERS[0],
    created: 1783890249,
    updated: 1786500743223,
    isUserDeleted: false,
  },
];

/** The same ranking `findUsers` applies against the real directory. */
function rank(user: User, query: string): UserMatch | null {
  const fields: Array<[UserMatch['field'], string | undefined]> = [
    ['handle', user.name],
    ['display_name', user.profile?.display_name],
    ['real_name', user.real_name ?? user.profile?.real_name],
    ['email', user.profile?.email],
  ];

  for (const [field, value] of fields) {
    const v = value?.toLowerCase();
    if (!v) continue;
    if (v === query) return { user, rank: 0, field };
    if (v.startsWith(query)) return { user, rank: 1, field };
    if (v.includes(query)) return { user, rank: 2, field };
  }

  return null;
}

/**
 * Creates a mock implementation of ISlackClient for integration tests.
 * This mocks the EXTERNAL Slack API, NOT the MCP client.
 */
export function createIntegrationMockSlackClient(
  mockData: MockData = {}
): ISlackClient & { mockData: MockData } {
  // Track posted messages for testing
  const postedMessages: Message[] = [];

  const client = {
    mockData,

    async getChannels(): Promise<Channel[]> {
      return (
        mockData.channels ?? [
          {
            id: 'C123456789',
            name: 'general',
            is_channel: true,
            is_group: false,
            is_im: false,
            is_mpim: false,
            is_private: false,
            is_archived: false,
            is_general: true,
            is_member: true,
            num_members: 10,
            created: 1234567890,
          },
        ]
      );
    },

    async getChannel(channelId: string): Promise<Channel> {
      const channel = mockData.channels?.find((c) => c.id === channelId);
      if (channel) {
        return channel;
      }

      return {
        id: channelId,
        name: 'mock-channel',
        is_channel: true,
        is_group: false,
        is_im: false,
        is_mpim: false,
        is_private: false,
        is_archived: false,
        is_general: false,
        is_member: true,
        created: 1234567890,
      };
    },

    async getMessages(
      channelId: string,
      options?: { limit?: number }
    ): Promise<{
      messages: Message[];
      hasMore: boolean;
      nextCursor?: string;
    }> {
      const messages = mockData.messages?.[channelId] ?? [
        {
          type: 'message',
          user: 'U123456789',
          text: 'Mock message',
          ts: '1234567890.123456',
        },
      ];

      const limit = options?.limit ?? 20;
      return {
        messages: messages.slice(0, limit),
        hasMore: messages.length > limit,
      };
    },

    async getThread(
      channelId: string,
      threadTs: string,
      options?: { limit?: number }
    ): Promise<{
      messages: Message[];
      hasMore: boolean;
      nextCursor?: string;
    }> {
      const key = `${channelId}:${threadTs}`;
      const messages = mockData.threads?.[key] ?? [
        {
          type: 'message',
          user: 'U123456789',
          text: 'Mock parent message',
          ts: threadTs,
          thread_ts: threadTs,
        },
      ];

      const limit = options?.limit ?? 50;
      return {
        messages: messages.slice(0, limit),
        hasMore: messages.length > limit,
      };
    },

    async postMessage(
      channelId: string,
      text: string,
      options?: { threadTs?: string; replyBroadcast?: boolean }
    ): Promise<Message> {
      const ts = `${Date.now() / 1000}.123456`;
      const message: Message = {
        type: 'message',
        text,
        ts,
        thread_ts: options?.threadTs,
      };
      postedMessages.push(message);
      return message;
    },

    async updateMessage(channelId: string, ts: string, text: string): Promise<Message> {
      return {
        type: 'message',
        text,
        ts,
        edited: {
          user: 'U123456789',
          ts: `${Date.now() / 1000}`,
        },
      };
    },

    async addReaction(): Promise<void> {
      // No-op for mock
    },

    async getFileInfo(fileId: string): Promise<SlackFile> {
      return {
        id: fileId,
        name: `mock-file-${fileId}.txt`,
        mimetype: 'text/plain',
        size: 1024,
        url_private: `https://files.slack.com/files-pri/mock/${fileId}`,
        url_private_download: `https://files.slack.com/files-pri/mock/${fileId}/download`,
      };
    },

    async openFile(): Promise<SlackFileStream> {
      const bytes = Buffer.from('mock-file-content');
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
          },
        }),
        contentType: 'text/plain',
        contentLength: bytes.length,
      };
    },

    async uploadSnippet(
      content: string,
      options: {
        channelId: string;
        filename?: string;
        title?: string;
        threadTs?: string;
      }
    ): Promise<SlackFile> {
      return {
        id: `F${Date.now()}`,
        name: options.filename ?? 'snippet.txt',
        title: options.title,
        mimetype: 'text/plain',
        size: content.length,
        permalink: `https://slack.com/files/mock/${options.filename ?? 'snippet.txt'}`,
      };
    },

    async getUser(userId: string): Promise<User> {
      const user = (mockData.users ?? DEFAULT_USERS).find((u) => u.id === userId);
      if (!user) {
        throw new Error(`Slack API error on users.info: user_not_found`);
      }
      return user;
    },

    async findUsers(query: string): Promise<UserSearch> {
      const normalized = query.trim().replace(/^@/, '').toLowerCase();
      if (normalized === '') return { matches: [], truncated: false };

      const matches = (mockData.users ?? DEFAULT_USERS)
        .map((user) => rank(user, normalized))
        .filter((m): m is UserMatch => m !== null)
        .sort(compareMatches);

      return { matches, truncated: false };
    },

    async lookupUserByEmail(email: string): Promise<User | null> {
      const target = email.trim().toLowerCase();
      return (
        (mockData.users ?? DEFAULT_USERS).find(
          (u) => u.profile?.email?.toLowerCase() === target
        ) ?? null
      );
    },

    async openDm(userId: string): Promise<OpenDmResult> {
      const existing = (mockData.dms ?? DEFAULT_DMS).find((dm) => dm.userId === userId);
      return {
        channelId: existing?.id ?? `D${userId}`,
        via: 'conversations.open',
      };
    },

    async findDmChannel(userId: string): Promise<string | null> {
      return (mockData.dms ?? DEFAULT_DMS).find((dm) => dm.userId === userId)?.id ?? null;
    },

    async getDms(options?: { includeGroupDms?: boolean; limit?: number }): Promise<DmList> {
      const dms = (mockData.dms ?? DEFAULT_DMS).filter(
        (dm) => options?.includeGroupDms || !dm.isGroup
      );
      return {
        dms: options?.limit === undefined ? dms : dms.slice(0, options.limit),
        truncated: false,
      };
    },
  };

  return client;
}
