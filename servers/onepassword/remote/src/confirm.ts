/**
 * A human in front of every 1Password reveal and write, routed to the session
 * that made the call.
 *
 * ## The problem this solves
 *
 * The vendored tools gate a reveal (`onepassword_get_item`) and the four writes
 * on `requestConfirmation()` from `@pulsemcp/mcp-elicitation`, and that library
 * finds its human through `process.env`: `ELICITATION_REQUEST_URL` /
 * `ELICITATION_POLL_URL`. That is upstream's deployment, one server process per
 * agent session, where the environment IS the session. strad's bundle is one
 * process serving every caller, so a container-wide URL cannot name the calling
 * session; the alternative, `DANGEROUSLY_SKIP_ELICITATIONS=true`, reveals every
 * secret to whoever can reach the slug, unasked.
 *
 * So the address travels with the CALL. strad core reads it off the caller's
 * `/mcp` request (`X-Elicitation-Url`, held to
 * `gateway.elicitation.allowedUrlPrefixes`) and, for a slug declaring
 * `confirmations: true`, forwards it on the upstream `tools/call` as
 * `_meta["dev.strad/elicitation"]`. Core never forwards a client's own `_meta`,
 * so that key is core's word and not the caller's. This is the same channel
 * gmail's `send_email` asks through (images/bundle-google/src/confirm.ts); the
 * protocol client below is a port of that one, with the same four rules: a
 * redirect is an error, a failure names a status and never a body, every request
 * is aborted at the deadline, and an answer read after the call was dropped is a
 * `cancel`.
 *
 * ## How, without editing the vendored tree
 *
 * The library's NATIVE tier asks the server object whether the client supports
 * elicitation, then calls `server.elicitInput()`. The tools capture the server
 * object they are registered on, so the server handed to the vendored
 * registration is a proxy ({@link withConfirmation}):
 *
 *   - `setRequestHandler` wraps the `tools/call` handler, so every call runs in
 *     an AsyncLocalStorage scope holding THAT call's channel, deadline and abort
 *     signal. Two sessions calling at once never see each other's address.
 *   - `getClientCapabilities()` reports elicitation support exactly when the
 *     current call has someone to ask.
 *   - `elicitInput()` speaks the approval protocol itself ({@link askHuman}).
 *
 * ## Who decides whether to ask
 *
 * strad does, per mount, and the vendored tool is made to always ask so that it
 * never decides on its own. The tool reads its posture from `process.env` on
 * every call, and every mount in the process shares it, so
 * {@link forceAskEverything} pins it at the start of EVERY call (a parameter
 * refresh can write the environment after boot): reads and writes both elicit,
 * nothing is whitelisted, and `DANGEROUSLY_SKIP_ELICITATIONS` is removed. What a
 * mount then does with the question is {@link ConfirmationOptions.confirmWrites}:
 *
 *   - a REVEAL (`get_item`, and `share_item`, whose link reveals the item) is
 *     always put to a human. There is no per-slug way out.
 *   - a CREATE is put to a human unless the mount was built with
 *     `confirmWrites: false` (`OP_ELICITATION_WRITE=false` under the slug's own
 *     variable name), in which case it is answered `accept` here, unasked. That
 *     is the provisioning posture: mint a credential and store it in one
 *     unattended pass, while reading or sharing an existing one still asks.
 *
 * ## Fail closed
 *
 * A call that needs a human refuses, before it runs, when it carries no channel
 * (the console, a flow-through grant, a caller that sent no header, an `admin`
 * token), when core refused the caller's channel, or when the container sets a
 * container-wide `ELICITATION_REQUEST_URL` / `ELICITATION_POLL_URL`, which the
 * library could prefer over the per-call channel. A refused reveal reveals
 * nothing; a refused write writes nothing.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** The `_meta` key core writes the caller's channel under. */
export const ELICITATION_META_KEY = 'dev.strad/elicitation';

/**
 * The tools that expose an EXISTING secret. Always confirmed, on every mount.
 *
 * `onepassword_share_item` is here and not with the writes: it mints a link to
 * any item the token can see, and whoever opens the link reads the item. A
 * share is a reveal to a third party, so no write posture may skip it.
 */
