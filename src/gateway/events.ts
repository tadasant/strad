import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { ServerUnconfiguredError } from "./unconfigured.ts";
import { withDeadline } from "../util/deadline.ts";
import {
  denamespace,
  namespaced,
  type EventDescriptor,
  type PollEventsResult,
} from "./adapters/types.ts";
import type { Registry } from "./registry.ts";

/**
 * MCP Events through the gateway — draft SEP-3415, POLL MODE ONLY.
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
 *      prefixed `<slug>__` like a tool; `events/poll` strips the prefix, routes
 *      to that slug, and prefixes the names in the answer.
 *   3. ENTITLE. A poll is allowed for a slug the request SELECTED — the
 *      intersection the router computed from the token and `?servers=`, the
 *      same set a tool call is checked against. Anything else is Forbidden
 *      (`-32024`), whether the slug exists or not: a refusal that said which
 *      would be a slug oracle.
 *
 * Core holds NO event state. The cursor is the upstream's, opaque here; each
 * poll is one stateless round trip, like every other `/mcp` request.
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
} as const;

/** Codes an upstream's refusal is relayed under, verbatim. Everything else is ours. */
const RELAYED_CODES = new Set<number>([
  EVENTS_ERROR.invalidParams,
  EVENTS_ERROR.notFound,
  EVENTS_ERROR.forbidden,
  EVENTS_ERROR.resourceExhausted,
  EVENTS_ERROR.unsupported,
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

const ListEventsRequestSchema = z.object({
  method: z.literal("events/list"),
  params: z.object({ cursor: z.string().optional() }).passthrough().optional(),
});

const PollEventsRequestSchema = z.object({
  method: z.literal("events/poll"),
  params: z
    .object({
      name: z.string(),
      arguments: z.record(z.unknown()).nullish(),
      cursor: z.string().nullish(),
      maxEvents: z.number().int().positive().optional(),
      maxAgeMs: z.number().nonnegative().optional(),
    })
    .passthrough(),
});

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
      if (!adapter?.supportsEvents) return false;
      try {
        return await withDeadline(
          () => adapter.supportsEvents!(),
          deadlineMs,
          "the events handshake",
        );
      } catch {
        return false;
      }
    }),
  );
  return answers.some(Boolean);
}

export interface EventHandlerOptions {
  selected: readonly string[];
  registry: Registry;
  principalId: string;
  log: (event: Record<string, unknown>) => void;
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
        try {
          const events = await adapter.listEvents();
          return events.map((e) => ({ ...e, name: namespaced(slug, e.name) }));
        } catch {
          // One upstream that cannot list does not hide the others' events.
          // Its own message is not ours to log.
          log({ evt: "mcp.events_list_failed", slug });
          return [];
        }
      }),
    );
    return { events: lists.flat() } as never;
  });

  server.setRequestHandler(PollEventsRequestSchema, async (request) => {
    const { name } = request.params;
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
        arguments: request.params.arguments ?? {},
        cursor: request.params.cursor ?? null,
        ...(request.params.maxEvents !== undefined
          ? { maxEvents: request.params.maxEvents }
          : {}),
        ...(request.params.maxAgeMs !== undefined
          ? { maxAgeMs: request.params.maxAgeMs }
          : {}),
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
