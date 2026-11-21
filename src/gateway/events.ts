import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { ServerUnconfiguredError } from "./unconfigured.ts";
import { withDeadline } from "../util/deadline.ts";
import {
  denamespace,
  namespaced,
  type EventDescriptor,
  type PollEventsResult,
  type ServerAdapter,
} from "./adapters/types.ts";
import type { Registry } from "./registry.ts";

/**
 * MCP Events through the gateway — draft SEP-3415, POLL AND WEBHOOK MODES.
 *
 * The draft this tracks is pinned in `docs/mcp-events-spec-pin.md`; it is a
 * draft, its error codes are provisional, and the wire may move under it.
 * `HACKS.md` #131 and the limitations page say what that costs.
 *
 * WHAT CORE DOES. The same three things it does for tools, and nothing else:
 *
 *   1. ADVERTISE `capabilities.extensions["io.modelcontextprotocol/events"]` on
 *      `initialize` exactly when a slug selected for the request serves events
 *      — decided from each upstream's own handshake (`supportsEvents`).
 *   2. NAMESPACE. `events/list` is the union over the selected slugs, each name
 *      prefixed `<slug>__` like a tool; `events/poll`, `events/subscribe` and
 *      `events/unsubscribe` strip the prefix and route to that slug, and a
 *      poll's answer has its names prefixed again.
 *   3. ENTITLE. A poll or a subscription is allowed for a slug the request SELECTED — the
 *      intersection the router computed from the token and `?servers=`, the
 *      same set a tool call is checked against. Anything else is Forbidden
 *      (`-32024`), whether the slug exists or not: a refusal that said which
 *      would be a slug oracle.
 *
 * Core holds NO event state. The cursor is the upstream's, opaque here; each
 * poll is one stateless round trip, like every other `/mcp` request.
 *
 * WEBHOOK MODE adds one thing core alone can supply: WHO is subscribing. The
 * draft keys a subscription on `(principal, delivery.url, name, arguments)`
 * and requires an authenticated principal, and only core authenticated the
 * caller. So core forwards `events/subscribe` and `events/unsubscribe` with a
 * `_meta` it builds itself — `strad/principal` (the principal's id) and
 * `strad/name` (the prefixed name deliveries must carry) — and drops whatever
 * `_meta` the client sent. The upstream holds the subscriptions and POSTs the
 * deliveries; core is not in that path.
 *
 * `tools:` policy does not apply. It names tools, and an event type is not one;
 * a slug that should not deliver events should not be selected for the caller.
 *
 * The `Mcp-Method` / `Mcp-Name` headers the draft requires on these requests
 * are accepted and not checked yet: the router reads neither.
 */

export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";

/** The draft's provisional codes. */
export const EVENTS_ERROR = {
  methodNotFound: -32601,
  invalidParams: -32602,
  notFound: -32023,
  forbidden: -32024,
  resourceExhausted: -32025,
  unsupported: -32026,
  callbackEndpointError: -32027,
} as const;

/** `_meta` keys core sets on a forwarded subscribe or unsubscribe. */
export const PRINCIPAL_META = "strad/principal";
export const NAME_META = "strad/name";

/** Codes an upstream's refusal is relayed under, verbatim. Everything else is ours. */
const RELAYED_CODES = new Set<number>([
  EVENTS_ERROR.invalidParams,
  EVENTS_ERROR.notFound,
  EVENTS_ERROR.forbidden,
  EVENTS_ERROR.resourceExhausted,
  EVENTS_ERROR.unsupported,
  EVENTS_ERROR.callbackEndpointError,
]);

/**
 * A JSON-RPC error with a draft code and exactly this message. Not the SDK's
 * `McpError`, which prefixes `MCP error <code>:` onto the message — and an
 * upstream's refusal relayed through that would carry the prefix twice. The
 * SDK serialises any thrown error by `code`, `message` and `data`.
 */
export class EventsError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EventsError";
  }
}