export const REVEAL_TOOLS: readonly string[] = ['onepassword_get_item', 'onepassword_share_item'];

/**
 * The tools that create a NEW item. Confirmed unless the mount says otherwise.
 *
 * NOT DERIVED, on purpose: these two lists are what a call is refused on when
 * there is no one to ask. `test/confirm.test.ts` greps the vendored tree for
 * every tool that calls `requestConfirmation` and fails if the two lists
 * together disagree with it, so a re-vendor that adds a tenth elicitation is
 * caught in CI.
 */
export const WRITE_TOOLS: readonly string[] = [
  'onepassword_create_login',
  'onepassword_create_secure_note',
  'onepassword_create_api_credential',
];

/** The client methods behind the confirmed tools that act. Refused once a call is dropped. */
const WRITE_METHODS = new Set(['createLogin', 'createSecureNote', 'shareItem', 'createApiCredential']);

/** Poll every 5s, the library's default. */
export const POLL_INTERVAL_MS = 5_000;
/** Without a deadline from core, give a human five minutes, the library's default. */
const DEFAULT_TTL_MS = 5 * 60_000;
/** How often a waiting confirmation proves the call is alive; well under fetch's 300s. */
export const KEEPALIVE_MS = 30_000;

const ANSWERS = new Set(['accept', 'decline', 'cancel', 'expired']);

/** What the library's native tier expects back from `elicitInput()`. */
export interface ElicitationResult {
  action: 'accept' | 'decline' | 'cancel' | 'expired';
  content?: Record<string, unknown>;
}

/** A channel core forwarded, or the reason it refused the caller's. */
export type Channel =
  | { url: string; slug?: string; ttlMs?: number; headers?: Record<string, string> }
  | { refused: string };

/** What core's schema refuses too (`confirmationHeaderProblem`). */
const RESERVED_HEADERS = new Set([
  'content-type',
  'content-length',
  'transfer-encoding',
  'connection',
  'host',
]);

function headersFrom(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read core's `_meta` entry off a `tools/call`. Anything malformed, or any shape
 * this module does not know, counts as no channel at all, which a confirmed call
 * turns into a refusal.
 */
export function channelFrom(meta: unknown): Channel | null {
  if (!meta || typeof meta !== 'object') return null;
  const raw = (meta as Record<string, unknown>)[ELICITATION_META_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.refused === 'string') return { refused: entry.refused };
  if (typeof entry.url !== 'string') return null;
  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return null;
  }
  // Core has already held the URL to its allowlist. This is the second, cheaper
  // check: only a web URL is ever fetched from here.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return {
    url: entry.url,
    slug: typeof entry.slug === 'string' ? entry.slug : undefined,
    ttlMs:
      typeof entry.ttlMs === 'number' && entry.ttlMs > 0 ? Math.floor(entry.ttlMs) : undefined,
    headers: headersFrom(entry.headers),
  };
}

/**
 * The variables the vendored tools read their posture from, and the values that
 * make them always ask. strad answers; the tool never decides on its own.
 */
const ASK_EVERYTHING: Readonly<Record<string, string | undefined>> = {
  OP_ELICITATION_READ: 'true',
  OP_ELICITATION_WRITE: 'true',
  OP_WHITELISTED_ITEMS: undefined,
  DANGEROUSLY_SKIP_ELICITATIONS: undefined,
};

/**
 * Pin the vendored tools' posture to "ask about every reveal and every write".
 *
 * Mutates `env` (the process environment, which is what the vendored tools
 * read) and returns the names it had to change from a value someone set, so the
 * caller can say so. A bare `DANGEROUSLY_SKIP_ELICITATIONS=true` on a shared
 * bundle would otherwise switch the prompt off for every 1Password mount in the
 * process, whichever slug set it.
 */
