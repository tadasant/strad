/**
 * MCP Events (draft SEP-3415) on this server: `events/list`, `events/poll`,
 * webhook delivery through `events/subscribe` and `events/unsubscribe`, and
 * the `io.modelcontextprotocol/events` extension that says they exist. Push
 * (`events/stream`) is not built.
 *
 * WEBHOOK CALLS COME FROM STRAD CORE, which authenticated the caller. Core
 * puts the principal and the namespaced event name in `_meta` under
 * {@link PRINCIPAL_META} and {@link NAME_META}; a subscribe without a
 * principal is Forbidden, as the draft requires. This mount is reached only
 * behind strad's internal token, so nothing else can set them.
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
import { decodeCursor } from './buffer.js';
import {
  CallbackEndpointError,
  SubscriptionLimit,
  SubscriptionNotFound,
} from './webhook/delivery.js';
import { InvalidWebhookSecret, parseWebhookSecret } from './webhook/signing.js';
import { InvalidCallbackUrl, validateCallbackUrl } from './webhook/transport.js';

/** `_meta` key strad core sets to the authenticated principal's id. */
export const PRINCIPAL_META = 'strad/principal';
/** `_meta` key strad core sets to the event name as the subscriber knows it. */
export const NAME_META = 'strad/name';

export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';

/** The draft's provisional codes. */
export const EVENTS_ERROR = {
  invalidParams: -32602,
  notFound: -32023,
  forbidden: -32024,
  resourceExhausted: -32025,
  unsupported: -32026,
  callbackEndpointError: -32027,
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

const SubscribeRequestSchema = z.object({
  method: z.literal('events/subscribe'),
  params: z.record(z.unknown()).optional(),
});

const UnsubscribeRequestSchema = z.object({
  method: z.literal('events/unsubscribe'),
  params: z.record(z.unknown()).optional(),
});

export const MESSAGE_POSTED_DESCRIPTOR = {
  name: MESSAGE_POSTED,
  description:
    'A message was posted in a channel, private channel or direct message this Slack bot is a ' +
    "member of. Edits, deletions, joins and other system subtypes are not events; the bot's own " +
    'posts and group DMs are never delivered. Delivered at least once: dedupe on eventId, which is ' +
    '`slack:<channel_id>:<ts>`. Kept for 7 days by default.',
  delivery: ['poll', 'webhook'],
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

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const p = webhookParams(request.params, 'events/subscribe');
    const delivery = p.delivery;
    if (delivery.mode !== undefined && delivery.mode !== 'webhook') {
      throw new EventsError(
        EVENTS_ERROR.unsupported,
        'events/subscribe is for webhook delivery only; poll needs no subscribe',
        { feature: 'deliveryMode', value: delivery.mode }
      );
    }
    let secret: Buffer;
    try {
      secret = parseWebhookSecret(delivery.secret);
    } catch (err) {
      if (err instanceof InvalidWebhookSecret) {
        throw new EventsError(EVENTS_ERROR.invalidParams, err.message);
      }
      throw err;
    }
    const ttlMs = request.params?.ttlMs;
    if (ttlMs !== undefined && ttlMs !== null && (typeof ttlMs !== 'number' || !(ttlMs >= 0))) {
      throw new EventsError(EVENTS_ERROR.invalidParams, 'ttlMs must be a non-negative number or null');
    }
    const maxAgeMs = request.params?.maxAgeMs;
    if (maxAgeMs !== undefined && maxAgeMs !== null && (typeof maxAgeMs !== 'number' || !(maxAgeMs >= 0))) {
      throw new EventsError(EVENTS_ERROR.invalidParams, 'maxAgeMs must be a non-negative number');
    }
    try {
      const cursor = decodeCursor(request.params?.cursor);
      return (await ingest.subscribe({
        principal: p.principal,
        name: p.name,
        eventType: MESSAGE_POSTED,
        arguments: p.arguments,
        url: p.url,
        secret,
        cursor,
        maxAgeMs: typeof maxAgeMs === 'number' ? maxAgeMs : undefined,
        ttlMs: ttlMs as number | null | undefined,
      })) as never;
    } catch (err) {
      throw webhookError(err);
    }
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    const p = webhookParams(request.params, 'events/unsubscribe');
    try {
      await ingest.unsubscribe({
        principal: p.principal,
        name: p.name,
        url: p.url,
        arguments: p.arguments,
      });
    } catch (err) {
      throw webhookError(err);
    }
    return {} as never;
  });
}

interface WebhookParams {
  principal: string;
  /** The name the subscriber knows the event by. */
  name: string;
  url: string;
  arguments: Record<string, unknown>;
  delivery: { mode?: unknown; secret?: unknown };
}

/** What subscribe and unsubscribe both check, in the order a caller would fix them. */
function webhookParams(params: Record<string, unknown> | undefined, method: string): WebhookParams {
  const p = params ?? {};
  if (p.name !== MESSAGE_POSTED) {
    throw new EventsError(EVENTS_ERROR.notFound, `unknown event type "${String(p.name)}"`, {
      kind: 'event',
    });
  }
  const meta = (p._meta && typeof p._meta === 'object' ? p._meta : {}) as Record<string, unknown>;
  const principal = meta[PRINCIPAL_META];
  if (typeof principal !== 'string' || principal === '') {
    throw new EventsError(
      EVENTS_ERROR.forbidden,
      `${method} needs an authenticated principal; call it through strad`
    );
  }
  const name = typeof meta[NAME_META] === 'string' ? (meta[NAME_META] as string) : MESSAGE_POSTED;
  const args = p.arguments ?? {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new EventsError(EVENTS_ERROR.invalidParams, 'arguments must be an object');
  }
  const delivery = p.delivery;
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
    throw new EventsError(EVENTS_ERROR.invalidParams, 'delivery must be an object with a url');
  }
  let url: string;
  try {
    url = validateCallbackUrl((delivery as Record<string, unknown>).url).href;
  } catch (err) {
    if (err instanceof InvalidCallbackUrl) {
      throw new EventsError(EVENTS_ERROR.invalidParams, err.message);
    }
    throw err;
  }
  return {
    principal,
    name,
    url,
    arguments: args as Record<string, unknown>,
    delivery: delivery as WebhookParams['delivery'],
  };
}

function webhookError(err: unknown): unknown {
  if (err instanceof InvalidEventArguments) {
    return new EventsError(EVENTS_ERROR.invalidParams, err.message);
  }
  if (err instanceof EventsNotServed) {
    return new EventsError(EVENTS_ERROR.notFound, err.message, { kind: 'event' });
  }
  if (err instanceof SubscriptionNotFound) {
    return new EventsError(EVENTS_ERROR.notFound, err.message, { kind: 'subscription' });
  }
  if (err instanceof CallbackEndpointError) {
    return new EventsError(EVENTS_ERROR.callbackEndpointError, err.message, { reason: err.reason });
  }
  if (err instanceof SubscriptionLimit) {
    return new EventsError(EVENTS_ERROR.resourceExhausted, err.message, {
      limit: err.limit,
      max: err.max,
    });
  }
  return err;
}
