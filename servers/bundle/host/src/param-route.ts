// GENERATED — DO NOT EDIT.
// Vendored from src/secrets/param-route.ts by `npm run paramroute:sync`.
// Edit the source, run the sync, and commit both. CI fails if these drift.
/**
 * The parameter WRITE-BACK wire: how a hosted server persists a credential that
 * rotated under it, and reads the current one back at boot.
 *
 * ## The problem this exists for
 *
 * A credential that rotates ON USE cannot run durably on strad without it. X's
 * OAuth 2.0 refresh tokens are the shape: every refresh returns a new token and
 * kills the one just used. The process rotates in memory, the container
 * restarts, and it comes back holding the value the deploy baked — which the
 * upstream invalidated hours ago. Nothing is broken until the restart, and then
 * everything is, permanently, until a human re-seeds by hand.
 *
 * ## Why it is a ROUTE and not a credential
 *
 * The obvious fix — give the container something that can write the store — is
 * the one thing the deployment's whole shape refuses. A supplementary image
 * holds no cloud credential by design (`STRAD_IMAGE_ONLY_SECRET_KEYS` in
 * src/deploy/appspec.ts keeps the resolver key off every one of them), and the
 * viewer/admin/resolver split exists to keep the container answering `/mcp` weak.
 * Handing it `secretmanager.versions.add` — even scoped to one secret — adds a
 * fourth credential class to exactly the box the split is built around.
 *
 * So the write goes through CORE, which already holds the store-admin credential
 * (`SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON`, `consoleEnv:`, core-only) and
 * already owns a write path that does the hard parts right: `store.rotate()`
 * applies the base64url envelope and preserves the per-parameter
 * `secretAccessor` grant. No new credential, no new IAM, no new encoding path.
 *
 * ## The direction is the new thing
 *
 * Every authenticated call before this one is core → bundle (`internalHeaders`,
 * gateway/registry.ts). This is the first bundle → core call, so the bundle
 * needs core's private URL in its environment — `CORE_URL_ENV` below, bound to
 * `${core.PRIVATE_URL}` by appspec.ts. The credential is the shared
 * `STRAD_INTERNAL_TOKEN`, which the bundle already holds
 * (`BUNDLE_BOOT_ENV_KEYS`), authorised with the same `authorizePresence`
 * comparator the presence route uses.
 *
 * ## What a caller can reach, and why it is not an oracle
 *
 * The URL names a slug and a variable. NEITHER STRING IS TRUSTED. Core looks the
 * pair up in that server's `paramsWritable:` allowlist and builds the store path
 * out of the CONFIG's own slug and the CONFIG's own variable name — the request's
 * bytes are used for one thing, an equality test. A caller cannot address a path
 * no config names, so this cannot become a write-anything-anywhere oracle however
 * the URL is spelled. That is the same structural defence
 * `gateway/bundle-presence.ts` documents for the read side, in the other
 * direction.
 *
 * The GET discloses only values that component already holds: `paramsWritable`
 * requires `params: true`, and `params: true` bakes the whole namespace onto that
 * component at render time. What the GET adds is FRESHNESS — the value as of now
 * rather than as of the last deploy — which is precisely the race it exists to
 * close.
 *
 * This file is VENDORED into the bundle host tree (`npm run paramroute:sync`,
 * `test/param-route.sync.test.ts`), so it must stay import-free. It carries BOTH
 * ends — the shapes core validates AND the client the host calls with — for the
 * same reason presence.ts carries both the request parser and the report
 * builder: the half that lives only in the tree with no test runner is the half
 * that is never exercised. Here, `createParamClient` is what decides that an
 * unreachable core degrades to the baked environment rather than failing a boot,
 * and that decision is too load-bearing to sit somewhere nothing can drive it.
 */

/** The route prefix. A slug and a variable follow: `/_strad/params/{slug}/{VAR}`. */
export const PARAM_ROUTE_PREFIX = "/_strad/params";

/**
 * The wire version, echoed on every response.
 *
 * A reader that finds an unfamiliar protocol treats the answer as ABSENT rather
 * than guessing — which for the boot read means falling back to the baked env,
 * the value that at least used to work.
 */
