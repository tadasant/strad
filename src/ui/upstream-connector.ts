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
  clientMetadataUrl,
  clientSource,
  completeUpstreamAuthorization,
  metadataDocumentEligible,
  discoverUpstream,
  checkTokenEndpoint,
  heldVariables,
  parseSuppliedDocument,
  protectedResourceCandidates,
  registerClient,
  shown,
  storeUpstreamWrites,
  UPSTREAM_PROVIDER,
  UpstreamConnectError,
  upstreamClientName,
  upstreamConfigTerms,
  upstreamConnectorFor,
  upstreamNote,
  upstreamPlan,
  upstreamWrites,
  type ClientSource,
  type MetadataDocument,
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
  BRIGHTDATA_KEY_VARIABLE,
  brightDataFetch,
  proxiedOn403,
} from "../connectors/discovery-proxy.ts";
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
 * the upstream itself and, where it can, names its own client — a client ID
 * metadata document strad serves, or a registration. So the
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

/** The Connect form's two optional fields: metadata a human pasted. */
const PASTE_FIELDS = {
  resource: "resource_metadata",
  authorizationServer: "authorization_server_metadata",
} as const;

export async function handleUpstreamConnect(
  req: Request,
  res: Response,
  opts: ConnectorUiOptions,
  entry: UpstreamConnector,
): Promise<void> {
  const signedInAs = signedInLabel(res);
  const slug = entry.server.slug;
  const plan = upstreamPlan(entry);

  // What was pasted, raw, so a refusal can hand it back in the form rather
  // than make a human fetch and paste it again. Re-rendered escaped, into a
  // page only this signed-in human sees; never logged or evented.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const pasted = {
    resource:
      typeof body[PASTE_FIELDS.resource] === "string"
        ? (body[PASTE_FIELDS.resource] as string)
        : "",
    authorizationServer:
      typeof body[PASTE_FIELDS.authorizationServer] === "string"
        ? (body[PASTE_FIELDS.authorizationServer] as string)
        : "",
  };

  // 409 AND NEVER A 5xx, rendered in place: see `handleConnect` for why the
  // App Platform edge makes that a rule. Every one is an event.
  const refuse = async (
    reason: ConnectRefusal,
    message: string,
    state?: UpstreamState,
    detail: Record<string, string | number> = {},
    blocked?: { document: MetadataDocument; url: string },
  ): Promise<void> => {
    connectFailed("begin", slug, reason, detail);
    await renderUpstreamConnectorPage(res, opts, entry, {
      signedInAs,
      status: 409,
      state,
      flash: { tone: "error", message },
      ...(blocked || pasted.resource || pasted.authorizationServer
        ? { paste: { values: pasted, ...(blocked ? { blocked } : {}) } }
        : {}),
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
  const proxy = entry.oauth.discoveryProxy;
  const metadataFetch = proxy
    ? proxiedOn403(
        fetchImpl,
        brightDataFetch(
          {
            apiKey: proxyKeyReader(opts, proxy.apiKeyFrom ?? slug),
            zone: proxy.zone,
          },
          fetchImpl,
        ),
      )
    : undefined;

  let terms: UpstreamTerms;
  let scopes: string[];
  try {
    const supplied = {
      resource: parseSuppliedDocument(pasted.resource, "resource"),
      authorizationServer: parseSuppliedDocument(
        pasted.authorizationServer,
        "authorization_server",
      ),
    };
    const discovery = await discoverUpstream(
      {
        upstreamUrl: plan.url!,
        ...(plan.resource?.mode === "literal"
          ? { resourceOverride: plan.resource.value }
          : {}),
        scopes: plan.scopes,
        supplied,
        ...(metadataFetch ? { metadataFetch } : {}),
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
          `${shown(discovery.tokenEndpoint)}. A refresh token minted at one would be ` +
          `spent at the other, so strad will not begin. Make tokenUrl a ` +
          `\${NAME} and Connect writes the discovered one. Nothing was ` +
          `registered or written.`,
      );
    }

    // The exchange and every refresh go here from strad's egress. A firewall
    // in front of it is fatal however the metadata was read, so it is asked
    // before anything is registered and before anyone signs in.
    await checkTokenEndpoint(discovery.tokenEndpoint, fetchImpl);

    // A server that takes client ID metadata documents is offered strad's
    // own — when this deployment has an https public URL to serve it from.
    // `clientSource` decides whether it is used; see the order there.
    const metadataDocument = discovery.clientIdMetadataDocumentSupported
      ? clientMetadataUrl(opts.config, slug)
      : null;
    let source: ClientSource | null = clientSource(
      plan,
      {
        metadataDocument,
        registration: discovery.registrationEndpoint !== null,
      },
      state.held,
      // The client id's own `static/` entry: a human's, never Connect's.
      plan.clientId?.mode === "write"
        ? (state.metas.find(
            (m) =>
              m.hasValue &&
              m.path ===
                `${staticNamespace(opts.config.gateway.env, slug)}${
                  plan.clientId?.mode === "write" ? plan.clientId.variable : ""
                }`,
          ) ?? null)
        : null,
    );
    if (!source) {
      const variable =
        plan.clientId?.mode === "write" ? plan.clientId.variable : "clientId";
      // Why strad could not name a client itself. A server that takes a
      // metadata document, for a plan that could use one, on a deployment with
      // no https URL to serve it from, is the deployment's to fix — so that is
      // said first. (A plan that could use one never reaches here when the
      // server also offers registration: it registers instead.)
      const why =
        discovery.clientIdMetadataDocumentSupported &&
        metadataDocument === null &&
        metadataDocumentEligible(plan)
          ? `The authorization server ${shown(discovery.issuer)} takes a client ` +
            `ID metadata document and offers no dynamic client registration, ` +
            `but this deployment's gateway.publicUrl is not a bare https ` +
            `origin, so strad has no document address the server could fetch ` +
            `or would accept as a client id. Set gateway.publicUrl to the ` +
            `deployment's https origin (no path) and redeploy, or seed a ` +
            `client by hand: ` +
            `\${${variable}} is not seeded in this server's own namespace`
          : (discovery.registrationEndpoint === null
              ? `The authorization server ${shown(discovery.issuer)} offers no ` +
                `dynamic client registration` +
                (discovery.clientIdMetadataDocumentSupported
                  ? `, and strad does not sign in with its client ID ` +
                    `metadata document for a server that declares ` +
                    `oauthRefresh.clientSecret or oauthRefresh.registration`
                  : ` and takes no client ID metadata document`)
              : `This server declares oauthRefresh.clientSecret, so strad cannot ` +
                `register a client for it (without oauthRefresh.registration: it registers public clients only)`) +
            `, and \${${variable}} is not seeded in this server's own namespace`;
      throw new UpstreamConnectError(
        "no_client",
        why +
          `. Register a client at the upstream with the redirect URI ` +
          `${redirectUri}, seed its id as ${variable}` +
          (plan.clientSecretVariable !== null
            ? ` and its secret as ${plan.clientSecretVariable}`
            : "") +
          ` under ` +
          `${staticNamespace(opts.config.gateway.env, slug)}, and Connect ` +
          `uses it. Nothing was registered or written.`,
      );
    }
    // A confidential client strad registers brings its own secret; only a
    // seeded or literal client needs one already in the store.
    if (
      source.kind !== "register" &&
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

    let clientId: string | null = null;
    let sealedClientSecret: string | undefined;
    if (source.kind === "literal" || source.kind === "metadata_document") {
      clientId = source.clientId;
    } else if (source.kind === "register") {
      try {
        // `registration:` is the per-server opt-in that changes WHO strad
        // registers as, and — with `clientSecret:` declared — lets it keep a
        // confidential client's secret. Every other server registers a public
        // client under strad's own name.
        const confidential =
          plan.registration !== null && plan.clientSecretVariable !== null;
        const registered = await registerClient(
          {
            registrationEndpoint: discovery.registrationEndpoint!,
            redirectUri,
            clientName: upstreamClientName(opts.config, slug, plan),
            scopes: discovery.scopes,
            ...(confidential
              ? { confidential: { clientAuth: entry.oauth.clientAuth } }
              : {}),
          },
          fetchImpl,
        );
        clientId = registered.clientId;
        if (registered.clientSecret !== undefined) {
          sealedClientSecret = opts.sessions!.connectorSecret.seal({
            v: 1,
            secret: registered.clientSecret,
          });
        }
      } catch (err) {
        // A registration endpoint that REFUSES (401/403: it wants an initial
        // access token, or a firewall stands in front of it) is the case the
        // refusal tells a human to answer by seeding a client id. When one is
        // seeded, use it rather than refusing again on every Connect.
        const variable =
          plan.clientId?.mode === "write" ? plan.clientId.variable : null;
        const seeded = variable ? state.held.get(variable) : undefined;
        const refused =
          err instanceof UpstreamConnectError &&
          err.code === "registration_failed" &&
          (err.status === 401 || err.status === 403);
        if (!refused || !variable || !seeded) throw err;
        source = { kind: "seeded", variable, path: seeded.path };
        // A seeded client of a server that declares a secret needs that
        // secret seeded too — checked above only for a client strad would not
        // register, so asked again here, before anyone signs in.
        if (
          plan.clientSecretVariable !== null &&
          !state.held.has(plan.clientSecretVariable)
        ) {
          throw new UpstreamConnectError(
            "no_client",
            `The registration endpoint refused to register a client ` +
              `(HTTP ${(err as UpstreamConnectError).status}), and \${${variable}} ` +
              `is seeded but \${${plan.clientSecretVariable}} is not. Seed ` +
              `both under ${staticNamespace(opts.config.gateway.env, slug)}. ` +
              `Nothing was registered or written.`,
          );
        }
      }
    }
    if (source.kind === "seeded") {
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
    if (clientId === null) throw new Error("unreachable: no client id");

    terms = {
      clientId,
      // A metadata-document client id is written like a registered one: the
      // `${NAME}` is what every refresh reads, so the refresh token must land
      // beside the id it was issued to.
      registered:
        source.kind === "register" || source.kind === "metadata_document",
      ...(source.kind === "metadata_document"
        ? { metadataDocument: true as const }
        : {}),
      ...(source.kind === "seeded" && source.shadowed
        ? { overwriteClientId: true as const }
        : {}),
      ...(sealedClientSecret ? { sealedClientSecret } : {}),
      tokenUrl: discovery.tokenEndpoint,
      resource: discovery.resource,
      issuer: discovery.issuer,
    };
    const pending = beginUpstreamAuthorization({
      discovery,
      clientId,
      redirectUri,
      ...(entry.oauth.authorizeParams
        ? { authorizeParams: entry.oauth.authorizeParams }
        : {}),
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
        err.blocked,
      );
      return;
    }
    // A deadline that expired inside a discovery step surfaces as the step's
    // own `UpstreamConnectError`; anything else is strad's bug, not the
    // upstream's words, and the catch of last resort handles it.
    throw err;
  }
}

/**
 * The discovery proxy's API key, read once, on first use, from the `apiKeyFrom`
 * slug's own namespace (`oauth/` then `static/`) with the console's admin
 * credential — the same store read a seeded client id takes. Every failure is
 * `proxy_key_unreadable`, naming where the key was looked for and never what
 * the store said.
 */
function proxyKeyReader(
  opts: ConnectorUiOptions,
  keySlug: string,
): () => Promise<string> {
  let once: Promise<string> | undefined;
  const where = staticNamespace(opts.config.gateway.env, keySlug);
  const refuse = (why: string) =>
    new UpstreamConnectError(
      "proxy_key_unreadable",
      `A metadata document answered strad 403 and this server reads it through ` +
        `BrightData, but ${why} Seed ${BRIGHTDATA_KEY_VARIABLE} under ${where} ` +
        `(the console's Secrets page), or paste the document below. Nothing ` +
        `was registered or written.`,
    );
  const read = async (): Promise<string> => {
    const prefix = `/strad/${opts.config.gateway.env}/mcp/${keySlug}/`;
    const resolved = storeForPath(
      opts.config,
      opts.secrets,
      `${where}${BRIGHTDATA_KEY_VARIABLE}`,
      { parametersStore: opts.parametersStore },
    );
    if (!resolved.store) {
      throw refuse(`no parameter store reaches ${prefix}.`);
    }
    let metas: ParameterMeta[];
    try {
      metas = await resolved.store.list(prefix);
    } catch {
      throw refuse(`strad could not list ${prefix}.`);
    }
    const meta = heldVariables(opts.config, keySlug, metas).get(
      BRIGHTDATA_KEY_VARIABLE,
    );
    if (!meta) {
      throw refuse(
        `${BRIGHTDATA_KEY_VARIABLE} is not seeded for "${keySlug}".`,
      );
    }
    let value: string;
    try {
      value = await resolved.store.reveal(meta.path);
    } catch {
      throw refuse(`strad could not read ${meta.path}.`);
    }
    if (value.trim() === "") {
      throw refuse(`${meta.path} is empty.`);
    }
    return value.trim();
  };
  return () => (once ??= read());
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
  // transaction, which is a signed cookie in a browser. The exception is a
  // confidential client strad registered on THIS Connect: its secret is in the
  // transaction ENCRYPTED, and is written beside the client id below.
  let clientSecret: string | undefined;
  let registeredSecret: string | undefined;
  if (plan.clientSecretVariable !== null && terms.registered) {
    const opened = opts.sessions?.connectorSecret.open<{
      v: 1;
      secret: string;
    }>(terms.sealedClientSecret);
    if (typeof opened?.secret !== "string" || opened.secret === "") {
      // The transaction verified, so this is a value this key did not seal —
      // in practice, a console key rotated mid-Connect. Never a store read.
      connectFailed("callback", slug, "client_unreadable", {
        variable: plan.clientSecretVariable,
        failure: "unreadable",
      });
      back("?error=client_unreadable");
      return;
    }
    clientSecret = registeredSecret = opened.secret;
  } else if (plan.clientSecretVariable !== null) {
    const variable = plan.clientSecretVariable;
    const meta = state.held.get(variable);
    const path =
      meta?.path ??
      `${staticNamespace(opts.config.gateway.env, slug)}${variable}`;
    if (!meta) {
      // Checked at the connect POST too; this is the value going missing while
      // the human was at the upstream.
      connectFailed("callback", slug, "client_unreadable", {
        variable,
        failure: "not_found",
      });
      back("?error=client_unreadable");
      return;
    }
    try {
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
      registeredSecret,
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
  /**
   * The pasted-metadata form, opened: what was posted, and the document strad
   * was refused, when that is why it is open.
   */
  paste?: {
    values: { resource: string; authorizationServer: string };
    blocked?: { document: MetadataDocument; url: string };
  };
}

/**
 * The form for a Connect whose metadata strad cannot read itself.
 *
 * Closed until something asks for it — a `metadata_blocked` refusal, or a
 * paste that was itself refused — because for an upstream that answers strad
 * it is noise. The address in each label is one strad validated, the one it
 * was refused at; a human opens it in their own browser, where the firewall's
 * view of a cloud provider's egress does not apply.
 */
function pasteForm(
  action: string,
  upstreamUrl: string,
  paste: UpstreamPageExtras["paste"],
): string {
  const values = paste?.values ?? { resource: "", authorizationServer: "" };
  const blocked = paste?.blocked;
  const resourceUrl =
    blocked?.document === "resource"
      ? blocked.url
      : (() => {
          try {
            return protectedResourceCandidates(upstreamUrl)[0]!;
          } catch {
            return null;
          }
        })();
  const asUrl =
    blocked?.document === "authorization_server" ? blocked.url : null;
  const link = (url: string) =>
    `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer"><code>${esc(shown(url))}</code></a>`;
  const open = paste !== undefined;
  return `
<section class="panel">
  <details${open ? " open" : ""}>
    <summary><h2 style="display:inline">Connect with metadata you paste</h2>
      <span class="panel-note">for an upstream whose firewall blocks this deployment</span></summary>
    <p class="field-h">Discovery reads two public documents. When a firewall refuses them to this
      deployment's cloud addresses, read them in your own browser instead and paste them here. strad
      checks a pasted document the way it checks a fetched one, and still makes the registration,
      the code exchange and every refresh itself — so it first checks the token endpoint answers it.</p>
    <form method="post" action="${esc(action)}" style="display:grid;gap:1rem">
      <label class="field">
        <span class="field-l">Protected-resource metadata</span>
        <span class="field-h">${resourceUrl ? `Open ${link(resourceUrl)} and paste the whole JSON.` : "The upstream's RFC 9728 document."}</span>
        <textarea class="in" name="${PASTE_FIELDS.resource}" rows="6" spellcheck="false" style="width:100%">${esc(values.resource)}</textarea>
      </label>
      <label class="field">
        <span class="field-l">Authorization server metadata <em>(optional)</em></span>
        <span class="field-h">${
          asUrl
            ? `strad was refused ${link(asUrl)} too. Open it and paste the whole JSON.`
            : "Only if strad then reports this one blocked as well; it names the address."
        }</span>
        <textarea class="in" name="${PASTE_FIELDS.authorizationServer}" rows="6" spellcheck="false" style="width:100%">${esc(values.authorizationServer)}</textarea>
      </label>
      <div><button class="btn btn-primary">Connect with this metadata</button></div>
    </form>
  </details>
</section>`;
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

/** What `authorizeParams:` adds to the sign-in link, on the page before anyone clicks. */
function authorizeParamsLine(
  params: Readonly<Record<string, string>> | undefined,
): string {
  const pairs = Object.entries(params ?? {});
  if (pairs.length === 0) return "";
  return (
    `, with the configured ` +
    pairs.map(([k, v]) => `<code>${esc(`${k}=${v}`)}</code>`).join(", ")
  );
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

  const clientVariable =
    plan.clientId?.mode === "write" ? plan.clientId.variable : "";
  // Shown only where the route serves it: an eligible plan on a deployment
  // with an https public URL. See `clientMetadataDocument`.
  const documentUrl = metadataDocumentEligible(plan)
    ? clientMetadataUrl(opts.config, slug)
    : null;
  const registersAs = plan.registration
    ? ` registered under the name <code>${esc(plan.registration.clientName)}</code> ` +
      `(this server's <code>registration:</code>)`
    : "";
  const clientLine =
    plan.clientId?.mode === "literal"
      ? `the configured client <code>${esc(plan.clientId.value)}</code>`
      : plan.registration && plan.clientSecretVariable !== null
        ? `a confidential client strad registers at the upstream (RFC 7591)${registersAs}, ` +
          `whose id and secret it writes as <code>\${${esc(clientVariable)}}</code> and ` +
          `<code>\${${esc(plan.clientSecretVariable)}}</code> — or, if the upstream offers no ` +
          `registration, the client seeded under those names`
        : plan.clientSecretVariable !== null
          ? `the client seeded as <code>\${${esc(
              plan.clientId?.mode === "write" ? plan.clientId.variable : "",
            )}}</code> and <code>\${${esc(plan.clientSecretVariable)}}</code>`
          : (documentUrl
              ? `strad's own client ID metadata document, <code>${esc(documentUrl)}</code>, as the ` +
                `client id when the upstream takes one; otherwise `
              : "") +
            `a public client strad registers at the upstream (RFC 7591)${registersAs}, or — if ` +
            `the upstream offers neither — the client id seeded as ` +
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
${state.kind === "ready" || state.kind === "connected" ? pasteForm(action, entry.server.url, extras.paste) : ""}

<section class="panel">
  <div class="panel-head"><h2>What Connect does</h2>
    <span class="panel-note">MCP authorization · discovered, not configured</span></div>
  <ol class="scope-list">
    <li>Asks <code>${esc(entry.server.url)}</code> for its protected-resource metadata (RFC 9728), and that names the authorization server (RFC 8414).${
      entry.oauth.discoveryProxy
        ? ` A document that answers strad 403 is read again through BrightData, a third-party proxy, with
      <code>${esc(BRIGHTDATA_KEY_VARIABLE)}</code> from <code>${esc(
        entry.oauth.discoveryProxy.apiKeyFrom ?? slug,
      )}</code>'s namespace. Only those two public documents go through it.`
        : ""
    }</li>
    <li>Uses ${clientLine}, with the redirect URI below.</li>
    <li>Sends you to sign in, with PKCE and <code>resource=</code> (RFC 8707), asking for ${
      plan.scopes
        ? plan.scopes.length > 0
          ? `the configured scopes <code>${esc(plan.scopes.join(" "))}</code>`
          : "no scopes"
        : "the scopes the upstream advertises"
    }${authorizeParamsLine(entry.oauth.authorizeParams)}.</li>
    <li>Exchanges the code and stores what it learned under this server's <code>oauth/</code> namespace.</li>
  </ol>
</section>

<section class="panel">
  <div class="panel-head"><h2>Where it goes</h2>
    <span class="panel-note">the refresh token is never displayed, never logged</span></div>
  <ul class="scope-list">
    ${describeField("tokenUrl", plan.tokenUrl, "the discovered token endpoint")}
    ${describeField("clientId", plan.clientId, "the client id, when strad registered it or signed in with its metadata document")}
    ${
      plan.registration && plan.clientSecretVariable !== null
        ? `<li><code>\${${esc(plan.clientSecretVariable)}}</code> — the client secret, when strad registered the client, as a secret parameter</li>`
        : ""
    }
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
    <span class="field-h">Registered automatically when strad registers the client, and the one redirect URI
      strad's client metadata document lists. A client registered by hand must list this exact string.</span>
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
      `ask for it. Others take a parameter on the sign-in link instead: for ` +
      `Google, set oauthRefresh.authorizeParams to access_type: offline and ` +
      `prompt: consent.`,
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
