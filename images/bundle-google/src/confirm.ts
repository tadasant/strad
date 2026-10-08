/**
 * A human in front of `send_email`, routed to the session that made the call.
 *
 * ## The problem this solves
 *
 * The vendored gmail tree gates `send_email` on `requestConfirmation()` from
 * `@pulsemcp/mcp-elicitation`, and that library finds its human through
 * `process.env`: `ELICITATION_REQUEST_URL` / `ELICITATION_POLL_URL`. That works
 * for upstream's deployment, one server process per agent session, where the
 * environment IS the session. strad's bundle is one process serving every
 * caller, so a container-wide URL cannot name the calling session. It would
 * send every confirmation to one place, whoever asked.
 *
 * So the address travels with the CALL instead. strad core reads it off the
 * caller's `/mcp` request (the `X-Elicitation-Url` header, held to
 * `gateway.elicitation.allowedUrlPrefixes`) and, for a slug declaring
 * `confirmations: true`, puts it on the upstream `tools/call` as
 * `_meta["dev.strad/elicitation"]`. Core never forwards a client's own `_meta`,
 * so that key is core's word and not the caller's.
 *
 * ## How, without editing the vendored tree
 *
 * `vendor/gmail-shared` and `vendor/mcp-elicitation` are both verbatim copies,
 * and neither knows about a per-call address. But the library has a seam
 * already: its NATIVE tier asks the server object it was handed whether the
 * client supports elicitation, then calls `server.elicitInput()`. The tool
 * captures that server object when it is registered. So the server handed to
 * the vendored registration is a proxy (see {@link withConfirmation}):
 *
 *   - `setRequestHandler` wraps the `tools/call` handler. Every call runs inside
 *     an AsyncLocalStorage scope holding THAT call's channel and deadline, so
 *     two sessions sending at once never see each other's address.
 *   - `getClientCapabilities()` reports elicitation support exactly when the
 *     current call carries a channel.
 *   - `elicitInput()` speaks the approval protocol itself, against the
 *     channel's URL ({@link askHuman}). Nothing reads the address from
 *     `process.env`.
 *
 * ## Why the protocol is spoken here and not by the library
 *
 * The library's own HTTP client is right for an address its operator chose and
 * wrong for one a caller sent. It follows redirects, so an open redirect on an
 * allowed host would carry the POST anywhere. It copies a failed response's
 * body into the error the tool returns, so the caller could read whatever the
 * bundle's network position can reach. And it sets no timeout on a request, so
 * a reply that hangs past the deadline can still come back `accept`. Here a
 * redirect is an error, an error names a status and nothing from the body,
 * every request is aborted at the deadline, and an answer that lands after it
 * counts as expired.
 *
 * ## A dropped call never sends
 *
 * A confirmation can take minutes, and the call that asked can be gone before
 * the human answers: core's hop timed out, the caller disconnected, or it
 * cancelled. An approval after that would send mail the caller was told had
 * failed, and twice if it retried. So the call's own abort signal (the SDK
 * fires it when this request's response closes, and core closes it the moment
 * its caller goes away) is honoured at every step: it aborts the approval
 * requests and the wait between polls, it turns any answer into `cancel`, and
 * the mailbox itself refuses `sendMessage` / `sendDraft` once it has fired
 * ({@link guardSends}), which covers the reads the tool makes between the
 * approval and the send.
 *
 * ## Keeping a long wait open
 *
 * Nothing else crosses the wire while a human decides, and Node's `fetch` in
 * core drops a response body that has been silent for 300s. So while it waits
 * this sends a progress notification every {@link KEEPALIVE_MS}, against the
 * progressToken core puts on every confirmed call. Core relays it on to its
 * own caller if that caller asked for progress.
 *
 * ## The edge in front of the approval URL
 *
 * The approval service can sit behind an edge that wants strad's own
 * credential, a Cloudflare Access service token. Core forwards the slug's
 * `confirmationHeaders:` with the channel, and they go on the POST and every
 * poll, to the URL core held to its allowlist and nowhere else.
 *
 * ## Fail closed
 *
 * A confirmed tool refuses, before it runs, when:
 *
 *   - the call carries no channel (the console, a flow-through grant, a caller
 *     that sent no header, or an `admin` token: holding every role does not
 *     skip the human);
 *   - core refused the caller's channel (a URL off the allowlist);
 *   - the CONTAINER's environment would route around the per-call channel:
 *     `ELICITATION_ENABLED=false`, which makes the vendored tool skip the
 *     prompt, or a container-wide `ELICITATION_REQUEST_URL` /
 *     `ELICITATION_POLL_URL`, which it would prefer over the per-call one.
 *
 * `DANGEROUSLY_SKIP_ELICITATIONS` is not on that list because the gmail tree
 * never reads it. That flag belongs to 1Password, and setting it for the
 * `onepassword-*` slugs does not reach this mount.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  readElicitationConfig,
  type ElicitationResult,
} from "@pulsemcp/mcp-elicitation";
import type { IGmailClient } from "gmail-workspace-mcp-server-shared";

/** The `_meta` key core writes the caller's channel under. */
export const ELICITATION_META_KEY = "dev.strad/elicitation";

