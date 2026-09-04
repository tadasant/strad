import type { Principal } from "../auth/index.ts";
import type { ServerConfig, StradConfig } from "../config/schema.ts";
import { entitledServers } from "../gateway/entitlements.ts";
import {
  connectUrl,
  originFor,
  playgroundAccess,
  playgroundHref,
} from "./playground.ts";
import {
  FAILURE_BACKOFF_MS,
  MAX_DIAGNOSIS_TTL_MS,
  type StoreDiagnostics,
} from "../secrets/store-diagnostics.ts";
import { esc, layout } from "./render.ts";
import { serverConsolePath } from "./paths.ts";
import { serverLooksGcs, serverLooksSecrets } from "./resolve.ts";
import {
  fixTargets,
  isActionable,
  SOURCE_TOOLTIP,
  STATE_RANK,
  storeProject,
  unobservableTarget,
  type FixTarget,
  type UnobservableScope,
  type SecretEvidence,
  type SecretObservation,
  type SecretSource,
  type SecretState,
  type ServerSecretStatus,
  type ServerState,
} from "./secret-status.ts";

/**
 * `/ui` — the console index: every configured MCP server, what it is scoped to,
 * and whether the secrets it needs are actually there.
 *
 * ## Why the roster is here and not on a page of its own
 *
 * It was two destinations: `/ui` listed the servers and `/secrets` said whether
 * each one's secrets resolved. Nobody wants the second question in isolation —
 * it is asked ABOUT a server, standing in front of the list of servers — so the
 * answer belongs on the entry, not one navigation away.
 *
 * ## What the two badges claim, exactly
 *
 * Every enabled entry carries `READY` or `ISSUE`, and the line between them is
 * drawn where it can be defended:
 *
 *   READY — every `${NAME}` this server references was OBSERVED to resolve, or
 *           it references none at all. It is **not** a claim the credential
 *           works: strad never calls the upstream. See secret-status.ts.
 *   ISSUE — anything else, INCLUDING "could not be checked from here". The
 *           badge opens a popout naming which flavour it is and what to do, so
 *           the nuance is one click away rather than compressed into the chip.
 *
 * "Could not be checked" landing under ISSUE is the deliberate half. A
 * bundle-scoped value is genuinely invisible to this process and may well be
 * fine — but calling that READY would be the exact false green
 * `src/ui/secret-status.ts` exists to prevent, and this page's whole claim is
 * that a green badge means something was observed.
 *
 * ## Why it prints secret names and the landing page does not
 *
 * `/` is deliberately narrow — no `env:` keys, no urls, no headers
 * (test/landing.test.ts asserts each absence) — because it is a directory and a
 * directory needs none of that. Naming the missing secret and the exact path it
 * goes at is this page's entire job, so it prints NAMES and PATHS. It is behind
 * `requireConsoleUi`, and the line it holds instead is the one that matters:
 * **no secret VALUE is ever rendered.** Not revealed, not excerpted, not
 * length-hinted, not in a title attribute. The status derivation
 * (secret-status.ts) reads values to spot a placeholder and returns sentences
 * about shapes; nothing here can print bytes because nothing here is ever handed
 * any.
 */

export interface ConsoleIndexOptions {
  config: StradConfig;
  /** Per-server secret status, for every ENABLED server. */
  statuses: ServerSecretStatus[];
  /**
   * The gateway's own boot keys, observed the same way.
   *
   * `required` is carried alongside because an absent OPTIONAL key is not a
   * problem — a deployment with no console has no `GOOGLE_CLIENT_SECRET`, and
   * flagging that red would train people to ignore the panel.
   */
  boot: { observation: SecretObservation; required: boolean }[];
  env: NodeJS.ProcessEnv;
  /**
   * The console identity this page is being rendered for.
   *
   * Roles are not a console ACL — every signed-in principal sees every card. It
   * is here for the ONE control that issues MCP calls rather than rendering
   * config: the playground icon, which is offered only where the playground
   * opens. See cardIcons().
   */
  principal: Principal;
  signedInAs?: string;
  /**
   * Origin the request arrived on, e.g. "https://staging.strad.example.com".
   * Used only when `gateway.publicUrl` is unset — a relative `/mcp?servers=x` is
   * pasteable into no MCP client, and the copy icon exists to be pasted.
   */
  requestOrigin?: string;
  /**
   * The store diagnosis behind the rows, so the page can say when it was read.
   *
   * The pair of store reads is answered from the process's reading of the
   * store, which means a row can be derived from an answer as old as
   * `gateway.secrets.ttlSeconds`. Absent (or null) when there was no
   * diagnosis at all — no resolver credential — and then the page says nothing,
   * because there is nothing whose age it would be describing.
   */
  storeDiagnosis?: StoreDiagnostics | null;
}

/** The two badges an entry can carry, and nothing in between. */
export type EntryBadge = "READY" | "ISSUE";

/**
 * READY is only ever an OBSERVATION.
 *
 * `ready` (every reference resolved) and `no-secrets` (there are none) are the
 * two states where the console established that nothing is outstanding.
 * `unverified` and `unknown` are not weaker greens, they are the absence of an
 * answer, and they read as ISSUE for the reason in the header comment.
 */
export function badgeFor(state: ServerState): EntryBadge {
  return state === "ready" || state === "no-secrets" ? "READY" : "ISSUE";
}

/** One entry on the index: a server, and what is known about its secrets. */
export interface Entry {
  server: ServerConfig;
  /** Absent for a DISABLED server, which is not on the secret roster at all. */
  status?: ServerSecretStatus;
  badge?: EntryBadge;
  /** Whether `/ui/<slug>` renders something. Part of the sort key. */
  hasView: boolean;
}

/**
 * READY before ISSUE; within each group, entries with a console view first.
 *
 * A DISABLED server carries no badge — strad does not mount it, so it needs no
 * secrets and `deriveServerStatuses` skips it — and sorts last. Reporting it
 * READY would be a green for a server that answers nothing.
 */
export function sortEntries(entries: Entry[]): Entry[] {
  const rank = (e: Entry): number => {
    if (!e.server.enabled) return 4;
    return (e.badge === "READY" ? 0 : 2) + (e.hasView ? 0 : 1);
  };
  // Array.prototype.sort is stable, so config order survives inside a rank.
  return [...entries].sort((a, b) => rank(a) - rank(b));
}