/** How long `initialize` waits on one upstream's handshake to decide the advertisement. */
export const SUPPORTS_EVENTS_DEADLINE_MS = 3_000;
/** How long `events/list` waits on one upstream's listing. */
export const LIST_EVENTS_DEADLINE_MS = 10_000;

const ListEventsRequestSchema = z.object({
  method: z.literal("events/list"),
  params: z.object({ cursor: z.string().optional() }).passthrough().optional(),
});

/**
 * The SDK parses a request against the schema it was registered with and
 * answers a mismatch as `-32603` with the parser's dump. So the registered
 * schema only matches the method, and the params are checked inside the
 * handler, where a mismatch can be the `-32602` the draft says it is.
 */
const PollEventsRequestSchema = z.object({
  method: z.literal("events/poll"),
  params: z.unknown().optional(),
});

const PollEventsParamsSchema = z
  .object({
    name: z.string(),
    arguments: z.record(z.unknown()).nullish(),
    cursor: z.string().nullish(),
    maxEvents: z.number().int().positive().optional(),
    maxAgeMs: z.number().nonnegative().optional(),
  })
  .passthrough();

const SubscribeRequestSchema = z.object({
  method: z.literal("events/subscribe"),
  params: z.unknown().optional(),
});

const UnsubscribeRequestSchema = z.object({
  method: z.literal("events/unsubscribe"),
  params: z.unknown().optional(),
});

/**
 * Shape only. What the upstream owns — the URL's scheme and address, the
 * secret's format, the arguments — it checks itself and refuses with the
 * draft's codes, which are relayed.
 */
const SubscribeParamsSchema = z
  .object({
    name: z.string(),
    arguments: z.record(z.unknown()).nullish(),
    delivery: z.record(z.unknown()),
    cursor: z.string().nullish(),
    maxAgeMs: z.number().nonnegative().nullish(),
    ttlMs: z.number().nonnegative().nullable().optional(),
  })
  .passthrough();

const UnsubscribeParamsSchema = z
  .object({
    name: z.string(),
    arguments: z.record(z.unknown()).nullish(),
    delivery: z.object({ url: z.unknown() }).passthrough(),
  })
  .passthrough();

/**
 * Does any selected slug serve events? Asked on `initialize` only, in
 * parallel, each bounded: a slug whose handshake is slow or failing counts as
 * "no", which costs that request the advertisement and nothing else.
 */
export async function selectionSupportsEvents(
  selected: readonly string[],
  registry: Registry,
  deadlineMs = SUPPORTS_EVENTS_DEADLINE_MS,
): Promise<boolean> {
  const answers = await Promise.all(
    selected.map(async (slug) => {
      const adapter = registry.get(slug);
      return adapter ? supportsWithin(adapter, deadlineMs) : false;
    }),
  );
  return answers.some(Boolean);
}

/**
 * One slug's "do you serve events", bounded and never throwing. An upstream
 * that is unconfigured, offline or slow is a "no" — for this request — and
 * nothing is logged: none of those is an events fault.
 */
async function supportsWithin(
  adapter: ServerAdapter,
  deadlineMs = SUPPORTS_EVENTS_DEADLINE_MS,
): Promise<boolean> {
  if (!adapter.supportsEvents) return false;
  try {
    return await withDeadline(
      () => adapter.supportsEvents!(),
      deadlineMs,
      "the events handshake",
    );
  } catch {
    return false;
  }
}

export interface EventHandlerOptions {
  selected: readonly string[];
  registry: Registry;
  principalId: string;
  log: (event: Record<string, unknown>) => void;
  /**
   * The exportable shape of a failed `events/list` — retry counts and the
   * status / code / class discriminator (#475). Injected rather than imported
   * because the HTTP adapter that owns those already imports this module.
   */
  describeListFailure?: (err: unknown) => Record<string, unknown>;
}

