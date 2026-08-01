import type { ServerConfig, StradConfig } from "../config/schema.ts";
import { esc, layout } from "./render.ts";
import { serverLooksGcs, serverLooksSecrets } from "./resolve.ts";
import {
  fixTargets,
  isActionable,
  SOURCE_TOOLTIP,
  STATE_RANK,
  storeProject,
  type FixTarget,
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
  signedInAs?: string;
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
    ? sorted.map((e) => serverCard(e)).join("\n")
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
  token.</p>

${sorted
  .filter((e) => e.status && e.status.requirements.length > 0)
  .map((e) => fixDialog(e, config, opts.env))
  .join("\n")}
${FIX_DIALOG_SCRIPT}
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
    the secret backend could not be consulted; <code>unverified</code> means nothing
    established the value — the component holding it did not answer, it runs an image
    without the presence route, or the server's credentials are managed parameters no
    component named. Each row says which. Neither is evidence that anything resolves.</p>`;
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
function serverCard(entry: Entry): string {
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
  const href = `/ui/${encodeURIComponent(server.slug)}`;

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
      ${
        hasView
          ? `<a class="card-cta" href="${href}">${hasSecrets ? "Manage →" : "Browse →"}</a>`
          : `<span class="card-muted">No view</span>`
      }
    </div>
  </div>`;
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
 */
function badgeMarkup(entry: Entry): string {
  if (!entry.badge) return "";
  const openable = (entry.status?.requirements.length ?? 0) > 0;
  if (entry.badge === "READY") {
    if (!openable) {
      return `<span class="chip chip-ok chip-badge" title="This server references no \${NAME}, so there is nothing to seed.">READY</span>`;
    }
    return `<button class="chip chip-ok chip-badge chip-button" type="button"
        data-fix-open="${esc(fixDialogId(entry.server.slug))}" aria-haspopup="dialog"
        title="Which secrets resolve, from which source, and which process established it">READY<span class="chip-caret">▾</span></button>`;
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
  return `<dialog class="fixdlg" id="${esc(fixDialogId(slug))}" aria-label="${
    ready ? `What is plumbed for ${esc(slug)}` : `How to resolve ${esc(slug)}`
  }">
  <div class="helpdlg-head">
    <h2>${esc(slug)} · ${ready ? "what is plumbed" : "what to do"}</h2>
    <button class="btn" type="button" data-fix-close aria-label="Close">Close</button>
  </div>
  <div class="helpdlg-body">
    <p class="fix-headline">${esc(ISSUE_HEADLINE[status.state])}</p>
    <p class="sec-detail">${esc(status.summary)}</p>
${worstFirst.map((o) => requirementBlock(o, config, env, slug)).join("\n")}
${
  entry.hasView
    ? `    <p class="acc-foot"><a href="/ui/${encodeURIComponent(slug)}">Open this server's console view →</a></p>`
    : ""
}
  </div>
</dialog>`;
}

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
          .map((t) => fixBlock(t, state))
          .join("\n")
      : "";

  return `      <div class="sec-req">
        <div class="sec-req-head">
          <code class="sec-var">\${${esc(requirement.name)}}</code>
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

/** Where to set it. A name, a project, a path — and a command to paste. */
function fixBlock(target: FixTarget, state: SecretState): string {
  return `        <div class="sec-fix">
          <div class="sec-fix-head">${esc(
            state === "placeholder" ? "Rotate it here" : "Set it here",
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
    ? `          <p class="acc-foot"><a href="${esc(target.href)}">Do it in the console →</a></p>`
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
.card-badges{display:flex;align-items:center;gap:.4rem}
.card-slug{font-size:.72rem;color:var(--g4)}
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
