import {
  capabilitiesFromHeld,
  NO_CAPABILITIES,
  PROBE_PERMISSIONS,
  type Capabilities,
} from "./capability-table.ts";
import {
  mintAccessToken,
  ServiceAccountAuthError,
  SCOPE_CLOUD_PLATFORM,
  type FetchLike,
  type MintedToken,
  type ServiceAccount,
} from "./service-account.ts";
import { errorSummary } from "../../util/error-text.ts";

/**
 * The console's half of the capability probe: how the question is ASKED.
 *
 * What is asked, and what the answer means, is `./capability-table.ts` — the
 * module vendored into `servers/secrets/shared/src/capability-table.ts` so that
 * the `/mcp` door and this one derive their surfaces from one table and one
 * fold. This file is the transport around it, plus the memo the console needs
 * and the `/mcp` mount has its own version of.
 *
 * A feature flag says what a surface should OFFER. The probe says what the
 * identity behind it is PERMITTED. They are different questions and both are
 * needed: the flag is the product decision and the IAM grant is the boundary
 * that cannot be bypassed. Neither substitutes for the other, and where they
 * disagree the narrower one wins.
 *
 * The reason to probe rather than configure is that a flag can lie. A config
 * claiming write access on a read-only key produces a surface that lists a tool
 * and fails every call to it, with a Google 403 as the only explanation; a config
 * claiming read-only on a key that can in fact read secret values produces a
 * security property that exists in prose and not in IAM. A probe cannot drift,
 * because the thing it reports is the thing that will be enforced.
 *
 * `projects:testIamPermissions` on Cloud Resource Manager is the right call for
 * this: it takes arbitrary project-grantable permission strings and returns the
 * subset the caller holds. It is a QUERY, not an escalation — it reveals only
 * what this credential could already discover by trying the operation.
 *
 * WHEN THE PROBE CANNOT RUN we fail CLOSED but say so distinctly. "The store
 * denied this" and "I could not find out" want different words in front of a
 * human, and reporting the second as the first is how someone ends up widening
 * IAM to fix an unenabled API.
 */

export {
  capabilitiesFromHeld,
  NO_CAPABILITIES,
  PROBE_PERMISSIONS,
  type Capabilities,
};

export interface ProbeConfig {
  projectId: string;
  account: ServiceAccount;
  /** Test seams. Default to the real APIs. */
  crmApiBase?: string;
  tokenUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_CRM_BASE = "https://cloudresourcemanager.googleapis.com";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Ask Google which of `PROBE_PERMISSIONS` this credential holds on the project.
 *
 * Never throws. A probe is a capability question asked at startup or per page
 * render, and a store outage must not take the surface down — it must narrow it.
 */
export async function probeCapabilities(
  cfg: ProbeConfig,
): Promise<Capabilities> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = cfg.crmApiBase ?? DEFAULT_CRM_BASE;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wanted = Object.values(PROBE_PERMISSIONS);

