import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ParameterManagerReadClient,
  type ParametersReader,
} from "./parameter-manager.js";
import { loadConfig, type SecretsConfig, type SecretsStore } from "./config.js";
import { registerTools } from "./tools.js";
import {
  NO_CAPABILITIES,
  probeCapabilities,
  type Capabilities,
  type CapabilityLookup,
} from "./capabilities.js";
import { createWriteClient, type ParametersWriter } from "./write-client.js";
import type { GatewayRefresh } from "./tools.js";

export interface CreateMCPServerOptions {
  version: string;
  /** Injected in tests; production reads the environment. */
  config?: SecretsConfig;
  readerFactory?: (store: SecretsStore) => ParametersReader;
  /**
   * How to make the strad gateway re-read the store now.
   *
   * Supplied by the bundle host, which is the process that can reach core
   * (`STRAD_CORE_URL` + `STRAD_INTERNAL_TOKEN`); this tree cannot. Absent
   * means the `refresh_gateway` tool is not offered and a write's result says
   * the gateway will pick the value up within its TTL — never that it did.
   */
  refreshGateway?: GatewayRefresh;
  /**
   * Test seam: override the capability probe, PER PROJECT. Production asks
   * Google once per store, on the first listing that needs an answer, and keeps
   * each ANSWER for the lifetime of the factory — an IAM grant does not change
   * mid-request, and the tool LIST must be stable within a session or a client's
   * cached listing goes stale in a confusing way. A probe that never reached
   * Google is not an answer and is not kept; see UNANSWERED_CAPABILITY_TTL_MS.
   */
  capabilities?: CapabilityLookup;
  writerFactory?: (store: SecretsStore) => ParametersWriter;
}

/**
 * How long an answer that is NOT an observation is remembered before the next
 * caller re-asks.
 *
 * `probed: true` is the only thing that means "Google answered". Everything else
 * — a token mint that never completed, a `testIamPermissions` that did not come
 * back, a store with no credential yet — is an ABSENCE of an answer, and an
 * absence must not be remembered for the life of the container. It was: one
 * transient mint failure at the first listing pinned a production store to
 * `NO_CAPABILITIES` for the whole process, with `list_parameters` working
 * perfectly on the same container and the only cure a redeploy
 * (tadasant/strad#270).
 *
 * FIFTEEN SECONDS IS THE CONSOLE'S NUMBER, deliberately. `cachedProbe` in
 * src/secrets/parameters/capabilities.ts has drawn this distinction since it was
 * written — a probed answer for five minutes, an unprobed one for fifteen
 * seconds, "because a network blip is not an answer" — and it is the same probe
 * about the same credential. The two doors disagreeing on how long a blip counts
 * is the defect, not a tuning question, so this is the same bound rather than a
 * new one.
 *
 * The bound is also the cost ceiling under a sustained outage: one mint plus one
 * round trip per store per fifteen seconds, not one per request. Zero would be
 * the regression this memo exists to prevent; Infinity was the bug.
 */
const UNANSWERED_CAPABILITY_TTL_MS = 15_000;

/**
 * How long ONE caller waits on a probe before it is treated as unanswered.
 *
 * The probe's two legs are bounded differently and one of them is not bounded at
 * all: `probeCapabilities` aborts the `testIamPermissions` fetch after ten
 * seconds, but the token mint underneath it passes no signal, so a connection
 * that hangs rather than fails hangs for as long as the socket does. Every
 * concurrent listing shares that one promise — which is right when it settles
 * and is a stall when it does not.
 *
 * Six seconds, because the number this has to stay under is the gateway's
 * reachability timeout (`DEFAULT_TIMEOUT_MS`, ten seconds): a `tools/list` that
 * outlives it makes the `secrets` slug read as UNREACHABLE on `/healthz`, which
 * is a different and less true statement than "this store's capabilities are
 * unknown". A healthy probe answers in well under a second, so this is only ever
 * reached by something that is already broken.
 *
 * The probe is abandoned rather than cancelled — its own abort still fires — and
 * the answer it eventually produces is dropped. That costs one round trip;
 * holding callers open for a stalled mint costs the listing.
 */
const PROBE_DEADLINE_MS = 6_000;