/**
 * The tools that ask a human before acting.
 *
 * NOT DERIVED, and that is deliberate: this is the list the guard refuses on
 * when there is no channel. A tool that elicits and is missing from it would
 * reach the library with no channel, and the library would still throw (no
 * native support, no fallback), so the miss is still closed, only less legible.
 * `test/confirm.test.ts` greps the vendored tree for every tool that imports
 * `requestConfirmation` and fails if this list disagrees, so a re-vendor that
 * adds a second elicitation is caught in CI.
 */
export const CONFIRMED_TOOLS: readonly string[] = ["send_email"];

/** Poll every 5s, the library's default. */
export const POLL_INTERVAL_MS = 5_000;
/** Without a deadline from core, give a human five minutes, the library's default. */
const DEFAULT_TTL_MS = 5 * 60_000;
/**
 * How often a waiting confirmation proves the call is alive. Well under the
 * 300s a silent response body survives in Node's `fetch`.
 */
export const KEEPALIVE_MS = 30_000;
/** The most a best-effort read for the prompt (the draft, the account) may take. */
const LOOKUP_MS = 5_000;

const ANSWERS = new Set(["accept", "decline", "cancel", "expired"]);

/** A channel core forwarded, or the reason it refused the caller's. */
export type Channel =
  | {
      url: string;
      slug?: string;
      ttlMs?: number;
      headers?: Record<string, string>;
    }
  | { refused: string };

/** What core's schema refuses too (`confirmationHeaderProblem`). */
const RESERVED_HEADERS = new Set([
  "content-type",
  "content-length",
  "transfer-encoding",
  "connection",
  "host",
]);

/** Core's `headers`, keeping only string values under sendable names. */
function headersFrom(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read core's `_meta` entry off a `tools/call`. Anything malformed counts as no
 * channel at all, which the guard turns into a refusal.
 */
export function channelFrom(meta: unknown): Channel | null {
  if (!meta || typeof meta !== "object") return null;
  const raw = (meta as Record<string, unknown>)[ELICITATION_META_KEY];
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.refused === "string") return { refused: entry.refused };
  if (typeof entry.url !== "string") return null;
  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return null;
  }
  // Core has already held the URL to its allowlist. This is the second,
  // cheaper check: only a web URL is ever fetched from here.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return {
    url: entry.url,
    slug: typeof entry.slug === "string" ? entry.slug : undefined,
    ttlMs:
      typeof entry.ttlMs === "number" && entry.ttlMs > 0
        ? Math.floor(entry.ttlMs)
        : undefined,
    headers: headersFrom(entry.headers),
  };
}

/**
 * Why this container's own environment would route a confirmation around the
 * per-call channel, or null when it would not.
 *
 * Read from `process.env` on purpose: it is what the vendored tool reads.
 */
export function containerBypass(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const cfg = readElicitationConfig(env);
  if (!cfg.enabled) {
    return (
      "this container sets ELICITATION_ENABLED=false, which would make the tool " +
      "skip the prompt entirely"
    );
  }
  if (cfg.requestUrl || cfg.pollUrl) {
    return (
      "this container sets a container-wide ELICITATION_REQUEST_URL or " +
      "ELICITATION_POLL_URL, which cannot name the session that made the call"
    );
  }
  return null;
}

function refusal(tool: string, why: string) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `${tool} was NOT run: it needs a human to confirm it, and ${why}. ` +
          "Nothing was sent. strad routes the confirmation to the session that " +
          "made the call, through the X-Elicitation-Url header on its /mcp " +
          "request (a Zimmer session's per-session elicitation URL). Calls " +
          "without one, including from the console and from admin tokens, " +
          "are refused rather than run unconfirmed.",
      },
    ],
    isError: true,
  };
}

