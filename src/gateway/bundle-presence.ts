import { isEnvName } from "../config/env-name.ts";
import { isUnhosted } from "../config/schema.ts";
import type { ServerConfig, StradConfig } from "../config/schema.ts";
import { refsIn } from "../secrets/provider/resolve.ts";
import {
  isPresence,
  reasonFor,
  PRESENCE_PROTOCOL,
  PRESENCE_ROUTE,
  type Presence,
  type PresenceReport,
  type PresenceVerdict,
} from "../secrets/presence.ts";
import { bundleUrlEnvName, internalHeaders } from "./registry.ts";

/**
 * Ask every bundle what it actually holds.
 *
 * This is the core half of `src/http/presence.ts`. It exists so the console can
 * make a POSITIVE claim about a secret that lives on a component core is not:
 * "plumbed, via env, on `bundle`, in a process that booted at 09:12" instead of
 * "this could not be checked from the console".
 *
 * ## Three things it will not do
 *
 * **It does not ask about a name core did not already know.** The key roster is
 * derived from the config core is running — `env:` maps, plus whatever the
 * component itself reports under `STRAD_PARAM_KEYS`. There is no path from a
 * request parameter to a probed name, so no caller can turn `/ui` or
 * `/api/secrets/readiness` into "tell me whether SECRET_X exists". That is the
 * oracle this feature had to avoid becoming, and the defence is structural
 * rather than a filter.
 *
 * **It does not fail the page.** A bundle that is down, slow, or running an
 * image that predates this route leaves its rows exactly as honest as they were
 * before: not observed. `unreachable` and `unsupported` are distinct outcomes
 * because they call for different actions — one is an outage, the other is a
 * pin bump.
 *
 * **It does not trust a malformed answer.** A response whose `protocol` is not
 * one this build understands, or whose verdicts are not the five words, is
 * discarded whole. Half-parsing a status report produces a confident answer
 * about a question nobody asked.
 */

export type BundleProbeOutcome =
  /** The component answered and its verdicts are usable. */
  | { kind: "ok"; report: PresenceReport }
  /** No private URL bound for it: this deployment does not wire that component. */
  | { kind: "unwired" }
  /** It answered 404/405 — an image that predates the presence route. */
  | { kind: "unsupported"; detail: string }
  /** It could not be reached, or refused. */
  | { kind: "unreachable"; detail: string };

export interface BundlePresence {
  probes: Map<string, BundleProbeOutcome>;
}

/** Which component holds a given server's `env:`-delivered secrets. */
export function bundleOf(server: ServerConfig): string | null {
  // A server strad runs no container for holds no component env.
  if (isUnhosted(server)) return null;
  return server.bundle;
}

/**
 * The env KEYS a component is expected to hold, per bundle.
 *
 * KEYS, not `${NAME}` refs, and the difference is the whole reason this is a
 * separate function. `appspec.ts` bakes a supplementary server's `env:` map
 * filed under its declared KEY with the ref RESOLVED — the ref name is injected
 * nowhere. `env: { SLACK_BOT_TOKEN: "${SLACK_TOKEN}" }` puts a value under
 * `SLACK_BOT_TOKEN`, and probing for `SLACK_TOKEN` would report a healthy
 * deployment broken. This is the same mistake `src/ui/resolve.ts` carries the
 * scar from, one component over.
 */
export function expectedKeys(config: StradConfig): Map<string, Set<string>> {
  const byBundle = new Map<string, Set<string>>();
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    const keys = byBundle.get(server.bundle) ?? new Set<string>();
    for (const key of Object.keys(server.env)) keys.add(key);
    byBundle.set(server.bundle, keys);
  }
  return byBundle;
}

/**
 * `${NAME}` -> the KEYS it is delivered under, per bundle.
 *
 * One ref can land under several keys on several components (the capability
 * variants declare their credentials identically on purpose), so this is the
 * join the console needs to answer "is `${SLACK_TOKEN}` plumbed?" from a report
 * that only ever speaks in keys.
 */