  let token: MintedToken;
  try {
    token = await mintAccessToken(cfg.account, {
      scope: SCOPE_CLOUD_PLATFORM,
      tokenUrl: cfg.tokenUrl,
      fetchImpl,
    });
  } catch (err) {
    // A malformed or rejected key. Report the SHAPE — the key is the payload.
    return {
      ...NO_CAPABILITIES,
      reason: `could not mint an access token for this credential (${authReason(err)})`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(
      `${base}/v1/projects/${encodeURIComponent(cfg.projectId)}:testIamPermissions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ permissions: wanted }),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      return {
        ...NO_CAPABILITIES,
        reason:
          `projects:testIamPermissions returned ${res.status}. The Cloud Resource Manager API ` +
          `may not be enabled on "${cfg.projectId}", or this credential may lack any access to it.`,
      };
    }
    const body = (await res.json()) as { permissions?: string[] };
    // An empty body is Google's way of saying "none of them" — an answer, not a
    // failure, and prod's normal one.
    return capabilitiesFromHeld(new Set(body.permissions ?? []));
  } catch (err) {
    return {
      ...NO_CAPABILITIES,
      reason: `projects:testIamPermissions did not complete (${authReason(err)})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How long ONE caller waits on a probe before it is treated as unanswered.
 *
 * The probe's two legs are bounded separately and by their own callers'
 * numbers: `probeCapabilities` aborts the `testIamPermissions` fetch after
 * `DEFAULT_TIMEOUT_MS`, and it builds that AbortController AFTER the token mint
 * returns — which is covered by the ten-second default the mint itself carries
 * (`src/secrets/parameters/service-account.ts`). Added up they are a bound on
 * the probe; what they are not is a bound on how long a PAGE RENDER waits, which
 * is a different question with a different answer.
 *
 * SIX SECONDS IS THE /mcp DOOR'S NUMBER, deliberately. The `secrets` mount's
 * memo in `servers/secrets/shared/src/server.ts` already bounds the same probe
 * about the same credential at six, and two doors disagreeing on how long a
 * caller waits is a difference with no reason behind it. What the number has to
 * be under over there is the gateway's ten-second reachability timeout; what it
 * has to be under here is a human's patience with a page that has not painted.
 * Both are satisfied by six, and a healthy probe answers in well under a second,
 * so this is only ever reached by something already broken.
 *
 * The abandoned probe is CANCELLED, not merely dropped. Nothing of the probe's
 * own fires on the stalled-mint path this exists for, so an uncancelled request
 * would leave a socket per render parked until undici timed it out.
 * `ProbeConfig` takes a `fetchImpl`, so the deadline supplies one carrying a
 * signal of its own — a caller's choice about its own request, which leaves what
 * the probe MAKES of an answer alone.
 */
const PROBE_DEADLINE_MS = 6_000;

/**
 * A probe bounded by the deadline, in both directions: the caller stops waiting
 * and the request stops running.
 *
 * Resolves to `NO_CAPABILITIES` if no answer arrives in time — which is
 * `probed: false`, so the memo above keeps it for `failureTtlMs` and the next
 * caller asks again rather than inheriting the stall.
 */
function probeWithDeadline(
  cfg: ProbeConfig,
  deadlineMs: number,
): Promise<Capabilities> {
  const abandon = new AbortController();
  const underlying = cfg.fetchImpl ?? fetch;
  // Every fetch the probe makes joins this signal. The CRM leg passes one of its
  // own (`DEFAULT_TIMEOUT_MS`), so the two are combined rather than replaced.
  const fetchImpl: FetchLike = (input, init) =>
    underlying(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, abandon.signal])
        : abandon.signal,
    });

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<Capabilities>((resolve) => {
    timer = setTimeout(() => {
      abandon.abort();
      resolve({
        ...NO_CAPABILITIES,
        reason:
          `the capability probe for "${cfg.projectId}" did not answer within ` +
          `${deadlineMs / 1000}s`,
      });
    }, deadlineMs);
    // A pending probe must never be the reason the process refuses to exit.
    timer.unref?.();
  });

  return Promise.race([
    probeCapabilities({ ...cfg, fetchImpl }),
    deadline,
  ]).finally(() => clearTimeout(timer));
}

/**
 * The probe, MEMOISED with a TTL.
 *
 * An IAM grant changes on human timescales, and the probe costs a token mint
 * plus a round trip — doing it per page render would add latency to every view
 * for an answer that is stable for hours. The TTL bounds how long a REVOKED
 * permission keeps being offered; the operation itself still fails closed at
 * Google, so a stale `true` costs a legible error, not a leak.
 *
 * ## The in-flight entry is shared, and it always ends
 *
 * Concurrent renders join ONE probe rather than stampeding Google, and the entry
 * is cleared when that probe settles. Sharing a promise is only safe if the
 * promise settles, and a probe left to the deadlines its two legs carry
 * THEMSELVES settles in its own time rather than in this page's: the mint's
 * ten-second default and the CRM call's `DEFAULT_TIMEOUT_MS` are one caller's
 * bound each, and neither is the bound a render needs. An entry that inherited
 * them, cleared in `.finally()`, is one every later render of that store's page
 * joins for however long the slowest leg takes, unlogged and untimed by anything
 * the console chose. An UNBOUNDED leg is the worst version of it and the reason
 * this paragraph exists: a mint that never settles is an entry that is never
 * cleared, so every later render joins the same hanging promise for the life of
 * the process, with a redeploy the only cure — which is exactly what an operator
 * trying to rotate a credential through this console cannot reach for.
 *
 * So the entry holds a probe bounded by construction. The deadline is what makes
 * the memo's own claim true — an answer for `ttlMs`, a non-answer for
 * `failureTtlMs`, and never a pending promise for the life of the process.
 *
 * The deadline is SILENT here, deliberately, where the `/mcp` mount logs the
 * same fault to stderr: the console's caller is a human looking at the page it
 * renders, and the reason travels to them as the unverified-capability detail on
 * that page rather than into a log they would have to go and read.
 */
export function cachedProbe(
  cfg: ProbeConfig,
  ttlMs = 5 * 60_000,
  now: () => number = () => Date.now(),
  /**
   * A FAILED probe is cached far more briefly than a successful one. A grant
   * changes on human timescales, so five minutes is right for an answer; a
   * network blip is not an answer, and caching it that long would withhold
   * reveal long after the cause had passed.
   */
  failureTtlMs = 15_000,
  /** Test seam. See PROBE_DEADLINE_MS for why the default is what it is. */
  deadlineMs = PROBE_DEADLINE_MS,
): () => Promise<Capabilities> {
  let at = 0;
  let inFlight: Promise<Capabilities> | undefined;
  let value: Capabilities | undefined;

  return () => {
    const ttl = value?.probed === false ? failureTtlMs : ttlMs;
    if (value && now() - at < ttl) return Promise.resolve(value);
    // The `.then` hangs off the RACE, not off the probe, so an abandoned probe
    // that settles later cannot write itself over a fresher answer.
    inFlight ??= probeWithDeadline(cfg, deadlineMs)
      .then((caps) => {
        value = caps;
        at = now();
        return caps;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

/**
 * Why a probe did not finish, in a form safe to print.
 *
 * This reason is rendered to a human — `revealPosture()` puts it on the console
 * page — so `errorSummary` is the base (`src/util/error-text.ts`). Per-surface
 * shaping on top of it: a `ServiceAccountAuthError`'s message is strad's own,
 * built from a status and a status text, so it passes through where a class name
 * would say nothing. Everything else is reduced, because both calls here parse a
 * Google response body and one of those bodies carries the minted token.
 */
function authReason(err: unknown): string {
  return err instanceof ServiceAccountAuthError
    ? err.message
    : errorSummary(err);
}