/** Pull the literal method name out of an MCP SDK request schema. */
function methodOf(schema: unknown): string | undefined {
  const method = (schema as { shape?: { method?: unknown } })?.shape?.method as
    { value?: unknown; _def?: { value?: unknown } } | undefined;
  const value = method?.value ?? method?._def?.value;
  return typeof value === "string" ? value : undefined;
}

type Outcome =
  | { stopped: "expired" | "dropped" }
  | { stopped?: undefined; body: unknown };

/**
 * One request to the approval endpoint, bounded by the deadline and by the
 * call's own signal.
 */
async function call(
  url: string,
  init: RequestInit,
  deadline: number,
  headers: Record<string, string> | undefined,
  dropped: AbortSignal | undefined,
): Promise<Outcome> {
  if (dropped?.aborted) return { stopped: "dropped" };
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { stopped: "expired" };
  const timeout = AbortSignal.timeout(remaining);
  const stop = (): Outcome | null =>
    dropped?.aborted
      ? { stopped: "dropped" }
      : timeout.aborted
        ? { stopped: "expired" }
        : null;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      // Core's edge headers first, so nothing in them can replace ours.
      headers: { ...headers, "content-type": "application/json" },
      // A redirect is an error, never followed: the allowlist bounds where
      // this request goes, and a 3xx would let the far end move it.
      redirect: "error",
      signal: dropped ? AbortSignal.any([timeout, dropped]) : timeout,
    });
  } catch (err) {
    const stopped = stop();
    if (stopped) return stopped;
    // The cause is not repeated: it can describe the network beyond the
    // bundle, and this text reaches the caller.
    throw new Error("the approval endpoint could not be reached");
  }
  if (!response.ok) {
    // The status, never the body. See the header.
    await response.body?.cancel().catch(() => {});
    throw new Error(`the approval endpoint answered HTTP ${response.status}`);
  }
  try {
    return { body: await response.json() };
  } catch (err) {
    const stopped = stop();
    if (stopped) return stopped;
    throw new Error("the approval endpoint did not answer with JSON");
  }
}

/** Wait `ms`, or less if `signal` fires first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Ask a human, through the pulsemcp fallback-elicitation protocol: POST the
 * question to `url`, then poll `url/<request-id>` until it is answered or the
 * deadline passes. Only an answer that arrives before the deadline counts, and
 * only while the call that asked is still there: once `signal` fires, every
 * outcome is `cancel`.
 */
export async function askHuman(options: {
  url: string;
  message: string;
  requestedSchema: unknown;
  toolName: string;
  deadline: number;
  pollIntervalMs?: number;
  /** Sent on the POST and every poll. Core's, from `confirmationHeaders:`. */
  headers?: Record<string, string>;
  /** The call's own abort signal. */
  signal?: AbortSignal;
}): Promise<ElicitationResult> {
  const { url, deadline, headers, signal } = options;
  const ended = (stopped: "expired" | "dropped"): ElicitationResult => ({
    action: stopped === "dropped" ? "cancel" : "expired",
  });
  const requestId = randomUUID();
  const created = await call(
    url,
    {
      method: "POST",
      body: JSON.stringify({
        mode: "form",
        message: options.message,
        requestedSchema: options.requestedSchema,
        _meta: {
          "com.pulsemcp/request-id": requestId,
          "com.pulsemcp/expires-at": new Date(deadline).toISOString(),
          "com.pulsemcp/tool-name": options.toolName,
        },
      }),
    },
    deadline,
    headers,
    signal,
  );
  if (created.stopped) return ended(created.stopped);
  const echoed = (created.body as { requestId?: unknown } | null)?.requestId;
  const id = typeof echoed === "string" && echoed ? echoed : requestId;
  const pollUrl = `${url.replace(/\/$/, "")}/${encodeURIComponent(id)}`;
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;

  while (Date.now() < deadline) {
    const polled = await call(
      pollUrl,
      { method: "GET" },
      deadline,
      headers,
      signal,
    );
    if (polled.stopped) return ended(polled.stopped);
    const body = polled.body as { action?: unknown; content?: unknown } | null;
    const action = typeof body?.action === "string" ? body.action : "";
    if (action !== "pending") {
      // An answer read after the caller left, or after the deadline, is an
      // answer nobody is waiting for. It sends nothing.
      if (signal?.aborted) return ended("dropped");
      if (Date.now() >= deadline) return { action: "expired" };
      // Anything unrecognised is a no, exactly as the library treats it.
      if (!ANSWERS.has(action)) return { action: "decline" };
      return {
        action: action as ElicitationResult["action"],
        content:
          body?.content && typeof body.content === "object"
            ? (body.content as ElicitationResult["content"])
            : undefined,
      };
    }
    const wait = Math.min(interval, deadline - Date.now());
    if (wait > 0) await pause(wait, signal);
    if (signal?.aborted) return ended("dropped");
  }
  return { action: "expired" };
}