export function renderIndex(opts: ConsoleIndexOptions): string {
  const { config, statuses } = opts;
  const bySlug = new Map(statuses.map((s) => [s.server.slug, s]));

  const sorted = sortEntries(
    config.servers.map((server) => {
      const status = bySlug.get(server.slug);
      return {
        server,
        status,
        badge: status ? badgeFor(status.state) : undefined,
        hasView: hasConsoleView(server),
      };
    }),
  );

  const readyCount = sorted.filter((e) => e.badge === "READY").length;
  const issues = sorted.filter((e) => e.badge === "ISSUE");
  const { project, guessed } = storeProject(config, opts.env);
  // Where this gateway lives, for the copy icon. Config first, then the origin
  // the request arrived on — see ConsoleIndexOptions.requestOrigin.
  const base = originFor(config, opts.requestOrigin);
  // Once for the whole grid, not once per card: every icon is a question about
  // the same principal, and `entitledServers` walks every server for each call.
  const entitled = entitledServers(opts.principal, config);

  const body = `
<section class="intro">
  <h1>Servers <span class="env-badge">${esc(config.gateway.env)}</span></h1>
  <p class="lede">Every MCP server on this gateway: what it is scoped to, and whether the
    secrets it needs are seeded. A <span class="chip chip-ok chip-badge">READY</span> entry
    has every <code>\${NAME}</code> it references resolving — which is not a claim that the
    upstream accepts the credential. An <span class="chip chip-bad chip-badge">ISSUE</span>
    entry opens the exact path to fix.</p>
</section>

${summaryBar(readyCount, issues.length, statuses.length)}

${banner(issues, statuses.length)}

<div class="card-grid">
${
  sorted.length
    ? sorted
        .map((e) =>
          serverCard(
            e,
            base,
            playgroundAccess(config, entitled, e.server.slug).ok,
          ),
        )
        .join("\n")
    : `<p class="empty">No servers are configured on this gateway.</p>`
}
</div>

<section class="panel">
  <div class="panel-head">
    <h2>The gateway itself</h2>
    <span class="panel-note">boot keys</span>
  </div>
  <p class="copy-note">Not any server's secrets — strad's own. Without
    <code>STRAD_TOKENS</code> every <code>/mcp</code> request is rejected and no amount of
    per-server <code>READY</code> above means anything.</p>
  <div class="listing">
${opts.boot.map((o) => bootRow(o)).join("\n")}
  </div>
</section>

<p class="copy-note">Parameter store project: <code>${esc(project)}</code>${
    guessed
      ? " — inferred from the naming convention, because this deployment declares none."
      : ""
  } Secret Manager names follow <code>strad-${esc(config.gateway.env)}-&lt;NAME&gt;</code>.
  Values are never displayed here; use
  <a href="/ui/secrets">the parameters console</a> to set one. A machine wanting the same
  derivation as JSON calls <code>GET /api/secrets/readiness</code> with a static bearer
  token.${diagnosisNote(opts.storeDiagnosis, config)}</p>

${sorted
  .filter(hasFixDialog)
  .map((e) => fixDialog(e, config, opts.env))
  .join("\n")}
${FIX_DIALOG_SCRIPT}
${COPY_SCRIPT}
${INDEX_CSS}`;

  return layout({
    title: "Servers",
    body,
    signedInAs: opts.signedInAs,
    brandHref: "/",
    brandSub: "console",
    footNote: "status and guidance · never values",
    helpTitle: "Console guide",
    help: GUIDE,
  });
}

/**
 * WHEN the store was asked, appended to the page's own footnote.
 *
 * The rows above are derived from the process's one reading of the store,
 * which is held for `gateway.secrets.ttlSeconds` (see `secrets/parameters/gcp.ts`)
 * and over which the index + render pass is itself reused for up to a minute
 * (see `secrets/store-diagnostics.ts`). Printing the verdict without the
 * reading's age would make this page claim something fresher than it holds,
 * which is the one thing a cache in front of a health signal must not be
 * allowed to do — the console's whole posture is that it says what it
 * established, and when.
 */
function diagnosisNote(
  diagnosis: StoreDiagnostics | null | undefined,
  config: StradConfig,
): string {
  if (!diagnosis) return "";

  const complete = diagnosis.indexRead && diagnosis.renderRead;
  // The same two numbers the cache holds the answer for, so the page states the
  // bound that actually applies rather than the one for the healthy case: an
  // incomplete pass is held for the failure backoff, which is far shorter.
  const windowSeconds = complete
    ? Math.min(config.gateway.secrets.ttlSeconds, MAX_DIAGNOSIS_TTL_MS / 1000)
    : Math.min(config.gateway.secrets.ttlSeconds, FAILURE_BACKOFF_MS / 1000);
  const age =
    diagnosis.ageMs < 1000
      ? "just now"
      : `${Math.round(diagnosis.ageMs / 1000)}s ago`;

  // Assembled by concatenation rather than as one wrapped template literal: a
  // newline inside "reused for up to 60s" is invisible in the rendered HTML and
  // makes the sentence unfindable to anything that reads the markup.
  const subject =
    " The store's own account of itself — which parameters exist," +
    " and which exist and refuse to render —";

  if (!diagnosis.indexRead && !diagnosis.renderRead) {
    return (
      `${subject} did not answer when it was last asked, ${age},` +
      ` so those distinctions are not drawn on the rows above.` +
      ` It is asked again after ${windowSeconds}s.`
    );
  }

  // Which half failed is read from the flags rather than assumed: the two reads
  // share one deadline and fail independently, so either can be the missing one.
  const halfDown = diagnosis.indexRead
    ? ", and its per-parameter render did not answer"
    : ", and its index read did not answer";

  return (
    `${subject} was read ${age}${complete ? "" : halfDown};` +
    ` that pass is reused for up to ${windowSeconds}s over a reading of the store` +
    ` this process holds for up to ${config.gateway.secrets.ttlSeconds}s,` +
    ` so a value seeded since, outside this console, is not necessarily reflected above yet.`
  );
}

// ---------------------------------------------------------------------------
// The header: a count, and a claim that has to survive a store outage
// ---------------------------------------------------------------------------

function summaryBar(ready: number, issues: number, total: number): string {
  return `<div class="browse-head">
  <div class="stat"><span class="stat-n">${total}</span><span class="stat-l">enabled server${total === 1 ? "" : "s"}</span></div>
  <div class="stat"><span class="stat-n stat-ready">${ready}</span><span class="stat-l">ready</span></div>
  <div class="stat"><span class="stat-n stat-missing">${issues}</span><span class="stat-l">issue${issues === 1 ? "" : "s"}</span></div>
</div>`;
}

/**
 * The headline claim, and it has to be THREE-way rather than two.
 *
 * The two-way version said "every server is fine" whenever nothing was
 * ACTIONABLE — and `unknown` and `unverified` are not actionable. So a total
 * store outage, with every entry correctly unable to report, printed a green "a
 * value EXISTS for each ${NAME}" across the top. The entries were honest and the
 * banner above them was not, which is worse than either alone: the banner is the
 * part someone reads.
 *
 * FOUR-way, in fact, because of the empty roster. The core ships with zero
 * servers (src/config/schema.ts), so a fresh install's very first screen is this
 * one — and "Every server is READY" over an empty grid is an unearned green of
 * exactly the kind this module refuses everywhere else. Nothing was checked
 * because there was nothing to check, and that is what it says.
 */
