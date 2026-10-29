/**
 * MCP Events (draft SEP-3415, POLL MODE ONLY) on this server: `events/list`
 * and `events/poll`, and the `io.modelcontextprotocol/events` extension that
 * says they exist.
 *
 * The draft this follows is pinned in docs/mcp-events-spec-pin.md at the strad
 * repository root; the wire it describes may still change.
 *
 * ADVERTISED ONLY WHEN CONFIGURED. A container with no app-level token lists
 * no event types and does not advertise the extension, so strad core does not
 * advertise it either. The handlers are registered anyway: a client that polls
 * without asking first is told WHY there is nothing here, by name, rather than
 * `-32601`.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import { MAX_TEXT_CHARS } from './normalize.js';
import {
  EventsNotServed,
  InvalidEventArguments,
  MESSAGE_POSTED,
  type SlackEventsIngest,
} from './ingest.js';

export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';

/** The draft's provisional codes. */
export const EVENTS_ERROR = {
  invalidParams: -32602,
  notFound: -32023,
  forbidden: -32024,
} as const;

/**
 * A JSON-RPC error with the draft's code and THIS message. Not the SDK's
 * `McpError`, whose constructor bakes `MCP error <code>:` into the message — and
 * the gateway in front of this re-raises it, so the prefix would stack. The
 * SDK serialises any error by its `code`, `message` and `data`.
 */
export class EventsError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'EventsError';
  }
}

const ListEventsRequestSchema = z.object({
  method: z.literal('events/list'),
  params: z.object({ cursor: z.string().optional() }).passthrough().optional(),
});

const PollEventsRequestSchema = z.object({
  method: z.literal('events/poll'),
  params: z
    .object({
      name: z.string(),
      arguments: z.unknown().optional(),
      cursor: z.unknown().optional(),
      maxEvents: z.unknown().optional(),
      maxAgeMs: z.unknown().optional(),
    })
    .passthrough(),
});

export const MESSAGE_POSTED_DESCRIPTOR = {
  name: MESSAGE_POSTED,
  description:
    'A message was posted in a channel, private channel or direct message this Slack bot is a ' +
    "member of. Edits, deletions, joins and other system subtypes are not events; the bot's own " +
    'posts and group DMs are never delivered. Delivered at least once: dedupe on eventId, which is ' +
    '`slack:<channel_id>:<ts>`. Kept for 7 days by default.',
  delivery: ['poll'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      addressed_to_bot: {
        type: 'boolean',
        description:
          'Only messages addressed to the bot: a direct message to it, or text containing ' +
          '`<@BOT_USER_ID>`. Absent or false: no narrowing.',
      },
      channel_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only these conversations (channel or DM ids).',
      },
      include_dms: {
        type: 'boolean',
        default: true,
        description: 'Include direct messages to the bot. Default true.',
      },
      thread_ts: {
        type: 'string',
        description: 'Only this thread: its parent and its replies.',
      },
      top_level_only: {
        type: 'boolean',
        description: 'Only messages that are not thread replies.',
      },
      include_bot_authors: {
        type: 'boolean',
        default: true,
        description: 'Include messages posted by other bots and integrations. Default true.',
      },
    },
  },
  payloadSchema: {
    type: 'object',
    required: [
      'channel_id',
      'channel_type',
      'ts',
      'is_dm',
      'mentions_bot',
      'permalink',
      'text',
    ],
    properties: {
      channel_id: { type: 'string' },
      channel_type: { type: 'string', enum: ['channel', 'group', 'im'] },
      ts: { type: 'string', description: "The message's Slack timestamp, its id in the channel." },
      thread_ts: { type: 'string', description: "The parent's ts, when the message is in a thread." },
      user_id: { type: 'string' },
      bot_id: { type: 'string' },
      username: { type: 'string', description: 'The display name a bot or integration posted as.' },
      is_dm: { type: 'boolean' },
      mentions_bot: { type: 'boolean' },
      permalink: { type: 'string' },
      text: {
        type: 'string',
        description: `The message text in Slack mrkdwn, cut to ${MAX_TEXT_CHARS} characters.`,
      },
    },
  },
} as const;

export function registerEventHandlers(server: Server, ingest: SlackEventsIngest): void {
  if (ingest.configured) {
    server.registerCapabilities({ extensions: { [EVENTS_EXTENSION]: {} } });
  }

  server.setRequestHandler(ListEventsRequestSchema, async (request) => {
    if (request.params?.cursor !== undefined) {
      // One page is all there is, so no cursor of ours exists to be handed back.
      throw new EventsError(EVENTS_ERROR.invalidParams, 'events/list: unknown cursor');
    }
    return { events: ingest.configured ? [MESSAGE_POSTED_DESCRIPTOR] : [] } as never;
  });

  server.setRequestHandler(PollEventsRequestSchema, async (request) => {
    const { name } = request.params;
    if (name !== MESSAGE_POSTED) {
      throw new EventsError(EVENTS_ERROR.notFound, `unknown event type "${name}"`, { kind: 'event' });
    }
    try {
      return (await ingest.poll(request.params)) as never;
    } catch (err) {
      if (err instanceof InvalidEventArguments) {
        throw new EventsError(EVENTS_ERROR.invalidParams, err.message);
      }
      if (err instanceof EventsNotServed) {
        throw new EventsError(EVENTS_ERROR.notFound, err.message, { kind: 'event' });
      }
      throw err;
    }
  });
}