/**
 * Fail closed on time. Resolves to `NO_CAPABILITIES` if the probe has not
 * answered by the deadline, which — being unprobed — is memoised only for
 * UNANSWERED_CAPABILITY_TTL_MS.
 */
function withDeadline(
  answer: Promise<Capabilities>,
  project: string,
): Promise<Capabilities> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Capabilities>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ...NO_CAPABILITIES,
        reason:
          `the capability probe for "${project}" did not answer within ` +
          `${PROBE_DEADLINE_MS / 1000}s`,
      });
    }, PROBE_DEADLINE_MS);
    // A pending probe must not be the reason a process refuses to exit.
    timer.unref?.();
  });
  return Promise.race([answer, deadline]).finally(() => clearTimeout(timer));
}

/** A memoised capability answer, and when to stop believing it. */
interface ProbeMemo {
  answer: Promise<Capabilities>;
  /**
   * Epoch ms after which the next caller re-asks. `Infinity` while the probe is
   * still in flight — so concurrent callers share ONE round trip rather than
   * stampeding Google — and `Infinity` once it comes back `probed: true`, which
   * is the case the memo was always right about.
   */
  expiresAt: number;
}

/**
 * The factory, in the shape every server in this repo uses: `{ server,
 * registerHandlers }`, so the collapsed bundle host can mount it exactly like
 * the others.
 *
 * Credentials are read LAZILY, at registerHandlers time, because the image ships
 * none — strad injects them onto the component at deploy time.
 *
 * NOTHING IS SHARED BETWEEN TWO STORES. Each store gets its own read client, its
 * own write client and its own probe, keyed by project id — the same key the
 * console has used since it went multi-store (`capabilitiesFor` in
 * src/ui/index.ts). A cache keyed any less specifically would be the collapse
 * itself: one store's answer served for another's project.
 */
