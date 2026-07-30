import type { ServerConfig, StradConfig } from "../config/schema.ts";
import { esc, layout, serverLooksGcs, serverLooksSecrets } from "./render.ts";
import {
  fixTargets,
  isActionable,
  SOURCE_TOOLTIP,
  storeProject,
  tally,
  type FixTarget,
  type SecretObservation,
  type SecretSource,
  type SecretState,
  type ServerSecretStatus,
  type ServerState,
} from "./secret-status.ts";

/**
 * The Secrets Console: every configured MCP server, and whether the secrets it
 * needs are actually there.
 *
 * ## What this page is for
 *
 * It is step 2 of a loop that starts somewhere else. Someone looks at a list of
 * connectors, sees one that is broken, and needs to know whether STRAD is the
 * reason before they go looking anywhere else. So the page is a roster, not an
 * error log: every enabled server is on it, healthy ones included, because
 * "slack is fine, gmail is not" is the answer and a page listing only failures
 * cannot give it.
 *
 * ## Why it prints names and the landing page does not
 *
 * `/` is deliberately narrow — no `env:` keys, no urls, no headers
 * (test/landing.test.ts asserts each absence) — because it is an index and an
 * index needs none of that. This page's entire job is to name the secret that is
 * missing and the exact path it goes at, so it prints NAMES and PATHS. It is
 * behind the same `requireConsoleUi` gate, and the line it holds instead is the
 * one that matters: **no secret VALUE is ever rendered.** Not revealed, not
 * excerpted, not length-hinted, not in a title attribute. The status derivation
 * (secret-status.ts) reads values to spot a placeholder and returns sentences
 * about shapes; nothing on this page can print bytes because nothing on this page
 * is ever handed any.
 */