/** A read for the prompt that gives up, rather than holding the human's time. */
async function bounded<T>(work: () => Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), LOOKUP_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A header off a Gmail message, as the API returns it. */
function headerOf(message: unknown, name: string): string | undefined {
  const headers = (
    message as {
      payload?: { headers?: Array<{ name?: string; value?: string }> };
    }
  )?.payload?.headers;
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
    ?.value;
}

/**
 * What a draft send would actually send, for the prompt.
 *
 * The vendored prompt for `from_draft_id` names only the draft's id, which a
 * human cannot judge: an agent can stage a draft to anyone and ask approval for
 * an opaque number. So the draft is read and its recipients and subject are
 * put in front of the human. If it cannot be read, the prompt says so.
 */
async function draftSummary(
  client: IGmailClient,
  draftId: string,
): Promise<string> {
  const draft = await bounded(() => client.getDraft(draftId));
  if (!draft) {
    return (
      "strad could not read this draft, so its recipients and subject are " +
      "unknown. Decline unless you know what it is."
    );
  }
  const lines = ["The draft:"];
  for (const name of ["To", "Cc", "Bcc", "Subject"]) {
    const value = headerOf(draft.message, name);
    if (value) lines.push(`  ${name}: ${value}`);
  }
  return lines.join("\n");
}

type Handler = (request: unknown, extra: unknown) => unknown;

interface Scope {
  channel: Channel | null;
  deadline: number;
  args: Record<string, unknown>;
  /** The call's abort signal: its response closed, or it was cancelled. */
  signal?: AbortSignal;
  /** Prove the call is alive, against core's progressToken. */
  keepalive?: (progress: number) => void;
}

/**
 * One scope per in-flight `tools/call`, across every mount in the process: an
 * AsyncLocalStorage store is per async context, so two calls never share one,
 * and {@link guardSends} reads the same store {@link withConfirmation} writes.
 */
const current = new AsyncLocalStorage<Scope>();

/** The mailbox's two methods that send. Everything else passes through. */
const SENDS = new Set(["sendMessage", "sendDraft"]);

/**
 * The mailbox, refusing to send once the call that asked has been dropped.
 *
 * `askHuman` already answers `cancel` to a dropped call, but the tool does more
 * between an `accept` and the send: a reply reads the original message first.
 * A call dropped in that gap would still send. This closes it at the last
 * moment there is: the send itself.
 */
