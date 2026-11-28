/**
 * The decisions `buildMounts()` makes that are decidable from the environment
 * alone: which capability variables to scrub, which slugs the environment has
 * asked for a second instance of, and whether a mount that CAN be built is
 * nevertheless too under-configured to serve.
 *
 * They live beside `index.ts` rather than in it because `index.ts` calls
 * `main()` at import time — importing it starts a server, binds a port and
 * reaches into `/app/trees` — so nothing in that file can be reached by a test.
 * Everything here is a pure function of the environment it is handed, and
 * `test/mounts.test.ts` is what exercises it.
 */
import { prefixedEnvName, slugsWithPrefixedNames } from "./env-prefix.js";
import { log, logWarn } from "./log.js";

/**
 * Capability is the gateway's job now. Any surviving container-side toggle would
 * silently narrow EVERY slug served from this process — including the read-write
 * ones — so it does not merely get ignored, it gets removed.
 */
export function scrubCapabilityEnv(env: NodeJS.ProcessEnv = process.env): void {
  const SHAPE =
    /(^|_)(ENABLED_TOOLGROUPS|ENABLED_TOOL_GROUPS|TOOL_GROUPS|ENABLED_TOOLS|DISABLED_TOOLS)$/;
  for (const key of Object.keys(env)) {
    if (!SHAPE.test(key)) continue;
    logWarn(
      `ignoring ${key}: capability is enforced by the strad gateway now ` +
        `(tools.allow / tools.deny in the server config), not by this container. ` +
        `Leaving it set would strip tools from the read-write slugs too.`,
    );
    delete env[key];
  }
}

/**
 * Which slugs to mount a tree under: its conventional path, plus every slug the
 * environment carries per-slug values for.
 *
 * THIS PROCESS NEVER SEES strad's CONFIG. It knows the server list only through
 * the variables the renderer baked onto the container, so "is there a second
 * telegram?" is answered by looking for `<SLUG>__TELEGRAM_API_ID` and nothing
 * else. src/secrets/env-prefix.ts (vendored here) owns the name shape on both
 * sides of that.
 *
 * THE DEFAULT SLUG IS ALWAYS MOUNTED, even when per-slug values exist. A config
 * that points several slugs at the conventional path — which is every strad
 * deployment today — must keep resolving without editing that config first, so
 * this only ever ADDS mounts.
 *
 * THE MARKER SET IS THE CALLER'S, and it is usually — not always — a tree's whole
 * required set. `remote-filesystem` keys on its bucket alone, and `google-sheets`
 * and `gmail` on the OAuth app pair rather than the refresh token that completes
 * it, because that token is minted by a human on the slug's own console page and
 * the page is the mount. Smaller is not looser: every name in whatever set is
 * passed must be present, which is what keeps one stray variable from conjuring
 * an instance.
 */
export function extraSlugs(
  defaultSlug: string,
  markerNames: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // A tree loaded from `/app/trees` that does not export the list this was called
  // with hands us `undefined`, and dereferencing it inside `buildMounts()` would
  // exit the process — thirty mounts lost over one. Both halves ship in one
  // image from one commit, so this is a floor rather than a live risk.
  if (!Array.isArray(markerNames)) {
    logWarn(
      `${defaultSlug}: no marker names to discover per-slug instances by; ` +
        `mounting the conventional path only. The tree exports no list for it.`,
    );
    return [];
  }
  const discovered = slugsWithPrefixedNames(env, markerNames).filter(
    (slug) => slug !== defaultSlug,
  );
  if (discovered.length > 0) {
    log(
      `${defaultSlug}: per-slug environment found for ${discovered.join(", ")} — ` +
        `mounting ${discovered.length + 1} instance(s)`,
    );
  }
  return discovered;
}