/** Registers `events/list` and `events/poll` on a one-shot gateway server. */
export function registerEventHandlers(
  server: Server,
  opts: EventHandlerOptions,
): void {
  const { selected, registry, log } = opts;

  server.setRequestHandler(ListEventsRequestSchema, async (request) => {
    if (request.params?.cursor !== undefined) {
      // One page is all core ever returns, so no cursor of ours exists.
      throw new EventsError(
        EVENTS_ERROR.invalidParams,
        "events/list: unknown cursor",
      );
    }
    const lists = await Promise.all(
      selected.map(async (slug): Promise<EventDescriptor[]> => {
        const adapter = registry.get(slug);
        if (!adapter?.listEvents) return [];
        // Asked first, so an upstream that is unconfigured, offline or has no
        // events is skipped quietly, the way the handshake already answered it.
        // What fails AFTER a handshake that advertised events is a fault.
        if (!(await supportsWithin(adapter))) return [];
        try {
          const events = await withDeadline(
            () => adapter.listEvents!(),
            LIST_EVENTS_DEADLINE_MS,
            "events/list",
          );
          return events.map((e) => ({ ...e, name: namespaced(slug, e.name) }));
        } catch (err) {
          // An `oauth:` slug nobody has connected is unconfigured, not broken
          // (`awaitingConsent`), and is skipped as quietly as the handshake
          // skips one: the same answer a tool listing gives it.
          if (err instanceof ServerUnconfiguredError) return [];
          // One upstream that cannot list does not hide the others' events.
          // Its own message is not ours to log; its status, JSON-RPC code and
          // error class are, and they are what tells a page apart (#475).
          log({
            evt: "mcp.events_list_failed",
            slug,
            ...opts.describeListFailure?.(err),
          });
          return [];
        }
      }),
    );
    return { events: lists.flat() } as never;
  });

  server.setRequestHandler(PollEventsRequestSchema, async (request) => {
    const checked = PollEventsParamsSchema.safeParse(request.params);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new EventsError(
        EVENTS_ERROR.invalidParams,
        `events/poll: ${issue ? `${issue.path.join(".") || "params"}: ${issue.message}` : "invalid params"}`,
      );
    }
    const params = checked.data;
    const { name } = params;
    const parsed = denamespace(name);
    if (!parsed) {
      throw new EventsError(
        EVENTS_ERROR.invalidParams,
        `event "${name}" is not namespaced as <server>__<event>`,
      );
    }
    const adapter = selected.includes(parsed.slug)
      ? registry.get(parsed.slug)
      : undefined;
    if (!adapter) {
      log({
        evt: "mcp.events_forbidden",
        principal: opts.principalId,
      });
      throw new EventsError(
        EVENTS_ERROR.forbidden,
        `event "${name}" is not available to this request: its server is not ` +
          `selected for it, or this principal is not entitled to it.`,
      );
    }
    if (!adapter.pollEvents) {
      throw new EventsError(
        EVENTS_ERROR.notFound,
        `server "${parsed.slug}" serves no events`,
        { kind: "event" },
      );
    }

    let result: PollEventsResult;
    try {
      result = await adapter.pollEvents({
        name: parsed.tool,
        arguments: params.arguments ?? {},
        cursor: params.cursor ?? null,
        ...(params.maxEvents !== undefined
          ? { maxEvents: params.maxEvents }
          : {}),
        ...(params.maxAgeMs !== undefined ? { maxAgeMs: params.maxAgeMs } : {}),
      });
    } catch (err) {
      throw relayed(err, parsed.slug);
    }
    return {
      ...result,
      events: result.events.map((e) => ({
        ...e,
        name: namespaced(parsed.slug, e.name),
      })),
    } as never;
  });

  /**
   * The name's slug, if this request may reach it. The same check, and the
   * same refusal, as a poll: a slug the request did not select is Forbidden
   * whether or not it exists.
   */
  const entitled = (name: string) => {
    const parsed = denamespace(name);
    if (!parsed) {
      throw new EventsError(
        EVENTS_ERROR.invalidParams,
        `event "${name}" is not namespaced as <server>__<event>`,
      );
    }
    const adapter = selected.includes(parsed.slug)
      ? registry.get(parsed.slug)
      : undefined;
    if (!adapter) {
      log({ evt: "mcp.events_forbidden", principal: opts.principalId });
      throw new EventsError(
        EVENTS_ERROR.forbidden,
        `event "${name}" is not available to this request: its server is not ` +
          `selected for it, or this principal is not entitled to it.`,
      );
    }
    return { slug: parsed.slug, bare: parsed.tool, adapter };
  };

  const paramsOf = <T>(
    schema: z.ZodType<T>,
    raw: unknown,
    method: string,
  ): T => {
    const checked = schema.safeParse(raw);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new EventsError(
        EVENTS_ERROR.invalidParams,
        `${method}: ${issue ? `${issue.path.join(".") || "params"}: ${issue.message}` : "invalid params"}`,
      );
    }
    return checked.data;
  };

  /** Core's own `_meta`: the authenticated principal and the subscriber's name. */
  const meta = (name: string): Record<string, string> => ({
    [PRINCIPAL_META]: opts.principalId,
    [NAME_META]: name,
  });

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const params = paramsOf(
      SubscribeParamsSchema,
      request.params,
      "events/subscribe",
    );
    const { slug, bare, adapter } = entitled(params.name);
    if (!adapter.subscribeEvents) {
      throw new EventsError(
        EVENTS_ERROR.notFound,
        `server "${slug}" serves no events`,
        { kind: "event" },
      );
    }
    try {
      return (await adapter.subscribeEvents({
        name: bare,
        arguments: params.arguments ?? {},
        delivery: params.delivery,
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        ...(params.maxAgeMs !== undefined && params.maxAgeMs !== null
          ? { maxAgeMs: params.maxAgeMs }
          : {}),
        ...(params.ttlMs !== undefined ? { ttlMs: params.ttlMs } : {}),
        _meta: meta(params.name),
      })) as never;
    } catch (err) {
      throw relayed(err, slug);
    }
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    const params = paramsOf(
      UnsubscribeParamsSchema,
      request.params,
      "events/unsubscribe",
    );
    const { slug, bare, adapter } = entitled(params.name);
    if (!adapter.unsubscribeEvents) {
      throw new EventsError(
        EVENTS_ERROR.notFound,
        `server "${slug}" serves no events`,
        { kind: "event" },
      );
    }
    try {
      await adapter.unsubscribeEvents({
        name: bare,
        arguments: params.arguments ?? {},
        delivery: { url: params.delivery.url },
        _meta: meta(params.name),
      });
    } catch (err) {
      throw relayed(err, slug);
    }
    return {} as never;
  });
}