export function forceAskEverything(env: NodeJS.ProcessEnv = process.env): string[] {
  const overridden: string[] = [];
  for (const [name, value] of Object.entries(ASK_EVERYTHING)) {
    const prior = env[name];
    if (prior !== undefined && prior !== '' && prior !== value) overridden.push(name);
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return overridden;
}

/**
 * Why this container's own environment would route a confirmation around the
 * per-call channel, or null when it would not.
 */
export function containerBypass(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  if (env.ELICITATION_REQUEST_URL?.trim() || env.ELICITATION_POLL_URL?.trim()) {
    return (
      'this container sets a container-wide ELICITATION_REQUEST_URL or ' +
      'ELICITATION_POLL_URL, which cannot name the session that made the call'
    );
  }
  return null;
}

function refusal(tool: string, why: string) {
  const what =
    tool === 'onepassword_share_item'
      ? 'No share link was created.'
      : REVEAL_TOOLS.includes(tool)
        ? 'Nothing was read from 1Password and nothing was revealed.'
        : 'Nothing was written to 1Password.';
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `${tool} was NOT run: it needs a human to confirm it, and ${why}. ${what} ` +
          'strad routes the confirmation to the session that made the call, through ' +
          'the X-Elicitation-Url header on its /mcp request (a Zimmer session\'s ' +
          'per-session elicitation URL), and only for a slug that declares ' +
          '`confirmations: true`. Calls without one, including from the console and ' +
          'from admin tokens, are refused rather than run unconfirmed. To check that ' +
          'an item exists or see its fields, use onepassword_get_item_metadata, which ' +
          'never reveals a value and never asks.',
      },
    ],
    isError: true,
  };
}

function methodOf(schema: unknown): string | undefined {
  const method = (schema as { shape?: { method?: unknown } })?.shape?.method as
    | { value?: unknown; _def?: { value?: unknown } }
    | undefined;
  const value = method?.value ?? method?._def?.value;
  return typeof value === 'string' ? value : undefined;
}

type Outcome = { stopped: 'expired' | 'dropped' } | { stopped?: undefined; body: unknown };

/** One request to the approval endpoint, bounded by the deadline and the call's signal. */
async function call(
  url: string,
  init: RequestInit,
  deadline: number,
  headers: Record<string, string> | undefined,
  dropped: AbortSignal | undefined
): Promise<Outcome> {
  if (dropped?.aborted) return { stopped: 'dropped' };
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { stopped: 'expired' };
  const timeout = AbortSignal.timeout(remaining);
  const stop = (): Outcome | null =>
    dropped?.aborted
      ? { stopped: 'dropped' }
      : timeout.aborted
        ? { stopped: 'expired' }
        : null;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      // Core's edge headers first, so nothing in them can replace ours.
      headers: { ...headers, 'content-type': 'application/json' },
      // Never followed: the allowlist bounds where this goes, and a 3xx would
      // let the far end move it.
      redirect: 'error',
      signal: dropped ? AbortSignal.any([timeout, dropped]) : timeout,
    });
  } catch {
    const stopped = stop();
    if (stopped) return stopped;
    // The cause is not repeated: it can describe the network beyond the bundle,
    // and this text reaches the caller.
    throw new Error('the approval endpoint could not be reached');
  }
  if (!response.ok) {
    // The status, never the body.
    await response.body?.cancel().catch(() => {});
    throw new Error(`the approval endpoint answered HTTP ${response.status}`);
  }
  try {
    return { body: await response.json() };
  } catch {
    const stopped = stop();
    if (stopped) return stopped;
    throw new Error('the approval endpoint did not answer with JSON');
  }
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Ask a human through the pulsemcp fallback-elicitation protocol: POST the
 * question to `url`, then poll `url/<request-id>` until it is answered or the
 * deadline passes. Only an answer read before the deadline counts, and only
 * while the call that asked is still there.
 */