function banner(issues: Entry[], enabled: number): string {
  if (enabled === 0) {
    return `<p class="posture">No servers are enabled on this gateway, so there is nothing
      to seed and nothing to report. Add one to <code>servers:</code> in the config, and its
      secrets appear here.</p>`;
  }

  if (issues.length === 0) {
    return `<p class="posture"><strong>Every server is READY.</strong> Every
      <code>\${NAME}</code> the config references was OBSERVED to resolve — each row says by
      which process and from which source, <code>GSM</code> or <code>ENV</code>. strad does
      not call any upstream, so it is not a claim that a credential is still accepted. A
      server that lists tools and 401s on every call is the shape to suspect next.</p>`;
  }

  // `isActionable` rather than an inlined `missing || placeholder`: there is one
  // definition of "a human has to do something about this", and the banner and
  // the popout headline must not be able to disagree about it.
  const actionable = issues.filter(
    (e) => e.status !== undefined && isActionable(e.status.state),
  ).length;
  const unchecked = issues.length - actionable;

  if (actionable > 0) {
    return `<p class="posture posture-warn"><strong>${actionable} server${
      actionable === 1 ? "" : "s"
    } need attention.</strong> Open the <code>ISSUE</code> badge on each for the store, the
      project and the resource name to create. Nothing here can be fixed by redeploying alone
      unless the value exists first.${
        unchecked
          ? ` A further ${unchecked} could not be checked at all — their popouts say which process would have to be asked.`
          : ""
      }</p>`;
  }

  return `<p class="posture posture-warn"><strong>Nothing is known to be broken, but ${unchecked} server${
    unchecked === 1 ? "" : "s"
  } could not be checked.</strong> That is not the same as healthy. <code>unknown</code> means
    the secret backend could not be consulted; <code>unverified</code> means the value
    this server runs on was not established — the component holding it did not answer, it
    runs an image without the presence route, or the server's credentials are managed
    parameters no component named. On the last of those some other name may well have
    resolved; it is not the one that decides. Each popout says which. Neither state is
    evidence that anything this server needs resolves.</p>`;
}

// ---------------------------------------------------------------------------
// One entry
// ---------------------------------------------------------------------------

/**
 * The badge occupies the slot the slug used to.
 *
 * On the majority of entries the config declares no `title:`, so the heading IS
 * the slug and printing it again in the foot was pure duplication — the badge is
 * what deserves that space. Where a `title:` does differ from the slug, the slug
 * still renders beside the badge, because there it is information rather than an
 * echo.
 */
function serverCard(entry: Entry, base: string, playable: boolean): string {
  const { server, status, hasView } = entry;
  const hasSecrets = serverLooksSecrets(server);
  const title = server.title ?? server.slug;
  const desc =
    server.description ??
    (hasSecrets
      ? "Add, rotate, reveal and delete the non-secret and secret parameters this server manages."
      : serverLooksGcs(server)
        ? "Browse the object store this server is scoped to."
        : "No browser view for this server kind yet.");
  const href = serverConsolePath(server.slug);

  return `  <div class="card server-card">
    <div class="card-head">
      <span class="card-title">${
        hasView
          ? `<a class="card-title-link" href="${href}">${esc(title)}</a>`
          : esc(title)
      }</span>
      <span class="chip chip-${esc(server.kind)}">${esc(server.kind)}</span>
      ${server.enabled ? "" : `<span class="chip chip-off">disabled</span>`}
    </div>
    <p class="card-desc">${esc(desc)}</p>
    ${status ? `<p class="card-status">${esc(status.summary)}</p>` : ""}
    <div class="card-foot">
      <span class="card-badges">${badgeMarkup(entry)}${
        title === server.slug
          ? ""
          : `<code class="card-slug">${esc(server.slug)}</code>`
      }</span>
      <span class="card-actions">${cardIcons(server, base, playable)}${
        hasView
          ? `<a class="card-cta" href="${href}">${hasSecrets ? "Manage →" : "Browse →"}</a>`
          : `<span class="card-muted">No view</span>`
      }</span>
    </div>
  </div>`;
}

/**
 * The two icons an entry can carry: poke at it, or take its URL. Each one is
 * offered only where the thing it offers can actually be done — an icon whose
 * entire job is "go do this" must not lead somewhere that refuses.
 *
 * THE TWO GATES ARE DIFFERENT, because the two icons address different
 * identities.
 *
 * The playground icon is gated on `playgroundAccess` — the same
 * `entitledServers` / `resolveSelection` pair the page itself decides on, on
 * this console session's principal. `enabled` alone is the narrower half of that
 * rule and offering on it leads to a 424: a mounted server whose `entitlements:`
 * omits the console's role, or a console whose `roles:` is the schema default
 * `[]`, is enabled and still not this identity's to open.
 *
 * The copy icon is gated on `enabled` alone, and deliberately NOT on console
 * entitlement. What it hands over is addressed to a TOKEN principal — a
 * different identity — so an admin copying the URL an agent's token will use is
 * doing something legitimate that their own roles say nothing about. `enabled`
 * is a property of the server rather than of the reader: a disabled server is
 * mounted for nobody, so its `?servers=` URL is one the gateway refuses whatever
 * token presents it.
 *
 * The copy icon carries NO CREDENTIAL. What lands on the clipboard is
 * `/mcp?servers=<slug>`, a public address; the bearer token is a separate header
 * the client supplies, and a token in a URL would outlive the paste in shell
 * history, proxy logs and screenshots. See connectUrl() in playground.ts.
 *
 * The copy icon needs an ORIGIN to be pasteable at all, so with neither
 * `gateway.publicUrl` nor a Host header it is omitted rather than rendered over
 * a relative path — `"/mcp?servers=gcs"` on the clipboard is a working link for
 * nobody.
 */
function cardIcons(
  server: ServerConfig,
  base: string,
  playable: boolean,
): string {
  const slug = server.slug;
  const url = server.enabled && base ? connectUrl(base, slug) : "";

  return `${
    playable
      ? `<a class="card-icon" href="${playgroundHref(slug)}"
        title="Playground — list this server's tools and call them, by hand"
        aria-label="Open the playground for ${esc(slug)}">${PLAY_SVG}</a>`
      : ""
  }${
    url
      ? `<button class="card-icon" type="button" data-copy data-url="${esc(url)}"
        title="Copy this server's MCP URL: ${esc(url)}"
        aria-label="Copy the MCP URL for ${esc(slug)}">${COPY_SVG}</button>`
      : ""
  }`;
}

