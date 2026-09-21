import type { Principal } from "../auth/index.ts";
import type { ServerConfig, StradConfig } from "../config/schema.ts";
import type { EntrySource, ServerOverlay } from "../config/overlay.ts";
import { RUNTIME_CREATABLE_KINDS } from "../config/overlay.ts";
import { connectorFor } from "../connectors/index.ts";
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
import { connectorsPath, serverConsolePath } from "./paths.ts";
import { serverLooksGcs, serverLooksSecrets } from "./resolve.ts";
import { flashHtml, kindBlurb, type Flash } from "./servers-page.ts";
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
 * `/connectors` — the console's one view of the servers this gateway serves:
 * every entry, what it is scoped to, whether the secrets it needs are actually
 * there, and — where the deployment keeps its roster in a store — the controls
 * to add, edit, disable and remove one.
 *
 * ## Why it is one page and not three
 *
 * Split three ways, the first two are the same list of servers answering
 * different questions: one listing every slug as a directory tile, one listing
 * every slug again with its scope and secret status, one listing every slug a
 * third time with the editor controls. Nobody wants any of those in isolation —
 * you read a status in order to decide what to change, and you change an entry
 * whose status you are looking at. So the status is on the entry, the editor is
 * on the entry, and `/` is a splash carrying the one thing that is about no
 * particular server: the endpoint to paste into a client. `/ui` and `/secrets`
 * redirect here, because both URLs were published.
 *
 * ## It answers on every deployment
 *
 * `gateway.configStore.enabled` gates the EDITOR, never the view. A deployment
 * whose roster comes from the checked-in document still gets every row, every
 * badge and every popout; what it loses is the Edit / Disable / Remove controls
 * and the "add a connector" menu, and the page says which of the two it is.
 * Making the whole page conditional would mean a deployment without a config
 * store had nowhere to read a secret status at all.
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
 * ## Why it prints secret names and the splash does not
 *
 * `/` is deliberately narrow — no slugs, no `env:` keys, no urls, no headers
 * (test/landing.test.ts asserts each absence) — because it is a splash and a
 * splash needs none of that. Naming the missing secret and the exact path it
 * goes at is this page's entire job, so it prints NAMES and PATHS. It is behind
 * `requireConsoleUi`, and the line it holds instead is the one that matters:
 * **no secret VALUE is ever rendered.** Not revealed, not excerpted, not
 * length-hinted, not in a title attribute. The status derivation
 * (secret-status.ts) reads values to spot a placeholder and returns sentences
 * about shapes; nothing here can print bytes because nothing here is ever handed
 * any.
 */

/**
 * The roster half: what the runtime holder says about the entries, and what may
 * be done to them. Absent when this deployment keeps no roster in a store —
 * which takes the controls away and leaves everything else standing.
 */
export interface RosterState {
  overlay: ServerOverlay;
  sources: Map<string, EntrySource>;
  /** False when this gateway holds no admin credential to write the overlay. */
  writable: boolean;
}