/**
 * Names a per-slug mount may NOT inherit from the bare environment.
 *
 * `slugEnvView` falls back to the bare name for anything a slug has no name of
 * its own for. That fallback is the whole backward-compatibility story and it is
 * right for nearly everything — a shared OAuth client, a viewer domain, an
 * organisation id. It is wrong for a variable that IS an identity.
 *
 * A `google-sheets` slug is discovered on its OAuth app pair, so it mounts before
 * anyone has connected it and its refresh token is legitimately absent. If some
 * other server on the same bundle put a bare `GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN`
 * on the container, the unconnected slug would inherit it: `missingCredentials()`
 * would report nothing missing, the mount would say it is healthy, and every call
 * would run against ANOTHER Google account — under a slug whose console page says
 * it is not connected. Since one OAuth app usually serves every slug, the refresh
 * would even succeed.
 *
 * GMAIL IS THE SHARPER CASE, and it is why this takes a list rather than a name.
 * That tree has TWO auth modes and the bundle carries both: the conventional
 * `/gmail` mount is a service account impersonating a Workspace user, so
 * `GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL`, `GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY` and
 * `GMAIL_IMPERSONATE_EMAIL` are all on the box as bare names. An unconnected
 * `gmail-personal-ro` that inherited them would not be unconfigured — it would
 * be configured as somebody ELSE, serving a work mailbox under a slug named for
 * a personal account, with nothing failing anywhere. So every per-account name
 * in BOTH modes is dropped, not just the refresh token.
 *
 * So a per-slug mount reads these from its own name or not at all. Absent is the
 * honest answer: the mount degrades and names what is missing, which is the state
 * the connector flow expects to find.
 *
 * Mutates the view it is handed, like {@link scrubCapabilityEnv}. Only speaks when
 * it actually dropped something, because a slug that was never going to inherit
 * anything is the ordinary case.
 *
 * ONE LINE PER SLUG, not one per variable, and gmail is why. Every gmail
 * connector slug on a bundle that also serves the conventional `/gmail` refuses
 * THREE bare names, on every boot, for as long as the deployment exists — that
 * is the designed steady state, not an incident, and three warnings per slug
 * saying it is how a boot log stops being read. The line names each dropped
 * variable with the per-slug name that would have satisfied it, so it loses
 * nothing by being one line.
 */
export function dropInheritedNames(
  view: Record<string, string | undefined>,
  slug: string,
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  /** Drop without saying so: for a mount that re-reads per call, having said it once at boot. */
  quiet = false,
): void {
  const inherited: { name: string; own: string | null }[] = [];
  for (const name of names) {
    const own = prefixedEnvName(slug, name);
    if (own !== null && env[own]) continue;
    if (view[name]) inherited.push({ name, own });
    delete view[name];
  }
  if (inherited.length === 0 || quiet) return;

  const one = inherited.length === 1;
  logWarn(
    `${slug}: not inheriting the bare ${inherited.map((i) => i.name).join(", ")} — ` +
      `${one ? "it belongs" : "they belong"} to whichever account seeded ` +
      `${one ? "it" : "them"}, not to this slug. This mount reads its account ` +
      `under its own ${inherited
        .map((i) => i.own ?? `${i.name} under this slug`)
        .join(", ")} or not at all, and stays degraded until it has one. A slug ` +
      `with an oauth: connector gets one by being connected in strad's console.`,
  );
}

/**
 * Bare credentials that belong to a DIFFERENT origin than the bare origin.
 *
 * The renderer picks the owner of each bare name separately, so on a container
 * holding several slugs of one tree, the bare origin can be one slug's and the
 * bare credential another's: slug C declares only an entrypoint, slug B declares
 * an entrypoint and a token, and the conventional mount comes up holding C's
 * entrypoint and B's token. Sent together, that is B's credential handed to C's
 * host. A per-slug view is guarded by {@link dropInheritedNames}; this is the
 * guard for the conventional one.
 *
 * A bare credential is dropped when some slug carries the same value under its
 * own name AND that slug's own origin is not the bare origin — the one case in
 * which the pairing is provably wrong. Returns the names it dropped.
 */
export function dropUnpairedCredentials(
  view: Record<string, string | undefined>,
  originName: string,
  credentialNames: readonly string[],
  slugs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dropped: string[] = [];
  for (const name of credentialNames) {
    const bare = view[name];
    if (!bare) continue;
    for (const slug of slugs) {
      const ownCredential = prefixedEnvName(slug, name);
      const ownOrigin = prefixedEnvName(slug, originName);
      if (ownCredential === null || ownOrigin === null) continue;
      if (env[ownCredential] === bare && env[ownOrigin] !== view[originName]) {
        delete view[name];
        dropped.push(name);
        break;
      }
    }
  }
  if (dropped.length > 0) {
    logWarn(
      `not using the bare ${dropped.join(", ")} for the conventional mount: ` +
        `${dropped.length === 1 ? "it belongs" : "they belong"} to a slug whose ` +
        `${originName} is not the bare one, and would be sent to a host it was ` +
        `not issued for.`,
    );
  }
  return dropped;
}