export const PARAM_PROTOCOL = 1;

/**
 * The env var App Platform binds `${core.PRIVATE_URL}` into, on every component
 * that is not core.
 *
 * Named for the direction it enables rather than for core, so it reads as the
 * mirror of `STRAD_BUNDLE_URL_*` (gateway/registry.ts) that it is.
 */
export const CORE_URL_ENV = "STRAD_CORE_URL";

/** A legal environment-variable name. The same shape presence.ts checks. */
const VARIABLE_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A legal server slug: lowercase alphanumerics, single dashes between. */
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The largest value this route will carry, in UTF-16 code units.
 *
 * Parameter Manager's own payload ceiling is far higher; this is a sanity bound
 * on a body arriving over the private network, sized so every credential shape
 * strad manages (an OAuth token, a PEM key, a service-account JSON) fits with
 * room to spare and a runaway caller does not.
 */
export const MAX_PARAM_VALUE_LENGTH = 64 * 1024;

/** True when `variable` could name an environment variable at all. */
export function isParamVariable(variable: string): boolean {
  return VARIABLE_SHAPE.test(variable);
}

/** True when `slug` has the shape the config schema's SLUG allows. */
export function isParamSlug(slug: string): boolean {
  return SLUG_SHAPE.test(slug);
}

/**
 * The path for one server's one variable.
 *
 * Both segments are percent-encoded. They are already constrained to shapes that
 * need no encoding, which is exactly why encoding them anyway is cheap: it means
 * a future slug alphabet cannot silently turn a path segment into two.
 */
export function paramRoutePath(slug: string, variable: string): string {
  return `${PARAM_ROUTE_PREFIX}/${encodeURIComponent(slug)}/${encodeURIComponent(variable)}`;
}

export interface ParamWriteRequest {
  /** The rotated value to store. */
  value: string;
}

export interface ParamReadResponse {
  protocol: number;
  /** The parameter's current value. */
  value: string;
}

export type ParamParse<T> =
  ({ ok: true } & T) | { ok: false; status: number; error: string };

/**
 * Validate a write body.
 *
 * The offending body is never echoed. This carries a credential, so a 400 that
 * quoted what it received would put one in core's logs — the failure mode
 * `parsePresenceRequest` refuses for the same reason, one direction over.
 */
export function parseParamWriteRequest(
  body: unknown,
): ParamParse<{ value: string }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be a JSON object" };
  }
  const value = (body as { value?: unknown }).value;
  if (typeof value !== "string") {
    return { ok: false, status: 400, error: "value must be a string" };
  }
  if (value === "") {
    // An empty write is never a rotation, and storing one would replace a
    // working credential with nothing — the exact outcome this path exists to
    // prevent, arrived at from the other side.
    return { ok: false, status: 400, error: "value must not be empty" };
  }
  if (value.length > MAX_PARAM_VALUE_LENGTH) {
    return { ok: false, status: 413, error: "value is too large" };
  }
  return { ok: true, value };
}

/**
 * Validate a read response, from the CALLER's side.
 *
 * A malformed answer is not trusted into a boot: the caller's fallback is the
 * baked environment, which is a value that at least used to work, and taking a
 * garbled one over it would trade a stale credential for a nonsense one.
 */