export function refDelivery(
  config: StradConfig,
): Map<string, { bundle: string; key: string }[]> {
  const out = new Map<string, { bundle: string; key: string }[]>();
  for (const server of config.servers) {
    if (!server.enabled) continue;
    if (server.kind !== "supplementary-image") continue;
    for (const [key, value] of Object.entries(server.env)) {
      for (const name of refsIn(value)) {
        const list = out.get(name) ?? [];
        if (!list.some((d) => d.bundle === server.bundle && d.key === key)) {
          list.push({ bundle: server.bundle, key });
        }
        out.set(name, list);
      }
    }
  }
  return out;
}

export interface ProbeOptions {
  config: StradConfig;
  env: NodeJS.ProcessEnv;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-bundle deadline. One sick component must not hang the page. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Probe every bundle that holds a supplementary server, concurrently.
 *
 * Concurrent with a per-bundle deadline, for the reason `observe()` is: a
 * component that hangs costs this page `timeoutMs` once, not once per bundle.
 */
export async function probeBundles(
  opts: ProbeOptions,
): Promise<BundlePresence> {
  const keys = expectedKeys(opts.config);
  const probes = new Map<string, BundleProbeOutcome>();

  const results = await Promise.all(
    [...keys.entries()].map(async ([bundle, want]) => {
      const outcome = await probeBundle(bundle, [...want].sort(), opts);
      return [bundle, outcome] as const;
    }),
  );
  for (const [bundle, outcome] of results) probes.set(bundle, outcome);
  return { probes };
}

async function probeBundle(
  bundle: string,
  keys: string[],
  opts: ProbeOptions,
): Promise<BundleProbeOutcome> {
  const base = opts.env[bundleUrlEnvName(bundle)];
  if (!base) return { kind: "unwired" };

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const res = await doFetch(`${base.replace(/\/$/, "")}${PRESENCE_ROUTE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...internalHeaders(opts.env, bundle),
      },
      body: JSON.stringify({ keys }),
      signal: controller.signal,
    });

    if (res.status === 404 || res.status === 405) {
      return {
        kind: "unsupported",
        detail:
          `the component answered ${res.status} for ${PRESENCE_ROUTE}, so it is running an ` +
          `image that predates the presence route. Rebuild and repin that image to make ` +
          `its secrets checkable from here.`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        kind: "unreachable",
        detail:
          `the component REFUSED the internal token (${res.status}). That is a ` +
          `configuration fault rather than an outage: the component does not hold the ` +
          `token core derives for it from STRAD_INTERNAL_TOKEN — a render from a ` +
          `different root, or a component that holds none at all.`,
      };
    }
    if (!res.ok) {
      return {
        kind: "unreachable",
        // The status, not the body. A component's error body is the one piece of
        // text on this path that did not come from code promising to be
        // value-free, and it would land in a console sentence.
        detail: `the component answered ${res.status} for ${PRESENCE_ROUTE}.`,
      };
    }

    const body: unknown = await res.json();
    const report = validateReport(body);
    if (!report) {
      return {
        kind: "unreachable",
        detail:
          `the component answered ${PRESENCE_ROUTE} with a body this build does not ` +
          `understand (protocol ${PRESENCE_PROTOCOL} expected), so nothing in it was used.`,
      };
    }
    return { kind: "ok", report };
  } catch (err) {
    return {
      kind: "unreachable",
      // Class name only, for the same reason readiness.ts withholds a message:
      // this is the boundary where foreign text would enter the page.
      detail:
        err instanceof Error && err.name === "AbortError"
          ? `the component did not answer ${PRESENCE_ROUTE} within the deadline.`
          : `the component could not be reached at ${PRESENCE_ROUTE} (${
              err instanceof Error ? err.name : "unknown"
            }).`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Accept the answer, or none of it.
 *
 * Every field is checked because every field ends up as a claim on a page whose
 * entire premise is that its claims are earned. A verdict that is not one of the
 * five words is not "probably present".
 */
export function validateReport(body: unknown): PresenceReport | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  if (raw.protocol !== PRESENCE_PROTOCOL) return null;
  // Every string that survives this function is either matched against something
  // core already knows or bounded here. `component`, `image` and `bootedAt` are
  // rendered as PROSE on a provenance line, so they are charset-limited and
  // length-capped; `keys` and `paramKeys` must be env-var names, which they are
  // rendered as; and a verdict's `reason` is dropped entirely and re-derived
  // locally. They are escaped at render time too, so this is not about markup —
  // it is about a component being able to write a paragraph, or a megabyte, into
  // a row about some other server's secret. Bounded at the seam rather than
  // trusted because it arrived over the private network.
  if (!isLabel(raw.component)) return null;
  if (!isLabel(raw.bootedAt) || !isLabel(raw.observedAt)) return null;
  if (typeof raw.keys !== "object" || raw.keys === null) return null;

  // `__proto__` is an own property of a JSON.parse result, and assigning it on a
  // plain `{}` mutates the accumulator's prototype instead of adding a key.
  // Prototype-less accumulators make that shape inert rather than clever.
  const keys: Record<string, PresenceVerdict> = Object.create(null) as Record<
    string,
    PresenceVerdict
  >;
  for (const [key, value] of Object.entries(raw.keys)) {
    if (!isEnvName(key)) return null;
    if (typeof value !== "object" || value === null) return null;
    const verdict = value as Record<string, unknown>;
    if (!isPresence(verdict.presence)) return null;
    // The peer's `reason` is DROPPED, not validated. The five words are a closed
    // set and `reasonFor()` derives the sentence locally, so there is nothing a
    // peer's prose could add except the ability to write into a page that
    // promises to author its own copy. Same rule as the error-message boundary
    // in ui/secret-status.ts, one component further out.
    keys[key] = {
      presence: verdict.presence as Presence,
      reason: reasonFor(verdict.presence as Presence),
    };
  }

  let paramKeys: Record<string, string[]> | null = null;
  if (raw.paramKeys !== null && raw.paramKeys !== undefined) {
    if (typeof raw.paramKeys !== "object") return null;
    paramKeys = Object.create(null) as Record<string, string[]>;
    for (const [slug, value] of Object.entries(
      raw.paramKeys as Record<string, unknown>,
    )) {
      if (!Array.isArray(value)) return null;
      // Re-applied here rather than trusted: the vendored `parseParamKeys` checks
      // the same shape on the peer, and core must not assume the peer ran it.
      // These strings become `requirement.name` and are rendered as `${…}`.
      if (value.some((v) => typeof v !== "string" || !isEnvName(v))) {
        return null;
      }
      paramKeys[slug] = value as string[];
    }
  }

  return {
    protocol: PRESENCE_PROTOCOL,
    component: raw.component,
    // DEGRADED, not fatal. `image` is decoration on a provenance line, and a
    // component identifying itself by digest or by a full registry path is
    // plausible enough that discarding the whole report over it would silently
    // turn every row on that component back into a shrug — a total, invisible
    // loss of the feature over a cosmetic field.
    image: isLabel(raw.image) ? raw.image : null,
    bootedAt: raw.bootedAt,
    observedAt: raw.observedAt,
    keys,
    paramKeys,
  };
}

/**
 * A short, printable identifier: a component name, an image tag, a timestamp.
 *
 * Deliberately narrow — letters, digits, and the punctuation those three shapes
 * actually use. Anything a caller could use to write a sentence (a space, a
 * quote, a newline) is not in it, so a value that passes this cannot masquerade
 * as console copy no matter where it lands.
 */
function isLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:+-]+$/.test(value)
  );
}