export interface ConnectorsPageOptions {
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
   * Roles are not a console ACL — every signed-in principal sees every row. It
   * is here for the ONE control that issues MCP calls rather than rendering
   * config: the playground icon, which is offered only where the playground
   * opens. See rowIcons().
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
  /** The roster editor's state, absent on a deployment with no config store. */
  roster?: RosterState;
  /** The outcome of the write that redirected here, if this is one. */
  flash?: Flash;
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

/** One entry on the roster: a server, and what is known about its secrets. */
export interface Entry {
  server: ServerConfig;
  /** Absent for a DISABLED server, which is not on the secret roster at all. */
  status?: ServerSecretStatus;
  badge?: EntryBadge;
  /** What `/ui/<slug>` renders for this server. Part of the sort key. */
  view: ConsoleView;
}

/**
 * What `/ui/<slug>` renders for a server. Every slug has a page; three kinds of
 * server have a DEDICATED one, and everything else gets the read-only overview.
 */
export type ConsoleView = "connector" | "secrets" | "gcs" | "overview";

/**
 * Asked in the order `handleServerView` in `src/ui/index.ts` asks it: an
 * enabled `oauth:` connector first, then the parameter store, then the bucket.
 * A row that reads a slug differently from the route labels a working page as
 * something else, so this is the one reading both use.
 */
export function consoleView(
  config: StradConfig,
  server: ServerConfig,
): ConsoleView {
  if (connectorFor(config, server.slug)) return "connector";
  if (serverLooksSecrets(server)) return "secrets";
  if (serverLooksGcs(server)) return "gcs";
  return "overview";
}

/**
 * Which heading an entry is drawn under — asked ONCE, by both halves that care.
 *
 * The sort and the grouping are the same question and must not be able to
 * disagree about it: a partition the sort does not follow interleaves rows under
 * the wrong heading, and — worse — a partition with a hole DROPS an entry off
 * the page entirely, silently, while the counts above it keep saying it is
 * there. So this is total by construction: three values, `enabled` decides one
 * of them and the badge decides the other two.
 *
 * `undefined` lands in `attention` rather than `ready`, and that is the case
 * worth stating. `deriveServerStatuses` returns a status for every enabled
 * server today, so a badgeless enabled entry is a shape nothing produces — but
 * if one ever appears, nothing was established about it, which is precisely what
 * ISSUE means everywhere else on this page. Green would be the false green
 * `src/ui/secret-status.ts` exists to prevent.
 */
type GroupKey = "attention" | "ready" | "disabled";

function groupOf(entry: Entry): GroupKey {
  // A DISABLED server carries no badge — strad does not mount it, so it needs no
  // secrets and `deriveServerStatuses` skips it. Reporting it READY would be a
  // green for a server that answers nothing.
  if (!entry.server.enabled) return "disabled";
  return entry.badge === "READY" ? "ready" : "attention";
}

/**
 * Needs attention before READY; within each group, entries with a dedicated view
 * first, and config order breaks the remaining ties.
 *
 * Sorting the greens to the top would be pleasant and backwards: this is a
 * working surface, the entries that need something done to them are the reason
 * anyone opens it, and on a 35-entry roster the ones that do not fit on the
 * first screen would be precisely the ones worth reading.
 */
export function sortEntries(entries: Entry[]): Entry[] {
  // Array.prototype.sort is stable, so config order survives inside a rank.
  return [...entries].sort((a, b) => entryRank(a) - entryRank(b));
}

const GROUP_RANK: Record<GroupKey, number> = {
  attention: 0,
  ready: 2,
  disabled: 4,
};

function entryRank(e: Entry): number {
  if (!e.server.enabled) return GROUP_RANK.disabled;
  return GROUP_RANK[groupOf(e)] + (e.view === "overview" ? 1 : 0);
}

/** The three groups the rows are drawn under, worst first. */
const GROUPS: { key: GroupKey; label: string; note: string }[] = [
  {
    key: "attention",
    label: "Needs attention",
    note: "a secret does not resolve, or could not be checked",
  },
  {
    key: "ready",
    label: "Ready",
    note: "every ${NAME} this entry references was observed to resolve",
  },
  {
    key: "disabled",
    label: "Disabled",
    note: "declared and not mounted — no badge, because nothing is asked of it",
  },
];

export function renderConnectors(opts: ConnectorsPageOptions): string {
  const { config, statuses, roster } = opts;
  const bySlug = new Map(statuses.map((s) => [s.server.slug, s]));

  const sorted = sortEntries(
    config.servers.map((server) => {
      const status = bySlug.get(server.slug);
      return {
        server,
        status,
        badge: status ? badgeFor(status.state) : undefined,
        view: consoleView(config, server),
      };
    }),
  );

  const readyCount = sorted.filter((e) => e.badge === "READY").length;
  const issues = sorted.filter((e) => e.badge === "ISSUE");
  const { project, guessed } = storeProject(config, opts.env);
  // Where this gateway lives, for the copy icon. Config first, then the origin
  // the request arrived on — see ConnectorsPageOptions.requestOrigin.
  const base = originFor(config, opts.requestOrigin);
  // Once for the whole roster, not once per row: every icon is a question about
  // the same principal, and `entitledServers` walks every server for each call.
  const entitled = entitledServers(opts.principal, config);
  const editable = roster !== undefined;
  const writable = roster?.writable === true;

  const rows = GROUPS.map((group) => {
    const members = sorted.filter((e) => groupOf(e) === group.key);
    if (members.length === 0) return "";
    return `  <tbody>
    <tr class="conn-group"><td colspan="4"><span class="conn-group-l">${esc(group.label)}</span><span class="conn-group-n">${members.length}</span><span class="conn-group-note">${esc(group.note)}</span></td></tr>
${members
  .map((e) =>
    serverRow(e, {
      base,
      playable: playgroundAccess(config, entitled, e.server.slug).ok,
      source: roster?.sources.get(e.server.slug),
      editable,
      writable,
    }),
  )
  .join("\n")}
  </tbody>`;
  })
    .filter(Boolean)
    .join("\n");

  const body = `
${flashHtml(opts.flash)}
<section class="intro">
  <h1>Connectors <span class="env-badge">${esc(config.gateway.env)}</span></h1>
  <p class="lede">Every MCP server this gateway serves, what it is scoped to, and whether
    its secrets are seeded. A badge claims <em>presence</em> and never that an upstream still
    accepts a credential — open one for the detail, or Help for the rest.</p>
</section>

${summaryBar(readyCount, issues.length, statuses.length, roster)}

${banner(issues, statuses.length)}
${editorNote(editable, writable)}

<table class="conn-table">
  <thead><tr>
    <th>Server</th><th>Scope</th><th>Secrets</th><th></th>
  </tr></thead>
${rows || `  <tbody><tr><td colspan="4" class="empty">No servers are configured on this gateway.</td></tr></tbody>`}
</table>
${removedSection(roster)}
${addMenu(writable)}

<section class="panel">
  <div class="panel-head">
    <h2>The gateway itself</h2>
    <span class="panel-note">boot keys</span>
  </div>
  <p class="copy-note">Not any server's secrets — strad's own. Without
    <code>STRAD_TOKENS</code> every <code>/mcp</code> request is rejected and no amount of
    per-server <code>READY</code> above means anything. That one is a roster rather than a
    value: <a href="/tokens">the tokens console</a> shows which credentials are live, mints
    one, and revokes one. A key marked <code>not set · optional</code> is absent and not
    required: nothing on this deployment reads it unless the feature it belongs to is
    turned on.</p>
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
${ROSTER_CSS}`;

  return layout({
    title: "Connectors",
    wide: true,
    body,
    signedInAs: opts.signedInAs,
    nav: "connectors",
    brandHref: "/",
    brandSub: "console",
    footNote: "status and guidance · never values",
    helpTitle: "Connectors guide",
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

/**
 * Three numbers, and — where there is a runtime holder — where the roster came
 * from and when it last moved.
 *
 * The revision is on the same bar as the counts rather than in a line of its own
 * because it is the same kind of fact: a small, current number describing the
 * list below it.
 */
function summaryBar(
  ready: number,
  issues: number,
  total: number,
  roster: RosterState | undefined,
): string {
  const meta = roster
    ? `<div class="conn-rev">runtime roster · revision ${esc(
        String(roster.overlay.revision),
      )}${roster.overlay.updatedBy ? ` · ${esc(roster.overlay.updatedBy)}` : ""}${
        roster.overlay.updatedAt ? ` · ${esc(roster.overlay.updatedAt)}` : ""
      }</div>`
    : `<div class="conn-rev">roster from the checked-in config</div>`;

  return `<div class="browse-head">
  <div class="stat"><span class="stat-n">${total}</span><span class="stat-l">enabled server${total === 1 ? "" : "s"}</span></div>
  <div class="stat"><span class="stat-n stat-ready">${ready}</span><span class="stat-l">ready</span></div>
  <div class="stat"><span class="stat-n stat-missing">${issues}</span><span class="stat-l">issue${issues === 1 ? "" : "s"}</span></div>
  ${meta}
</div>`;
}

/**
 * Which half of this page the deployment has, said once and near the top.
 *
 * Three states rather than two. An editable, writable roster says nothing — the
 * controls on every row are the statement. A gateway with a store it cannot
 * WRITE is the loud one: the rows look editable and a save has nowhere to go. A
 * gateway with no store at all is neither broken nor editable, and the note is
 * what keeps a reader from hunting for controls that were never going to be
 * there.
 */
function editorNote(editable: boolean, writable: boolean): string {
  if (writable) return "";
  if (editable) {
    return `<div class="flash flash-error">
    <div>This gateway cannot write the roster.</div>
    <ul class="ex-why"><li>It holds no admin parameter credential
    (<code>SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON</code>), so a change here
    would have nowhere to go. The roster below is what the deployment is
    serving; editing it needs that credential on this component.</li></ul>
  </div>`;
  }
  return `<p class="posture">This gateway sets no <code>gateway.configStore:</code>, so its
    roster comes from the checked-in document and changes with a deploy. Everything below is
    still live — the entries, their scope, and the secret status of each — there is just
    nothing here to edit.</p>`;
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
 * one — and "Every server is READY" over an empty table is an unearned green of
 * exactly the kind this module refuses everywhere else. Nothing was checked
 * because there was nothing to check, and that is what it says.
 */
function banner(issues: Entry[], enabled: number): string {
  if (enabled === 0) {
    return `<p class="posture">No servers are enabled on this gateway, so there is nothing
      to seed and nothing to report. Add one below or to <code>servers:</code> in the config,
      and its secrets appear here.</p>`;
  }

  if (issues.length === 0) {
    return `<p class="posture"><strong>Every server is READY.</strong> Every
      <code>\${NAME}</code> the config references was checked and has a value; each popout
      says where it was found (<code>GSM</code> or <code>ENV</code>) and which process
      checked. strad does not call any upstream, so this does not show a credential is still
      accepted. If a server lists tools but fails every call with a 401, suspect the
      credential itself.</p>`;
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
    } need attention.</strong> Open the <code>ISSUE</code> badge on each to see what is
      missing, where to set it, and in which project where this page can know it. Redeploying
      alone fixes none of these until the value exists.${
        unchecked
          ? ` Another ${unchecked} could not be checked; their popouts say how to check them.`
          : ""
      }</p>`;
  }

  return `<p class="posture posture-warn"><strong>${unchecked} server${
    unchecked === 1 ? "" : "s"
  } could not be checked.</strong> Nothing is known to be broken, and nothing is confirmed
    healthy either. <code>unknown</code> means the secret store did not answer.
    <code>unverified</code> means this page could not see the values the server runs on:
    the component holding them did not answer, runs an image too old to report them, or
    the server uses managed parameters no component listed. Each popout says which, and
    how to check.</p>`;
}

// ---------------------------------------------------------------------------
// The roster editor's own sections
// ---------------------------------------------------------------------------

/**
 * The slugs the checked-in config declares and the overlay subtracts.
 *
 * Without this the table iterates `config.servers`, which by definition no
 * longer holds them — so a removed server is not shown as removed, it is shown
 * as nothing at all, and the only clue that the file's entry is not serving is
 * its absence. A standing instruction to subtract something should be visible to
 * the person who has to reason about the file.
 */
function removedSection(roster: RosterState | undefined): string {
  if (!roster || roster.overlay.servers.removals.length === 0) return "";
  const rows = roster.overlay.servers.removals
    .map(
      (slug) => `    <tr>
      <td class="conn-slug"><span class="conn-name conn-name-off">${esc(slug)}</span>
        <p class="conn-desc">Declared in the checked-in config, removed here.</p></td>
      <td class="conn-scope"><span class="chip chip-off">removed</span></td>
      <td></td>
      <td>${
        roster.writable
          ? `<div class="conn-acts"><form method="post" action="${esc(connectorsPath(slug, "restore"))}">
             <button class="btn-ghost" type="submit">Restore</button>
           </form></div>`
          : ""
      }</td>
    </tr>`,
    )
    .join("\n");

  return `
<section class="panel">
  <div class="panel-head">
    <h2>Removed</h2>
    <span class="panel-note">${roster.overlay.servers.removals.length} subtracted from the file</span>
  </div>
  <p class="copy-note">These are declared in the checked-in config and subtracted here. The
    removal stands until somebody deletes the entry from the file or restores it.</p>
  <table class="conn-table">
    <tbody>
${rows}
    </tbody>
  </table>
</section>`;
}

/** The three kinds a runtime write may create, each with what it can and cannot do. */
function addMenu(writable: boolean): string {
  if (!writable) return "";
  return `
<section class="panel">
  <div class="panel-head">
    <h2>Add a connector</h2>
    <span class="panel-note">applied without a deploy</span>
  </div>
  <div class="card-grid card-grid-tight addmenu">
${RUNTIME_CREATABLE_KINDS.map(
  (kind) => `    <a class="card card-link" href="${esc(
    `${connectorsPath("new")}?kind=${encodeURIComponent(kind)}`,
  )}">
      <div class="card-head"><span class="card-title">${esc(kind)}</span></div>
      <p class="card-desc">${esc(kindBlurb(kind))}</p>
      <span class="card-cta">Add →</span>
    </a>`,
).join("\n")}
  </div>
</section>`;
}

// ---------------------------------------------------------------------------
// One entry
// ---------------------------------------------------------------------------

/** Everything about a row that is not the entry itself. */
interface RowContext {
  /** The origin the MCP URL is built from; empty when none is known. */
  base: string;
  /** `playgroundAccess(...).ok` for this console identity. */
  playable: boolean;
  /** Where this slug came from, when there is a runtime holder to ask. */
  source: EntrySource | undefined;
  /**
   * Whether there is a roster in a store at all, i.e. whether
   * `/connectors/<slug>` is a page rather than the "editor is off" 404. It
   * gates the door; `writable` gates the controls, and the two come apart on a
   * gateway that holds a store it cannot write.
   */
  editable: boolean;
  /** Whether a change made here would actually go anywhere. */
  writable: boolean;
}

/**
 * One entry, as a row.
 *
 * A row rather than a card in a three-across grid: 35 cards are two and a half
 * screens of prose you read in a zig-zag. A row puts the one thing that varies —
 * the badge — in the same place on every line, and lets the kind and the roles
 * line up into columns you can scan down instead of hunting across. The
 * description and the status summary are clamped to one line each, so a row's
 * height does not depend on how talkative its `description:` is.
 *
 * EVERY name is a link to `/ui/<slug>`, and it is the only link in the first
 * cell: the playground and copy icons are controls of their own in the last one,
 * so nothing interactive ends up nested inside this anchor.
 */
function serverRow(entry: Entry, ctx: RowContext): string {
  const { server, status, view } = entry;
  const title = server.title ?? server.slug;
  const href = serverConsolePath(server.slug);
  // AT MOST TWO SECONDARY LINES, and each has to earn its line. A `description:`
  // is per-entry prose somebody wrote, so it always shows. The status summary
  // shows on an ISSUE row, where it is the sentence that says what is wrong —
  // and NOT on a READY one, where it restates the badge in more words on every
  // row at once. The popout has it either way.
  const desc = server.description ?? "";
  const summary = status && entry.badge === "ISSUE" ? status.summary : "";

  return `    <tr>
      <td class="conn-slug">
        <a class="conn-name" href="${href}">${esc(title)}</a>${
          // Most entries declare no `title:`, so the heading IS the slug.
          // Printing it again beside itself is noise on the majority of rows.
          title === server.slug
            ? ""
            : `<code class="conn-alt">${esc(server.slug)}</code>`
        }${sourceChip(ctx.source)}${
          server.enabled ? "" : `<span class="chip chip-off">disabled</span>`
        }
${
  desc
    ? `
        <p class="conn-desc" title="${esc(desc)}">${esc(desc)}</p>`
    : ""
}${
    summary
      ? `
        <p class="conn-status" title="${esc(summary)}">${esc(summary)}</p>`
      : ""
  }
      </td>
      <td class="conn-scope">
        <span class="chip chip-${esc(server.kind)}">${esc(server.kind)}</span>
        <span class="conn-roles">${esc(server.entitlements.join(", ") || "no roles")}</span>
      </td>
      <td class="conn-badge">${badgeMarkup(entry)}</td>
      <td>
        <div class="conn-acts">${rowIcons(server, ctx.base, ctx.playable)}<a class="card-cta" href="${href}">${VIEW_CTA[view]}</a>${editControls(server, ctx)}</div>
      </td>
    </tr>`;
}

/**
 * Where this entry is declared, which is the one fact only the runtime holder
 * knows. Omitted entirely when there is no holder: on such a deployment every
 * entry comes from the file, and a chip that says the same thing on every row is
 * a column of noise.
 */
function sourceChip(source: EntrySource | undefined): string {
  if (source === undefined) return "";
  return source === "store"
    ? `<span class="chip chip-ok" title="Added or edited through this console — stored in the runtime overlay, applied without a deploy">console</span>`
    : `<span class="chip chip-plain" title="Declared in the checked-in config document">config file</span>`;
}

/**
 * The entry's own page, and — where a write would land — the controls on it.
 *
 * THREE STATES, not two, because `editable` and `writable` come apart. A
 * gateway with a store it cannot write still SERVES `/connectors/<slug>`:
 * `handleEdit` gates on `editable` (src/ui/servers.ts), and that page is the
 * only place a human sees an entry's full declaration — every field, not the
 * handful the row has room for. So it keeps a read-only `View` door and loses
 * the controls. A gateway with no store at all answers that route with the
 * "editor is off" 404, so offering the door would send a reader from a working
 * page to a dead one; the roster is the whole of what it has.
 *
 * Nothing is drawn disabled. The page has already said which of the three this
 * deployment is, once, at the top (see editorNote) — repeating that answer 35
 * times down the roster is not a clearer way to say it.
 *
 * Remove is destructive and gets the danger styling rather than a confirm step,
 * because the act is recoverable: the removal is a stored subtraction over the
 * checked-in document, and `Restore` on the row below puts a file entry back.
 */
function editControls(server: ServerConfig, ctx: RowContext): string {
  const slug = server.slug;
  if (!ctx.writable) {
    return ctx.editable
      ? `<a class="btn-ghost" href="${esc(connectorsPath(slug))}">View</a>`
      : "";
  }
  return `<a class="btn-ghost" href="${esc(connectorsPath(slug))}">Edit</a>
          <form method="post" action="${esc(connectorsPath(slug, "toggle"))}">
            <button class="btn-ghost" type="submit">${server.enabled ? "Disable" : "Enable"}</button>
          </form>
          <form method="post" action="${esc(connectorsPath(slug, "remove"))}">
            <button class="btn-ghost btn-danger" type="submit">Remove</button>
          </form>`;
}

/** The row's call to action, named for what `/ui/<slug>` does for this view. */
const VIEW_CTA: Record<ConsoleView, string> = {
  connector: "Manage →",
  secrets: "Manage →",
  gcs: "Browse →",
  overview: "Details →",
};

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
function rowIcons(
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
 * about a state neither of them anticipated. Exactly one entry has neither: a
 * `no-secrets` server, which is READY and references nothing. Every entry
 * carrying an ISSUE badge has one or the other, and that is the contract this
 * predicate exists to keep — including a `params: true` builtin, which gets a
 * scope of its own rather than the supplementary image's (see unobservableScope,
 * #264).
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
 * — see unobservableBlock(). NO SHAPE REACHES THAT BRANCH: every ISSUE entry
 * carries either requirement rows or a scope. It is kept as the floor it is — a
 * badge whose panel would be empty must not be a control that swallows the click
 * — rather than as a shape anything ships in. The last shape that took it was a
 * `params: true` BUILTIN with no `${NAME}` of its own, whose scope is #264.
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
    "Every secret this server needs has a value. Each row says where it was found (GSM or ENV) and which process checked. strad does not call the upstream, so this does not show the credential is still accepted.",
  "no-secrets": "",
  missing:
    "A secret this server needs is not seeded. Create it at the resource below; the badge turns READY on the next page load once it resolves.",
  unconfigured:
    "Waiting for a credential nobody has seeded yet. The server was deployed inactive on purpose (mayBeUnseeded), so nothing is broken. Seed the value below and it starts serving within a TTL, with no redeploy and no PR.",
  unrenderable:
    "A secret this server needs exists in the parameter store, but its value cannot be read, so nothing that references it gets a value. Rotate it through the console to rewrite it. Do not create it again; that fails with 409.",
  placeholder:
    "A secret this server needs is set to a placeholder. The server lists tools normally, but the upstream rejects every call. Rotate it to a real credential.",
  unverified:
    "This page could not check this server's credentials. That does not mean they are missing, and it does not mean they are fine.",
  unknown:
    "The secret store did not answer, so this server's status is unknown. That does not mean anything is missing: do not seed anything until the store answers.",
};

/**
 * `unverified`, for the entry where SOME of it was established.
 *
 * The rows below it are real observations and are about to say so, so the
 * headline cannot open by claiming nothing was. What it has to say instead is
 * narrower and more useful: what was checked is not the part this server takes
 * its credentials from.
 *
 * "this page cannot see", never "nothing could read it", and the distinction
 * is the whole reason this string is worded the way it is. `optionsFor` resolves
 * a `params: true` BUILTIN's namespace in this very process, per tool call,
 * through the resolver TTL — staging's `echo` exists to be watched that way — so
 * the wider claim would be flatly false about the one server most likely to show
 * this line. The zero-row summary beside it makes the same narrow claim for the
 * same reason.
 */
const PARTIAL_UNVERIFIED_HEADLINE =
  "The references below resolve, but they are not everything this server needs. " +
  "It also uses managed parameters that this page cannot see, so those are unchecked.";

/**
 * What is wrong, and what to do about it.
 *
 * A `<dialog>` rather than an inline expander, for the same reason the Help
 * control is one: the roster stays a roster, and the remediation — a store, a
 * canonical path, a project where one is knowable, and a pasteable recipe per
 * route — does not have to fit in a grid cell. `showModal()` gives the focus trap, the backdrop
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
  // FIRST LINE. The `unverified` headline says this page could not check the
  // server, and a reader who skims acts on the first line — so printing it over
  // a row reading "plumbed, checked by this gateway process" is the popout
  // contradicting itself in two consecutive sentences.
  //
  // The condition is EVERY ROW `present`, not merely "has rows". An entry
  // carrying an `unobservable` row is `unverified` BECAUSE of that row, and the
  // ordinary headline is exactly right about it; only the managed-namespace gap
  // demotes an entry whose rows all resolved.
  //
  // Not keyed off `status.unobservable`, which would be the obvious thing and is
  // wrong in the other direction: a scope is set on graded entries too, so an
  // entry whose rows carry real bad news would get the "the references below
  // resolve" line over a row reading `not seeded`. Every-row-`present` is the
  // fact this headline is about, and it holds for every kind.
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
    <p class="acc-foot"><a href="${serverConsolePath(slug)}">Open this server's console page →</a></p>
  </div>
</dialog>`;
}

/**
 * The managed namespace nothing answered for, said in the panel that opens.
 *
 * A `params: true` server whose component named no parameters produces ZERO rows
 * for them, and until this existed the page rendered a button over an empty
 * panel it never emitted — the click went nowhere and the badge was a dead
 * control. The fix is not to take the control away: an inert chip asserting
 * "this needs attention" with no way to find out why is the worse half of the
 * trade. So the control stays and the panel says the true thing instead.
 *
 * ORDERED FOR THE READER WHO CAME TO ACT. The component and a short chip first;
 * then the numbered steps; then where the values live and when a write there
 * takes effect; and last, folded away, why this page could not check. The
 * mechanism is true and worth having, and it is not what anyone opens the badge
 * to read first.
 *
 * EVERY LINE OF IT IS PER-REASON. The chip and the steps written for a
 * supplementary image, whose values are on a container core cannot see, are
 * FALSE about a `params: true` builtin core mounts: this process resolves its
 * parameters itself, per tool call, so "not checked" by a component and
 * "redeploy it" would be the panel contradicting itself (#264). `delegated` keeps
 * the container chip, because its values genuinely are elsewhere.
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
          <span class="chip chip-plain chip-route">${esc(UNOBSERVABLE_ROUTE[scope.reason])}</span>
          <span class="sec-delivery">${esc(UNOBSERVABLE_LABEL[scope.reason])}</span>
        </div>
        <ol class="fix-steps">
${scope.steps.map((s) => `          <li>${esc(s)}</li>`).join("\n")}
        </ol>
${fixBlock(
  unobservableTarget(config, scope, env),
  "Where the values live",
  "Open in the parameters console →",
)}
        <details class="sec-why">
          <summary>${esc(UNOBSERVABLE_WHY[scope.reason])}</summary>
          <p class="sec-detail">${esc(scope.detail)}</p>
        </details>
      </div>`;
}

/** Why the value is where it is, in the two or three words on the chip. */
const UNOBSERVABLE_ROUTE: Record<UnobservableScope["reason"], string> = {
  unwired: "not checked",
  unsupported: "not checked",
  unreachable: "not checked",
  unmanifested: "not checked",
  silent: "not checked",
  instance: "read from the store on demand",
  // NOT "not checked" by a component. This process holds these values; what it
  // does not do is read them on this page.
  "in-process": "resolved in this process",
  delegated: "not checked",
  inert: "not read at all",
};

/** The probe outcome — or, for a builtin, who resolves it — beside the chip. */
const UNOBSERVABLE_LABEL: Record<UnobservableScope["reason"], string> = {
  unwired: "no private URL for the component",
  unsupported: "image too old to report",
  unreachable: "component did not answer",
  unmanifested: "component listed no parameters",
  silent: "none seeded for this server",
  instance: "store-served instance",
  "in-process": "read on each tool call",
  delegated: "read by that component on each tool call",
  inert: "no resolver credential",
};

/** The folded mechanism's own heading: why, in this reason's terms. */
const UNOBSERVABLE_WHY: Record<UnobservableScope["reason"], string> = {
  unwired: "Why this page cannot check",
  unsupported: "Why this page cannot check",
  unreachable: "Why this page cannot check",
  unmanifested: "Why this page cannot check",
  silent: "What the component reported",
  instance: "How an instance gets its credentials",
  "in-process": "How this server gets its parameters",
  delegated: "How this server gets its parameters",
  inert: "Why nothing reads them",
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
  unobservable: "not checked",
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
      return "Checked by: this gateway process, in its own environment.";
    case "store":
      return "Checked by: the parameter store, read from this process.";
    case "bundle": {
      const who = evidence.component ?? "the component";
      const image = evidence.image ? `, image ${evidence.image}` : "";
      const booted = evidence.bootedAt ? `, up since ${evidence.bootedAt}` : "";
      return `Checked by: ${who} itself, asked over the private network${image}${booted}. It reports whether a value exists, never the value.`;
    }
    case "none":
      return "Checked by: nothing. No process could answer for this name.";
  }
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
        .join(" ")}. It is one secret, so fixing it here fixes those too.</p>`
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
  // two collide: a `params: true` server can declare `${FOO}` while its
  // component manifests a managed parameter also called `FOO`, and both rows
  // render (#280) — one claiming the deployment resolves the reference, the
  // other reporting what the running container holds. Identical heads would make
  // the second look like a duplicate of the first, which is exactly the reading
  // that has to be impossible: they can disagree, and when they do the
  // disagreement is the news.
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
            <dt>project</dt><dd${
              // A null project is not a missing field — it is the answer. The
              // deploy environment's project is not a fact this process holds,
              // and printing the one project id it does hold is what put a
              // credential in the wrong place (HACKS.md #86). The route's own
              // detail, right below, says which project to look for and where.
              target.project === null
                ? ' class="sec-fix-open">your deploy environment&#39;s own project — see below'
                : `><code>${esc(target.project)}</code>`
            }</dd>
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

  // THE PROSE IS FOR A ROW THAT NEEDS IT, and two kinds of row do not.
  //
  // A `plumbed` key's sentence restates its chip in two sentences. An absent
  // OPTIONAL key's says the same thing as every other absent optional key, and
  // a deployment with no console has six of them in a row — so that one is said
  // ONCE, above the listing, rather than six times inside it. Both are stated
  // where they belong; neither is dropped.
  const detailed = state !== "present" && !optionalAbsent;

  return `    <div class="row secret-row">
      <span class="row-name">${esc(requirement.name)}</span>
      <span class="chip ${chip} chip-route">${esc(label)}</span>
      ${sourceBadge(entry.observation.source)}
      ${entry.required ? `<span class="chip chip-warnish">required</span>` : ""}
      ${detailed ? `<span class="sec-detail sec-detail-inline">${esc(detail)}</span>` : ""}
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
 * an ISSUE reading "not checked" is a scoping fact rather than a fault.
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
        <li><b>ISSUE</b> — anything else. Click it: the popout says what is wrong and what to
          do, and names the store and path to fix, with the project (except on the
          <code>strad-&lt;env&gt;-*</code> route, whose project only your deploy environment
          knows). The states you will see:
          <ul>
            <li><b>not seeded</b> — the store answered, and there is no such secret. Create
              it.</li>
            <li><b>placeholder</b> — a value exists but is filler (an unexpanded
              <code>\${...}</code>, a "change-me" string, an empty string). The server boots
              and lists tools, then every call fails with an auth error. Rotate it.</li>
            <li><b>not checked</b> — the value lives on a component this page could not ask.
              A supplementary image's <code>env:</code> is baked onto its own container at
              deploy time and never shared with core. It had a value at the last successful
              deploy, because a missing one fails the render. The popout says how to check it
              yourself.</li>
            <li><b>unknown</b> — the secret store did not answer. That does not mean the
              secret is missing.</li>
          </ul>
        </li>
      </ul>
      <p>The last two are not faults, and they are still not READY: green on this page always
        means a value was actually checked.</p>
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
    <summary>How the rows are grouped and ordered</summary>
    <div class="acc-body">
      <p><b>Needs attention</b> first, then <b>Ready</b>, then <b>Disabled</b>. This is a
        working surface: the entries something has to be done about are why anyone opens it,
        and on a 35-entry roster sorting the greens to the top put exactly the wrong rows
        below the fold.</p>
      <p>Within each group, servers with a dedicated console view come before servers that
        only have the overview, and config order breaks the remaining ties. A disabled server
        carries no badge — strad does not mount it, so it needs no secrets, and a green would
        be a claim about a server that answers nothing.</p>
    </div>
  </details>
  <details class="acc">
    <summary>Editing the roster, and what a change reaches</summary>
    <div class="acc-body">
      <p>Where this gateway sets <code>gateway.configStore:</code> and holds the admin
        credential to write it, every row carries <b>Edit</b>, <b>Disable</b> and
        <b>Remove</b>, and the menu below the table adds one. A change is stored in the
        parameter store and applied to the running process — no deploy, no restart.</p>
      <ul>
        <li><b>remote-http</b> and <b>local-tunnel</b> — addable in full. Nothing of strad's
          runs for them, so an entry saved here is routable on the next request.</li>
        <li><b>supplementary-image</b> — a new slug pointed at a mount this deployment is
          <em>already running</em>. Its credentials are baked onto the container by the
          deploy, so an entry added here reuses what the mount already has. That is how one
          upstream becomes a read-only and a read-write slug.</li>
        <li><b>builtin</b> — never. The module is imported out of the running image, so it
          has to ship with a build.</li>
      </ul>
      <p>The checked-in config stays authoritative for everything nobody has touched. This
        page stores a <em>diff</em> over it: entries added, entries overridden, entries
        removed. Remove a console entry and the file's version comes back; remove a file
        entry and the removal is remembered — and listed under <b>Removed</b> — until
        somebody re-adds it.</p>
      <p>No secret is typed into the entry form. Anything credential-shaped is a
        <code>\${NAME}</code> ref, created on the server's own secrets page and resolved from
        the store on every call, which is what lets it rotate without a deploy. A save is
        validated against the whole merged config, so a refusal can name a rule about a
        <em>different</em> entry; nothing is written until it passes.</p>
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
          <code>/strad/&lt;env&gt;/gateway/static/</code>. A new value lands at once through
          this console or the <code>secrets</code> MCP server, otherwise within
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
 * for this page and nothing else renders one — with the exception of
 * `.conn-table`, which the entry form's sibling markup shares and which
 * therefore lives in the theme. The tokens (<code>--g*</code>,
 * <code>--accent</code>) come from the shared theme, so the page cannot drift
 * from the rest of the console.
 */
const ROSTER_CSS = `<style>
.chip-bad{color:#e8776b;border-color:color-mix(in srgb,#e8776b 45%,var(--g5))}
.chip-ok{color:var(--text-accent);border-color:color-mix(in srgb,var(--accent) 45%,var(--g5))}
.stat-ready{color:var(--text-accent)}
.stat-missing{color:#e8776b}
/* The revision sits at the far end of the same bar as the counts. */
.conn-rev{margin-left:auto;font-family:var(--font-mono);font-size:.72rem;color:var(--g4);
  text-align:right}
/* The lede is prose and keeps a prose measure even on the wide frame. */
.intro .lede{max-width:46rem}
/* Three cards, not five columns' worth of room for three cards. */
.addmenu{grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))}
/* The entry badge. Loud on purpose: on a 35-row roster it is the one thing that
   varies from line to line. */
.chip-badge{font-weight:600;letter-spacing:.08em}
.chip-button{cursor:pointer;background:none;font-family:var(--font-mono);
  display:inline-flex;align-items:center;gap:.3rem}
.chip-button:hover{border-color:#e8776b;background:color-mix(in srgb,#e8776b 12%,transparent)}
.chip-button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.chip-caret{font-size:.6rem;opacity:.75}

/* One entry, as a row. The first cell is the only one that grows; everything
   else is a short fact that wants to line up down the column. */
.conn-table tr:hover td{background:color-mix(in srgb,var(--accent) 5%,transparent)}
.conn-table td{vertical-align:top}
.conn-table td.conn-slug{width:42%;font-family:var(--font-sans);font-size:.86rem}
.conn-name{color:var(--white);font-weight:600;font-size:.92rem}
.conn-name:hover{color:var(--text-accent)}
.conn-name-off{color:var(--g3)}
.conn-alt{margin-left:.45rem;font-size:.74rem;color:var(--g4)}
.conn-slug .chip{margin-left:.45rem;vertical-align:2px}
/* Both clamped to one line: a row's height must not depend on how talkative a
   description: is, or the column alignment the table buys is spent again. */
.conn-desc,.conn-status{margin:.2rem 0 0;max-width:30rem;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.conn-desc{color:var(--g2);font-size:.8rem;font-family:var(--font-sans)}
.conn-status{color:var(--g3);font-size:.76rem;font-family:var(--font-sans)}
.conn-badge{white-space:nowrap}
/* Kind and roles are the same question — what this entry is scoped to — so they
   are one cell stacked rather than two columns, which is 7rem of table width
   back for the controls that needed it. */
.conn-scope{white-space:nowrap;line-height:1.35}
.conn-roles{display:block;margin-top:.25rem;color:var(--g4);font-size:.74rem;
  font-family:var(--font-mono)}
.conn-table tbody tr:not(.conn-group) td:last-child{text-align:right}
/* The group headings. A table row rather than a heading between tables, so the
   columns below them stay one grid. */
.conn-group td{background:var(--g6);border-top:1px solid var(--g5);padding:.45rem .8rem}
.conn-group-l{font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;
  color:var(--g2)}
.conn-group-n{margin-left:.5rem;font-family:var(--font-mono);font-size:.72rem;color:var(--g4)}
.conn-group-note{margin-left:.7rem;font-size:.74rem;color:var(--g4)}
/* The icons, the CTA and the editor controls share the last cell. Quiet until
   hovered: on a 35-row roster two loud glyphs per line is a wall of teal. */
/* One line, always. Wrapping the controls onto three rows per entry costs more
   height than the whole rest of the row; below 46rem the media query turns the
   table into a stack and lets them wrap again. */
.conn-acts{display:flex;align-items:center;gap:.35rem;justify-content:flex-end;
  flex-wrap:nowrap;white-space:nowrap}
.conn-acts .btn-ghost{padding:.25rem .45rem;font-size:.72rem}
.conn-acts form{display:inline}
.card-icon{display:inline-flex;align-items:center;justify-content:center;
  width:1.7rem;height:1.7rem;padding:0;border:1px solid var(--g5);border-radius:.35rem;
  background:none;color:var(--g3);cursor:pointer;text-decoration:none}
.card-icon:hover{color:var(--text-accent);border-color:color-mix(in srgb,var(--accent) 55%,var(--g5))}
.card-icon:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.card-icon.is-copied{color:var(--text-accent);
  border-color:color-mix(in srgb,var(--accent) 70%,var(--g5))}
.conn-acts .card-cta{white-space:nowrap;margin:0 .1rem}
.conn-acts .btn-ghost{display:inline-block;text-decoration:none;line-height:1.4}
/* Quiet until you reach for it. Thirteen red buttons down a roster point the
   eye at the one control nobody came here to press. */
.btn-danger:hover{border-color:#e8776b;color:#e8776b;
  background:color-mix(in srgb,#e8776b 12%,transparent)}
/* Below this the table stops being a grid and each row becomes a stack — five
   columns of short facts do not survive a 34rem viewport. */
@media (max-width:46rem){
  /* Every part of the table stops being a table: a display:table element sizes
     itself from its cells' min-content, so leaving the table itself alone makes
     the PAGE scroll sideways however the rows are laid out. */
  .conn-table,.conn-table tbody{display:block}
  .conn-table thead{display:none}
  .conn-table tr{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;
    padding:.55rem .3rem;border-top:1px solid var(--g6)}
  .conn-table td{display:block;border:none;padding:.1rem .5rem}
  .conn-table td.conn-slug{flex:1 1 100%;width:auto}
  /* The one-line clamp is a column-alignment device and there are no columns
     here. Wrapping is what a phone has room for. */
  .conn-desc,.conn-status{white-space:normal;max-width:none;overflow:visible}
  .conn-scope,.conn-roles{white-space:normal}
  .conn-roles{display:inline;margin:0 0 0 .5rem}
  .conn-acts{justify-content:flex-start;flex-wrap:wrap;white-space:normal}
  .conn-group td{flex:1 1 100%}
  .conn-group-note{display:none}
  .conn-rev{margin:.4rem 0 0;text-align:left;flex:1 1 100%}
}

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
.sec-fix-dl dd.sec-fix-open{word-break:normal;color:var(--g3);font-style:italic}
.sec-fix-why{color:var(--g2);font-size:.79rem;margin:.55rem 0 0;line-height:1.55}
/* What to do, first and numbered. The mechanism is folded below it. */
.fix-steps{margin:.6rem 0 .2rem;padding-left:1.3rem;color:var(--g1);font-size:.84rem;
  line-height:1.55}
.fix-steps li{margin:.25rem 0}
.sec-why{margin:.6rem 0 .2rem}
.sec-why summary{cursor:pointer;color:var(--g3);font-size:.78rem}
.sec-why .sec-detail{margin-top:.35rem}
.secret-row .sec-detail-inline{padding-left:0}
</style>`;