/** Terminal-ish glyph: this is a console you poke at, not a media player. */
const PLAY_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
  focusable="false"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/></svg>`;

/** Two sheets. The universal copy glyph, and nothing cleverer. */
const COPY_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
  focusable="false"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

/**
 * One delegated listener for every copy icon on the page.
 *
 * Same behaviour as the landing page's, and deliberately the same shape: with no
 * JS the icon is a dead control, so the URL is also in the `title` tooltip,
 * where it can be read and selected by hand. The `<noscript>` block hides the
 * button rather than leaving a control that does nothing.
 */
const COPY_SCRIPT = `<script>
document.addEventListener("click", function (e) {
  if (!(e.target instanceof Element)) return;
  var btn = e.target.closest("[data-copy]");
  if (!btn) return;
  var text = btn.getAttribute("data-url");
  if (!text || !navigator.clipboard) return;
  navigator.clipboard.writeText(text).then(function () {
    btn.classList.add("is-copied");
    setTimeout(function () { btn.classList.remove("is-copied"); }, 1200);
  }, function () {});
});
</script>
<noscript><style>.card-icon[data-copy]{display:none}</style></noscript>`;

/**
 * Whether this entry gets a popout — asked ONCE, by both halves that care.
 *
 * The badge and the `<dialog>` list are rendered by different code a hundred
 * lines apart, and this is the predicate they have to agree on: a button whose
 * `data-fix-open` names an id nobody emitted is a control that swallows the
 * click and says nothing, which is precisely how `ISSUE` came to be dead on a
 * `params: true` server. Two copies of the rule is what let them drift; one
 * function is what stops it, and the drift is the bug rather than either copy.
 *
 * It is derived from WHAT fixDialog() WILL RENDER rather than from the state —
 * requirement rows, or an `unobservable` scope — so the two cannot disagree
 * about a state neither of them anticipated. Two entries have neither: a
 * `no-secrets` server, which is READY and references nothing, and a `params:
 * true` BUILTIN that declares no `${NAME}` beside its parameters, which is
 * `unverified` and gets no scope because core resolves those parameters itself
 * (see unobservableScope, and #264).
 */
function hasFixDialog(entry: Entry): boolean {
  const status = entry.status;
  if (!status) return false;
  return status.requirements.length > 0 || status.unobservable !== undefined;
}

/**
 * BOTH badges open, when there is something behind them.
 *
 * A READY entry carries a POSITIVE claim — this secret is plumbed, from this
 * source, established by this process, which booted then. That is the answer
 * someone came to the page for, so it gets a control; inert text would be the
 * same mistake as the shrug, information the console holds and does not show.
 *
 * A READY entry with no requirements (`no-secrets`) still has nothing behind it
 * and stays inert. A control that opens an empty panel is worse than no control.
 *
 * BOTH branches consult `hasFixDialog`, and that is the half that was missing.
 * The ISSUE branch returned a `<button>` unconditionally, so an entry with the
 * badge and nothing behind it named a `<dialog>` id nobody emitted and swallowed
 * the click. Asking on one branch only is what let the two rules drift.
 *
 * The inert ISSUE chip is a floor, not the fix. An entry that asserts "this
 * needs attention" and offers no way to find out why is the worse of the two
 * failures, so the real answer is that the popout is given something true to say
 * — see unobservableBlock(). One shape still takes this branch: a `params: true`
 * BUILTIN with no `${NAME}` of its own, which is `unverified` and gets no scope
 * because every sentence the panel knows how to say is about a component core is
 * not. Explaining that one honestly is #264.
 */
function badgeMarkup(entry: Entry): string {
  if (!entry.badge) return "";
  const openable = hasFixDialog(entry);
  if (entry.badge === "READY") {
    if (!openable) {
      return `<span class="chip chip-ok chip-badge" title="This server references no \${NAME}, so there is nothing to seed.">READY</span>`;
    }
    return `<button class="chip chip-ok chip-badge chip-button" type="button"
        data-fix-open="${esc(fixDialogId(entry.server.slug))}" aria-haspopup="dialog"
        title="Which secrets resolve, from which source, and which process established it">READY<span class="chip-caret">▾</span></button>`;
  }
  if (!openable) {
    return `<span class="chip chip-bad chip-badge" title="Something is outstanding for this server and this page holds no detail about it.">ISSUE</span>`;
  }
  return `<button class="chip chip-bad chip-badge chip-button" type="button"
        data-fix-open="${esc(fixDialogId(entry.server.slug))}" aria-haspopup="dialog"
        title="What needs to be done to resolve this">ISSUE<span class="chip-caret">▾</span></button>`;
}

function fixDialogId(slug: string): string {
  return `fix-${slug}`;
}

// ---------------------------------------------------------------------------
// The popout behind an ISSUE badge
// ---------------------------------------------------------------------------

/**
 * The one sentence at the top of a popout: what KIND of problem this is, and
 * therefore what kind of action closes it. The per-secret guidance below it is
 * specific; this frames it, because "not seeded" and "could not be checked" want
 * opposite responses and a reader who skims will act on the first line.
 */
const ISSUE_HEADLINE: Record<ServerState, string> = {
  ready:
    "Every secret this server needs was OBSERVED to resolve. Each row below says from which source — GSM or ENV — and which process established it. strad does not call the upstream, so this is not a claim that the credential is still accepted.",
  "no-secrets": "",
  missing:
    "A secret this server needs is not seeded. Create the value at the resource named below — the entry goes READY on the next load once it resolves.",
  unconfigured:
    "This server declared that it could deploy without a credential it has not been given, so the deploy shipped it INACTIVE rather than failing for the whole fleet. Nothing is broken and nothing will fix it but you: create the value at the resource named below, and the server starts serving on its own within a TTL — no redeploy, no PR.",
  unrenderable:
    "A secret this server needs EXISTS in the parameter store and its value cannot be read. This is neither absent nor healthy: creating it again fails with 409, and nothing that references it gets a value. Rotate it through the console, which rewrites the payload.",
  placeholder:
    "A secret this server needs resolves to evident filler. The gateway boots and lists tools normally and the upstream rejects every call, which looks like a broken server rather than an unset secret. Rotate it to a real credential.",
  unverified:
    "Nothing here is known to be broken — and nothing here was established either. This entry could not be checked from the console, which is not the same as healthy.",
  unknown:
    "The secret backend could not be consulted for this entry. Its status is unknown, NOT absent — do not seed anything on the strength of this until the backend answers.",
};

/**
 * `unverified`, for the entry where SOME of it was established.
 *
 * The rows below it are real observations and are about to say so, so the
 * headline cannot open by claiming nothing was. What it has to say instead is
 * narrower and more useful: what was checked is not the part this server takes
 * its credentials from.
 *
 * "THIS PAGE does not read", never "nothing could read it", and the distinction
 * is the whole reason this string is worded the way it is. `optionsFor` resolves
 * a `params: true` BUILTIN's namespace in this very process, per tool call,
 * through the resolver TTL — staging's `echo` exists to be watched that way — so
 * the wider claim would be flatly false about the one server most likely to show
 * this line. The zero-row summary beside it makes the same narrow claim for the
 * same reason.
 */
const PARTIAL_UNVERIFIED_HEADLINE =
  "The rows below were established, and they are not the part that decides this. " +
  "This server takes its credentials from a managed namespace THIS PAGE does not " +
  "read, so what it actually runs on was checked by nothing.";

/**
 * What is wrong, and what to do about it.
 *
 * A `<dialog>` rather than an inline expander, for the same reason the Help
 * control is one: the roster stays a roster, and the remediation — a store, a
 * project, a canonical path and two pasteable commands per secret — does not
 * have to fit in a grid cell. `showModal()` gives the focus trap, the backdrop
 * and Escape-to-close for free.
 *
 * EVERY requirement is listed, worst first — not only the outstanding ones. A
 * server carrying four secrets is ISSUE because of one of them, and "the other
 * three resolve" is part of the answer to "what do I do about this": it is the
 * difference between one value to seed and a connector nobody ever configured.
 */
function fixDialog(
  entry: Entry,
  config: StradConfig,
  env: NodeJS.ProcessEnv,
): string {
  const status = entry.status;
  if (!status) return "";
  const slug = entry.server.slug;
  const worstFirst = [...status.requirements].sort(
    (a, b) => STATE_RANK[b.state] - STATE_RANK[a.state],
  );

  const ready = status.state === "ready";
  // A FULLY ESTABLISHED SET OF ROWS UNDER AN `unverified` BADGE GETS ITS OWN
  // FIRST LINE. The `unverified` headline says "nothing here was established
  // either", and a reader who skims acts on the first line — so printing it over
  // a row reading "PLUMBED, established by this gateway process" is the popout
  // contradicting itself in two consecutive sentences.
  //
  // The condition is EVERY ROW `present`, not merely "has rows". An entry
  // carrying an `unobservable` row is `unverified` BECAUSE of that row, and the
  // ordinary headline is exactly right about it; only the managed-namespace gap
  // demotes an entry whose rows all resolved.
  //
  // Not keyed off `status.unobservable`, which would be the obvious thing and is
  // wrong: `unobservableScope()` builds no scope for a `params: true` BUILTIN,
  // whose parameters core resolves itself, so a builtin would silently fall back
  // to the headline that contradicts its own rows. Every-row-`present` is the
  // fact, and it holds for both kinds.
  const established =
    status.requirements.length > 0 &&
    status.requirements.every((o) => o.state === "present");
  const headline =
    status.state === "unverified" && established
      ? PARTIAL_UNVERIFIED_HEADLINE
      : ISSUE_HEADLINE[status.state];
  return `<dialog class="fixdlg" id="${esc(fixDialogId(slug))}" aria-label="${
    ready ? `What is plumbed for ${esc(slug)}` : `How to resolve ${esc(slug)}`
  }">
  <div class="helpdlg-head">
    <h2>${esc(slug)} · ${ready ? "what is plumbed" : "what to do"}</h2>
    <button class="btn" type="button" data-fix-close aria-label="Close">Close</button>
  </div>
  <div class="helpdlg-body">
    <p class="fix-headline">${esc(headline)}</p>
    <p class="sec-detail">${esc(status.summary)}</p>
