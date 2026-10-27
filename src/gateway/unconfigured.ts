import { SecretNotFoundError } from "../secrets/provider/index.ts";
import type { ErrorKind, SelfClassifyingError } from "../telemetry/index.ts";
import type { ServerAdapter } from "./adapters/types.ts";

/**
 * A slug that is waiting for a credential nobody has seeded yet.
 *
 * ## Why this is not just "the upstream is down"
 *
 * The deploy stopped failing on a `${NAME}` a human deliberately deferred (see
 * src/deploy/unseeded.ts), which means the gateway now boots with slugs it
 * cannot resolve a credential for. That is a supported state, and it is the ONE
 * state where nothing is broken, nothing is down, and nothing will fix itself:
 * it clears the moment a value lands in the store, and not before.
 *
 * Reporting it as an ordinary upstream failure would put it in the same bucket
 * as a bundle that will not start — so a fleet with one slug awaiting a token
 * would never read as healthy, `/healthz` would report it degraded, and the
 * deploy gate that asserts on `degraded` would red the deploy that this whole
 * feature exists to let through. The distinction is carried, once, from here to
 * `/healthz`, the console and the MCP error a client sees.
 *
 * ## It never carries a value, and it never sends one upstream
 *
 * The alternative to throwing is substituting the literal `${APIFY_TOKEN}` into
 * an `Authorization:` header and sending it to a third party, which is worse
 * than a failed request in every way. The message is built from the SLUG and the
 * NAMES — both of which strad's own config authored — and from nothing else.
 */
export class ServerUnconfiguredError
  extends Error
  implements SelfClassifyingError
{
  readonly slug: string;
  /**
   * The `${NAME}`s this slug declared and the store does not hold.
   *
   * In practice ONE, and that is worth knowing rather than inferring: resolution
   * runs the names concurrently through `Promise.all`, so the first rejection
   * wins and the others are never reported. A plural field because a caller
   * should not have to care, and because reporting one at a time is a property
   * of how resolution happens rather than of what is missing — a slug short of
   * two credentials will name the second one on the next probe.
   */
  readonly names: string[];
  /**
   * Which deferral this is. `unseeded` is a `mayBeUnseeded` name nobody has
   * seeded; `unconnected` is an `oauth:` slug whose refresh token nobody has
   * minted, because nobody has clicked Connect. Same state to every consumer —
   * the only difference is the sentence, which sends a human to the right place.
   */
  readonly reason: "unseeded" | "unconnected";

  constructor(
    slug: string,
    names: string[],
    reason: "unseeded" | "unconnected" = "unseeded",
  ) {
    const list = [...new Set(names)].sort();
    super(
      reason === "unconnected"
        ? `server "${slug}" is not connected yet: the store holds no ` +
            `${list.join(", ")} for its oauth: connector. Complete Connect for ` +
            `it in the console; until then it stays inactive, and there is ` +
            `nothing to restart.`
        : `server "${slug}" is not configured yet: ` +
            `${list.join(", ")} ${list.length === 1 ? "is" : "are"} declared ` +
            `mayBeUnseeded and no value has been seeded. The server deploys and ` +
            `stays inactive until one is; nothing is broken and there is nothing ` +
            `to restart.`,
    );
    this.name = "ServerUnconfiguredError";
    this.slug = slug;
    this.names = list;
    this.reason = reason;
  }

  /**
   * Its own telemetry kind, declared rather than pattern-matched. Without it
   * this message ("...is not configured yet...") matches none of `errorKind()`'s
   * patterns and exports as `unknown` — into the same bucket an alert rule uses
   * to find real faults, which is exactly the mistake `LocalMachineOfflineError`
   * already made once.
   */
  readonly telemetryKind: ErrorKind = "server_unconfigured";
}

/**
 * Run a resolution, and translate the misses this slug declared.
 *
 * The waiver list is the whole discriminator: a `SecretNotFoundError` for a name
 * in it is the deferral a human wrote down, and one for any other name is a
 * fault that reaches the caller unchanged. That is the runtime half of the same
 * rule the deploy gate holds — a marked name degrades, an unmarked one does not
 * — so a config that would have failed the render still fails the request.
 *
 * Wrapped around the ENDPOINT THUNK rather than around the adapter, because the
 * thunk is what resolves: an adapter-level catch would also swallow a genuine
 * upstream 404 that happened to mention a secret name.
 */
export async function resolvingFor<T>(
  slug: string,
  waived: ReadonlySet<string>,
  resolve: () => Promise<T>,
): Promise<T> {
  try {
    return await resolve();
  } catch (err) {
    if (err instanceof SecretNotFoundError && waived.has(err.secretName)) {
      throw new ServerUnconfiguredError(slug, [err.secretName]);
    }
    throw err;
  }
}

/**
 * An `oauth:` slug that has never been connected says so, instead of failing as
 * its upstream.
 *
 * ## Why at the failure, and not before resolution like `resolvingFor`
 *
 * A connector's refresh token is never a `${NAME}` (see `OAuthConnector` in
 * src/config/schema.ts): the renderer injects it onto the slug's own container
 * only if the store holds it, so core resolves nothing that could miss, and the
 * upstream is what fails — an ordinary `upstream_error`, which pages. The log
 * record cannot tell "never connected" from "connected and broken", so the
 * distinction has to be made here, where the store can be asked.
 *
 * Asked ONLY once an operation has already failed. A connected slug that works
 * costs nothing, and a slug whose server is built to survive an absent token
 * (Google Sheets lists its tools unconnected) keeps doing so.
 *
 * ## It must never silence a real fault
 *
 * The translation fires on exactly one answer: the store was reached and holds
 * no refresh token in this slug's namespaces. A token that IS held — revoked,
 * expired, or fine behind a bundle that will not start — leaves the original
 * error untouched, and so does a store that cannot be read, because "I could not
 * check" is not evidence that nobody connected.
 *
 * `held` answers from the slug's own `oauth/` and `static/` namespaces and
 * nothing else, from metadata: the caller builds it on the same listing and
 * rule as the console's Connected badge, so a parameter that exists but will
 * not render counts as HELD and its fault stands.
 */
export function awaitingConsent(
  adapter: ServerAdapter,
  variable: string,
  held: () => Promise<boolean>,
): ServerAdapter {
  // Asked on EVERY failure, transient ones included. A slice of the held
  // snapshot while it is fresh; one enumeration of the store when it is not.
  const translate = async (err: unknown): Promise<never> => {
    if (err instanceof ServerUnconfiguredError) throw err;
    let present: boolean;
    try {
      present = await held();
    } catch {
      throw err;
    }
    if (present) throw err;
    throw new ServerUnconfiguredError(adapter.slug, [variable], "unconnected");
  };
  const guarded = <A extends unknown[], R>(
    op: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return (...args) => op(...args).catch(translate);
  };

  const wrapped: ServerAdapter = {
    slug: adapter.slug,
    kind: adapter.kind,
    ...(adapter.host ? { host: adapter.host } : {}),
    listTools: guarded(() => adapter.listTools()),
    callTool: guarded((name, args, ctx) => adapter.callTool(name, args, ctx)),
    close: () => adapter.close(),
  };
  if (adapter.listResources) {
    wrapped.listResources = guarded(() => adapter.listResources!());
  }
  if (adapter.readResource) {
    wrapped.readResource = guarded((uri: string) => adapter.readResource!(uri));
  }
  if (adapter.postRaw) wrapped.postRaw = adapter.postRaw.bind(adapter);
  if (adapter.getRaw) wrapped.getRaw = adapter.getRaw.bind(adapter);
  return wrapped;
}
