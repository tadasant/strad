import type { AppSpec, EnvVar } from "./appspec.ts";

/**
 * How large an App Platform spec this deploy is willing to emit, and where the
 * bytes went when it is too large.
 *
 * ## The failure this replaces
 *
 * DigitalOcean refuses an app spec past some size with
 * `400 … error validating app spec field "App spec": size limit exceeded`, and
 * that 400 arrives from `doctl apps update`, three steps after the render that
 * caused it. It names no number and no cause. strad-prod has been taken down by
 * it twice — on 2026-08-12 and again on 2026-08-30 — and both times the render
 * that produced the oversize spec was green and silent.
 *
 * The renderer knows the number. This is where it says so.
 *
 * ## Where the ceiling comes from
 *
 * DigitalOcean documents no app-spec size limit. Their App Platform Limits page
 * has storage, build, image, scaling, networking and "other" sections, and none
 * of them mentions the size of a spec. So the only bound anyone has is
 * empirical, and establishing the real one would mean repeatedly PUTting
 * synthetic specs at a live production app — a mutating prod action nobody
 * should take to satisfy a linter.
 *
 * What exists instead is every prod deploy since 2026-07-12 logging its own
 * rendered size. Across the 176 `Deploy strad production` runs in
 * tadasant-internal that recorded one:
 *
 *   - the LARGEST spec App Platform accepted is **131,010 bytes** — runs
 *     33286223074, 33287528135 and 33291566037, all on 2026-08-30, the last of
 *     them deploying at 04:01Z;
 *   - the SMALLEST spec it refused for size is **141,342 bytes** — run
 *     33330369567 at 19:18Z the same day.
 *
 * An earlier pair from the 2026-08-12 outage — 118,066 accepted, 151,838
 * refused — is the same property measured more coarsely and sits outside this
 * window on both sides, so it narrows nothing. A 139,095-byte spec (run
 * 33329085506) was rejected that evening on `services.instance_size_slug`
 * rather than on size, which means App Platform validated it PAST the size
 * check; that hints the real ceiling is above 139,095, but it depends on
 * DigitalOcean's field-validation order and nothing here rests on it.
 *
 * So the true limit is somewhere in `(131010, 141342]`.
 * `LARGEST_ACCEPTED_SPEC_BYTES` is the bottom of that window rather than a
 * round number inside it, and the reasoning is one-sided on purpose:
 *
 *   - A guard that refuses a spec App Platform would have taken turns a working
 *     deploy pipeline into a broken one, and `scripts/render-spec.ts` is
 *     executed straight from `main` by tadasant-internal's prod deploy — no
 *     image publish, no version bump, no dispatch between a merge here and the
 *     next prod render. So the threshold must never sit below a size that is
 *     OBSERVED to deploy. This is exactly the largest such size.
 *   - Above it there is no evidence either way, and the cost of guessing wrong
 *     in that direction is the opaque 400 this exists to prevent.
 *
 * `128 KiB` (131,072) is the obvious guess and it is wrong by 62 bytes in the
 * dangerous direction: it sits ABOVE the largest spec anyone has watched
 * deploy, so it would let one through on nothing but the roundness of the
 * number. An agent guessing rather than checking a DigitalOcean identifier is
 * what caused the failure immediately before this one (`apps-s-1vcpu-512mb`,
 * #209).
 *
 * **Raise this when a larger spec is observed to deploy.** That is a better
 * measurement, not a weakening.
 *
 * ## Two consumers, one number
 *
 * `scripts/render-spec.ts` REFUSES past it, and `scripts/assert-spec.ts` — which
 * reads the rendered file back before `doctl` — advises on it. The hard gate is
 * defensible only because it sits exactly here: it cannot refuse a size that is
 * known to work, and `--max-spec-bytes` raises it on the spot for an operator
 * who learns App Platform takes more, without waiting on a PR to this repo.
 */
export const LARGEST_ACCEPTED_SPEC_BYTES = 131_010;

/**
 * The share of the ceiling above which a spec is worth a sentence, short of
 * refusing it.
 *
 * Both outages were growth nobody was watching: prod went 96,238 → 131,010 over
 * a day of ordinary config edits, and a single strad PR once added 33,772 bytes
 * in one step. 20% of the ceiling is 26,202 bytes — about one such step — so a
 * spec inside the band is roughly one ordinary change away from being refused,
 * which is when a human wants to hear about it rather than after.
 *
 * It warns and emits, in both consumers. A spec under the ceiling is a spec App
 * Platform is observed to take, and neither of them gets to fail a deploy over
 * a size that works.
 */
export const SPEC_SIZE_ADVISORY_FRACTION = 0.8;

/** One env var's share of the spec, for saying where the budget went. */
export interface EnvContributor {
  component: string;
  key: string;
  bytes: number;
}

/** One component's share, largest first. */
export interface ComponentSize {
  name: string;
  /** Bytes of this component's serialized `envs`. */
  envBytes: number;
  count: number;
  largest: EnvContributor[];
}