${worstFirst.map((o) => requirementBlock(o, config, env, slug)).join("\n")}
${unobservableBlock(status, config, env)}
${
  entry.hasView
    ? `    <p class="acc-foot"><a href="${serverConsolePath(slug)}">Open this server's console view →</a></p>`
    : ""
}
  </div>
</dialog>`;
}

/**
 * The managed namespace nothing answered for, said in the panel that opens.
 *
 * A `params: true` server whose component named no parameters produces ZERO rows
 * for them, and until this existed the page rendered a button over an empty
 * panel it never emitted — the click went nowhere and the badge was a dead
 * control. The fix is not to take the control away: the banner above this grid
 * says in so many words that "their popouts say which process would have to be
 * asked", and an inert chip asserting "this needs attention" with no way to find
 * out why is the worse half of the trade. So the control stays and the panel
 * says the true thing instead — WHICH component holds the value, WHY this
 * process could not ask it, and WHERE to look rather than here.
 *
 * It renders BELOW the requirement rows, and on an entry that has some. Those
 * rows are about names this server references; this block is about the
 * credentials it runs on, which is a different question and the one the rows
 * cannot answer.
 *
 * Keyed off `unobservable` alone rather than off the row count as well: asking
 * twice is the same rule in two places, which is what `hasFixDialog` exists to
 * stop.
 */
function unobservableBlock(
  status: ServerSecretStatus,
  config: StradConfig,
  env: NodeJS.ProcessEnv,
): string {
  const scope = status.unobservable;
  if (!scope) return "";
  return `      <div class="sec-req">
        <div class="sec-req-head">
          <code class="sec-component">${esc(scope.component)}</code>
          <span class="chip chip-plain chip-route">not visible here</span>
          <span class="sec-delivery">${esc(UNOBSERVABLE_LABEL[scope.reason])}</span>
        </div>
        <p class="sec-detail">${esc(scope.detail)}</p>
        <p class="sec-evidence">Established by: nothing. This gateway process is not the component that holds these values, and it never sees them.</p>
${fixBlock(
  unobservableTarget(config, scope, env),
  "Check it here",
  "Look in the console →",
)}
      </div>`;
}

/** The probe outcome, in the few words that go beside the chip. */
const UNOBSERVABLE_LABEL: Record<UnobservableScope["reason"], string> = {
  unwired: "no private URL bound",
  unsupported: "image predates the presence route",
  unreachable: "component did not answer",
  unmanifested: "component manifested no parameters",
  silent: "component listed none for this slug",
};

const SECRET_CHIP_CLASS: Record<SecretState, string> = {
  present: "chip-ok",
  placeholder: "chip-warnish",
  missing: "chip-bad",
  unrenderable: "chip-bad",
  unobservable: "chip-plain",
  error: "chip-warnish",
};

const SECRET_LABEL: Record<SecretState, string> = {
  present: "plumbed",
  placeholder: "placeholder",
  missing: "not seeded",
  unrenderable: "cannot render",
  unobservable: "not visible here",
  error: "unknown",
};

/**
 * The secret-source badge.
 *
 * `GSM` / `ENV`, spelled exactly as Zimmer's Connectors page spells them, because
 * the workflow is to read that screen and this one and compare. A `title` carries
 * the expansion so the abbreviation is not a puzzle. Absent when the source could
 * not be established — that is the `error` state, and inventing a store there
 * would be the same class of lie as calling an unreachable backend "not seeded".
 */
function sourceBadge(source: SecretSource | null): string {
  if (!source) return "";
  return `<span class="chip chip-src chip-src-${esc(source.toLowerCase())}" title="${esc(
    SOURCE_TOOLTIP[source],
  )}">${esc(source)}</span>`;
}

/**
 * WHO established this row, and how current it is.
 *
 * The line exists because "plumbed" is not one claim, it is three with different
 * strengths, and a reader is entitled to know which they were handed:
 *
 *   core   — this process read the value out of its own environment. Strongest:
 *            nothing is between the claim and the fact.
 *   store  — the parameter store answered. True about the store; on a
 *            bundle-delivered name it is a claim about the NEXT deploy.
 *   bundle — the component that actually serves the request was asked and
 *            answered. The boot time is printed because a process older than the
 *            last render holds the previous deploy's environment, and that is
 *            precisely the case where "baked" and "held" come apart.
 *   none   — nothing established it. Printed rather than omitted: a row with no
 *            provenance line would read as one whose provenance was fine.
 */
