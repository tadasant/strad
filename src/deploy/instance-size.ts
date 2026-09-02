import type { StradConfig } from "../config/schema.ts";

/**
 * Which App Platform compute plans exist, and the deploy gate that refuses a
 * config naming one that does not.
 *
 * ## The failure this closes
 *
 * `bundles[].instanceSizeSlug` is a plain string in the config schema, and
 * `renderAppSpec` copies it into `instance_size_slug` verbatim. So a
 * plausible-but-nonexistent `apps-s-1vcpu-512mb` — the 512 MiB plan is really
 * `apps-s-1vcpu-0.5gb` — satisfies the schema, satisfies `check-config`,
 * satisfies CI, renders a spec, merges, and only then fails at
 * `doctl apps update`:
 *
 *   error validating app spec field "services.instance_size_slug":
 *   unknown instance size "apps-s-1vcpu-512mb"
 *
 * That is how prod deploys went down on 2026-08-30. And it fails LATE in a
 * second sense: a bundle nothing is placed on renders no component, so it is
 * never sent to DigitalOcean at all, and a wrong slug sits dormant until some
 * unrelated change enables a server on that bundle — weeks later, past the
 * merge, at the last step of a deploy. `unknownInstanceSizes` walks
 * `config.bundles` rather than a rendered spec precisely so a declared-but-empty
 * bundle answers for its slug on the pull request that writes it.
 *
 * ## Why a deploy gate and not a schema rule
 *
 * Same split as `assertImmutableCoreImage` (src/deploy/imageTag.ts) and the
 * strict config parse (src/config/strict.ts): lenient library, strict deploy
 * gate. `parseConfig` runs at BOOT, in every container, and the config versions
 * independently of the image — so a schema that rejected a slug it had not heard
 * of would make an older image refuse the config a newer one wrote, turning a
 * rollback into a crash loop. Nothing at runtime reads `instanceSizeSlug`; only
 * the renderer does. A field with no runtime meaning must not be able to stop a
 * container from starting.
 *
 * `scripts/check-config.ts` and `scripts/render-spec.ts` are where it holds
 * instead, and between them every config in either repo is checked on the PR
 * that edits it and again at the deploy boundary. `renderAppSpec` itself stays
 * permissive, as it does for image tags — it shapes specs for tests and for
 * whoever embeds it, and has no business adjudicating a vendor's price list.
 */

/**
 * Every App Platform instance size DigitalOcean sells, exactly as the API
 * spells it.
 *
 * Source: the "Current Plans" table at
 * https://docs.digitalocean.com/products/app-platform/details/pricing/
 *
 * An allowlist rather than a denylist, which is the opposite of `MUTABLE_TAGS`
 * in imageTag.ts and for a reason that does not carry over: that list covers tag
 * schemes another repo owns and may extend at will, so guessing tight there
 * would block a deploy someone else made legitimate. This list is DigitalOcean's
 * own — small, public, and changed about once a year.
 */
export const APP_INSTANCE_SIZES = [
  "apps-s-1vcpu-0.5gb",
  "apps-s-1vcpu-1gb-fixed",
  "apps-s-1vcpu-1gb",
  "apps-s-1vcpu-2gb",
  "apps-s-2vcpu-4gb",
  "apps-d-1vcpu-0.5gb",
  "apps-d-1vcpu-1gb",
  "apps-d-1vcpu-2gb",
  "apps-d-1vcpu-4gb",
  "apps-d-2vcpu-4gb",
  "apps-d-2vcpu-8gb",
  "apps-d-4vcpu-8gb",
  "apps-d-4vcpu-16gb",
  "apps-d-8vcpu-32gb",
] as const;

/**
 * The legacy plans, from the same page's "Legacy Plans" table.
 *
 * App Platform accepts these only for apps created before 7 May 2024, and
 * DigitalOcean says it intends to deprecate them. `strad-prod` and
 * `strad-staging` were both created 2026-07-12, so on either one a legacy slug
 * is an `unknown instance size` waiting for the next deploy.
 *
 * They are accepted here anyway, and reported as a warning instead. What this
 * gate exists to catch is a name DigitalOcean does not HAVE; a legacy name is a
 * name it has, on an app old enough to use it. Refusing one would make a
 * legitimate config for such an app undeployable, and nothing in a config says
 * when its app was created — so the gate reports what it can see and leaves the
 * decision with the operator. Gating them behind a config flag was the
 * alternative and buys nothing: a key no deployment here sets, guarding a value
 * the API already adjudicates.
 */
