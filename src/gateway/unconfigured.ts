import { SecretNotFoundError } from "../secrets/provider/index.ts";
import type { ErrorKind, SelfClassifyingError } from "../telemetry/index.ts";

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

  constructor(slug: string, names: string[]) {
    const list = [...new Set(names)].sort();
    super(
      `server "${slug}" is not configured yet: ` +
        `${list.join(", ")} ${list.length === 1 ? "is" : "are"} declared ` +
        `mayBeUnseeded and no value has been seeded. The server deploys and ` +
        `stays inactive until one is; nothing is broken and there is nothing ` +
        `to restart.`,
    );
    this.name = "ServerUnconfiguredError";
    this.slug = slug;
    this.names = list;
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