function evidenceLine(evidence: SecretEvidence): string {
  switch (evidence.by) {
    case "core":
      return "Established by: this gateway process, reading its own environment.";
    case "store":
      return "Established by: the parameter store, read from this process.";
    case "bundle": {
      const who = evidence.component ?? "the component";
      const image = evidence.image ? `, image ${evidence.image}` : "";
      const booted = evidence.bootedAt ? `, up since ${evidence.bootedAt}` : "";
      return `Established by: ${who} itself, asked over the private network${image}${booted}. It reported presence, never a value.`;
    }
    case "none":
      return "Established by: nothing. No process was able to answer for this name.";
  }
}

/** Whether `/ui/<slug>` renders something, so the link is worth offering. */
function hasConsoleView(server: ServerConfig): boolean {
  return serverLooksGcs(server) || serverLooksSecrets(server);
}

function requirementBlock(
  observation: SecretObservation,
  config: StradConfig,
  env: NodeJS.ProcessEnv,
  /** The server whose entry this is, so "also required by" can exclude it. */
  slug: string,
): string {
  const { requirement, state, detail } = observation;
  // The OTHER servers that declare this same name — not this one, which the
  // reader is already looking at.
  const others = requirement.slugs.filter((s) => s !== slug);
  const shared = others.length
    ? `<p class="sec-shared">Also required by ${others
        .map((s) => `<code>${esc(s)}</code>`)
        .join(
          " ",
        )} — one secret, one problem, however many entries carry the badge.</p>`
    : "";

  // `unrenderable` is in `isActionable`, so a row that offered no resource, no
  // project and no console link would be telling a reader to act and then not
  // saying where. The fix targets are the same ones — it is the same parameter.
  const guidance =
    state === "missing" || state === "placeholder" || state === "unrenderable"
      ? fixTargets(config, requirement, env)
          .map((t) =>
            fixBlock(
              t,
              state === "placeholder" ? "Rotate it here" : "Set it here",
            ),
          )
          .join("\n")
      : "";

  // A MANAGED PARAMETER IS NOT A `${NAME}` REFERENCE, and the row says which it
  // is rather than printing both kinds the same way. It matters most where the
  // two collide: a `params: true` server can declare `${FOO}` and its component
  // can manifest a managed parameter also called `FOO`, and both rows now render
  // (#280) — one claiming the deployment resolves the reference, the other
  // reporting what the running container holds. Identical heads would make the
  // second look like a duplicate of the first, which is exactly the reading that
  // has to be impossible: they can disagree, and when they do the disagreement is
  // the news.
  const nameHead = requirement.managed
    ? `<code class="sec-var">${esc(requirement.name)}</code>
          <span class="chip chip-plain chip-route" title="A managed parameter resolved out of this server's static namespace and injected onto its component — not a \${NAME} reference.">managed parameter</span>`
    : `<code class="sec-var">\${${esc(requirement.name)}}</code>`;

  return `      <div class="sec-req">
        <div class="sec-req-head">
          ${nameHead}
          <span class="chip ${SECRET_CHIP_CLASS[state]} chip-route">${esc(SECRET_LABEL[state])}</span>
          ${sourceBadge(observation.source)}
          <span class="sec-delivery">${esc(requirement.deliveries.join(" + "))}</span>
        </div>
        <p class="sec-detail">${esc(detail)}</p>
        <p class="sec-evidence">${esc(evidenceLine(observation.evidence))}</p>
        ${shared}
${guidance}
      </div>`;
}

/**
 * Where to set it. A name, a project, a path — and a command to paste.
 *
 * The heading is the caller's, because the verb is not always "set": rotating a
 * placeholder is a different act from creating a missing value, and an entry the
 * console could not observe is not being told to write anything at all.
 */
function fixBlock(
  target: FixTarget,
  heading: string,
  linkLabel = "Do it in the console →",
): string {
  return `        <div class="sec-fix">
          <div class="sec-fix-head">${esc(
            heading,
          )}<span class="sec-fix-store">${esc(target.store)}</span></div>
          <dl class="sec-fix-dl">
            <dt>resource</dt><dd><code>${esc(target.resource)}</code></dd>
            <dt>project</dt><dd><code>${esc(target.project)}</code></dd>
          </dl>
          <p class="sec-fix-why">${esc(target.detail)}</p>
${
  target.commands.length
    ? `          <pre class="acc-code">${target.commands.map((c) => esc(c)).join("\n")}</pre>`
    : ""
}
${
  target.href
    ? `          <p class="acc-foot"><a href="${esc(target.href)}">${esc(linkLabel)}</a></p>`
    : ""
}
        </div>`;
}

// ---------------------------------------------------------------------------
// The gateway's own boot keys
// ---------------------------------------------------------------------------

/**
 * One boot key.
 *
 * An absent OPTIONAL key renders as "not set · optional" in the neutral chip, not
 * as a fault: `GOOGLE_CLIENT_ID` is genuinely absent on a deployment with no
 * console, and `scripts/render-spec.ts` omits it without complaint for exactly
 * that reason. Only `STRAD_TOKENS` and `STRAD_INTERNAL_TOKEN` are required, and
 * they are the two whose absence is silent at deploy time and obvious only in
 * production.
 */
function bootRow(entry: {
  observation: SecretObservation;
  required: boolean;
}): string {
  const { requirement, state, detail } = entry.observation;
  const optionalAbsent = state === "missing" && !entry.required;
  const chip = optionalAbsent ? "chip-plain" : SECRET_CHIP_CLASS[state];
  const label = optionalAbsent ? "not set · optional" : SECRET_LABEL[state];
  const text = optionalAbsent
    ? "Not set, and not required. Nothing on this deployment reads it unless the feature it belongs to is turned on."
    : detail;

  return `    <div class="row secret-row">
      <span class="row-name">${esc(requirement.name)}</span>
      <span class="chip ${chip} chip-route">${esc(label)}</span>
      ${sourceBadge(entry.observation.source)}
      ${entry.required ? `<span class="chip chip-warnish">required</span>` : ""}
      <span class="sec-detail sec-detail-inline">${esc(text)}</span>
    </div>`;
}

/**
 * Open and close the per-entry popouts.
 *
 * One delegated listener for every dialog on the page rather than one per card:
 * a 27-server roster would otherwise attach 27 handlers to do one thing. A
 * missing `showModal` falls back to the `open` attribute, the same degradation
 * the Help control takes — and with no JS at all the `<noscript>` block hides the
 * buttons and renders every panel inline, which is where the guidance lived
 * before there was a control.
 */