/**
 * The error a failed poll reaches the caller as.
 *
 * An upstream that ANSWERED with a draft code meant it — an unknown event, a
 * bad argument, a type its deployment does not serve yet — and that answer is
 * relayed with its code and its words, because the words are the remedy
 * (`SLACK_APP_TOKEN is not set`). `-32601` is an upstream that has no events
 * at all. A slug waiting for its credential says so, as it does for a tool.
 * Anything else is an upstream fault and stays one.
 */
function relayed(err: unknown, slug: string): unknown {
  if (err instanceof ServerUnconfiguredError) {
    return new EventsError(EVENTS_ERROR.notFound, err.message, {
      kind: "event",
    });
  }
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const o = e as { code?: unknown; message?: unknown; data?: unknown };
    if (typeof o.code === "number") {
      if (o.code === EVENTS_ERROR.methodNotFound) {
        return new EventsError(
          EVENTS_ERROR.notFound,
          `server "${slug}" serves no events`,
          { kind: "event" },
        );
      }
      if (RELAYED_CODES.has(o.code)) {
        const message =
          typeof o.message === "string"
            ? o.message.replace(/^(MCP error -?\d+: )+/, "")
            : "upstream refused the poll";
        return new EventsError(
          o.code,
          message,
          o.data && typeof o.data === "object"
            ? (o.data as Record<string, unknown>)
            : undefined,
        );
      }
    }
    e = (e as { cause?: unknown }).cause;
  }
  return err;
}