/**
 * A variable this mount reads under its OWN slug's name or not at all — and,
 * unlike {@link dropInheritedNames}, one that is not a credential.
 *
 * The renderer gives every key in a server's `env:` its bare name as well as
 * its per-slug one, and `slugEnvView` falls back to the bare name. For a
 * credential that fallback is guarded by `dropInheritedNames`. For a setting
 * that describes ONE mailbox, such as the name its mail is sent under, the
 * fallback is just as wrong and fails more quietly: every other mount on the
 * bundle, the conventional one included, would send under a sibling's name, and
 * nothing would fail. So the bare name is never read for it.
 *
 * Silent, because a mount that configures no such setting is the ordinary case
 * and a bare one on the box is a sibling's own, correctly declared, value.
 */
export function ownNameOnly(
  view: Record<string, string | undefined>,
  slug: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const own = prefixedEnvName(slug, name);
  const value = own === null ? undefined : env[own];
  if (value) view[name] = value;
  else delete view[name];
}

/**
 * remote-filesystem, degraded rather than unmounted.
 *
 * The tools must still LIST so an agent can see what this deployment would
 * offer, and so the console shows the slug at all. Every call then fails with an
 * error naming the variable. The bucket is what the whole server is FOR, so its
 * absence degrades everything; the viewer domain only decides what happens to a
 * sensitive upload, so its absence degrades that alone — and the bucket is
 * reported first, because a deployment missing both is missing the bucket.
 *
 * A uniform bucket-level access deployment (`_UNIFORM_ACCESS=true`) refuses
 * sensitive uploads BY DESIGN — its bucket can hold no per-object grant — so a
 * missing domain there is the correct configuration, not a degraded one. The
 * tree's `loadConfig` refuses a viewer domain alongside it, and any value that
 * is not exactly `true` or `false`, and either refusal fails every tool, so
 * both are reported here as that.
 *
 * `envPrefix` is passed rather than imported: `index.ts` owns
 * `REMOTE_FS_ENV_PREFIX` (it is half of the marker name
 * `test/env-prefix.markers.test.ts` greps that file for) and this only composes
 * with it.
 */
export function remoteFilesystemDegraded(
  env: Readonly<Record<string, string | undefined>>,
  envPrefix: string,
): string | null {
  if (!env[`${envPrefix}_GCS_BUCKET`]) {
    return `${envPrefix}_GCS_BUCKET is not set; every tool will fail`;
  }
  const uniform = env[`${envPrefix}_UNIFORM_ACCESS`]?.trim();
  if (uniform && uniform !== "true" && uniform !== "false") {
    return `${envPrefix}_UNIFORM_ACCESS="${uniform}" is not "true" or "false"; every tool will fail`;
  }
  if (uniform === "true") {
    return env[`${envPrefix}_SENSITIVE_VIEWER_DOMAIN`]?.trim()
      ? `${envPrefix}_SENSITIVE_VIEWER_DOMAIN is set alongside ${envPrefix}_UNIFORM_ACCESS=true; every tool will fail`
      : null;
  }
  if (!env[`${envPrefix}_SENSITIVE_VIEWER_DOMAIN`]) {
    return `${envPrefix}_SENSITIVE_VIEWER_DOMAIN is not set; is_sensitive=true uploads will be refused`;
  }
  return null;
}

/**
 * A mount whose tree reports its own missing credentials — telegram and
 * google-sheets — degraded rather than unmounted, same posture, same reason.
 *
 * Each tree owns WHAT its credential is (`missingCredentials()`); this owns only
 * the sentence. The message names EVERY missing variable, not the first: three
 * absent Telegram variables are one un-seeded login, and a deployment should
 * learn that in one line rather than three deploys.
 */