const FIX_DIALOG_SCRIPT = `<script>
(function () {
  document.addEventListener("click", function (e) {
    if (!(e.target instanceof Element)) return;
    var opener = e.target.closest("[data-fix-open]");
    if (opener) {
      var dlg = document.getElementById(opener.getAttribute("data-fix-open"));
      if (!dlg) return;
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
      return;
    }
    var closer = e.target.closest("[data-fix-close]");
    if (closer) {
      var own = closer.closest("dialog");
      if (!own) return;
      if (typeof own.close === "function") own.close();
      else own.removeAttribute("open");
      return;
    }
    // A click on the backdrop — outside the dialog's own box — closes it.
    if (e.target instanceof HTMLDialogElement && e.target.classList.contains("fixdlg")) {
      e.target.close();
    }
  });
})();
</script>
<noscript><style>
  .chip-button{display:none}
  .fixdlg{display:block;position:static;max-width:none;width:auto;margin:1.4rem 0;max-height:none}
  .fixdlg .helpdlg-head button{display:none}
  .fixdlg .helpdlg-body{max-height:none;overflow:visible}
</style></noscript>`;

/**
 * The guide, behind the Help control in the top right.
 *
 * It exists to make the badges honest in prose as well as in markup — in
 * particular that READY is a statement about presence and nothing else, and that
 * an ISSUE reading "not visible here" is a scoping fact rather than a fault.
 */
const GUIDE = `
  <details class="acc" open>
    <summary>What READY and ISSUE actually claim</summary>
    <div class="acc-body">
      <ul>
        <li><b>READY</b> — every <code>\${NAME}</code> this server references resolves to a
          value, or it references none at all. It is <b>not</b> a claim that the credential
          works: strad never calls the upstream to check. A server that lists tools and fails
          every call with an auth error is exactly the shape this badge cannot rule out.</li>
        <li><b>ISSUE</b> — anything else. Click it: the popout names the secret, the state,
          and the exact store, project and path to fix. Four things land here, and they are
          not the same problem:
          <ul>
            <li><b>not seeded</b> — the backend answered, and there is no such secret. The one
              unambiguous state, and the one the fix guidance is really for.</li>
            <li><b>placeholder</b> — a value exists and is evidently filler (an unexpanded
              <code>\${...}</code>, a well-known "change-me" string, an empty string). Seeded
              is not working; this is what a boot-fine-then-401 server looks like from here.</li>
            <li><b>not visible here</b> — the value is scoped to a component this process is
              not. A supplementary image's <code>env:</code> is baked onto that container at
              deploy time and never broadcast to core, so the console cannot confirm it either
              way. It was present at the last successful deploy, because a missing one fails
              the render.</li>
            <li><b>unknown</b> — the secret backend could not be consulted. Not absent.</li>
          </ul>
        </li>
      </ul>
      <p>The last two are not faults, and they are still not READY. A badge that went green on
        "I could not check" would be the one lie this page cannot afford: its whole value is
        that green means observed.</p>
    </div>
  </details>
  <details class="acc">
    <summary>The icons an entry can carry</summary>
    <div class="acc-body">
      <ul>
        <li><b>Playground</b> — opens a human MCP client for that one server: the tools it
          actually serves you, and a field to call them with. No model is involved; you pick
          the tool and write the arguments. The session runs inside this process against the
          same <code>Server</code> object <code>/mcp</code> builds, so entitlements and the
          <code>tools:</code> capability policy apply exactly as they do to an agent. A call
          from there is <b>real</b> — same upstream, same credentials, same side effects.</li>
        <li><b>Copy</b> — puts <code>&lt;gateway&gt;/mcp?servers=&lt;slug&gt;</code> on the
          clipboard: the address of that one server, for Claude Desktop, Cursor or any other
          MCP client. It carries <b>no credential</b>. A token in a URL survives in shell
          history, proxy logs, a <code>Referer</code> header and any screenshot of the address
          bar, so the client sends its own <code>Authorization: Bearer …</code>, minted with
          <code>npm run token:mint</code>.</li>
      </ul>
      <p>They are offered on different rules, because they address different identities. The
        playground icon is on the entries <b>your console session</b> may open — the same
        entitlement check the page itself makes — so an entry your roles do not reach keeps its
        card and loses the icon rather than sending you to a 424. The copy icon is on every
        ENABLED entry, whatever your roles: what it copies is for an agent's token to present,
        and that is not your identity. A DISABLED entry has neither, because strad mounts it for
        nobody.</p>
    </div>
  </details>
  <details class="acc">
    <summary>How the entries are ordered</summary>
    <div class="acc-body">
      <p>READY first, then ISSUE. Within each group, servers with a console view come before
        servers without one, and config order breaks the remaining ties. Disabled servers sort
        last and carry no badge — strad does not mount them, so they need no secrets, and a
        green would be a claim about a server that answers nothing.</p>
    </div>
  </details>
  <details class="acc">
    <summary>The GSM / ENV badge, and why those exact letters</summary>
    <div class="acc-body">
      <p>Inside a popout, each secret carries a badge naming <b>which store holds it</b> — not
        its status, which is the chip beside it.</p>
      <ul>
        <li><b>GSM</b> — Google Secret Manager holds the bytes. Either read at runtime
          through the parameter store (whose secret parameters are <code>__REF__</code>
          pointers into Secret Manager), or seeded as
          <code>strad-&lt;env&gt;-&lt;NAME&gt;</code> and baked into the app spec at deploy
          time. On a <code>not seeded</code> row it names where the value has to go.</li>
        <li><b>ENV</b> — strad reads it straight out of its own process environment. Every
          <code>consoleEnv:</code> name is ENV by design: it is read from the deploy
          environment only and never from the store, because it carries the console's
          store-admin credential.</li>
      </ul>
      <p>These are the same two labels Zimmer's Connectors page uses, and that is the whole
        reason for the abbreviation. The workflow is to read that screen and then this one
        and compare, so a divergent spelling would defeat the badge. Zimmer additionally
        shows <code>Rails Credentials</code>; strad has no equivalent and never shows it.</p>
      <p>An <code>unknown</code> row carries no badge. A backend that could not be consulted
        cannot be named as the source either.</p>
    </div>
  </details>
  <details class="acc">
    <summary>Why one unseeded secret lights up several entries</summary>
    <div class="acc-body">
      <p>Every capability variant of a server family declares its credentials identically, on
        purpose: a component's environment is the union of its servers' <code>env:</code> maps,
        so with the secret on only one variant, setting <code>enabled: false</code> on THAT
        variant would silently strip it from its siblings — which would keep listing their
        tools and fail every call with an auth error naming no cause.</p>
      <p>So one <code>\${NAME}</code> legitimately makes several entries ISSUE at once. Each
        popout says which other entries share it: one unseeded secret behind four badges is
        one problem, not four.</p>
    </div>
  </details>
  <details class="acc">
    <summary>Where a value has to be set, and when it lands</summary>
    <div class="acc-body">
      <p>There is one secret path per deployment, and it is what
        <code>gateway.secrets.provider</code> declares.</p>
      <ul>
        <li><b>env</b> — the deploy workflow loads every <code>strad-&lt;env&gt;-*</code> secret
          from GCP Secret Manager and <code>scripts/render-spec.ts</code> bakes each referenced
          name into the app spec as a SECRET env var. A new value needs a redeploy.</li>
        <li><b>gcp-parameter-store</b> — the gateway reads the value at runtime from
          <code>/strad/&lt;env&gt;/gateway/static/</code>. A new value lands within
          <code>negativeTtlSeconds</code>, no deploy at all — and the same path is what the
          next deploy's preflight checks.</li>
      </ul>
      <p>A <code>consoleEnv:</code> name is neither: it is read from the deploy environment
        only, never from the store, because it carries the console's store-admin credential
        and filing that inside the store would let the weaker resolver credential read the
        stronger one.</p>
    </div>
  </details>
  <details class="acc">
    <summary>The machine-readable answer</summary>
    <div class="acc-body">
      <p><code>GET /api/secrets/readiness</code> returns this same derivation as JSON, for a
        platform app that needs to know whether Google Secret Manager and Parameter Manager
        are wired up without a human reading a page. It takes a static bearer token — the same
        credential shape <code>/mcp</code> takes — because its consumer is a machine and the
        Google-SSO path guards the human console alone.</p>
      <p>It prints names, paths and states. It never prints a value, for the same reason this
        page does not.</p>
    </div>
  </details>
  <details class="acc">
    <summary>No value is ever shown here</summary>
    <div class="acc-body">
      <p>This is a status and guidance page. It prints secret NAMES and canonical PATHS,
        because naming the missing thing is its entire job — and it prints no value, ever.
        The placeholder check reads a value and returns a sentence about the shape it
        matched, never the bytes.</p>
      <p>Use <a href="/ui/secrets">the parameters console</a> to add or rotate a value.</p>
    </div>
  </details>`;