export const LEGACY_APP_INSTANCE_SIZES = [
  "basic-xxs",
  "basic-xs",
  "basic-s",
  "basic-m",
  "professional-xs",
  "professional-s",
  "professional-m",
  "professional-1l",
  "professional-l",
  "professional-xl",
] as const;

/** True for a plan only an app created before 7 May 2024 may use. */
export function isLegacyInstanceSize(slug: string): boolean {
  return (LEGACY_APP_INSTANCE_SIZES as readonly string[]).includes(slug);
}

/** True for any plan DigitalOcean serves — current or legacy. */
export function isKnownInstanceSize(slug: string): boolean {
  return (
    (APP_INSTANCE_SIZES as readonly string[]).includes(slug) ||
    isLegacyInstanceSize(slug)
  );
}

/** A bundle whose declared size names something, and what it names. */
export interface BundleInstanceSize {
  bundle: string;
  slug: string;
}

/**
 * Every declared bundle whose `instanceSizeSlug` names no App Platform plan.
 *
 * Over `config.bundles`, NOT over a rendered spec: a bundle that carries no
 * server renders no component, and that is exactly the case whose wrong slug
 * detonates later.
 */
export function unknownInstanceSizes(
  config: StradConfig,
): BundleInstanceSize[] {
  return (config.bundles ?? [])
    .filter((b) => !isKnownInstanceSize(b.instanceSizeSlug))
    .map((b) => ({ bundle: b.name, slug: b.instanceSizeSlug }));
}

/** Every declared bundle on a plan only a pre-7-May-2024 app may use. */
export function legacyInstanceSizes(config: StradConfig): BundleInstanceSize[] {
  return (config.bundles ?? [])
    .filter((b) => isLegacyInstanceSize(b.instanceSizeSlug))
    .map((b) => ({ bundle: b.name, slug: b.instanceSizeSlug }));
}

const PRICING_URL =
  "https://docs.digitalocean.com/products/app-platform/details/pricing/";

/**
 * What an operator is told about a slug that names no plan.
 *
 * It lists every accepted value, because the fix is almost always a
 * near-miss — `apps-s-1vcpu-512mb` for `apps-s-1vcpu-0.5gb` — and reading the
 * right name off the message is faster than finding the page.
 */
export function formatUnknownInstanceSize(bad: BundleInstanceSize): string {
  return (
    `bundle "${bad.bundle}": instanceSizeSlug "${bad.slug}" names no App ` +
    `Platform plan. DigitalOcean rejects a size it does not sell at ` +
    `\`doctl apps update\`, after the merge, and a bundle that renders no ` +
    `component yet is not sent until some later change creates it. Current ` +
    `plans: ${APP_INSTANCE_SIZES.join(", ")}. Legacy plans, accepted only by ` +
    `apps created before 7 May 2024: ${LEGACY_APP_INSTANCE_SIZES.join(", ")}. ` +
    `See ${PRICING_URL}`
  );
}

/** What an operator is told about a legacy plan. Never fatal. */
export function formatLegacyInstanceSize(old: BundleInstanceSize): string {
  return (
    `bundle "${old.bundle}": instanceSizeSlug "${old.slug}" is a legacy App ` +
    `Platform plan, accepted only by apps created before 7 May 2024, and ` +
    `DigitalOcean intends to deprecate legacy plans. strad-prod and ` +
    `strad-staging were both created 2026-07-12, so on either one the deploy ` +
    `fails with "unknown instance size". Move to a current plan — see ` +
    `${PRICING_URL}`
  );
}

/**
 * Refuse a config naming a plan that does not exist.
 *
 * The deploy boundary's half of the gate, called by `scripts/render-spec.ts`
 * before any of the deploy's real work — the same shape and the same place as
 * `assertImmutableCoreImage`.
 */
export function assertKnownInstanceSizes(config: StradConfig): void {
  const bad = unknownInstanceSizes(config);
  if (bad.length === 0) return;
  throw new Error(bad.map(formatUnknownInstanceSize).join("\n"));
}