export function parseParamReadResponse(
  body: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "response is not an object" };
  }
  const { protocol, value } = body as Partial<ParamReadResponse>;
  if (protocol !== PARAM_PROTOCOL) {
    return {
      ok: false,
      error: `unsupported parameter protocol: ${JSON.stringify(String(protocol))}`,
    };
  }
  if (typeof value !== "string" || value === "") {
    return { ok: false, error: "response carried no value" };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// The CALLER's end
// ---------------------------------------------------------------------------

/**
 * One server's handle on its own writable parameters.
 *
 * The asymmetry between the two methods is the whole contract, and it is not an
 * accident of implementation:
 *
 *   `get()` NEVER THROWS. Its caller is a boot path, and the right answer when
 *   core is unreachable, unconfigured, or answering nonsense is the value the
 *   deploy baked — a credential that at least used to work. A boot that failed
 *   because the store blinked would turn a degraded dependency into an outage.
 *
 *   `put()` ALWAYS THROWS ON FAILURE. A swallowed write is the worst outcome
 *   available here: everything keeps working until the next restart, and then
 *   nothing does, with nothing anywhere pointing at when it broke. The caller
 *   catches it, marks its mount degraded, and logs.
 */
export interface ParamClient {
  /** The current value, or undefined if it could not be read. Never throws. */
  get(variable: string): Promise<string | undefined>;
  /** Persist a rotated value. Throws if it did not land. */
  put(variable: string, value: string): Promise<void>;
}

export interface ParamClientOptions {
  /** The strad slug whose namespace this client addresses. */
  slug: string;
  /** Core's private URL — `CORE_URL_ENV`. Absent means "not configured". */
  baseUrl: string | undefined;
  /** The shared `STRAD_INTERNAL_TOKEN`. Absent means "not configured". */
  token: string | undefined;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * How long either call may take.
   *
   * Bounded because the read is on a boot path and core may be mid-deploy. Five
   * seconds is comfortably more than a private-network round trip through a
   * parameter store and comfortably less than a container that looks hung.
   */
  timeoutMs?: number;
  /**
   * Where the soft outcomes go. The host routes this to its own logger.
   *
   * `get()` reports through this rather than throwing, so every reason it
   * returned undefined is on the record even though none of them is a fault.
   */
  note?: (level: "info" | "warn", message: string) => void;
}

export function createParamClient(opts: ParamClientOptions): ParamClient {
  const base = (opts.baseUrl ?? "").replace(/\/$/, "");
  const token = opts.token ?? "";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const note = opts.note ?? (() => {});

  /**
   * Why "unconfigured" is a plain absence rather than an error at construction.
   *
   * Most deployments of an image run no server with `paramsWritable:`, and for
   * them these two variables are meaningfully unset. A handle that threw when it
   * was built would make an optional capability a boot requirement; reporting it
   * per call keeps the read soft and the write loud, which is the split above.
   */
  const unconfigured = (): string | null => {
    if (!base) return `${CORE_URL_ENV} is not set`;
    if (!token) return "STRAD_INTERNAL_TOKEN is not set";
    return null;
  };

  const call = (variable: string, init: RequestInit): Promise<Response> =>
    fetchImpl(`${base}${paramRoutePath(opts.slug, variable)}`, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

  const baked = "using the value this container was deployed with";

  return {
    async get(variable) {
      const why = unconfigured();
      if (why) {
        note("info", `not reading ${variable} from core (${why}); ${baked}`);
        return undefined;
      }
      try {
        const res = await call(variable, { method: "GET" });
        if (!res.ok) {
          // TWO STATUSES ARE THE NORMAL CASE, not faults, and warning on either
          // would cry wolf on every cold start of every container.
          //
          //   404 — the parameter exists in no store yet: every deployment
          //         before its first rotation.
          //   403 — this deployment does not list the name under
          //         `paramsWritable:`. The read is unconditional (the container
          //         cannot see strad's config), so the overwhelmingly common
          //         answer, on every image that ships this mount and every
          //         deployment that has not opted in, is exactly this.
          //
          // Anything else is a fault worth saying out loud.
          const expected = res.status === 404 || res.status === 403;
          note(
            expected ? "info" : "warn",
            `core has no current ${variable} for this deployment ` +
              `(HTTP ${res.status}); ${baked}`,
          );
          return undefined;
        }
        const parsed = parseParamReadResponse(await res.json());
        if (!parsed.ok) {
          note(
            "warn",
            `core's answer for ${variable} was not usable (${parsed.error}); ${baked}`,
          );
          return undefined;
        }
        note("info", `read the current ${variable} from the parameter store`);
        return parsed.value;
      } catch (err) {
        note(
          "warn",
          `could not read ${variable} from core ` +
            `(${err instanceof Error ? err.message : String(err)}); ${baked}`,
        );
        return undefined;
      }
    },

    async put(variable, value) {
      const why = unconfigured();
      // Thrown, not noted and swallowed: the caller is about to lose a
      // single-use credential and has to know that it did.
      if (why) throw new Error(`cannot persist ${variable}: ${why}`);

      const res = await call(variable, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value } satisfies ParamWriteRequest),
      });
      if (!res.ok) {
        // The status, and core's own short error word when it sent one. Never
        // the body verbatim and never the value — this string ends up in a log
        // line and on a /healthz page.
        let detail = "";
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string") detail = `: ${body.error}`;
        } catch {
          // A non-JSON body from something in the middle. The status is the fact.
        }
        throw new Error(`core refused the write (HTTP ${res.status}${detail})`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// RUNTIME REFRESH — the same wire, on an interval instead of once
// ---------------------------------------------------------------------------

/**
 * ## Why this is here and not a fourth credential
 *
 * `params: true` on a `supplementary-image` server is the ONE credential path in
 * strad that is still deploy-time. The other three resolve at runtime already: a
 * gateway `${NAME}` within `gateway.secrets.ttlSeconds`, a `builtin`'s `params:`
 * per tool call (gateway/registry.ts), an unhosted server's `${NAME}` per
 * request. A supplementary image's parameters are resolved by `render-spec` and
 * baked onto the component as SECRET env vars, and process environment is fixed
 * at spawn — so rotating the token behind such a slug meant redeploying the
 * fleet by hand.
 *
 * The fix reuses the wire above rather than adding anything. `get()` already
 * reads the CURRENT value of one of a server's own parameters through core, and
 * `loadXTwitter` already calls it once at mount time for exactly this reason.
 * All that is new is calling it again, on a bounded interval, for the variables
 * a config listed under `paramsRefresh:`.
 *
 * ## What bounds it: the plan, which comes from the config
 *
 * The plan is the list of names the CONFIG listed under `paramsRefresh:`, handed
 * over in `STRAD_PARAM_REFRESH` by the renderer. Nothing here enumerates a
 * namespace and nothing here asks core what exists, so a parameter created under
 * a slug that nobody listed changes nothing until the next deploy. The rendered
 * spec still names every variable this component may ever hold; what is no
 * longer pinned by it is the value, and the value moves toward the store, which
 * is where the render read it from in the first place.
 *
 * ## The cost, stated
 *
 * One store read per listed variable per component per interval, paid whether or
 * not anybody is using the credential. That is the reason this polls instead of
 * resolving per request the way a builtin does: a poll's cost is a constant, and
 * Parameter Manager has already 429'd three consecutive production deploys.
 * `MIN_PARAM_REFRESH_SECONDS` is the floor under it.
 */

/**
 * The env var naming which slugs re-read which variables: `{"slug":["NAME",…]}`.
 *
 * GENERAL, not SECRET — it holds names, exactly like `STRAD_PARAM_KEYS` beside
 * it. What is secret is the values, and none are here.
 */
export const PARAM_REFRESH_ENV = "STRAD_PARAM_REFRESH";

/** How often to re-read, in seconds. GENERAL: a number. */
export const PARAM_REFRESH_SECONDS_ENV = "STRAD_PARAM_REFRESH_SECONDS";

/**
 * The floor, restated here as well as in the config schema.
 *
 * Two copies on purpose. The schema's copy refuses the config; this one refuses
 * the ENVIRONMENT, which a component can be given by something other than this
 * renderer. A reader that trusted the variable could be talked down to one
 * second by a spec edit nothing in this repo produced.
 */
export const MIN_PARAM_REFRESH_SECONDS = 30;

/** What the schema defaults to, used when the variable is absent or unusable. */
export const DEFAULT_PARAM_REFRESH_SECONDS = 300;

/** One server's refreshable variables. */
export interface ParamRefreshTarget {
  slug: string;
  variables: string[];
}

/**
 * Read the plan out of an environment. Never throws: a component with no plan,
 * a malformed one, or one written by a renderer this image does not know
 * refreshes nothing and keeps the values the deploy baked.
 */
export function parseParamRefreshPlan(
  env: Readonly<Record<string, string | undefined>>,
): ParamRefreshTarget[] {
  const raw = env[PARAM_REFRESH_ENV];
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  const plan: ParamRefreshTarget[] = [];
  for (const [slug, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    // Both shapes are checked because this string arrives from the environment,
    // not from the config: the config's own validation happened in another
    // process, on another machine, at another time.
    if (!isParamSlug(slug)) continue;
    if (!Array.isArray(value)) continue;
    const variables = value.filter(
      (v): v is string => typeof v === "string" && isParamVariable(v),
    );
    if (variables.length > 0) plan.push({ slug, variables });
  }
  return plan.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The interval to poll on, clamped to the floor. */
export function paramRefreshSeconds(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env[PARAM_REFRESH_SECONDS_ENV];
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_PARAM_REFRESH_SECONDS;
  return Math.max(MIN_PARAM_REFRESH_SECONDS, Math.floor(parsed));
}

export interface ParamRefreshOptions {
  /** What to re-read. Usually {@link parseParamRefreshPlan} of the environment. */
  plan: readonly ParamRefreshTarget[];
  /** One store handle per slug. The host binds these to its own environment. */
  clientFor: (slug: string) => ParamClient;
  /** The environment to WRITE INTO — `process.env` in the container. */
  env: Record<string, string | undefined>;
  /**
   * What one (slug, variable) is CALLED on this box.
   *
   * Passed in rather than computed here because the answer lives in
   * env-prefix.ts, which is a different vendored module, and this file must stay
   * import-free. The host passes the bare name AND `<SLUG>__<NAME>`: the bare
   * one is what the renderer wrote for a parameter, and the per-slug alias is
   * what a tree reading through `slugEnvView` would see instead. Writing both is
   * what stops a refresh from landing on a name nothing reads — the alias is
   * slug-scoped, so it can only ever be this server's own.
   */
  names: (slug: string, variable: string) => string[];
  /** Called once per variable whose value actually MOVED. Never given the value. */
  onChange?: (slug: string, variable: string) => void;
  /** Soft outcomes. `get()` already reports its own; this adds the applying. */
  note?: (level: "info" | "warn", message: string) => void;
}

/**
 * One pass over the plan. Returns the variables whose value changed.
 *
 * NEVER THROWS, and never partially fails a pass: each variable is independent,
 * and `get()` already returns undefined rather than throwing for every reason a
 * read can fail. An unreachable core means this pass changes nothing and the
 * container keeps serving with what it has, which is the same posture the boot
 * read takes.
 *
 * A value that has not moved is not rewritten and not reported. That is what
 * makes the change log an actual record of rotations rather than a heartbeat.
 */
export async function refreshParamsOnce(
  opts: ParamRefreshOptions,
): Promise<{ slug: string; variable: string }[]> {
  const changed: { slug: string; variable: string }[] = [];
  for (const target of opts.plan) {
    const client = opts.clientFor(target.slug);
    for (const variable of target.variables) {
      let value: string | undefined;
      try {
        value = await client.get(variable);
      } catch (err) {
        // `get()` promises not to throw, but it is an interface and this is a
        // background loop: one implementation breaking that promise must not
        // stop the OTHER servers on this component from refreshing.
        opts.note?.(
          "warn",
          `${target.slug}: reading ${variable} threw ` +
            `(${err instanceof Error ? err.message : String(err)}); ` +
            `keeping the value this container already holds`,
        );
        continue;
      }
      if (value === undefined) continue;

      const names = opts.names(target.slug, variable);
      // The bare name is the one the renderer wrote a parameter under, so it is
      // the one that decides whether this is a change at all. The aliases follow
      // it rather than voting on it.
      const before = opts.env[names[0] ?? variable];
      if (before === value) continue;
      for (const name of names) opts.env[name] = value;
      changed.push({ slug: target.slug, variable });
      opts.onChange?.(target.slug, variable);
    }
  }
  return changed;
}
