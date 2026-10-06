import type { Request, Response } from "express";
import { sanitizeNext } from "../auth/session.ts";
import { consolePrincipal, signedInLabel } from "./console-auth.ts";
import { esc, layout } from "./render.ts";
import { serverConsolePath } from "./paths.ts";
import { event } from "../telemetry/index.ts";
import { errorSummary } from "../util/error-text.ts";
import {
  consoleSessionId,
  issueConnectorTx,
  type ConnectorTxPayload,
} from "../connectors/state.ts";
import {
  ConnectorError,
  connectorRedirectUri,
  type ConnectorErrorCode,
} from "../connectors/index.ts";
import {
  beginUpstreamAuthorization,
  clientSource,
  completeUpstreamAuthorization,
  discoverUpstream,
  heldVariables,
  registerPublicClient,
  storeUpstreamWrites,
  UPSTREAM_PROVIDER,
  UpstreamConnectError,
  upstreamConfigTerms,
  upstreamConnectorFor,
  upstreamNote,
  upstreamPlan,
  upstreamWrites,
  type UpstreamConnector,
  type UpstreamPlan,
  type UpstreamTerms,
} from "../connectors/upstream.ts";
import {
  oauthParameterPath,
  staticNamespace,
  type ParameterMeta,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import { storeForPath } from "./store-client.ts";
import {
  clientReadDetail,
  clientReadFailure,
  connectFailed,
  notice,
  type ConnectorUiOptions,
  type ConnectRefusal,
} from "./connector.ts";

/**
 * **Connect** for a `remote-http` server whose bearer is minted by
 * `oauthRefresh:` — the console half of src/connectors/upstream.ts.
 *
 * It rides the `oauth:` connector's routes rather than adding its own:
 * `POST /ui/<slug>/connect` dispatches here when the slug is a `remote-http`
 * with `oauthRefresh:`, and `GET /ui/oauth/callback` dispatches here when the
 * transaction was SEALED under `UPSTREAM_PROVIDER`. So the gate, the
 * token-session refusal, the sealed state, its CSRF compare, its session and
 * deployment binding are the same code for both flows, checked before either
 * one runs.
 *
 * What differs is where the terms come from. An `oauth:` connector's endpoints
 * and client are configured; this flow DISCOVERS the authorization server from
 * the upstream itself and, where it can, registers its own client. So the
 * connect POST makes outbound requests before it redirects, and every way that
 * can fail is a 409 rendered on this page in strad's own words — above all the
 * one that motivated it: a metadata document a firewall refuses to serve to
 * this deployment's egress.
 *
 * Same rule as the rest of the connector: the authorization code, the access
 * token and the refresh token are never rendered, redirected with, logged or
 * evented.
 */

/** Where a Connect for this slug stands, as the page renders it. */
export type UpstreamState =
  | { kind: "not_connectable"; problems: string[] }
  | { kind: "no_redirect_uri" }
  | { kind: "env_provider" }
  | { kind: "no_store"; reason: string }
  | { kind: "store_error"; reason: string }
  | {
      kind: "ready" | "connected";
      store: ParameterStore;
      metas: ParameterMeta[];
      held: Map<string, ParameterMeta>;
      note?: string;
    };

function refreshPath(
  opts: ConnectorUiOptions,
  plan: UpstreamPlan,
  slug: string,
) {
  return oauthParameterPath(
    opts.config.gateway.env,
    slug,
    plan.refreshVariable,
  );
}

/**
 * Read this slug's Connect state. One listing of `/strad/{env}/mcp/{slug}/`.
 *
 * `env_provider` is its own refusal rather than `no_store`: a deployment on the
 * `env` provider may well HAVE a parameter store (a `secrets` slug), but its
 * running gateway reads every `${NAME}` from the environment, so a token
 * written to the store would reach nothing until someone copied it by hand —
 * the exact step this flow exists to remove.
 */
export async function readUpstreamState(
  opts: ConnectorUiOptions,
  entry: UpstreamConnector,
  plan: UpstreamPlan,
): Promise<UpstreamState> {
  if (plan.problems.length > 0) {
    return { kind: "not_connectable", problems: plan.problems };
  }
  if (!connectorRedirectUri(opts.config)) return { kind: "no_redirect_uri" };
  if (opts.config.gateway.secrets.provider !== "gcp-parameter-store") {
    return { kind: "env_provider" };
  }
  const resolved = storeForPath(
    opts.config,
    opts.secrets,
    refreshPath(opts, plan, entry.server.slug),
    { parametersStore: opts.parametersStore },
  );
  if (!resolved.store) return { kind: "no_store", reason: resolved.reason };

  const prefix = `/strad/${opts.config.gateway.env}/mcp/${entry.server.slug}/`;
  let metas: ParameterMeta[];
  try {
    metas = await resolved.store.list(prefix);
  } catch (err) {
    return {
      kind: "store_error",
      reason:
        `strad could not list ${prefix}, so it cannot tell whether this ` +
        `server is connected. ${err instanceof Error ? err.name : "The store"} ` +
        `did not answer.`,
    };
  }
  const held = heldVariables(opts.config, entry.server.slug, metas);
  const token = held.get(plan.refreshVariable);
  return {
    kind: token ? "connected" : "ready",
    store: resolved.store,
    metas,
    held,
    ...(token?.note ? { note: token.note } : {}),
  };
}

// ---------------------------------------------------------------------------
// POST /ui/:server/connect
// ---------------------------------------------------------------------------

export async function handleUpstreamConnect(
  _req: Request,
  res: Response,
  opts: ConnectorUiOptions,
  entry: UpstreamConnector,
): Promise<void> {
  const signedInAs = signedInLabel(res);
  const slug = entry.server.slug;
  const plan = upstreamPlan(entry);

  // 409 AND NEVER A 5xx, rendered in place: see `handleConnect` for why the
  // App Platform edge makes that a rule. Every one is an event.
  const refuse = async (
    reason: ConnectRefusal,
    message: string,
    state?: UpstreamState,
    detail: Record<string, string | number> = {},
  ): Promise<void> => {
    connectFailed("begin", slug, reason, detail);
    await renderUpstreamConnectorPage(res, opts, entry, {
      signedInAs,
      status: 409,
      state,
      flash: { tone: "error", message },
    });
  };

  const sealer = opts.sessions?.connector;
  if (!sealer) {
    await refuse(
      "no_session_key",
      "This deployment has no console session key, so strad cannot seal " +
        "an authorization transaction. Set CONSOLE_SESSION_SECRET.",
    );
    return;
  }

  const state = await readUpstreamState(opts, entry, plan);
  if (state.kind !== "ready" && state.kind !== "connected") {
    await refuse(
      state.kind,
      "This server cannot be connected yet. See the setup below.",
      state,
    );
    return;
  }
  // Narrowed by `readUpstreamState`: both are non-null once the state is one
  // of these two.
  const redirectUri = connectorRedirectUri(opts.config)!;
  const fetchImpl = opts.connectorFetch ?? fetch;

  let terms: UpstreamTerms;
  let scopes: string[];
  try {
    const discovery = await discoverUpstream(
      {
        upstreamUrl: plan.url!,
        ...(plan.resource?.mode === "literal"
          ? { resourceOverride: plan.resource.value }
          : {}),
        scopes: plan.scopes,
      },
      fetchImpl,
    );
    scopes = discovery.scopes;

    // A LITERAL token URL is the one every refresh will use. Minting a refresh
    // token at a different endpoint would store a credential the minter then
    // spends somewhere that never issued it.
    if (
      plan.tokenUrl?.mode === "literal" &&
      plan.tokenUrl.value !== discovery.tokenEndpoint
    ) {
      throw new UpstreamConnectError(
        "token_url_mismatch",
        `This server's oauthRefresh.tokenUrl is ${plan.tokenUrl.value}, but ` +
          `the upstream's authorization server advertises ` +
          `${discovery.tokenEndpoint}. A refresh token minted at one would be ` +
          `spent at the other, so strad will not begin. Make tokenUrl a ` +
          `\${NAME} and Connect writes the discovered one. Nothing was ` +
          `registered or written.`,
      );
    }

    const source = clientSource(
      plan,
      discovery.registrationEndpoint !== null,
      state.held,
    );
    if (!source) {
      const variable =
        plan.clientId?.mode === "write" ? plan.clientId.variable : "clientId";
      throw new UpstreamConnectError(
        "no_client",
        (discovery.registrationEndpoint === null
          ? `The authorization server ${discovery.issuer} offers no dynamic ` +
            `client registration`
          : `This server declares oauthRefresh.clientSecret, so strad cannot ` +
            `register a client for it (it registers public clients only)`) +
          `, and \${${variable}} is not seeded in this server's own ` +
          `namespace. Register a client at the upstream with the redirect URI ` +
          `${redirectUri}, seed its id as ${variable} under ` +
          `${staticNamespace(opts.config.gateway.env, slug)}, and Connect ` +
          `uses it. Nothing was registered or written.`,
      );
    }
    if (
      plan.clientSecretVariable !== null &&
      !state.held.has(plan.clientSecretVariable)
    ) {
      throw new UpstreamConnectError(
        "no_client",
        `This server declares a client secret as ` +
          `\${${plan.clientSecretVariable}}, and it is not seeded in this ` +
          `server's own namespace, so the code could not be exchanged. Seed it ` +
          `under ${staticNamespace(opts.config.gateway.env, slug)}. Nothing ` +
          `was registered or written.`,
      );
    }

    let clientId: string;
    if (source.kind === "literal") {
      clientId = source.clientId;
    } else if (source.kind === "register") {
      clientId = await registerPublicClient(
        {
          registrationEndpoint: discovery.registrationEndpoint!,
          redirectUri,
          clientName: `strad (${opts.config.gateway.env}) ${slug}`,
          scopes: discovery.scopes,
        },
        fetchImpl,
      );
    } else {
      try {
        clientId = await state.store.reveal(source.path);
      } catch (err) {
        const read = clientReadFailure(err, source.variable, source.path);
        await refuse(
          "client_unreadable",
          `strad cannot read this server's client id, so it cannot begin an ` +
            `authorization: ${read.sentence} Nothing was written.`,
          state,
          clientReadDetail(source.variable, read, err),
        );
        return;
      }
    }

    terms = {
      clientId,
      registered: source.kind === "register",
      tokenUrl: discovery.tokenEndpoint,
      resource: discovery.resource,
      issuer: discovery.issuer,
    };
    const pending = beginUpstreamAuthorization({
      discovery,
      clientId,
      redirectUri,
    });

    issueConnectorTx(
      res,
      sealer,
      {
        state: pending.state,
        verifier: pending.verifier,
        slug,
        env: opts.config.gateway.env,
        provider: UPSTREAM_PROVIDER,
        terms: upstreamConfigTerms(entry),
        account: "",
        scopes,
        variable: plan.refreshVariable,
        sid: consoleSessionId(consolePrincipal(res)),
        next: serverConsolePath(slug),
        upstream: terms,
      },
      opts.env,
    );
    event({ evt: "strad.connector_begin", slug });
    res.redirect(302, pending.url);
  } catch (err) {
    if (err instanceof UpstreamConnectError) {
      await refuse(
        err.code,
        err.message,
        state,
        err.status === undefined ? {} : { status: err.status },
      );
      return;
    }
    // A deadline that expired inside a discovery step surfaces as the step's
    // own `UpstreamConnectError`; anything else is strad's bug, not the
    // upstream's words, and the catch of last resort handles it.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// GET /ui/oauth/callback, for a transaction sealed under UPSTREAM_PROVIDER
// ---------------------------------------------------------------------------

/**
 * The second half. Everything about the transaction itself — present, state
 * matches, same session, same deployment — has been checked by the shared
 * callback before it dispatched here; this checks what is particular to the
 * flow and then exchanges.
 */
export async function handleUpstreamCallback(
  req: Request,
  res: Response,
  opts: ConnectorUiOptions,
  tx: ConnectorTxPayload,
  refuse: (heading: string, sub: string, status?: number) => void,
): Promise<void> {
  const entry = upstreamConnectorFor(opts.config, tx.slug);
  if (!entry) {
    refuse(
      "That server can no longer be connected",
      `"${tx.slug}" is no longer an enabled remote-http server with ` +
        `oauthRefresh: on this gateway. Nothing was written.`,
      409,
    );
    return;
  }
  const slug = entry.server.slug;
  const plan = upstreamPlan(entry);

  // THE CONFIG THE HUMAN WAS SHOWN. The upstream URL and every oauthRefresh
  // field are bound; a deploy that changed any of them mid-consent refuses
  // rather than storing a grant against terms nobody agreed to.
  if (
    !tx.upstream ||
    upstreamConfigTerms(entry) !== tx.terms ||
    plan.refreshVariable !== tx.variable
  ) {
    refuse(
      "This server's configuration changed mid-flow",
      "The upstream URL or the oauthRefresh: block configured for this " +
        "server is not the one this authorization was begun under. Nothing " +
        "was written. Start again from the server's page.",
      409,
    );
    return;
  }
  const terms = tx.upstream;

  const state = await readUpstreamState(opts, entry, plan);
  if (state.kind !== "ready" && state.kind !== "connected") {
    connectFailed("callback", slug, state.kind);
    refuse(
      "strad cannot complete this authorization",
      "This server stopped being connectable while the authorization was in " +
        "progress — its store, its public URL or its config. Nothing was " +
        "written.",
      409,
    );
    return;
  }
  const redirectUri = connectorRedirectUri(opts.config)!;

  const back = (query: string): void => {
    res.redirect(302, `${sanitizeNext(tx.next)}${query}`);
  };

  // A configured confidential client's secret, from the store — never from the
  // transaction, which is a signed cookie in a browser.
  let clientSecret: string | undefined;
  if (plan.clientSecretVariable !== null) {
    const variable = plan.clientSecretVariable;
    const meta = state.held.get(variable);
    const path =
      meta?.path ??
      `${staticNamespace(opts.config.gateway.env, slug)}${variable}`;
    try {
      if (!meta) throw new Error("NotSeeded");
      clientSecret = await state.store.reveal(path);
    } catch (err) {
      const read = clientReadFailure(err, variable, path);
      connectFailed(
        "callback",
        slug,
        "client_unreadable",
        clientReadDetail(variable, read, err),
      );
      back("?error=client_unreadable");
      return;
    }
  }

  try {
    const grant = await completeUpstreamAuthorization(
      {
        terms,
        clientSecret,
        clientAuth: entry.oauth.clientAuth,
        redirectUri,
        code: String(req.query.code ?? ""),
        verifier: tx.verifier,
      },
      opts.connectorFetch ?? fetch,
    );

    const writes = upstreamWrites(
      opts.config,
      entry,
      plan,
      terms,
      grant.refreshToken,
    );
    await storeUpstreamWrites(
      state.store,
      writes,
      new Set(state.metas.map((m) => m.path)),
      upstreamNote(terms, grant.grantedScopes, new Date()),
    );
    // Core resolves this server's `${NAME}`s per request, so dropping the
    // cached reading is what makes the very next call use what was just
    // written — a `mayBeUnseeded` slug comes up without a redeploy.
    opts.afterUpstreamWrite?.();

    event({
      evt: "strad.connector_connected",
      slug,
      variable: plan.refreshVariable,
    });
    back("?connected=1");
  } catch (err) {
    const code: ConnectorErrorCode | "store_failed" =
      err instanceof ConnectorError ? err.code : "store_failed";
    event({ evt: "strad.connector_refused", slug, reason: code });
    if (!(err instanceof ConnectorError)) {
      console.error(
        `[strad] upstream connector write failed for ${slug}: ` +
          `${errorSummary(err)}`,
      );
    }
    back(`?error=${encodeURIComponent(code)}`);
  }
}

// ---------------------------------------------------------------------------
// GET /ui/:server — the page
// ---------------------------------------------------------------------------

export interface UpstreamPageExtras {
  signedInAs?: string;
  status?: number;
  flash?: { tone: "ok" | "error"; message: string };
  state?: UpstreamState;
}

function describeField(
  label: string,
  field: UpstreamPlan["tokenUrl"],
  writes: string,
): string {
  if (!field) return "";
  if (field.mode === "write") {
    return `<li><code>\${${esc(field.variable)}}</code> — ${esc(writes)}</li>`;
  }
  return `<li><code>${esc(label)}</code> is the literal <code>${esc(
    field.value,
  )}</code> — the config's own, used as written and not stored.</li>`;
}

export async function renderUpstreamConnectorPage(
  res: Response,
  opts: ConnectorUiOptions,
  entry: UpstreamConnector,
  extras: UpstreamPageExtras,
): Promise<void> {
  const slug = entry.server.slug;
  const plan = upstreamPlan(entry);
  const state = extras.state ?? (await readUpstreamState(opts, entry, plan));
  const redirectUri = connectorRedirectUri(opts.config);
  const host = (() => {
    try {
      return new URL(entry.server.url).host;
    } catch {
      return entry.server.url;
    }
  })();

  const flash = extras.flash
    ? `<div class="flash flash-${extras.flash.tone}">${esc(extras.flash.message)}</div>`
    : "";

  const action = `${serverConsolePath(slug)}/connect`;
  const button = (label: string, hint: string): string => `
<form method="post" action="${esc(action)}" class="connect-form">
  <button class="btn btn-primary">${esc(label)}</button>
  <span class="field-h">${esc(hint)}</span>
</form>`;

  let statusBlock: string;
  switch (state.kind) {
    case "not_connectable":
      statusBlock = notice(
        "warn",
        "This server's config cannot be connected from the console",
        state.problems.join(" "),
      );
      break;
    case "no_redirect_uri":
      statusBlock = notice(
        "warn",
        "No public URL on this deployment",
        `The upstream needs an exact redirect URI, and strad derives it from ` +
          `gateway.publicUrl. Set that, redeploy, and Connect becomes usable.`,
      );
      break;
    case "env_provider":
      statusBlock = notice(
        "warn",
        "This deployment reads its credentials from the environment",
        `gateway.secrets.provider is env, so the running gateway reads ` +
          `\${${plan.refreshVariable}} from its environment and a token written ` +
          `to a parameter store would reach nothing. Connect needs ` +
          `gcp-parameter-store.`,
      );
      break;
    case "no_store":
      statusBlock = notice(
        "warn",
        "No parameter store to write to",
        `${state.reason}. Connect stores the refresh token as a managed ` +
          `parameter, so this deployment cannot run it.`,
      );
      break;
    case "store_error":
      statusBlock = notice(
        "error",
        "The parameter store did not answer",
        state.reason,
      );
      break;
    case "ready":
      statusBlock = `
${notice(
  "info",
  "Not connected",
  `strad holds no refresh token for this server in its own namespace, so it ` +
    `cannot mint an access token and every call fails until a human signs in.`,
)}
${button(
  `Connect ${host}`,
  `strad asks ${host} where to sign in, then sends you there. It cannot check ` +
    `which account consents — make sure you sign in as the right one.`,
)}`;
      break;
    case "connected":
      statusBlock = `
${notice(
  "info",
  "A refresh token is stored",
  state.note
    ? `${state.note}. strad cannot tell you whether ${host} still accepts it — ` +
        `only a real call can.`
    : `A refresh token is present for this server. strad did not record how ` +
        `it got there, and cannot tell you whether ${host} still accepts it.`,
)}
${button(
  `Reconnect ${host}`,
  "Signs in again and replaces the stored values. The current ones stay until the new consent is complete.",
)}`;
      break;
  }

  const clientLine =
    plan.clientId?.mode === "literal"
      ? `the configured client <code>${esc(plan.clientId.value)}</code>`
      : plan.clientSecretVariable !== null
        ? `the client seeded as <code>\${${esc(
            plan.clientId?.mode === "write" ? plan.clientId.variable : "",
          )}}</code> and <code>\${${esc(plan.clientSecretVariable)}}</code>`
        : `a public client strad registers at the upstream (RFC 7591), or — if ` +
          `the upstream offers no registration — the client id seeded as ` +
          `<code>\${${esc(
            plan.clientId?.mode === "write" ? plan.clientId.variable : "",
          )}}</code>`;

  const body = `
<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/connectors" class="crumb">connectors</a><span class="crumb-sep">/</span><span class="crumb crumb-current">${esc(slug)}</span></nav>

<section class="browse-head">
  <div class="scope"><span class="scope-l">kind</span><code>remote-http</code></div>
  <div class="scope"><span class="scope-l">upstream</span><code>${esc(host)}</code></div>
  <div class="scope"><span class="scope-l">account</span><code>not checked</code></div>
</section>

${flash}
${statusBlock}

<section class="panel">
  <div class="panel-head"><h2>What Connect does</h2>
    <span class="panel-note">MCP authorization · discovered, not configured</span></div>
  <ol class="scope-list">
    <li>Asks <code>${esc(entry.server.url)}</code> for its protected-resource metadata (RFC 9728), and that names the authorization server (RFC 8414).</li>
    <li>Uses ${clientLine}, with the redirect URI below.</li>
    <li>Sends you to sign in, with PKCE and <code>resource=</code> (RFC 8707), asking for ${
      plan.scopes
        ? plan.scopes.length > 0
          ? `the configured scopes <code>${esc(plan.scopes.join(" "))}</code>`
          : "no scopes"
        : "the scopes the upstream advertises"
    }.</li>
    <li>Exchanges the code and stores what it learned under this server's <code>oauth/</code> namespace.</li>
  </ol>
</section>

<section class="panel">
  <div class="panel-head"><h2>Where it goes</h2>
    <span class="panel-note">the refresh token is never displayed, never logged</span></div>
  <ul class="scope-list">
    ${describeField("tokenUrl", plan.tokenUrl, "the discovered token endpoint")}
    ${describeField("clientId", plan.clientId, "the client id, when strad registered it")}
    ${describeField("resource", plan.resource, "the resource the tokens are bound to")}
    <li><code>\${${esc(plan.refreshVariable)}}</code> — the refresh token, as a secret parameter</li>
  </ul>
  <div class="field">
    <span class="field-l">Namespace</span>
    <code class="pathpart">${esc(`/strad/${opts.config.gateway.env}/mcp/${slug}/oauth/`)}</code>
    <span class="field-h">A server reads its own <code>oauth/</code> ahead of <code>static/</code> and the
      gateway's namespace, so these take precedence over anything seeded by hand.</span>
  </div>
  <div class="field">
    <span class="field-l">Redirect URI</span>
    <code class="pathpart">${redirectUri ? esc(redirectUri) : "—"}</code>
    <span class="field-h">Registered automatically when strad registers the client. A client registered by
      hand must list this exact string.</span>
  </div>
  <div class="field">
    <span class="field-l">When the server sees it</span>
    <span class="field-h">On its next request. Core resolves this server's credentials per call, and Connect
      drops this process's cached reading, so a server waiting on <code>mayBeUnseeded</code> names starts
      serving without a redeploy.</span>
  </div>
</section>`;

  res
    .status(extras.status ?? 200)
    .type("html")
    .send(
      layout({
        title: `${slug} · connect`,
        serverSlug: slug,
        signedInAs: extras.signedInAs,
        nav: "connectors",
        body,
      }),
    );
}

/**
 * The flash for a callback that has just redirected back here. Closed set in,
 * strad's own sentence out; nothing from the URL is rendered.
 */
export function upstreamFlash(
  query: Request["query"],
  entry: UpstreamConnector,
): { tone: "ok" | "error"; message: string } | undefined {
  const host = (() => {
    try {
      return new URL(entry.server.url).host;
    } catch {
      return entry.server.slug;
    }
  })();
  if (query.connected === "1") {
    return {
      tone: "ok",
      message:
        `Connected. strad stored a refresh token for ${host} in this server's ` +
        `own namespace, and the server uses it from its next request.`,
    };
  }
  const code = typeof query.error === "string" ? query.error : "";
  if (!code) return undefined;
  const messages: Record<string, string> = {
    exchange_failed:
      `Refused: ${host} would not exchange the authorization code. It may ` +
      `have expired or been used already. Nothing was written.`,
    exchange_timed_out:
      `Refused: ${host} did not answer the code exchange in time. Nothing was ` +
      `written; Connect again mints a fresh code.`,
    no_refresh_token:
      `Refused: ${host} completed the consent but issued no refresh token, so ` +
      `there is nothing durable to store. Nothing was written. Some servers ` +
      `issue one only for an offline_access scope — set oauthRefresh.scope to ` +
      `ask for it.`,
    client_unreadable:
      `Refused: strad could not read this server's client secret from its own ` +
      `namespace, so nothing was exchanged and nothing was written. strad's ` +
      `logs name why, under strad.connector_connect_failed.`,
    store_failed:
      `The authorization succeeded but the parameter store refused a write, ` +
      `so the stored values may be partly replaced. Connect again to write a ` +
      `consistent set; strad's logs name the failure.`,
  };
  return {
    tone: "error",
    message: messages[code] ?? "Refused. Nothing was written.",
  };
}