export function guardSends(client: IGmailClient): IGmailClient {
  return new Proxy(client, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof value !== "function") return value;
      if (typeof prop !== "string" || !SENDS.has(prop)) return value.bind(t);
      return (...args: unknown[]) => {
        if (current.getStore()?.signal?.aborted) {
          return Promise.reject(
            new Error(
              "the call that asked for this was dropped before it was sent, " +
                "so nothing was sent",
            ),
          );
        }
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

export interface ConfirmationOptions {
  /** Who the mail goes out as, for the prompt. Never a credential. */
  account?: string;
  /**
   * The mailbox, for a best-effort read of what the prompt should name: the
   * account when `account` is unset, and a draft's recipients.
   */
  client?: () => IGmailClient;
  /** For tests. The protocol's own default otherwise. */
  pollIntervalMs?: number;
  /** For tests. {@link KEEPALIVE_MS} otherwise. */
  keepaliveMs?: number;
}

/**
 * The call's abort signal, and a keepalive that sends progress against the
 * progressToken core put on the call. No token, no keepalive: progress without
 * one is not a thing the protocol lets a server send.
 */
function callExtras(
  meta: unknown,
  extra: unknown,
): { signal?: AbortSignal; keepalive?: (progress: number) => void } {
  const e = extra as
    | {
        signal?: AbortSignal;
        sendNotification?: (n: {
          method: string;
          params: Record<string, unknown>;
        }) => Promise<void>;
      }
    | undefined;
  const signal = e?.signal instanceof AbortSignal ? e.signal : undefined;
  const token = (meta as { progressToken?: unknown } | undefined)
    ?.progressToken;
  const send = e?.sendNotification;
  const keepalive =
    send && (typeof token === "string" || typeof token === "number")
      ? (progress: number) => {
          void send({
            method: "notifications/progress",
            params: {
              progressToken: token,
              progress,
              message: "waiting for a human to confirm",
            },
          }).catch(() => {});
        }
      : undefined;
  return { signal, keepalive };
}

/**
 * The server the vendored registration should see. Everything not named below
 * passes straight through to `target`.
 */
export function withConfirmation(
  target: Server,
  options: ConfirmationOptions = {},
): Server {
  const guard =
    (handler: Handler): Handler =>
    async (request, extra) => {
      const params = (
        request as {
          params?: { name?: unknown; arguments?: unknown; _meta?: unknown };
        }
      )?.params;
      const channel = channelFrom(params?._meta);
      const tool = typeof params?.name === "string" ? params.name : "";

      if (CONFIRMED_TOOLS.includes(tool)) {
        const bypass = containerBypass();
        if (bypass) return refusal(tool, bypass);
        if (!channel) {
          return refusal(tool, "this call carried no confirmation channel");
        }
        if ("refused" in channel) {
          return refusal(
            tool,
            `strad refused the caller's confirmation channel: ${channel.refused}`,
          );
        }
      }
      const ttl =
        channel && "url" in channel ? (channel.ttlMs ?? DEFAULT_TTL_MS) : 0;
      const args =
        params?.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      const { signal, keepalive } = callExtras(params?._meta, extra);
      // The clock starts when the call arrives, which is when core's did.
      return current.run(
        { channel, deadline: Date.now() + ttl, args, signal, keepalive },
        () => handler(request, extra),
      );
    };

  const elicitInput = async (params: {
    message?: unknown;
    requestedSchema?: unknown;
  }): Promise<ElicitationResult> => {
    const scope = current.getStore();
    const channel = scope?.channel;
    if (!scope || !channel || "refused" in channel) {
      // Unreachable through the guard; a throw is the closed answer anyway.
      throw new Error("no confirmation channel for this call");
    }
    const client = options.client;
    const account =
      options.account ??
      (client ? await bounded(() => client().getAccountEmail()) : undefined);
    const via = [channel.slug && `strad slug ${channel.slug}`, account]
      .filter(Boolean)
      .join(", ");
    let message = String(params.message ?? "");
    const draftId = scope.args.from_draft_id;
    if (typeof draftId === "string" && client) {
      message += `\n\n${await draftSummary(client(), draftId)}`;
    }
    let beat = 0;
    const timer = scope.keepalive
      ? setInterval(
          () => scope.keepalive?.(++beat),
          options.keepaliveMs ?? KEEPALIVE_MS,
        )
      : undefined;
    try {
      const answer = await askHuman({
        url: channel.url,
        message: via ? `[${via}]\n\n${message}` : message,
        requestedSchema: params.requestedSchema,
        toolName: "send_email",
        deadline: scope.deadline,
        pollIntervalMs: options.pollIntervalMs,
        headers: channel.headers,
        signal: scope.signal,
      });
      // The last word on a dropped call, whatever was read.
      return scope.signal?.aborted ? { action: "cancel" } : answer;
    } finally {
      if (timer) clearInterval(timer);
    }
  };

  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "setRequestHandler") {
        return (schema: unknown, handler: Handler) =>
          (t.setRequestHandler as (s: unknown, h: Handler) => void).call(
            t,
            schema,
            methodOf(schema) === "tools/call" ? guard(handler) : handler,
          );
      }
      if (prop === "getClientCapabilities") {
        return () => {
          const caps = t.getClientCapabilities();
          const channel = current.getStore()?.channel;
          return channel && "url" in channel
            ? { ...caps, elicitation: { form: {} } }
            : caps;
        };
      }
      if (prop === "elicitInput") return elicitInput;
      const value = Reflect.get(t, prop, receiver);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}