export interface SpecSizeReport {
  /**
   * The exact text `render-spec` writes to stdout. Measured and emitted are the
   * same string by construction — a guard that measured a second serialization
   * would be guarding a spec nobody deploys.
   */
  json: string;
  bytes: number;
  limit: number;
  /** The size at or above which `verdict` is `"warn"`. */
  warnAt: number;
  verdict: "ok" | "warn" | "over";
  /** Components by env payload, largest first. */
  components: ComponentSize[];
}

/** What `doctl apps create/update --spec` is fed: a bare spec, pretty-printed. */
export function serializeSpec(spec: AppSpec): string {
  return JSON.stringify(spec, null, 2);
}

/**
 * Bytes of one env var as it lands in the spec.
 *
 * Compact, not pretty-printed: the indentation the real document carries is a
 * per-line constant that says nothing about which variable is expensive, and
 * the breakdown exists to answer "which one". So the component sums below are
 * deliberately a little under the whole-spec byte count, and the report says
 * which number is which rather than pretending they add up.
 */
function envBytes(env: EnvVar): number {
  return Buffer.byteLength(JSON.stringify(env), "utf8");
}

/**
 * Measure a rendered spec and say where its bytes are.
 *
 * `limit` is passed rather than read, so `--max-spec-bytes` and the tests reach
 * the same code path the default does.
 */
export function specSizeReport(
  spec: AppSpec,
  limit: number = LARGEST_ACCEPTED_SPEC_BYTES,
): SpecSizeReport {
  const json = serializeSpec(spec);
  const bytes = Buffer.byteLength(json, "utf8");
  const warnAt = Math.floor(limit * SPEC_SIZE_ADVISORY_FRACTION);

  const components: ComponentSize[] = spec.services
    .map((service) => {
      const envs = service.envs ?? [];
      const sized = envs
        .map((env) => ({
          component: service.name,
          key: env.key,
          bytes: envBytes(env),
        }))
        .sort((a, b) => b.bytes - a.bytes);
      return {
        name: service.name,
        envBytes: sized.reduce((sum, e) => sum + e.bytes, 0),
        count: sized.length,
        largest: sized.slice(0, 3),
      };
    })
    .sort((a, b) => b.envBytes - a.envBytes);

  const verdict = bytes > limit ? "over" : bytes >= warnAt ? "warn" : "ok";
  return { json, bytes, limit, warnAt, verdict, components };
}

/** `core: 96,238 bytes over 12 var(s) — STRAD_CONFIG_YAML 85,008, …` */
function componentLines(report: SpecSizeReport): string[] {
  return report.components.map(
    (c) =>
      `${c.name}: ${c.envBytes.toLocaleString("en-US")} bytes of env over ` +
      `${c.count} var(s)` +
      (c.largest.length > 0
        ? ` — largest: ` +
          c.largest
            .map((e) => `${e.key} (${e.bytes.toLocaleString("en-US")})`)
            .join(", ")
        : ""),
  );
}

/**
 * The refusal.
 *
 * Names the size, the ceiling, the overshoot and the components the bytes are
 * in — because "spec too large" is what the DigitalOcean 400 already says, and
 * saying it earlier without saying more would move the failure without
 * improving it.
 */
export function formatSpecSizeError(report: SpecSizeReport): string {
  const over = report.bytes - report.limit;
  return (
    `the rendered app spec is ${report.bytes.toLocaleString("en-US")} bytes, ` +
    `${over.toLocaleString("en-US")} over the ` +
    `${report.limit.toLocaleString("en-US")}-byte ceiling this deploy will ` +
    `emit. DigitalOcean documents no app-spec size limit; that ceiling is the ` +
    `largest spec strad-prod has been observed to deploy, and the smallest it ` +
    `has refused is 141,342 bytes with ` +
    `\`400 … error validating app spec field "App spec": size limit ` +
    `exceeded\`. Emitting this would most likely buy that 400 three steps ` +
    `downstream, where it names neither the size nor the cause.\n` +
    `Where the bytes are:\n  ${componentLines(report).join("\n  ")}\n` +
    `(Env payload only, so these run a little under the whole-spec figure ` +
    `above.) STRAD_CONFIG_YAML is the config file with its comments already ` +
    `stripped (src/deploy/config-inline.ts) — if it dominates, the config ` +
    `itself has grown. Everything else is baked secrets, whose count follows ` +
    `gateway.secrets.provider: under gcp-parameter-store the gateway reads ` +
    `its own at runtime and only supplementary components carry theirs.\n` +
    `Shrink the spec, or pass --max-spec-bytes if App Platform is known to ` +
    `take more than the ceiling above.`
  );
}

/** The band below the refusal: said out loud, still emitted. */
export function formatSpecSizeWarning(report: SpecSizeReport): string {
  const left = report.limit - report.bytes;
  return (
    `the rendered app spec is ${report.bytes.toLocaleString("en-US")} bytes, ` +
    `${Math.round((report.bytes / report.limit) * 100)}% of the ` +
    `${report.limit.toLocaleString("en-US")}-byte ceiling this deploy will ` +
    `emit — ${left.toLocaleString("en-US")} bytes of headroom left. ` +
    `Largest: ${componentLines(report)[0] ?? "(no components)"}. ` +
    `strad-prod has twice grown into DigitalOcean's app-spec size limit ` +
    `without anyone watching this number; a single change has added 33,772 ` +
    `bytes before now.`
  );
}
