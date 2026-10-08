import {
  mintAccessToken,
  parseServiceAccount,
  SCOPE_CLOUD_PLATFORM,
  ServiceAccountAuthError,
  type FetchLike,
  type MintedToken,
  type ServiceAccount,
} from "./service-account.ts";
import {
  DEFAULT_RETRY_BUDGET,
  isIdempotentMethod,
  isRetryableStatus,
  parseRetryAfter,
  retryDelayMs,
  sleep,
  type RetryBudget,
} from "../../http/retry.ts";
import {
  decodeEnvelope,
  decodeEnvelopeValue,
  encodeEnvelope,
} from "./namespace.ts";
import {
  decodeStoredValue,
  encodeSecretValue,
  parameterId,
  secretRef,
  SECRET_VALUE_ENCODING,
  variableOf,
  type ParameterEnvelope,
} from "./wire.ts";
import {
  nextVersionId,
  rankVersions,
  versionIdOf,
  withSecretAccessor,
  type IamPolicy,
} from "./write-rules.ts";
import {
  ParameterStoreError,
  UnreadablePayloadError,
  type ConsoleReadGrant,
  type CreateParameterInput,
  type ParameterListing,
  type ParameterMeta,
  type ParameterStore,
  type ResolvedNamespace,
} from "./types.ts";
import { errorSummary } from "../../util/error-text.ts";

/**
 * The GCP implementation of the parameter store: Parameter Manager as the index
 * of everything, Secret Manager backing the secret parts.
 *
 * A non-secret parameter is a Parameter Manager parameter whose latest version's
 * payload IS the value (inside a small JSON envelope — see namespace.ts). A
 * secret parameter is the same Parameter Manager parameter, but its envelope
 * `value` is a `__REF__(…)` pointer at a Secret Manager version, and the real
 * value lives in Secret Manager. `:render` dereferences the pointer — for a
 * credential that can reach Secret Manager.
 *
 * This is the ADMIN + RESOLVER client (src/, core gateway). Its credential can
 * read secret values (admin: for the console reveal, behind SSO; resolver: to
 * build a child's env). The MCP viewer is a DIFFERENT credential in a DIFFERENT
 * process (servers/secrets) and cannot. No SDK: fetch + node:crypto.
 */

export interface GcpParameterStoreConfig {
  projectId: string;
  /** Parameter Manager location. `global` unless a deployment says otherwise. */
  location?: string;
  account: ServiceAccount;
  /** Test seams. Default to the real APIs. */
  pmApiBase?: string;
  smApiBase?: string;
  tokenUrl?: string;
  fetchImpl?: FetchLike;
  /**
   * Per-request deadline. Default 10s.
   *
   * A request that HANGS is worse than one that fails, and it is the case a
   * caller cannot defend against on its own: the runtime provider serves stale
   * values when a refresh REJECTS, but a never-settling promise gives it nothing
   * to react to — the single-flight it shares would pin every concurrent reader
   * behind it, and `/mcp` would stop answering because a secret store went quiet.
   * The whole "a store outage must not take the gateway down" property rests on
   * every read eventually settling, so it is enforced here, at the one place
   * every read passes through.
   */
  timeoutMs?: number;
  /**
   * How hard a refused call is tried again. Defaults to
   * `DEFAULT_RETRY_BUDGET`; see `src/http/retry.ts` for what each ceiling holds
   * and why the default is small.
   */
  retry?: Partial<RetryBudget>;
  /**
   * How long one reading of the whole store may be reused, in ms.
   *
   * `0` — the default — means never: every `list()` and `resolve()` reaches
   * the store.
   *
   * The runtime resolver, the two deploy-time readers and the console's admin
   * client set it. A write through a client that holds a reading re-reads the
   * parameter it touched, so a client that writes and re-lists in one breath
   * still sees its own write. See `snapshot()` for what is held and what
   * changes it.
   */
  snapshotTtlMs?: number;
  /** Injected in tests so the snapshot's age is not measured on the wall clock. */
  now?: () => number;
}

const DEFAULT_PM_BASE = "https://parametermanager.googleapis.com";
const DEFAULT_SM_BASE = "https://secretmanager.googleapis.com";
const DEFAULT_TIMEOUT_MS = 10_000;

/** How many store requests one enumeration or render keeps in flight. */
const FANOUT = 10;

/**
 * `fn` over every item, at most `width` at a time, results in input order.
 *
 * A pool, not fixed batches: a batch waits for its slowest member before the
 * next one starts, so a single read that backs off for a second on a `429`
 * idles the other nine lanes for that second.
 */
async function pooled<T, R>(
  items: readonly T[],
  width: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, lane),
  );
  return out;
}

/**
 * The HTTP status behind a failure, for the two error types this client raises.
 *
 * `undefined` means the failure was not an HTTP answer at all — an aborted
 * request, a socket reset, a `JSON.parse` on a truncated body. Those are NOT
 * retried: a timeout retried is the per-attempt deadline multiplied by the
 * attempt count, which is the unbounded read `timeoutMs` exists to prevent.
 */
function statusOf(err: unknown): number | undefined {
  if (err instanceof ParameterStoreError) return err.status;
  if (err instanceof ServiceAccountAuthError) return err.status;
  return undefined;
}