export function createMCPServer(options: CreateMCPServerOptions) {
  const server = new Server(
    { name: "secrets-mcp-server", version: options.version },
    { capabilities: { tools: {} } },
  );

  // Process-lifetime memos, and they have to live OUT here.
  //
  // The bundle host serves this mount statelessly: a fresh `Server` and a fresh
  // `registerHandlers` call PER HTTP REQUEST. Anything declared inside that
  // function is therefore per-request, and a memo that is per-request is not a
  // memo — it is a round trip to Google (an OAuth token mint plus
  // `projects:testIamPermissions`) added to every single `tools/list`, which is
  // what made this mount's listing several times slower than its peers'.
  //
  // Keyed by PROJECT ID, all three. Two stores are two projects, two
  // credentials, two capabilities and two clients; the key is what keeps them
  // apart.
  const probed = new Map<string, ProbeMemo>();
  const writers = new Map<string, ParametersWriter>();
  const readers = new Map<string, ParametersReader>();
  /** The last probe fault logged per project — see the `console.error` below. */
  const loggedFault = new Map<string, string>();

  const registerHandlers = async (
    target: Server,
    readerFactory?: (store: SecretsStore) => ParametersReader,
  ): Promise<void> => {
    const config = options.config ?? loadConfig();

    const factory =
      readerFactory ??
      options.readerFactory ??
      ((store: SecretsStore): ParametersReader => {
        if (!store.account) {
          throw new Error(
            `${store.viewerKeyVar} is not configured; this server cannot list ` +
              `parameters in "${store.project}" without a (viewer) credential.`,
          );
        }
        const held = readers.get(store.project);
        if (held) return held;
        const client = new ParameterManagerReadClient({
          projectId: store.project,
          account: store.account,
          apiBase: config.apiBase,
          tokenUrl: config.tokenUrl,
        });
        readers.set(store.project, client);
        return client;
      });

    // ONE PROBE PER STORE per process — for as long as there is an ANSWER to
    // memoise. A completed probe is a property of one credential on one project,
    // and re-asking on every tools/list would add a round trip per store to
    // every listing for a value that changes when a human edits IAM. A revoked
    // permission still fails closed at Google.
    //
    // That reasoning covers a probe that REACHED Google. It does not cover one
    // that never did, and the memo used to cache both identically, so a single
    // failed token mint was remembered as the permanent answer. So the lifetime
    // now follows `probed`, exactly as the console's `cachedProbe` already made
    // it: an observation is kept, an absence expires after
    // UNANSWERED_CAPABILITY_TTL_MS and the next caller asks again. Fail-closed
    // is untouched — an unanswered probe still yields NO_CAPABILITIES for the
    // call it was made on; it just stops being the last word.
    //
    // The cost is that this mount's tool LIST can widen mid-session, when a
    // store that could not be reached at boot is reached moments later. That is
    // the recovery, not a regression: the narrow listing was the wrong answer,
    // and every handler re-checks the capability per call anyway.
    //
    // A project this server does not front never reaches here — tools.ts asks
    // only about a store it resolved a path to — but the lookup fails closed on
    // one anyway, because a capability question with no answer must not read as
    // a yes.
    const capabilities: CapabilityLookup =
      options.capabilities ??
      ((project: string) => {
        const store = config.stores.find((s) => s.project === project);
        if (!store) {
          return Promise.resolve({
            ...NO_CAPABILITIES,
            reason: `"${project}" is not a store this server fronts`,
          });
        }
        const held = probed.get(project);
        if (held && Date.now() < held.expiresAt) return held.answer;

        const memo: ProbeMemo = {
          expiresAt: Number.POSITIVE_INFINITY,
          answer: store.account
            ? withDeadline(
                probeCapabilities({
                  projectId: store.project,
                  account: store.account,
                  tokenUrl: config.tokenUrl,
                }),
                project,
              )
            : Promise.resolve({
                ...NO_CAPABILITIES,
                reason: `no credential is configured for "${project}" (${store.viewerKeyVar} is unset)`,
              }),
        };
        probed.set(project, memo);
        void memo.answer.then(
          (caps) => {
            if (caps.probed) {
              loggedFault.delete(project);
              return;
            }
            memo.expiresAt = Date.now() + UNANSWERED_CAPABILITY_TTL_MS;
            // The degraded state nothing used to say out loud. On stderr, which
            // is where the bundle host's own lines go; stdout belongs to any
            // client that mounts this tree over a stdio transport.
            //
            // ON THE TRANSITION, not on every retry. A store whose probe fails
            // deterministically — Cloud Resource Manager not enabled on the
            // project, a revoked key — fails every fifteen seconds for the life
            // of the container, and a line each time is 5,000 a day saying one
            // thing. So: the first failure, and any CHANGE of reason, which is
            // the news. A store with no credential says nothing at all; that is
            // a config fact rather than a fault.
            const reason = caps.reason ?? "no reason given";
            if (store.account && loggedFault.get(project) !== reason) {
              loggedFault.set(project, reason);
              console.error(
                `[secrets] capability probe for "${project}" did not complete ` +
                  `(${reason}); failing closed, re-asking in ` +
                  `${UNANSWERED_CAPABILITY_TTL_MS / 1000}s`,
              );
            }
          },
          // probeCapabilities does not throw, and the branch above cannot. A
          // rejection here would therefore be a bug, and a bug must not be the
          // cached answer either: drop it and let the next call re-ask. The
          // rejection still reaches the caller, which fails closed on it.
          () => {
            memo.expiresAt = 0;
          },
        );
        return memo.answer;
      });

    // The mutating client is built LAZILY and only ever reached through that
    // store's capability check in tools.ts. Constructing it is not the
    // permission; the probe is — and the probe it must pass is the one for THIS
    // store's project.
    const writerFactory =
      options.writerFactory ??
      ((store: SecretsStore): ParametersWriter => {
        if (!store.account) {
          throw new Error(
            `no credential is configured for "${store.project}" (${store.viewerKeyVar} is unset)`,
          );
        }
        const held = writers.get(store.project);
        if (held) return held;
        const client = createWriteClient({
          projectId: store.project,
          account: store.account,
          pmApiBase: config.apiBase,
          tokenUrl: config.tokenUrl,
        });
        writers.set(store.project, client);
        return client;
      });

    registerTools(target, {
      config,
      reader: factory,
      capabilities,
      writer: writerFactory,
      refreshGateway: options.refreshGateway,
    });
  };

  return { server, registerHandlers };
}