/**
 * Page-local styles.
 *
 * Scoped here rather than added to the shared theme because every class below is
 * for this index and nothing else renders one. The tokens (<code>--g*</code>,
 * <code>--accent</code>) come from the shared theme, so the page cannot drift
 * from the rest of the console.
 */
const INDEX_CSS = `<style>
.chip-bad{color:#e8776b;border-color:color-mix(in srgb,#e8776b 45%,var(--g5))}
.chip-ok{color:var(--text-accent);border-color:color-mix(in srgb,var(--accent) 45%,var(--g5))}
.stat-ready{color:var(--text-accent)}
.stat-missing{color:#e8776b}
/* The entry badge sits where the duplicated slug used to. Loud on purpose: on a
   27-entry grid it is the one thing that varies from card to card. */
.chip-badge{font-weight:600;letter-spacing:.08em}
.chip-button{cursor:pointer;background:none;font-family:var(--font-mono);
  display:inline-flex;align-items:center;gap:.3rem}
.chip-button:hover{border-color:#e8776b;background:color-mix(in srgb,#e8776b 12%,transparent)}
.chip-button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.chip-caret{font-size:.6rem;opacity:.75}
.server-card{gap:.55rem}
.card-title-link{color:inherit;text-decoration:none}
.card-title-link:hover{color:var(--text-accent)}
.card-status{color:var(--g3);font-size:.78rem;margin:0;line-height:1.5}
/* Two more controls landed in the foot, so it wraps rather than squeezing a
   long slug into two lines beside them. */
.server-card .card-foot{flex-wrap:wrap;gap:.5rem}
.card-badges{display:flex;align-items:center;gap:.4rem}
.card-slug{font-size:.72rem;color:var(--g4);white-space:nowrap}
/* The two icons and the CTA share the foot's right-hand side. Quiet until
   hovered: on a 27-card grid two loud glyphs per card is a wall of teal. */
.card-actions{display:flex;align-items:center;gap:.5rem}
.card-icon{display:inline-flex;align-items:center;justify-content:center;
  width:1.7rem;height:1.7rem;padding:0;border:1px solid var(--g5);border-radius:.35rem;
  background:none;color:var(--g3);cursor:pointer;text-decoration:none}
.card-icon:hover{color:var(--text-accent);border-color:color-mix(in srgb,var(--accent) 55%,var(--g5))}
.card-icon:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.card-icon.is-copied{color:var(--text-accent);
  border-color:color-mix(in srgb,var(--accent) 70%,var(--g5))}
.fixdlg{border:1px solid var(--g5);border-radius:.7rem;background:var(--g7);color:var(--g1);
  max-width:46rem;width:calc(100% - 2rem);padding:0}
.fixdlg::backdrop{background:rgba(0,0,0,.6)}
/* A gcloud line is ~110 characters and the whole point of it is that it can be
   copied. Clipped at the dialog's edge it is worse than absent — it looks
   complete and is not. */
.fixdlg .acc-code{white-space:pre-wrap;word-break:break-word}
.fix-headline{color:var(--white);font-size:.92rem;line-height:1.6;margin:0 0 .6rem}
.sec-req{border-top:1px solid var(--g6);padding:.85rem 0 .3rem}
.sec-req-head{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap}
.sec-var{color:#e0a63b;font-size:.8rem}
/* A COMPONENT name, not a variable. Deliberately not .sec-var's amber: that slot
   holds a variable everywhere else on this page, and a reader who has opened one
   popout would read this one as a secret nobody named. */
.sec-component{color:var(--g3);font-size:.8rem}
.sec-delivery{font-family:var(--font-mono);font-size:.7rem;color:var(--g4);
  text-transform:uppercase;letter-spacing:.05em}
/* The secret-source badge. Same two labels Zimmer's Connectors page uses, so the
   two screens can be read side by side. Deliberately quiet: it is provenance,
   not status, and it must not compete with the state chip beside it. */
.chip-src{font-weight:500;cursor:help;border-style:solid}
.chip-src-gsm{color:#9db4e8;border-color:color-mix(in srgb,#9db4e8 42%,var(--g5))}
.chip-src-env{color:var(--g2);border-color:var(--g5)}
.sec-detail{color:var(--g2);font-size:.82rem;margin:.45rem 0 0;line-height:1.55}
.sec-detail-inline{flex:1 1 100%;margin:.2rem 0 0;color:var(--g3);font-size:.78rem}
.sec-shared{color:var(--g3);font-size:.78rem;margin:.35rem 0 0}
.sec-evidence{color:var(--g3);font-size:.75rem;margin:.3rem 0 0;font-style:italic}
.sec-fix{margin:.7rem 0 .2rem;padding:.7rem .9rem;border:1px solid var(--g5);
  border-left:3px solid var(--accent);border-radius:.4rem;background:var(--g6)}
.sec-fix-head{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;
  font-weight:600;color:var(--white);font-size:.85rem}
.sec-fix-store{font-weight:400;color:var(--g3);font-size:.76rem}
.sec-fix-dl{display:grid;grid-template-columns:auto 1fr;gap:.15rem .7rem;margin:.55rem 0 0}
.sec-fix-dl dt{color:var(--g4);font-size:.7rem;text-transform:uppercase;letter-spacing:.05em}
.sec-fix-dl dd{margin:0;font-size:.8rem;word-break:break-all}
.sec-fix-why{color:var(--g2);font-size:.79rem;margin:.55rem 0 0;line-height:1.55}
.secret-row .sec-detail-inline{padding-left:0}
</style>`;