export async function askHuman(options: {
  url: string;
  message: string;
  requestedSchema: unknown;
  toolName: string;
  deadline: number;
  pollIntervalMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<ElicitationResult> {
  const { url, deadline, headers, signal } = options;
  const ended = (stopped: 'expired' | 'dropped'): ElicitationResult => ({
    action: stopped === 'dropped' ? 'cancel' : 'expired',
  });
  const requestId = randomUUID();
  const created = await call(
    url,
    {
      method: 'POST',
      body: JSON.stringify({
        mode: 'form',
        message: options.message,
        requestedSchema: options.requestedSchema,
        _meta: {
          'com.pulsemcp/request-id': requestId,
          'com.pulsemcp/expires-at': new Date(deadline).toISOString(),
          'com.pulsemcp/tool-name': options.toolName,
        },
      }),
    },
    deadline,
    headers,
    signal
  );
  if (created.stopped) return ended(created.stopped);
  const echoed = (created.body as { requestId?: unknown } | null)?.requestId;
  const id = typeof echoed === 'string' && echoed ? echoed : requestId;
  const pollUrl = `${url.replace(/\/$/, '')}/${encodeURIComponent(id)}`;
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;

  while (Date.now() < deadline) {
    const polled = await call(pollUrl, { method: 'GET' }, deadline, headers, signal);
    if (polled.stopped) return ended(polled.stopped);
    const body = polled.body as { action?: unknown; content?: unknown } | null;
    const action = typeof body?.action === 'string' ? body.action : '';
    if (action !== 'pending') {
      if (signal?.aborted) return ended('dropped');
      if (Date.now() >= deadline) return { action: 'expired' };
      // Anything unrecognised is a no, exactly as the library treats it.
      if (!ANSWERS.has(action)) return { action: 'decline' };
      return {
        action: action as ElicitationResult['action'],
        content:
          body?.content && typeof body.content === 'object'
            ? (body.content as Record<string, unknown>)
            : undefined,
      };
    }
    const wait = Math.min(interval, deadline - Date.now());
    if (wait > 0) await pause(wait, signal);
    if (signal?.aborted) return ended('dropped');
  }
  return { action: 'expired' };
}

type Handler = (request: unknown, extra: unknown) => unknown;

interface Scope {
  tool: string;
  /** Who to ask, or null when nobody needs asking for this call. */
  channel: Channel | null;
  /** True when this call's question is answered here, unasked: a write on a mount that does not confirm writes. */
  unattended: boolean;
  deadline: number;
  signal?: AbortSignal;
  keepalive?: (progress: number) => void;
}

/** One scope per in-flight `tools/call`, across every mount in the process. */
const current = new AsyncLocalStorage<Scope>();

const dropped = () =>
  new Error('the call that asked for this was dropped before it ran, so nothing was written');

/**
 * The 1Password client, refusing to write once the call that asked has been
 * dropped. An approval that lands after the caller was told the call failed
 * must not create the item anyway, and twice if the caller retried.
 */
export function guardWrites<T extends object>(client: T): T {
  return new Proxy(client, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof value !== 'function') return value;
      if (typeof prop !== 'string' || !WRITE_METHODS.has(prop)) return value.bind(t);
      return (...args: unknown[]) => {
        if (current.getStore()?.signal?.aborted) return Promise.reject(dropped());
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

export interface ConfirmationOptions {
  /**
   * Put each write to a human. Default true. False is the provisioning posture:
   * writes are answered `accept` here, and reveals still ask.
   */
  confirmWrites?: boolean;
  /** Names the mount in the prompt, for a human who holds several. */
  label?: string;
  /** For tests. The protocol's own default otherwise. */
  pollIntervalMs?: number;
  /** For tests. {@link KEEPALIVE_MS} otherwise. */
  keepaliveMs?: number;
}

function callExtras(
  meta: unknown,
  extra: unknown
): { signal?: AbortSignal; keepalive?: (progress: number) => void } {
  const e = extra as
    | {
        signal?: AbortSignal;
        sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
      }
    | undefined;
  const signal = e?.signal instanceof AbortSignal ? e.signal : undefined;
  const token = (meta as { progressToken?: unknown } | undefined)?.progressToken;
  const send = e?.sendNotification;
  const keepalive =
    send && (typeof token === 'string' || typeof token === 'number')
      ? (progress: number) => {
          void send({
            method: 'notifications/progress',
            params: { progressToken: token, progress, message: 'waiting for a human to confirm' },
          }).catch(() => {});
        }
      : undefined;
  return { signal, keepalive };
}

/**
 * The server the vendored registration should see. Everything not named below
 * passes straight through to `target`.
 */
export function withConfirmation<S extends object>(target: S, options: ConfirmationOptions = {}): S {
  const confirmWrites = options.confirmWrites ?? true;

  const guard =
    (handler: Handler): Handler =>
    async (request, extra) => {
      const params = (
        request as { params?: { name?: unknown; _meta?: unknown } }
      )?.params;
      // Before anything reads it: the posture may have been rewritten since the
      // last call, and the vendored tool reads it fresh.
      forceAskEverything();
      const tool = typeof params?.name === 'string' ? params.name : '';
      const reveal = REVEAL_TOOLS.includes(tool);
      const write = WRITE_TOOLS.includes(tool);
      const unattended = write && !confirmWrites;
      const channel = channelFrom(params?._meta);

      if (reveal || (write && confirmWrites)) {
        const bypass = containerBypass();
        if (bypass) return refusal(tool, bypass);
        if (!channel) return refusal(tool, 'this call carried no confirmation channel');
        if ('refused' in channel) {
          return refusal(tool, `strad refused the caller's confirmation channel: ${channel.refused}`);
        }
      }
      const ttl = channel && 'url' in channel ? (channel.ttlMs ?? DEFAULT_TTL_MS) : 0;
      const { signal, keepalive } = callExtras(params?._meta, extra);
      // The clock starts when the call arrives, which is when core's did.
      return current.run(
        {
          tool,
          channel: unattended ? null : channel,
          unattended,
          deadline: Date.now() + ttl,
          signal,
          keepalive,
        },
        () => handler(request, extra)
      );
    };

  const elicitInput = async (params: {
    message?: unknown;
    requestedSchema?: unknown;
  }): Promise<ElicitationResult> => {
    const scope = current.getStore();
    if (scope?.unattended) {
      // The mount does not confirm writes. A dropped call still writes nothing.
      return scope.signal?.aborted
        ? { action: 'cancel' }
        : { action: 'accept', content: { confirm: true } };
    }
    const channel = scope?.channel;
    if (!scope || !channel || 'refused' in channel) {
      // Unreachable through the guard; a throw is the closed answer anyway.
      throw new Error('no confirmation channel for this call');
    }
    const via = [channel.slug && `strad slug ${channel.slug}`, options.label]
      .filter(Boolean)
      .join(', ');
    const message = String(params.message ?? '');
    let beat = 0;
    const timer = scope.keepalive
      ? setInterval(() => scope.keepalive?.(++beat), options.keepaliveMs ?? KEEPALIVE_MS)
      : undefined;
    try {
      const answer = await askHuman({
        url: channel.url,
        message: via ? `[${via}]\n\n${message}` : message,
        requestedSchema: params.requestedSchema,
        toolName: scope.tool,
        deadline: scope.deadline,
        pollIntervalMs: options.pollIntervalMs,
        headers: channel.headers,
        signal: scope.signal,
      });
      return scope.signal?.aborted ? { action: 'cancel' } : answer;
    } finally {
      if (timer) clearInterval(timer);
    }
  };

  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'setRequestHandler') {
        return (schema: unknown, handler: Handler) =>
          (
            (t as { setRequestHandler: (s: unknown, h: Handler) => void }).setRequestHandler
          ).call(t, schema, methodOf(schema) === 'tools/call' ? guard(handler) : handler);
      }
      if (prop === 'getClientCapabilities') {
        return () => {
          const caps = (t as { getClientCapabilities: () => unknown }).getClientCapabilities() as
            | Record<string, unknown>
            | undefined;
          const scope = current.getStore();
          const answerable = scope?.unattended || (scope?.channel && 'url' in scope.channel);
          return answerable ? { ...caps, elicitation: { form: {} } } : caps;
        };
      }
      if (prop === 'elicitInput') return elicitInput;
      const value = Reflect.get(t, prop, receiver);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
}