export function createGcpParameterStore(
  cfg: GcpParameterStoreConfig,
): ParameterStore {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const location = cfg.location ?? "global";
  const pmBase = cfg.pmApiBase ?? DEFAULT_PM_BASE;
  const smBase = cfg.smApiBase ?? DEFAULT_SM_BASE;
  const pmParent = `projects/${cfg.projectId}/locations/${location}`;
  const smParent = `projects/${cfg.projectId}`;
  /**
   * This client's OWN service account, as an IAM member string.
   *
   * The same identity every call below authenticates as — derived from the key
   * rather than configured separately, because a second source of truth for "who
   * are we" would bind read access to a principal that is not the one doing the
   * reading, and the grant would look right and do nothing.
   */
  const CONSOLE_MEMBER = `serviceAccount:${cfg.account.client_email}`;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const budget: RetryBudget = { ...DEFAULT_RETRY_BUDGET, ...cfg.retry };
  const snapshotTtlMs = cfg.snapshotTtlMs ?? 0;
  const now = cfg.now ?? Date.now;
  let cached: MintedToken | undefined;
  let held: Snapshot | undefined;
  /**
   * Parameters a write through this client has touched since `held` was taken.
   * The next read re-reads exactly these and splices them into the held roster,
   * instead of enumerating the whole project again. See `snapshot()`.
   */
  const dirty = new Set<string>();
  /**
   * Every envelope this process has read, keyed by parameter id, with the
   * version it was read from.
   *
   * A Parameter Manager version is immutable — its payload cannot be edited,
   * only a new version written — so once a version has been read, reading it
   * again can only return the same bytes. An enumeration still LISTS every
   * parameter's versions to learn which one is current, but it only GETs the
   * ones that moved. That halves what a re-read costs, and it takes the billed
   * verb (`GetParameterVersion`) out of a re-read entirely when nothing changed.
   *
   * The key is the version id AND its `createTime`, because a parameter deleted
   * and re-created under the same path starts again at `v1`. A listing that
   * reports no `createTime` is never cached. Bounded by the parameter count:
   * an id the last enumeration did not see is dropped. What it holds is the
   * envelope, so a non-secret parameter's value lives in this process's memory
   * for as long as the version is current; a secret one's envelope holds only
   * its `__REF__` pointer.
   */
  const envelopes = new Map<
    string,
    {
      key: string;
      read: {
        envelope: ParameterEnvelope;
        versionId: string;
        createTime?: string;
      };
    }
  >();

  /**
   * The bearer every call carries, minted once per hour and shared.
   *
   * Bounded and retried exactly like the calls it authorizes. It is on the same
   * critical path — `call()` awaits it before it has a `Response` to abort — so
   * a token endpoint that hangs or throttles takes down every read regardless of
   * what the per-request signal below promises. The mint carries a default
   * deadline of its own, and the wrapper below REPLACES it: this store's
   * `timeoutMs` is a deployment's choice about its own reads, and a bearer
   * fetched on the way to one is part of that read rather than a call with a
   * bound of its own.
   */
  async function token(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    // Idempotent despite being a POST: minting a token creates no resource and
    // changes nothing, so a refused exchange is safe to repeat.
    cached = await retrying(true, () =>
      mintAccessToken(cfg.account, {
        scope: SCOPE_CLOUD_PLATFORM,
        tokenUrl: cfg.tokenUrl,
        fetchImpl: (input, init) =>
          fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
      }),
    );
    return cached.token;
  }

  /**
   * Run `attempt` until it stops failing in a way worth repeating.
   *
   * Both callers reach a Google API and both can be refused by the same
   * per-project quota, but they report it differently — `call()` raises a
   * `ParameterStoreError`, `mintAccessToken` a `ServiceAccountAuthError`. What
   * they share is a status and a budget, so the loop lives here and the status
   * is read off whichever error arrived.
   *
   * Nothing is logged. A retry that succeeded is not news, and a retry that gave
   * up throws the original error unchanged — the status a caller switches on
   * (`404` to `null`, `409` to "already exists") must survive the loop exactly.
   *
   * A server-named `Retry-After` is honoured for a store call, which is where
   * one has ever been seen. `mintAccessToken` raises a `ServiceAccountAuthError`,
   * which carries no such field, so a throttled token endpoint is backed off
   * with the blind exponential instead.
   */
  async function retrying<T>(
    idempotent: boolean,
    attempt: () => Promise<T>,
  ): Promise<T> {
    let spentMs = 0;
    for (let n = 0; ; n++) {
      try {
        return await attempt();
      } catch (err) {
        const status = statusOf(err);
        if (status === undefined || !isRetryableStatus(status, idempotent))
          throw err;
        const delay = retryDelayMs({
          attempt: n,
          spentMs,
          retryAfterMs:
            err instanceof ParameterStoreError ? err.retryAfterMs : undefined,
          budget,
        });
        if (delay === undefined) throw err;
        await sleep(delay);
        spentMs += delay;
      }
    }
  }

  async function call(
    base: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    // The path names a resource; it never carries a value (values travel in the
    // body, which is not echoed here). Strip the query and any `:verb`.
    const resource = (path.split("?")[0] ?? path).split(":")[0];
    const idempotent = isIdempotentMethod(method);
    // The bearer is resolved OUTSIDE the loop. `token()` carries a retry budget
    // of its own, and nesting the two would multiply them into sixteen attempts
    // at one throttled token endpoint.
    const bearer = await token();
    return retrying(idempotent, async () => {
      const res = await fetchImpl(`${base}/v1/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Bound every ATTEMPT — a fresh signal each time round, because an
        // AbortSignal that has already fired aborts the next request instantly.
        // See `timeoutMs` above: an unbounded read is the one failure the
        // runtime provider cannot degrade around, and retrying widens that bound
        // rather than removing it (see `src/http/retry.ts` for the ceiling).
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        if (isRetryableStatus(res.status, idempotent)) {
          // Release the socket before sleeping on it. The body of a refused
          // request is a Google error payload we never read, and leaving it
          // undrained holds the connection open for the whole backoff.
          await res.body?.cancel().catch(() => {});
        }
        throw new ParameterStoreError(
          `${method} ${resource} failed: ${res.status} ${res.statusText}`,
          res.status,
          parseRetryAfter(res.headers.get("retry-after")),
        );
      }
      if (res.status === 204) return {};
      const text = await res.text();
      return text ? (JSON.parse(text) as unknown) : {};
    });
  }

  const pm = (m: string, p: string, b?: unknown) => call(pmBase, m, p, b);
  const sm = (m: string, p: string, b?: unknown) => call(smBase, m, p, b);

  // --- Parameter Manager version plumbing ---------------------------------

  /**
   * One parameter as an enumeration sees it: the id, plus everything its latest
   * version says about it. The envelope carries the path, so this is what a
   * namespace filter is applied to.
   */
  interface RosterEntry {
    id: string;
    envelope: ParameterEnvelope;
    versionId: string;
    createTime?: string;
  }

  /**
   * One enumeration's outcome: what was read, and what could not be.
   *
   * A parameter whose version read failed is kept apart rather than failing the
   * whole enumeration. The strict readers — `list()`, and through it `resolve()`
   * — still throw on any of them, because a parameter they cannot see may be one
   * a child process needs. The console's `listDetailed()` shows the rest and
   * names the ones it could not read, so one throttled request out of a hundred
   * no longer renders an empty namespace.
   */
  interface Roster {
    entries: RosterEntry[];
    unreadable: { id: string; error: unknown }[];
  }

  /**
   * One reading of the store, as this process holds it.
   *
   * `roster` is the enumeration — every managed parameter's envelope, which is
   * what a namespace filter runs over. `rendered` memoises the render of each
   * namespace that has been asked for against THIS roster, so a namespace read
   * twice inside the TTL costs no second `:render` per parameter. `at` is when
   * the enumeration began, and it is the age every reader of the snapshot
   * reports: a value served from here is a claim about the store as of `at`.
   */
  interface Snapshot {
    at: number;
    roster: Promise<Roster>;
    rendered: Map<string, Promise<ResolvedNamespace>>;
  }

  interface RawVersion {
    name?: string;
    payload?: { data?: string };
    createTime?: string;
    disabled?: boolean;
  }

  /**
   * The greatest `v{n}` among a parameter's enabled versions, or undefined.
   *
   * The paging is this client's; the RANKING is `write-rules.ts`, vendored into
   * `servers/secrets` so the half that writes versions cannot disagree with the
   * three halves that read them.
   */
  async function currentVersionId(id: string): Promise<string | undefined> {
    return (await currentVersion(id))?.vid;
  }

  /**
   * The current version's id, and the `createTime` the listing reported for it.
   *
   * The `createTime` is what makes the version a cache key (see `envelopes`):
   * a version id alone is not one, because a parameter deleted and re-created
   * under the same path starts again at `v1`.
   */
  async function currentVersion(
    id: string,
  ): Promise<{ vid: string; createTime?: string } | undefined> {
    const versions: RawVersion[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = (await pm(
        "GET",
        `${pmParent}/parameters/${id}/versions?${qs}`,
      )) as { parameterVersions?: RawVersion[]; nextPageToken?: string };
      versions.push(...(page.parameterVersions ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);

    const ranked = rankVersions(versions);
    if (!ranked) return undefined;
    const raw = versions.find((v) => versionIdOf(v.name) === ranked.vid);
    return { vid: ranked.vid, createTime: raw?.createTime };
  }

  async function addVersion(
    id: string,
    envelope: ParameterEnvelope,
  ): Promise<string> {
    const vid = nextVersionId(await currentVersionId(id));
    await pm(
      "POST",
      `${pmParent}/parameters/${id}/versions?parameter_version_id=${vid}`,
      {
        payload: {
          data: Buffer.from(encodeEnvelope(envelope), "utf8").toString(
            "base64",
          ),
        },
      },
    );
    return vid;
  }

  /**
   * The id-collision guard, matching the one the MCP write client applies.
   *
   * `parameterId` is a lossy fold, so two distinct paths can name one resource.
   * The envelope carries the EXACT path it was written with, so comparing them
   * turns "this id resolves" into "this is the parameter you asked for". Without
   * it a rotate or a delete under a differently-spelled path acts on someone
   * else's parameter, and a reveal returns its value.
   */
  function assertSamePath(envelope: ParameterEnvelope, path: string): void {
    if (envelope.path !== path) {
      throw new ParameterStoreError(
        `"${path}" does not exist (the id it folds to belongs to another parameter)`,
        404,
      );
    }
  }

  /**
   * The current envelope (raw — a secret one still holds a `__REF__`, not a value).
   *
   * The decode is wrapped for the same reason `renderOne`'s is, and it is the
   * console that makes it matter. Five store methods start here — `list`,
   * `rotate`, `setNote`, `reveal` and `destroy` — and between them they are
   * reached from `GET /ui/:server` and from four of its six `POST` actions,
   * every one of which renders a failure into an HTML page. An unwrapped `decodeEnvelope` throws `JSON.parse`'s own
   * `SyntaxError`, and that message embeds a window of the payload it choked on
   * — which on a non-secret parameter IS the value, and on a secret one is the
   * envelope around its pointer.
   *
   * So the thrown error is DROPPED rather than chained as a `cause`: a `cause`
   * travels, and anything that stringifies the chain puts the window back. What
   * replaces it names the resource and nothing else, in the `method + resource`
   * shape every other `ParameterStoreError` from this file uses, which is
   * exactly the shape `errorSummary` is allowed to pass through to a human.
   */
  async function currentEnvelope(id: string): Promise<{
    envelope: ParameterEnvelope;
    versionId: string;
    createTime?: string;
  } | null> {
    const cur = await currentVersion(id);
    if (!cur) return null;
    const { vid } = cur;
    // A version's payload never changes once written, so a version this
    // process has already read is not read again. See `envelopes`.
    const key = cur.createTime ? `${vid}@${cur.createTime}` : undefined;
    const known = key ? envelopes.get(id) : undefined;
    if (known && known.key === key) return { ...known.read };
    const resource = `${pmParent}/parameters/${id}/versions/${vid}`;
    const raw = (await pm("GET", resource)) as RawVersion;
    const data = raw.payload?.data;
    if (data == null) return null;
    let envelope: ParameterEnvelope;
    try {
      envelope = decodeEnvelope(Buffer.from(data, "base64").toString("utf8"));
    } catch {
      throw new UnreadablePayloadError(resource);
    }
    const read = { envelope, versionId: vid, createTime: raw.createTime };
    if (key) envelopes.set(id, { key, read });
    return { ...read };
  }

  /**
   * Make a secret parameter's `__REF__` actually resolvable.
   *
   * Parameter Manager dereferences a reference as the PARAMETER's own principal,
   * not as whoever called `:render`. So a secret parameter is born unresolvable:
   * the secret exists, the pointer at it exists, and every `:render` fails with
   * `400 SECRET_REFERENCE_ERROR` until this binding is added. No amount of grant
   * on the RESOLVER fixes it, which is what makes the failure so confusing — the
   * credential that gets the 400 holds every permission the error implicates.
   *
   * Two reads plus a write, rather than a blind overwrite: the policy is
   * read-modify-written so an etag guards a concurrent change, and a policy that
   * already carries this member is left alone. A fresh secret's policy is empty
   * — `create()` makes the secret itself, so the idempotent branch is
   * defence-in-depth here and the live path for a re-run over an existing secret.
   */
  async function grantRenderAccess(
    id: string,
    alsoConsole: boolean,
  ): Promise<void> {
    const param = (await pm("GET", `${pmParent}/parameters/${id}`)) as {
      policyMember?: { iamPolicyUidPrincipal?: string };
    };
    const principal = param.policyMember?.iamPolicyUidPrincipal;
    if (!principal) {
      // Fail rather than proceed. A parameter whose principal we cannot name is
      // one whose reference we cannot make resolvable, and finishing `create()`
      // would report success for a secret that can never be read back.
      throw new ParameterStoreError(
        `parameter "${id}" reported no policyMember.iamPolicyUidPrincipal, so its secret reference could not be made resolvable`,
        502,
      );
    }

    // ONE read-modify-write for both members when both are wanted. They are the
    // same binding on the same secret, and two round trips would be two audit
    // entries, two etags to lose a race on, and a window in which the parameter
    // is renderable and the connector still is not.
    await bindSecretAccessors(
      id,
      alsoConsole ? [principal, CONSOLE_MEMBER] : [principal],
    );
  }

  /**
   * Give every one of `principals` `secretAccessor` on ONE secret, in one
   * read-modify-write.
   *
   * `requestedPolicyVersion=3` on the read is REQUIRED, not a refinement.
   * Without it IAM answers with a version-1 VIEW of the policy that omits every
   * CONDITIONAL binding — and writing that view back deletes them. A
   * read-modify-write that cannot see part of what it is rewriting is a
   * destructive one.
   *
   * The edit itself is `write-rules.ts` — the same bytes the `secrets` server's
   * write client applies, because both of them write parameters this policy
   * decides the renderability of. `null` from it is "already a member", and a
   * policy that already says everything asked for is not written back at all: a
   * `setIamPolicy` that changes nothing is still a write, and still an audit
   * line. The return says which it was.
   */
  async function bindSecretAccessors(
    id: string,
    principals: readonly string[],
  ): Promise<boolean> {
    const policy = (await sm(
      "GET",
      `${smParent}/secrets/${id}:getIamPolicy?options.requestedPolicyVersion=3`,
    )) as IamPolicy;

    let next: IamPolicy | null = null;
    for (const principal of principals) {
      const edited = withSecretAccessor(next ?? policy, principal);
      if (edited) next = edited;
    }
    if (!next) return false;

    await sm("POST", `${smParent}/secrets/${id}:setIamPolicy`, {
      policy: next,
    });
    return true;
  }

  // --- ParameterStore surface ---------------------------------------------

  /**
   * Every `managed-by: strad` parameter in the project, with its envelope.
   *
   * The namespace is INSIDE the envelope, not on a label, so there is no way to
   * ask the store for one namespace: enumerating means reading a version of
   * every parameter and filtering afterwards. That is what makes this expensive
   * — one `ListParameterVersions` per parameter to find its current version,
   * plus one `GetParameterVersion` for each whose current version this process
   * has not read before (see `envelopes`) — and why `snapshot()` exists.
   * `strad#308` is the redesign that would take the per-parameter read away.
   */
  async function enumerate(): Promise<Roster> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = (await pm("GET", `${pmParent}/parameters?${qs}`)) as {
        parameters?: { name?: string; labels?: Record<string, string> }[];
        nextPageToken?: string;
      };
      for (const raw of page.parameters ?? []) {
        if (raw.labels?.["managed-by"] !== "strad") continue;
        const id = raw.name?.split("/").pop();
        if (id) ids.push(id);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    const roster = await readEntries(ids);
    // Bound the envelope cache by what the store holds: a parameter deleted
    // elsewhere stops being remembered at the next enumeration.
    const seen = new Set(ids);
    for (const id of envelopes.keys()) if (!seen.has(id)) envelopes.delete(id);
    return roster;
  }

  /**
   * Read the current envelope of each of `ids`, keeping failures apart.
   *
   * A `404` is a parameter deleted between the listing and the read, and is
   * simply absent. Anything else is UNREADABLE — carried with its error, so a
   * strict reader can throw exactly what it would have thrown, and the console
   * can show the rest.
   *
   * Bounded fan-out: a store of 500 parameters must not open 500 connections to
   * render one page. A pool rather than fixed batches, so one slow read holds up
   * one lane instead of the nine requests queued behind it.
   */
  async function readEntries(ids: string[]): Promise<Roster> {
    const roster: Roster = { entries: [], unreadable: [] };
    await pooled(ids, FANOUT, async (id) => {
      try {
        const cur = await currentEnvelope(id);
        if (cur) roster.entries.push({ id, ...cur });
      } catch (err) {
        if (err instanceof ParameterStoreError && err.status === 404) return;
        roster.unreadable.push({ id, error: err });
      }
    });
    return roster;
  }

  /**
   * The held roster with `ids` re-read and spliced in — what a write through
   * this client costs the next reader, instead of a whole enumeration.
   *
   * A write knows exactly which parameter it touched, so that parameter is the
   * only thing the held reading can be wrong about BECAUSE of the write. A
   * create appears, a delete disappears (its read is a `404`), a rotate or a
   * note moves to its new version.
   */
  async function patched(
    base: Promise<Roster>,
    ids: string[],
  ): Promise<Roster> {
    const [old, fresh] = await Promise.all([base, readEntries(ids)]);
    const drop = new Set(ids);
    return {
      entries: [
        ...old.entries.filter((e) => !drop.has(e.id)),
        ...fresh.entries,
      ],
      unreadable: [
        ...old.unreadable.filter((u) => !drop.has(u.id)),
        ...fresh.unreadable,
      ],
    };
  }

  /**
   * The one reading of the store this process works from, for `snapshotTtlMs`.
   *
   * ONE per process, whatever the namespace count. The runtime provider reads a
   * namespace per `${NAME}`-referencing slug plus the gateway's own, the
   * registry reads one per `params: true` builtin, and the console's diagnosis
   * reads the gateway's again — six or seven namespaces on the production
   * config — and every one of them used to enumerate the project on its own
   * timer. With 34 parameters and a minute's TTL that was 388 billed reads a
   * minute (`test/secrets.read-accounting.test.ts`), around the clock, to
   * re-learn values that change a few times a month. Everything now slices
   * this: one enumeration per TTL, plus one render per parameter in each
   * namespace actually asked for.
   *
   * What changes it, in order of how often it happens:
   *
   *   - a WRITE through this client (`writing()` below) that succeeded marks
   *     the parameter it touched, and the next read re-reads that one parameter
   *     and keeps the rest — the console's admin client writes and re-lists in
   *     one breath, and a whole enumeration per click is what made every
   *     console action slow. The render memo is dropped with it, since a value
   *     may have moved. A write that FAILED drops the reading outright: it may
   *     have half-landed, on more than the one parameter;
   *   - `forget()`, which the runtime provider calls on `invalidate()` — the
   *     path a console write takes to reach the resolver, which is a different
   *     client instance holding a different credential — and on a MISS, so a
   *     name seeded outside strad is found within `negativeTtlSeconds`;
   *   - the TTL, on the next read after it elapses.
   *
   * Nothing refreshes it on its own. A process that is never asked never reads.
   *
   * The PROMISE is held, not its result, so namespaces resolved concurrently
   * share one enumeration instead of racing to start several. A rejected
   * enumeration is evicted — a refused read must not be the answer for the
   * whole TTL — and so is one that could not read every parameter, so the next
   * reader tries the missing ones again rather than inheriting the gap.
   * With the TTL off, every call is a fresh snapshot, and the memo it carries
   * lives exactly as long as the call.
   */
  function snapshot(): Snapshot {
    if (snapshotTtlMs > 0 && held && now() - held.at < snapshotTtlMs) {
      if (dirty.size === 0) return held;
      const ids = [...dirty];
      dirty.clear();
      // `at` is kept: everything but the re-read parameters is still a claim
      // about the store as of the original enumeration.
      return hold({
        at: held.at,
        roster: patched(held.roster, ids),
        rendered: new Map(),
      });
    }
    dirty.clear();
    const fresh: Snapshot = {
      at: now(),
      roster: enumerate(),
      rendered: new Map(),
    };
    return snapshotTtlMs > 0 ? hold(fresh) : fresh;
  }

  function hold(snap: Snapshot): Snapshot {
    held = snap;
    snap.roster.then(
      (r) => {
        if (r.unreadable.length > 0 && held === snap) held = undefined;
      },
      () => {
        if (held === snap) held = undefined;
      },
    );
    return snap;
  }

  /**
   * Drop the snapshot, so the next read reaches the store.
   *
   * A write through this client that fails calls it. The runtime provider
   * calls it on `invalidate()` and when a `${NAME}` it was asked for is absent
   * — the two signals, besides the TTL, on which a running gateway re-reads the
   * store. The console's "Re-read the store" reaches it through
   * `forgetConsoleStores` (`src/ui/store-client.ts`).
   */
  function forget(): void {
    held = undefined;
    dirty.clear();
  }

  /** A write through this client landed on `id`. See `snapshot()`. */
  function touched(id: string): void {
    if (held) dirty.add(id);
  }

  /** How old the held snapshot is, in ms. `Infinity` when nothing is held. */
  function snapshotAgeMs(): number {
    return held ? now() - held.at : Infinity;
  }

  /** The roster's slice under `namespace`, as the console sees it. */
  function slice(entries: RosterEntry[], namespace: string): ParameterMeta[] {
    const out: ParameterMeta[] = [];
    for (const { envelope, versionId, createTime } of entries) {
      const { path, secret, note } = envelope;
      if (!path.startsWith(namespace)) continue;
      out.push({
        path,
        variable: variableOf(path),
        secret,
        note,
        hasValue: true,
        latestVersion: versionId,
        updatedAt: createTime,
      });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  /**
   * The STRICT slice: any parameter the enumeration could not read fails it,
   * with that parameter's own error. An unreadable parameter's namespace is
   * inside the envelope nobody could read, so there is no telling whether it
   * belongs to this one — and the resolver must not start a child without it.
   */
  async function listFrom(
    roster: Promise<Roster>,
    namespace: string,
  ): Promise<ParameterMeta[]> {
    const { entries, unreadable } = await roster;
    if (unreadable[0]) throw unreadable[0].error;
    return slice(entries, namespace);
  }

  async function list(namespace: string): Promise<ParameterMeta[]> {
    return listFrom(snapshot().roster, namespace);
  }

  /**
   * The console's listing: the slice, plus the parameters that could not be
   * read and plausibly belong to it.
   *
   * "Plausibly" is by id. The id is a fold of the path (`parameterId`), so a
   * parameter under this namespace has an id that starts with the namespace's
   * own fold. That can over-report a sibling namespace that folds alike; it
   * cannot under-report one under this namespace, which is the direction that
   * matters for a page claiming to be the whole list.
   */
  async function listDetailed(namespace: string): Promise<ParameterListing> {
    const snap = snapshot();
    const { entries, unreadable } = await snap.roster;
    // A namespace that folds to nothing — `/`, say — folds to the `p-` the id
    // rule prefixes onto an id that does not start with a letter, which would
    // match almost nothing. Every parameter is under such a namespace.
    const fold = parameterId(namespace).slice(0, 54);
    const prefix = fold === "p-" ? "" : fold;
    return {
      parameters: slice(entries, namespace),
      unreadable: unreadable
        .filter((u) => u.id.startsWith(prefix))
        .map((u) => ({ id: u.id, error: u.error }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      readAt: snap.at,
    };
  }

  async function create(input: CreateParameterInput): Promise<ParameterMeta> {
    const id = parameterId(input.path);

    // A secret parameter's value goes to Secret Manager FIRST, so the Parameter
    // Manager envelope can point at a version that already exists.
    let envelopeValue = input.value;
    if (input.secret) {
      await sm("POST", `${smParent}/secrets?secretId=${id}`, {
        replication: { automatic: {} },
        labels: { "managed-by": "strad" },
      });
      try {
        await sm("POST", `${smParent}/secrets/${id}:addVersion`, {
          payload: {
            // base64url of the value, THEN base64 for the wire. The inner
            // encoding is what `:render` will substitute into a JSON payload, so
            // it is the one that has to be inert — see `encodeSecretValue`. A PEM
            // key, a service-account blob or a JSON array of token records is
            // rejected outright without it.
            data: Buffer.from(encodeSecretValue(input.value), "utf8").toString(
              "base64",
            ),
          },
        });
      } catch (err) {
        // Roll the empty secret back so a retry is not met with "already exists".
        await sm("DELETE", `${smParent}/secrets/${id}`).catch(() => {});
        throw err;
      }
      envelopeValue = secretRef(cfg.projectId, id);
    }

    // Both Parameter Manager writes — the parameter and its first version — are
    // inside the rollback, along with the Secret Manager secret written above.
    // A failure at ANY of them must leave nothing behind, or a retry meets a 409
    // ("already exists") on whichever resource did get created. In particular the
    // parameter-create itself can fail (transient 5xx, a leftover) AFTER the
    // secret exists, which would otherwise orphan the secret.
    try {
      await pm("POST", `${pmParent}/parameters?parameter_id=${id}`, {
        format: "JSON",
        labels: { "managed-by": "strad", secret: String(input.secret) },
      });
    } catch (err) {
      // A 409 here is the ONE failure that must not roll back the parameter: it
      // means a parameter with this id already exists, and it is not this call's
      // to delete. `parameterId` collapses a path into a flat id, so two distinct
      // paths CAN share one — `gcs/static/FOO` and `GCS/Static/FOO` do — and the
      // rollback would then destroy the parameter that was already there, and
      // every version of it, in response to a typo.
      if (!(err instanceof ParameterStoreError && err.status === 409)) {
        await pm("DELETE", `${pmParent}/parameters/${id}`).catch(() => {});
      }
      if (input.secret)
        await sm("DELETE", `${smParent}/secrets/${id}`).catch(() => {});
      throw err;
    }

    try {
      // BEFORE the version, so there is never a moment where a complete-looking
      // secret parameter exists whose reference cannot render. The grant needs
      // the parameter to exist (its principal is minted with it) and does not
      // need the version, so this is the earliest point it can be made.
      if (input.secret)
        await grantRenderAccess(id, input.consoleReadable === true);
      await addVersion(id, {
        path: input.path,
        secret: input.secret,
        note: input.note,
        value: envelopeValue,
        ...(input.secret ? { encoding: SECRET_VALUE_ENCODING } : {}),
      });
    } catch (err) {
      // The parameter above is ours — this call created it — so rolling it back
      // is right. Each DELETE is 404-tolerant. Deleting the secret drops the
      // binding with it; an IAM policy does not outlive its resource.
      await pm("DELETE", `${pmParent}/parameters/${id}`).catch(() => {});
      if (input.secret)
        await sm("DELETE", `${smParent}/secrets/${id}`).catch(() => {});
      throw err;
    }

    return {
      path: input.path,
      variable: variableOf(input.path),
      secret: input.secret,
      note: input.note,
      hasValue: true,
      latestVersion: "v1",
    };
  }

  async function rotate(path: string, value: string): Promise<void> {
    const id = parameterId(path);
    const cur = await currentEnvelope(id);
    if (!cur) throw new ParameterStoreError(`no such parameter: ${path}`, 404);
    assertSamePath(cur.envelope, path);

    if (cur.envelope.secret) {
      // A parameter written before strad encoded secret values carries no
      // `encoding`, and its readers would take the base64url about to be written
      // for the value itself. Declare the encoding BEFORE writing the bytes.
      //
      // The ordering is the whole point, and it is not the intuitive one. Neither
      // write can be rolled into the other, so one of them lands first and there
      // is a window. Bytes-first means the window reads an encoded value as a
      // literal: the child process gets base64 text as its credential, silently.
      // Envelope-first means the window reads the OLD literal value as base64url,
      // which `decodeStoredValue` refuses — so reads fail, loudly, and the
      // provider serves its last known good snapshot until the second write
      // lands. A rotate that half-fails should be visible, not plausible.
      //
      // "Loudly" is a strong claim and it deserves its limit stated: the guard
      // catches a stale literal only when that literal is not ITSELF canonical
      // base64url decoding to valid UTF-8. All five names seeded in prod fail
      // that test (verified), and a short value is likelier to pass it, so the
      // window is closed below rather than merely made improbable.
      const upgraded = cur.envelope.encoding !== SECRET_VALUE_ENCODING;
      if (upgraded) {
        await addVersion(id, {
          ...cur.envelope,
          encoding: SECRET_VALUE_ENCODING,
        });
      }
      try {
        // The Secret Manager version is the value; the Parameter Manager `__REF__`
        // already points at `versions/latest`, so it needs no new version.
        await sm("POST", `${smParent}/secrets/${id}:addVersion`, {
          payload: {
            data: Buffer.from(encodeSecretValue(value), "utf8").toString(
              "base64",
            ),
          },
        });
      } catch (err) {
        // Put the envelope back. Without this the window above is not a window
        // at all — a 403 or a socket reset here strands the parameter declaring
        // an encoding its bytes do not have, permanently, and `resolve()` fails
        // for the WHOLE namespace until someone rotates it again. Same rollback
        // discipline `create()` applies, for the same reason.
        if (upgraded) await addVersion(id, cur.envelope).catch(() => {});
        throw err;
      }
    } else {
      await addVersion(id, { ...cur.envelope, value });
    }
  }

  async function setNote(path: string, note: string): Promise<void> {
    const id = parameterId(path);
    const cur = await currentEnvelope(id);
    if (!cur) throw new ParameterStoreError(`no such parameter: ${path}`, 404);
    assertSamePath(cur.envelope, path);
    // The note lives in the envelope, so a note change is a new version that
    // carries the SAME value pointer (or literal). A secret's value is untouched.
    await addVersion(id, { ...cur.envelope, note: note || undefined });
  }

  /**
   * Whether `path` is a secret parameter, read from its CURRENT envelope rather
   * than any held reading. `undefined` when the parameter does not exist.
   *
   * The console's reveal gate decides which posture applies from this, and a
   * held reading can be minutes old: a parameter deleted and re-created as a
   * secret outside this client would still read as non-secret there. One
   * version listing; the envelope itself usually comes from `envelopes`.
   */
  async function isSecret(path: string): Promise<boolean | undefined> {
    const cur = await currentEnvelope(parameterId(path)).catch((err) => {
      if (err instanceof ParameterStoreError && err.status === 404) return null;
      throw err;
    });
    if (!cur) return undefined;
    assertSamePath(cur.envelope, path);
    return cur.envelope.secret;
  }

  async function reveal(path: string): Promise<string> {
    const id = parameterId(path);
    const cur = await currentEnvelope(id);
    if (!cur) throw new ParameterStoreError(`no such parameter: ${path}`, 404);
    assertSamePath(cur.envelope, path);
    if (!cur.envelope.secret) return cur.envelope.value;
    // Secret: read the value from Secret Manager directly (the admin credential
    // can). Two callers, both on core and neither on /mcp: the console's reveal
    // button (a human, behind the SSO gate) and the parameter write-back route's
    // boot read (src/http/params.ts), which is bounded to the names a server's
    // own `paramsWritable:` allowlist already puts in that server's container.
    const res = (await sm(
      "GET",
      `${smParent}/secrets/${id}/versions/latest:access`,
    )) as { payload?: { data?: string } };
    const data = res.payload?.data;
    if (data == null) {
      throw new ParameterStoreError(
        `secret "${path}" has no version to reveal`,
        404,
      );
    }
    // `:access` is the DIRECT read — it hands back exactly the bytes that were
    // written, with no `:render` in the path to undo the encoding. So the
    // envelope's declared encoding has to be applied here too, or the console
    // shows a human base64 and calls it their credential.
    return decodeStoredValue(
      Buffer.from(data, "base64").toString("utf8"),
      cur.envelope.encoding,
      path,
    );
  }

  /**
   * One parameter's CURRENT value, read the way the gateway reads it: `:render`.
   *
   * `reveal` above is the console's read, and on prod the console holds no read
   * at all — secrets-iam.md §1 withholds `secretmanager.versions.access`, and
   * the `oauth/` kind is never granted back. This is the resolver's read, which
   * is the one a running gateway's `${NAME}` came through, so a caller comparing
   * against that value compares like with like. Live: the snapshot is never
   * consulted, because the question is what the store holds NOW.
   */
  async function renderPath(path: string): Promise<string> {
    const id = parameterId(path);
    const cur = await currentVersion(id);
    if (!cur) throw new ParameterStoreError(`no such parameter: ${path}`, 404);
    const resource = `${pmParent}/parameters/${id}/versions/${cur.vid}`;
    const rendered = (await pm("GET", `${resource}:render`)) as {
      renderedPayload?: string;
      payload?: { data?: string };
    };
    const data = rendered.renderedPayload ?? rendered.payload?.data;
    if (data == null) {
      throw new ParameterStoreError(
        `parameter "${path}" rendered no payload`,
        404,
      );
    }
    let envelope: ParameterEnvelope;
    let value: string;
    try {
      // Dropped, not chained, for `renderOne`'s reason: the rendered payload is
      // the secret, and `JSON.parse` quotes a window of it.
      envelope = decodeEnvelope(Buffer.from(data, "base64").toString("utf8"));
      value = decodeEnvelopeValue(envelope);
    } catch {
      throw new UnreadablePayloadError(resource);
    }
    assertSamePath(envelope, path);
    return value;
  }

  async function destroy(path: string): Promise<void> {
    const id = parameterId(path);
    // Verify the id names THIS path before deleting anything. A delete is the
    // one action with no undo, so the collision guard has to run first — and it
    // is required, not best-effort: swallowing the read and deleting anyway is
    // what turns a spelling collision into data loss.
    const existing = await currentEnvelope(id);
    if (!existing)
      throw new ParameterStoreError(`no such parameter: ${path}`, 404);
    assertSamePath(existing.envelope, path);

    // Whether this is a secret parameter is read from the PARAMETER'S label, not
    // its version envelope: the label survives even if the latest version is
    // unreadable, so a transient read glitch cannot make us skip the Secret
    // Manager delete and orphan the secret. If even the label is unreadable, we
    // still attempt the secret delete (it is 404-tolerant) rather than leave one
    // behind.
    const isSecret = await pm("GET", `${pmParent}/parameters/${id}`)
      .then(
        (p) =>
          (p as { labels?: Record<string, string> }).labels?.secret === "true",
      )
      .catch(() => true);

    // Delete the Parameter Manager parameter's versions, then the parameter,
    // then (for a secret parameter) its Secret Manager secret.
    await deleteAllVersions(id);
    await pm("DELETE", `${pmParent}/parameters/${id}`).catch((err) => {
      if (err instanceof ParameterStoreError && err.status === 404) return;
      throw err;
    });
    if (isSecret) {
      await sm("DELETE", `${smParent}/secrets/${id}`).catch((err) => {
        if (err instanceof ParameterStoreError && err.status === 404) return;
        throw err;
      });
    }
  }

  async function deleteAllVersions(id: string): Promise<void> {
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = (await pm(
        "GET",
        `${pmParent}/parameters/${id}/versions?${qs}`,
      ).catch((err) => {
        if (err instanceof ParameterStoreError && err.status === 404) {
          return { parameterVersions: [] };
        }
        throw err;
      })) as { parameterVersions?: RawVersion[]; nextPageToken?: string };
      for (const v of page.parameterVersions ?? []) {
        const vid = versionIdOf(v.name);
        if (vid) {
          await pm(
            "DELETE",
            `${pmParent}/parameters/${id}/versions/${vid}`,
          ).catch(() => {});
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  /**
   * Render every parameter in a namespace, keeping the failures apart from the
   * values.
   *
   * `resolve()` is fail-fast on purpose — a child process must not be started
   * with half its environment — but it still needs the full failure set for a
   * useful diagnostic. One bad parameter fails the namespace; the error names
   * every hard failure so the caller does not have to bisect the store.
   *
   * The console needs the other half of that fact. A parameter that exists and
   * cannot be dereferenced is neither seeded-and-healthy nor absent, and naming
   * it is the difference between "rotate this one value" and "the secret backend
   * is down". So the loop is written once, here, and the two callers differ only
   * in what they do with `unrenderable`.
   *
   * The reason attached to a failure is `errorSummary`-shaped — method and
   * resource, never a body. A `:render` failure's payload IS the dereferenced
   * secret, and a raw message is how it would reach a page.
   *
   * Memoised on the snapshot, per namespace. The second reader of a namespace
   * inside the TTL — the provider's next `${NAME}`, the console's diagnosis,
   * the registry's next tool call — gets the render already made. A render
   * that met a TRANSIENT failure (a 429, a 5xx, a timeout) on any parameter is
   * not kept: the outcome is still returned, so the caller degrades exactly as
   * it did, but the next reader re-renders rather than inheriting one bad
   * moment for the length of the TTL. A `400` is kept — it is the store's
   * settled answer about that parameter, and a rotate that fixes it drops the
   * snapshot on its own.
   */
  async function renderAll(namespace: string): Promise<ResolvedNamespace> {
    const snap = snapshot();
    const memo = snap.rendered.get(namespace);
    if (memo) return memo;
    const pending = renderFrom(snap, namespace);
    snap.rendered.set(namespace, pending);
    pending.then(
      (out) => {
        if (out.unrenderable.some((u) => u.transient)) {
          snap.rendered.delete(namespace);
        }
      },
      () => snap.rendered.delete(namespace),
    );
    return pending;
  }

  async function renderFrom(
    snap: Snapshot,
    namespace: string,
  ): Promise<ResolvedNamespace> {
    const metas = await listFrom(snap.roster, namespace);
    const values: Record<string, string> = {};
    const unrenderable: ResolvedNamespace["unrenderable"] = [];

    // Bounded fan-out, the same shape `list()` uses and for the same reason: a
    // namespace of 500 parameters must not open 500 connections. Sequential was
    // tolerable while the loop stopped at the first failure; it is not now that
    // every parameter is rendered on its own, because a namespace-wide 403 would
    // otherwise cost N round trips end to end on the deploy path.
    const outcomes = await pooled(metas, FANOUT, (meta) =>
      renderOne(meta.path, meta.latestVersion),
    );
    for (const outcome of outcomes) {
      if ("value" in outcome) values[outcome.variable] = outcome.value;
      else unrenderable.push(outcome);
    }
    return { values, unrenderable, readAt: snap.at };
  }

  type RenderOutcome =
    | { variable: string; value: string }
    | { variable: string; hard: boolean; reason: string; transient?: boolean };

  /**
   * One parameter: its value, or the shape of why it has none.
   *
   * `hard` is what `resolve()` throws on. A `:render` that errors and an envelope
   * that will not decode are hard; an empty payload is soft, so `resolve()` keeps
   * returning the rest.
   *
   * The versionless case is soft too and is now unreachable from `renderAll`,
   * which only ever passes paths `list()` returned — and `list()` drops a
   * parameter with no readable version before it becomes a meta. The branch
   * stays because `knownVid` is optional, not because anything reaches it.
   */
  async function renderOne(
    path: string,
    knownVid?: string,
  ): Promise<RenderOutcome> {
    const id = parameterId(path);
    const variable = variableOf(path);

    // `list()` already read the latest version to recover the envelope, so
    // re-deriving it here is a versions LIST per parameter that answers a
    // question the caller holds the answer to. On a deploy that is one wasted
    // request for every parameter in every namespace resolved.
    const vid = knownVid ?? (await currentVersionId(id));
    if (!vid) {
      return {
        variable,
        hard: false,
        reason:
          "the parameter exists but has no version, so there is nothing to render",
      };
    }

    // `:render` returns the payload with every `__REF__` dereferenced against
    // Secret Manager. For a non-secret parameter it is the raw payload; for a
    // secret one it carries the actual value. Either way we parse the envelope
    // and take `.value`.
    let data: string | undefined;
    try {
      const rendered = (await pm(
        "GET",
        `${pmParent}/parameters/${id}/versions/${vid}:render`,
      )) as { renderedPayload?: string; payload?: { data?: string } };
      data = rendered.renderedPayload ?? rendered.payload?.data;
    } catch (err) {
      return {
        variable,
        hard: true,
        reason: renderFailureReason(err),
        transient: isTransient(err),
      };
    }
    if (data == null) {
      return {
        variable,
        hard: false,
        reason: "the render returned no payload",
      };
    }

    try {
      // The one place on the RESOLVE path where a rendered payload becomes the
      // string a child process runs with. Every consumer funnels through here:
      // `resolveServerParams` (baked component env), the registry's param cache
      // (a builtin's options) and `StoreSecretProvider` (`${REF}` resolution).
      //
      // `decodeEnvelopeValue` undoes the storage encoding a secret value is
      // written with, so `:render` cannot splice raw bytes into the JSON text it
      // returns. Reading `.value` raw would hand a base64url-shaped string to a
      // server, which would boot with a credential no upstream accepts and fail
      // nowhere until the first real call.
      return {
        variable,
        value: decodeEnvelopeValue(
          decodeEnvelope(Buffer.from(data, "base64").toString("utf8")),
        ),
      };
    } catch {
      // The reason is a CLASS, and the thrown error is DROPPED rather than
      // chained. `JSON.parse` embeds a window of its input in the `SyntaxError`
      // it throws, and the input here is a rendered payload — it holds the
      // secret. That message must not travel, not even as a `cause`.
      return {
        variable,
        hard: true,
        reason: "the rendered payload did not decode into a usable value",
      };
    }
  }

  async function resolve(namespace: string): Promise<Record<string, string>> {
    const { values, unrenderable } = await renderAll(namespace);
    // FAIL FAST on exactly what used to throw, and no more. A `:render` that
    // errored or an envelope that would not decode propagated out of the old loop
    // on the first occurrence; a versionless parameter or empty payload was
    // skipped and the call succeeded. Widening the set here would break deploys
    // that work today, which is why `hard` exists.
    const hard = unrenderable.filter((u) => u.hard);
    if (hard.length > 0) {
      const details = hard.map((u) => `${u.variable}: ${u.reason}`).join("; ");
      throw new ParameterStoreError(
        `${hard.length} parameter(s) under ${namespace} could not be rendered ` +
          `(${details})`,
        500,
      );
    }
    // A copy: the map is memoised on the snapshot and handed to several
    // callers, and one of them spreading its own keys over it must not be
    // visible to the next.
    return { ...values };
  }

  async function resolveDetailed(
    namespace: string,
  ): Promise<ResolvedNamespace> {
    return renderAll(namespace);
  }

  /**
   * A write, and what it does to the snapshot.
   *
   * A write that SUCCEEDED changed one known parameter, so it marks that one
   * for re-reading (`touched`). A write that THREW may still have landed —
   * `create()` rolls back with best-effort DELETEs that are allowed to fail —
   * so the only safe assumption after it is that the whole snapshot is stale.
   */
  function writing<A extends unknown[], T>(
    fn: (...args: A) => Promise<T>,
    pathOf: (...args: A) => string,
  ): (...args: A) => Promise<T> {
    return async (...args: A) => {
      let out: T;
      try {
        out = await fn(...args);
      } catch (err) {
        forget();
        throw err;
      }
      touched(parameterId(pathOf(...args)));
      return out;
    };
  }

  /**
   * Bind the console's own credential `secretAccessor` on ONE parameter's
   * secret, then find out whether that actually made the value readable.
   *
   * The repair half of `create({ consoleReadable: true })`, for every parameter
   * seeded before that existed. Same member, same single secret, never the
   * project — see `CONSOLE_MEMBER`.
   *
   * THE READ-BACK IS THE POINT, not a belt-and-braces check. §1 of
   * docs/operate/secrets-iam.md recommends closing the console's self-grant
   * escalation with an IAM DENY policy, which is evaluated before any allow and
   * cannot be granted around; on such a deployment this `setIamPolicy` returns
   * 200 and the value stays unreadable. Reporting the write as success there
   * would move the failure to after the consent screen, which is strictly worse
   * than the manual grant it replaces. So the value is read and dropped, and
   * `readable` says what actually happened.
   *
   * A NON-SECRET parameter has no Secret Manager secret to bind anything on, and
   * the console can already read it. Nothing is written and `readable` is still
   * measured — the honest answer for a store that may be refusing for some other
   * reason entirely.
   *
   * The read's rejection is carried out unclassified and the VALUE is not: an
   * error raised while reading a value can quote it, which is why the caller
   * (`clientReadFailure`, src/ui/connector.ts) reduces it to a closed word.
   */
  async function grantConsoleRead(path: string): Promise<ConsoleReadGrant> {
    const id = parameterId(path);
    // Establish that this id names THIS path before writing an IAM binding
    // against it. `parameterId` folds a path into a flat id and two paths can
    // collide (see `create`), so without this a grant could be written onto a
    // secret belonging to a different parameter entirely.
    const cur = await currentEnvelope(id);
    if (!cur) throw new ParameterStoreError(`no such parameter: ${path}`, 404);
    assertSamePath(cur.envelope, path);

    const changed = cur.envelope.secret
      ? await bindSecretAccessors(id, [CONSOLE_MEMBER])
      : false;

    try {
      await reveal(path);
      return { changed, readable: true };
    } catch (err) {
      return { changed, readable: false, error: err };
    }
  }

  return {
    backend: "gcp",
    list,
    listDetailed,
    isSecret,
    create: writing(create, (input) => input.path),
    rotate: writing(rotate, (path) => path),
    setNote: writing(setNote, (path) => path),
    reveal,
    renderPath,
    destroy: writing(destroy, (path) => path),
    // `writing`, even though it writes no parameter: it changes whether this
    // namespace RENDERS, and a resolver-configured client memoises a failed
    // render for the length of its TTL (a 403 is the store's settled answer, so
    // `renderAll` keeps it). Dropping the reading is what stops a grant landing
    // and the next read still reporting the refusal it just fixed. The
    // verification read inside is live either way — `reveal` never consults the
    // snapshot.
    grantConsoleRead: writing(grantConsoleRead, (path) => path),
    resolve,
    resolveDetailed,
    forget,
    snapshotAgeMs,
  };
}

/**
 * Is this failure one the next reader might not meet?
 *
 * A throttle, a server error and a request that never answered are moments;
 * a `400` (the reference will not dereference) and a `403` (the credential may
 * not) are the store's settled view of that parameter until something changes.
 * Deliberately WIDER than `isRetryableStatus`, and the difference is the point:
 * that partition decides what is worth trying AGAIN, this one decides what is
 * worth REMEMBERING. A `501` is not worth a retry — the server will not start
 * implementing it in 400ms — but it is equally not the store's settled view of
 * that parameter, so caching it would answer a later read with an outage that
 * had already passed.
 */
function isTransient(err: unknown): boolean {
  const status = statusOf(err);
  return status === undefined || status === 429 || status >= 500;
}

/**
 * Why one `:render` failed, in a form safe to print.
 *
 * `errorSummary` is the base and it is the whole defence: a `ParameterStoreError`
 * is method + resource with the query and `:verb` stripped, so its message is
 * known value-free and passes through, and anything else is reduced to its class
 * name — a `SyntaxError` from a malformed response body embeds a window of that
 * body, and on THIS path the body is the dereferenced secret.
 *
 * What this function adds is per-surface SHAPING on top of that base, never a
 * second derivation of the string. The 400 is called out by name because it is
 * the one an operator can act on: Parameter Manager refuses to dereference a
 * payload whose rendered value carries a quote, a brace or a newline, which is
 * every structural credential.
 */
function renderFailureReason(err: unknown): string {
  if (err instanceof ParameterStoreError) {
    return err.status === 400
      ? `Parameter Manager refused to dereference this parameter (${err.message}). ` +
          `A rendered value carrying a quote, a brace or a newline — a service-account ` +
          `key, a PEM — is the known cause.`
      : err.message;
  }
  return errorSummary(err);
}

/** Parse an admin service-account key; report malformed keys by shape, not content. */
export function parseAdminAccount(raw: string | undefined): {
  account: ServiceAccount | null;
  reason?: string;
} {
  return parseServiceAccount(raw);
}