export interface SecretStatusPageOptions {
  config: StradConfig;
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

const CHIP_CLASS: Record<ServerState, string> = {
  ready: "chip-ok",
  "no-secrets": "chip-plain",
  missing: "chip-bad",
  placeholder: "chip-warnish",
  unverified: "chip-plain",
  unknown: "chip-warnish",
};

const SECRET_CHIP_CLASS: Record<SecretState, string> = {
  present: "chip-ok",
  placeholder: "chip-warnish",
  missing: "chip-bad",
  unobservable: "chip-plain",
  error: "chip-warnish",
};

const SECRET_LABEL: Record<SecretState, string> = {
  present: "present",
  placeholder: "placeholder",
  missing: "not seeded",
  unobservable: "not visible here",
  error: "unknown",
};

export function renderSecretStatus(opts: SecretStatusPageOptions): string {
  const { config, statuses } = opts;
  const counts = tally(statuses);
  const problems = statuses.filter((s) => isActionable(s.state));
  const { project, guessed } = storeProject(config, opts.env);

  const body = `
<section class="intro">
  <h1>Secrets Console <span class="env-badge">${esc(config.gateway.env)}</span></h1>
  <p class="lede">Every MCP server this gateway declares, and whether the secrets it
    requires are actually seeded. Arrived here from a broken connector? Find its row —
    if it is <span class="chip chip-ok chip-route">ready</span> the missing piece is not
    strad's, and if it is not, the fix guidance names the exact path to set.</p>
</section>

${summaryBar(counts, statuses.length)}

${
  problems.length
    ? `<p class="posture posture-warn"><strong>${problems.length} server${
        problems.length === 1 ? "" : "s"
      } need attention.</strong> Each one below is expanded, with the store, the project
      and the resource name to create. Nothing here can be fixed by redeploying alone
      unless the value exists first.</p>`
    : `<p class="posture"><strong>Every server's secrets resolve.</strong> That means a value
      EXISTS for each <code>\${NAME}</code> the config references — strad does not call any
      upstream, so it is not a claim that a credential is still accepted. A server that
      lists tools and 401s on every call is the shape to suspect next.</p>`
}

<section class="panel">
  <div class="panel-head">
    <h2>Servers</h2>
    <span class="panel-note">${statuses.length} enabled</span>
  </div>
${
  statuses.length
    ? statuses.map((s) => serverBlock(s, config, opts.env)).join("\n")
    : `  <p class="empty">No servers are enabled on this gateway.</p>`
}
</section>

<section class="panel">
  <div class="panel-head">
    <h2>The gateway itself</h2>
    <span class="panel-note">boot keys</span>
  </div>
  <p class="copy-note">Not any server's secrets — strad's own. Without
    <code>STRAD_TOKENS</code> every <code>/mcp</code> request is rejected and no amount of
    per-server green above means anything.</p>
  <div class="listing">
${opts.boot.map((o) => bootRow(o)).join("\n")}
  </div>
</section>

<p class="copy-note">Parameter store project: <code>${esc(project)}</code>${
    guessed
      ? " — inferred from the naming convention, because this deployment declares none."
      : ""
  } Secret Manager names follow <code>strad-${esc(config.gateway.env)}-&lt;NAME&gt;</code>.
  Values are never displayed on this page; use
  <a href="/ui/secrets">the parameters console</a> to set one.</p>
${STATUS_CSS}`;

  return layout({
    title: "Secrets Console",
    body,
    signedInAs: opts.signedInAs,
    brandHref: "/",
    brandSub: "secrets console",
    footNote: "status and guidance · never values",
    help: GUIDE,
  });
}

function summaryBar(
  counts: Record<ServerState, number>,
  total: number,
): string {
  const cells: [ServerState, string][] = [
    ["ready", "ready"],
    ["no-secrets", "no secrets"],
    ["missing", "not seeded"],
    ["placeholder", "placeholder"],
    ["unverified", "unverified"],
    ["unknown", "unknown"],
  ];
  return `<div class="browse-head">
  <div class="stat"><span class="stat-n">${total}</span><span class="stat-l">servers</span></div>
${cells
  .filter(([state]) => counts[state] > 0)
  .map(
    ([state, label]) =>
      `  <div class="stat"><span class="stat-n stat-${esc(state)}">${counts[state]}</span><span class="stat-l">${esc(label)}</span></div>`,
  )
  .join("\n")}
</div>`;
}

/**
 * One server. Expanded by default when it needs attention, collapsed otherwise.
 *
 * The default matters more than it looks: a 26-server roster where every row is
 * expanded is unreadable, and one where the broken row is collapsed buries the
 * only thing anyone came for.
 */
function serverBlock(
  status: ServerSecretStatus,
  config: StradConfig,
  env: NodeJS.ProcessEnv,
): string {
  const { server } = status;
  const title = server.title ?? server.slug;
  const open = isActionable(status.state) || status.state === "unknown";

  return `  <details class="acc sec-acc" ${open ? "open" : ""}>
    <summary>
      <span class="sec-name">${esc(title)}</span>
      ${
        title === server.slug
          ? ""
          : `<code class="sec-slug">${esc(server.slug)}</code>`
      }
      <span class="chip chip-${esc(server.kind)}">${esc(server.kind)}</span>
      <span class="chip ${CHIP_CLASS[status.state]} chip-route">${esc(status.label)}</span>
      <span class="sec-summary">${esc(status.summary)}</span>
    </summary>
    <div class="acc-body">
${
  status.requirements.length
    ? status.requirements
        .map((o) => requirementBlock(o, config, env))
        .join("\n")
    : `      <p>${esc(status.summary)}</p>`
}
${
  hasConsoleView(server)
    ? `      <p class="acc-foot"><a href="/ui/${encodeURIComponent(server.slug)}">Open this server's console view →</a></p>`
    : ""
}
    </div>
  </details>`;
}

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

/** Whether `/ui/<slug>` renders something, so the link is worth offering. */
function hasConsoleView(server: ServerConfig): boolean {
  return serverLooksGcs(server) || serverLooksSecrets(server);
}

function requirementBlock(
  observation: SecretObservation,
  config: StradConfig,
  env: NodeJS.ProcessEnv,
): string {
  const { requirement, state, detail } = observation;
  const shared =
    requirement.slugs.length > 1
      ? `<p class="sec-shared">Shared with ${requirement.slugs
          .filter((s) => s !== undefined)
          .map((s) => `<code>${esc(s)}</code>`)
          .join(
            " ",
          )} — one secret, one problem, however many rows reference it.</p>`
      : "";

  const guidance =
    state === "missing" || state === "placeholder"
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
 * The guide, behind the Help control in the top right.
 *
 * It exists to make the states honest in prose as well as in markup — in
 * particular that `ready` is a statement about presence and nothing else, and
 * that `not visible here` is a scoping fact rather than a fault.
 */
const GUIDE = `
  <details class="acc" open>
    <summary>What each state actually claims</summary>
    <div class="acc-body">
      <ul>
        <li><b>ready</b> — every <code>\${NAME}</code> this server references resolves to a
          value. It is <b>not</b> a claim that the credential works: strad never calls the
          upstream to check. A server that lists tools and fails every call with an auth
          error is exactly the shape this state cannot rule out.</li>
        <li><b>no secrets</b> — the server declares no references at all. Nothing to seed.</li>
        <li><b>not seeded</b> — the backend answered, and there is no such secret. This is the
          one state that is unambiguous, and it is the one the fix guidance is for.</li>
        <li><b>placeholder</b> — a value exists and is evidently filler (an unexpanded
          <code>\${...}</code>, a well-known "change-me" string, an empty string). Seeded is
          not working; this is what a boot-fine-then-401 server looks like from here.</li>
        <li><b>not visible here</b> — the value is scoped to a component this process is not.
          A supplementary image's <code>env:</code> is baked onto that container at deploy
          time and never broadcast to core, so the console cannot confirm it either way. It
          was present at the last successful deploy, because a missing one fails the render.</li>
        <li><b>unknown</b> — the secret backend could not be consulted. Not absent.</li>
      </ul>
    </div>
  </details>
  <details class="acc">
    <summary>The GSM / ENV badge, and why those exact letters</summary>
    <div class="acc-body">
      <p>Each secret carries a badge naming <b>which store holds it</b> — not its status,
        which is the chip beside it.</p>
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
    <summary>Why a shared secret appears once</summary>
    <div class="acc-body">
      <p>Every capability variant of a server family declares its credentials identically, on
        purpose: a component's environment is the union of its servers' <code>env:</code> maps,
        so with the secret on only one variant, setting <code>enabled: false</code> on THAT
        variant would silently strip it from its siblings — which would keep listing their
        tools and fail every call with an auth error naming no cause.</p>
      <p>So one <code>\${NAME}</code> legitimately appears on several entries. It is
        deduplicated here: one unseeded secret shared by four variants is one problem, and
        listing it four times would bury the other three.</p>
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
 * for this page's roster and nothing else renders one. The tokens
 * (<code>--g*</code>, <code>--accent</code>) come from the shared theme, so the
 * page cannot drift from the rest of the console.
 */
const STATUS_CSS = `<style>
.chip-bad{color:#e8776b;border-color:color-mix(in srgb,#e8776b 45%,var(--g5))}
.chip-ok{color:var(--text-accent);border-color:color-mix(in srgb,var(--accent) 45%,var(--g5))}
.stat-ready,.stat-no-secrets{color:var(--text-accent)}
.stat-missing{color:#e8776b}
.stat-placeholder,.stat-unknown{color:#e0a63b}
.sec-acc{margin-bottom:.5rem}
.sec-acc>summary{flex-wrap:wrap;gap:.55rem;padding:.7rem .95rem}
.sec-name{font-weight:600;color:var(--white)}
.sec-slug{font-size:.72rem}
.sec-summary{flex:1 1 100%;font-weight:400;color:var(--g3);font-size:.8rem;padding-left:1.3rem}
.sec-req{border-top:1px solid var(--g6);padding:.85rem 0 .3rem}
.sec-req:first-child{border-top:none}
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