export function missingCredentialsDegraded(
  missing: readonly string[],
): string | null {
  if (missing.length === 0) return null;
  return `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set; every tool will fail`;
}

/**
 * The process variables a STORE-SERVED instance inherits, and nothing else.
 *
 * Every other per-slug mount starts from `slugEnvView`, which is the whole
 * container environment with the slug's own names laid over it. That fallback
 * is exactly wrong here: an instance exists to hold ONE account, served out of
 * its own namespace, and a bare `TELEGRAM_STRING_SESSION` baked for the
 * conventional mount would otherwise complete an instance whose namespace is
 * half-seeded — a slug quietly running on a sibling's login.
 *
 * So an instance gets what a process needs to run at all — the grafana tree
 * spawns a Go binary, which needs a `PATH`, a `HOME` and its CA settings — plus
 * what core served. The list is deliberately the one the grafana tree already
 * passes its child (servers/grafana/shared/src/config.ts) plus the tailnet
 * proxy address, and none of it is a credential.
 */
export const INSTANCE_PROCESS_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  // Where this container's tailnet SOCKS5 listener is, set by the host itself
  // when the component was rendered with `tailnet:` (src/tailnet.ts). An
  // address, not a credential, and listed HERE so a served value of the same
  // name can never point an instance's SSH dial at a proxy of its choosing.
  "STRAD_TAILNET_SOCKS5",
] as const;

export function instanceEnv(
  served: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of INSTANCE_PROCESS_ENV_NAMES) {
    if (env[name]) out[name] = env[name];
  }
  // Served values last, but a served name never REPLACES a process one: a
  // parameter called `PATH` in a slug's namespace is not a credential, and
  // letting it steer which binary the grafana tree spawns would make seeding
  // a namespace a way to run code.
  for (const [name, value] of Object.entries(served)) {
    if ((INSTANCE_PROCESS_ENV_NAMES as readonly string[]).includes(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Whether a 1Password mount puts each WRITE to a human. Reveals always are.
 *
 * Read under the slug's OWN name (`<SLUG>__OP_ELICITATION_WRITE`) and never the
 * bare one: on a shared bundle the bare name is whichever slug declared it, and
 * a provisioning slug's `false` must not switch the prompt off for its siblings.
 * The conventional `/onepassword` mount has no slug of its own to read it under,
 * so it always confirms. Only the exact word `false` turns it off; anything
 * else, a typo included, leaves the prompt on.
 */
export function onePasswordConfirmsWrites(
  slug: string,
  perSlug: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!perSlug) return true;
  const own = prefixedEnvName(slug, "OP_ELICITATION_WRITE");
  if (own === null) return true;
  return env[own]?.trim().toLowerCase() !== "false";
}

/**
 * The environment one hatchbox mount reads, cut down so no slug runs on a
 * sibling's key.
 *
 * A Hatchbox slug is a TIER of one app — `-ro` holds the SSH key, `-deploy` the
 * deploy key, `-rw` all of them — and the slug's credentials ARE the tier: a
 * read-only slug cannot write because the API key is not in its environment.
 * The renderer also bakes every slug's `env:` under its bare name, and
 * `slugEnvView` falls back to the bare name, so on a bundle holding `-ro`
 * beside `-rw`, the `-ro` view would inherit `-rw`'s bare `HATCHBOX_API_KEY`
 * and quietly become `-rw`. So a per-slug view reads EVERY hatchbox name under
 * its own slug's name or not at all.
 *
 * The conventional `/hatchbox` mount gets the same rule once any per-slug
 * sibling exists — every bare hatchbox name on the box is then some sibling's,
 * so it reads only `HATCHBOX__*`, its own, and is otherwise the degraded
 * placeholder: a hatchbox slug is served on `path: /<its own slug>`. The
 * upstream names it REFUSES (`READONLY`, `ALLOW_DEPLOYS`, …) are generic
 * enough that another server may declare them, so those are read under the
 * mount's own name only, always.
 */
export function hatchboxEnvView(
  view: Record<string, string | undefined>,
  slug: string,
  perSlug: boolean,
  siblings: readonly string[],
  names: readonly string[],
  refused: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const own = perSlug || siblings.length > 0 ? names : refused;
  for (const name of own) ownNameOnly(view, slug, name, env);
}
