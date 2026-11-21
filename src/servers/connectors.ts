import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { INSTANCE_PATH_PREFIX, INSTANCE_TREES } from "../secrets/param-route.ts";
import { oauthParameterPath } from "../secrets/parameters/index.ts";
import type {
  BuiltinContext,
  BuiltinModule,
  CallToolResult,
} from "../gateway/adapters/types.ts";
import type { RuntimeConfig } from "../config/runtime.ts";
import { ConfigRejected } from "../config/runtime.ts";
import {
  AccessControlChanged,
  ImmutableFieldChanged,
  NotRuntimeCreatable,
  RUNTIME_CREATABLE_KINDS,
  ReachExceeded,
  SlugCollision,
  assertNoCollision,
  immutableFields,
  rawEntry,
  withRemoval,
  withRestore,
  withUpsert,
  type WritingPrincipal,
} from "../config/overlay.ts";
import {
  CREDENTIAL_SCHEMES,
  LiteralCredential,
} from "../config/secret-position.ts";
import { ConfigStoreReadOnly, ConfigStoreTooLarge } from "../config/store.ts";
import { soleRefName } from "../config/schema.ts";
import { refreshTokenPath } from "../connectors/index.ts";
import { serverConsolePath } from "../ui/paths.ts";
import { errorSummary } from "../util/error-text.ts";

/**
 * The connector editor, as an MCP server.
 *
 * ## Why this exists at all
 *
 * strad has two front doors and a capability behind only one of them is a
 * defect until somebody says otherwise. The console at `/connectors` lets a
 * HUMAN add, edit, disable and remove a server entry without a deploy; this is
 * the same roster, the same validation and the same rebuild, reachable by an
 * AGENT in the middle of a session. "Add a connector for this API and use it"
 * is a thing a session gets asked to do, and a version of that which needs a
 * person to open a browser is a version that stalls.
 *
 * ## One set of rules, not two
 *
 * Every decision here is delegated. What may be created and what may be edited
 * is `RuntimeConfig.assertAcceptable` — the same call the console form makes,
 * over the same `src/config/overlay.ts` rules. Whether a candidate roster is
 * legal is `RuntimeConfig.apply`, which validates the whole merged document.
 * This module owns the tool schemas and nothing else, because two
 * implementations of "may I add this" is two answers, and the one a human saw
 * and the one an agent saw would eventually differ.
 *
 * ## What withholds the write tools
 *
 * Two layers, and neither is invented here.
 *
 * A gateway whose process holds no credential that can PERSIST a roster change
 * lists the read tools and not the write ones — `visibleTools` below. A tool
 * that is listed and refuses every call is worse than one that is absent, and
 * this is the same shape the `secrets` server derives from its IAM probe.
 *
 * A deployment that wants the read half and not the write half says so with the
 * ordinary `tools: { allow: [...] }` policy on this slug, enforced by
 * `src/gateway/toolPolicy.ts` on `tools/list` AND `tools/call`. That mechanism
 * already exists, is already fail-closed, and is already what an operator
 * reaches for — a second switch in `options:` would be a second answer to the
 * same question.
 *
 * And the slug itself is the outermost gate: this builtin is mounted only by a
 * config entry that names it, with its own `entitlements:`. A deployment that
 * does not want an agent editing its roster does not mount it.
 *
 * ## The OAuth leg
 *
 * `describe_connector_authorization` is deliberately NOT "do the OAuth flow".
 * Granting consent is a browser handshake against a third party — the agent has
 * no browser, and a tool that claimed to do it would be a tool that lies. What
 * an agent needs instead is the handoff: the URL a human opens to finish, and
 * the parameter path the resulting credential lands at, so the agent can put
 * both in front of the person it is talking to and carry on. That tool returns
 * exactly those two facts, computed from config.
 */

const TEXT = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

const FAILURE = (message: string, detail?: string[]): CallToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ ok: false, error: message, detail }, null, 2),
    },
  ],
  isError: true,
});

const REVISION_ARG = {
  expectedRevision: {
    type: "number",
    description:
      "The roster revision this change was computed against, from list_connectors. " +
      "Supplied, a write is refused if the roster has moved since — the same check " +
      "the console form makes. Omitted, the write is applied to whatever the roster " +
      "is now. Supply it whenever you read before you wrote.",
  },
} as const;

const READ_TOOLS: Tool[] = [
  {
    name: "list_connectors",
    description:
      "Every MCP server this gateway serves, with where each entry came from. " +
      "An entry whose source is `store` was added or overridden at runtime and can be " +
      "edited from here; one whose source is `file` comes from the deployment's " +
      "checked-in config, and editing it writes a runtime override of it. Returns the " +
      "roster `revision`, which the write tools take as `expectedRevision`.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_connector",
    description:
      "One entry, exactly as it is written — the fields somebody set, not the defaults " +
      "the schema fills in around them. This is also how you COPY an existing " +
      "connector: take the returned `entry`, change `slug` and whatever else differs " +
      "(a credential ref, a narrower tools policy), and pass it to save_connector. " +
      "`immutableFields` names the fields that only a deploy can move on this kind. " +
      "A credential-carrying field holding a LITERAL rather than a ${NAME} ref comes " +
      "back redacted — an entry the CHECKED-IN config declares, or one stored before " +
      "runtime writes refused literals; a runtime write cannot store a new one. " +
      "save_connector refuses an entry that still carries the redaction, so replace " +
      "it with a ref rather than copying it through.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The connector's slug." },
      },
      required: ["slug"],
    },
  },
  {
    name: "describe_connector_authorization",
    description:
      "How a credential gets into a connector that needs one, and who has to do it. " +
      "Granting OAuth consent is a browser handshake against the provider, so an agent " +
      "cannot complete it — this returns the handoff instead: the URL a human opens to " +
      "finish, and the parameter path the resulting credential is read from. Put both " +
      "in front of the person you are working with. It reports what the CONFIG asks " +
      "for; whether the credential is present is a question for the secrets surface.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The connector's slug." },
      },
      required: ["slug"],
    },
  },
];

const WRITE_TOOLS: Tool[] = [
  {
    name: "save_connector",
    description:
      "Create a connector, or replace one that exists. `entry` is a server entry in the " +
      "same shape the checked-in config uses — start from get_connector on something " +
      "similar rather than from nothing. On success the change is live on this gateway " +
      "immediately: no deploy, no restart, and the next /mcp request can select the new " +
      "slug. The whole merged config is validated first, so a refusal can name a rule " +
      "about a DIFFERENT entry (a duplicate slug, a role nothing declares); nothing is " +
      "written unless it passes. Kinds that can be created: " +
      RUNTIME_CREATABLE_KINDS.join(", ") +
      " — a `builtin` never can, because its module has to ship inside the image, and a " +
      "`supplementary-image` either onto a mount this deployment already runs, or as a " +
      "store-served instance: `path: " +
      INSTANCE_PATH_PREFIX +
      "/{tree}/{its own slug}` with `params: true`, for " +
      INSTANCE_TREES.join(", ") +
      ". An instance is credentialed from that slug's own namespace: seed its values through " +
      "the secrets surface first, then call `refresh_gateway`, because core serves an " +
      "instance out of its reading of the store and a write made outside the console " +
      "otherwise reaches it only within `gateway.secrets.ttlSeconds`. It is served on its " +
      "next request. For a slug " +
      "the CHECKED-IN config declares, `entitlements:` and `tools:` cannot be changed " +
      "here at all: those decide who reaches that server and which of its tools they " +
      "get, and for a server the deploy authorised they stay with the deploy.",
    inputSchema: {
      type: "object",
      properties: {
        entry: {
          type: "object",
          description:
            "The server entry. Needs at least `slug` and `kind`; a `remote-http` also " +
            "needs `url`, and every entry needs `entitlements` naming roles this config " +
            "declares or nothing will be able to reach it. CREDENTIALS ARE NAMED, NEVER " +
            "CARRIED: every `headers` value must be one ${NAME} ref, optionally after an " +
            "auth scheme (" +
            CREDENTIAL_SCHEMES.join(", ") +
            ") — `\"Bearer ${GRANOLA_TOKEN}\"` — and a literal is refused, including one " +
            "that is not a secret, because nothing here can tell the difference. `url` " +
            "may not carry user:password@ userinfo. Put the value in this slug's own " +
            "namespace through the secrets surface first and reference it here.",
        },
        previousSlug: {
          type: "string",
          description:
            "When renaming: the slug this entry had before. Without it the old slug is " +
            "left behind as a second entry.",
        },
        ...REVISION_ARG,
      },
      required: ["entry"],
    },
  },
  {
    name: "set_connector_enabled",
    description:
      "Turn a connector on or off without removing it. A disabled entry stays in the " +
      "roster and stops being routed; a client that selects it is told it is disabled " +
      "rather than that it does not exist. Takes effect immediately.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The connector's slug." },
        enabled: { type: "boolean", description: "Whether to serve it." },
        ...REVISION_ARG,
      },
      required: ["slug", "enabled"],
    },
  },
  {
    name: "restore_connector",
    description:
      "Undo the removal of a connector the checked-in config declares, so the file's " +
      "entry serves again. The slugs this applies to are in list_connectors' `removed`. " +
      "It does not bring back a connector that was ADDED at runtime and then removed — " +
      "there is no file entry behind that one; re-create it with save_connector.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The connector's slug." },
        ...REVISION_ARG,
      },
      required: ["slug"],
    },
  },
  {
    name: "remove_connector",
    description:
      "Remove a connector from the roster. A connector that was ADDED at runtime is " +
      "simply dropped. One that the checked-in config declares cannot be dropped that " +
      "way, so the removal is recorded and stands until someone deletes it from the " +
      "file or re-adds it here. Takes effect immediately.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The connector's slug." },
        ...REVISION_ARG,
      },
      required: ["slug"],
    },
  },
];

function runtimeOf(ctx: Pick<BuiltinContext, "runtime">): RuntimeConfig | null {
  return ctx.runtime?.() ?? null;
}

const REDACTED = "<literal value, redacted — put it in the store as ${NAME}>";

/** Does this value read anything out of the parameter store? */
const REF = /\$\{[^}]+\}/;

/**
 * An entry with any literal credential-shaped value replaced.
 *
 * `headers:` is `z.record(z.string())`, so a literal bearer token in it is
 * legal config — and `get_connector` is a READ tool, available on a gateway
 * that cannot write at all. Handing the raw entry back would mean a deployment
 * that mounted this surface so an agent could *browse* the roster also handed
 * out every non-`${NAME}` header value in its config.
 *
 * The line is whether the value's secret lives in the STORE. A header that
 * references one — `Bearer ${TOKEN}`, the commonest correct shape there is —
 * is kept whole: the ref is what an agent needs to see, and `Bearer ` is not a
 * credential. A value with no ref at all is a literal, and a literal in a
 * header is the thing this exists to not hand out.
 *
 * `oauthRefresh`'s two credential fields are stricter, and get to be: the
 * schema already requires each to be exactly one `${NAME}`, so anything else
 * there cannot have come through a validated config.
 *
 * WHAT THIS HAS TO COVER, given `src/config/secret-position.ts`. A runtime
 * write cannot store a NEW literal in either of these positions, so an entry
 * reaching this function carrying one is either declared by the CHECKED-IN
 * document or was stored in the overlay before that rule refused it — an
 * overlay the poll and the boot still serve, on purpose. Neither is something
 * this surface can rewrite, and a deployment mounts the read tools precisely so
 * an agent can browse a roster it did not author.
 *
 * Redaction for the common case, not secret detection. A credential
 * interpolated beside a ref, or typed into some field nobody thinks of as
 * credential-carrying, is not something this can find. For a file-declared
 * entry the guarantee is still one layer out, in the config never being the
 * right place for a secret.
 */
function redacted(entry: Record<string, unknown>): Record<string, unknown> {
  const out = { ...entry };

  if (isRecord(out.headers)) {
    out.headers = Object.fromEntries(
      Object.entries(out.headers).map(([k, v]) => [
        k,
        REF.test(String(v)) ? v : REDACTED,
      ]),
    );
  }

  if (isRecord(out.oauthRefresh)) {
    const oauth = { ...out.oauthRefresh };
    for (const field of ["clientSecret", "refreshToken"] as const) {
      const value = oauth[field];
      if (typeof value === "string" && !soleRefName(value)) {
        oauth[field] = REDACTED;
      }
    }
    out.oauthRefresh = oauth;
  }

  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The roster as an agent sees it: facts, never a credential value. */
function summarise(runtime: RuntimeConfig) {
  const sources = runtime.sources();
  return {
    revision: runtime.overlay().revision,
    updatedAt: runtime.overlay().updatedAt,
    updatedBy: runtime.overlay().updatedBy,
    writable: runtime.writable,
    // Slugs the checked-in config declares and the overlay subtracts. Without
    // this the list below simply does not contain them, and "removed" and
    // "never existed" are the same answer — which is the wrong answer for the
    // one a `restore_connector` can undo.
    removed: runtime.overlay().servers.removals,
    connectors: runtime.config().servers.map((server) => ({
      slug: server.slug,
      kind: server.kind,
      source: sources.get(server.slug) ?? "file",
      enabled: server.enabled,
      entitlements: server.entitlements,
      title: server.title,
      description: server.description,
      tools: server.tools,
    })),
  };
}

const mod: BuiltinModule = {
  tools: [...READ_TOOLS, ...WRITE_TOOLS],

  visibleTools(ctx) {
    const runtime = runtimeOf(ctx);
    // No mutable roster: this gateway's servers come from its checked-in
    // document and change with a deploy, so there is nothing here to read OR
    // write that `tools/list` on the gateway does not already say. Offering
    // tools that answer "not here" to every call is worse than offering none.
    if (!runtime?.editable) return [];
    // A roster this process can read and not persist — a store with no admin
    // credential. Listing the write tools would advertise a capability the
    // next call cannot honour.
    return runtime.writable ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
  },

  async call(name, args, ctx): Promise<CallToolResult> {
    const runtime = runtimeOf(ctx);
    if (!runtime?.editable) {
      return FAILURE(
        "This gateway has no runtime server roster: its config does not set " +
          "gateway.configStore.enabled, so the server list comes from the " +
          "checked-in document and changes with a deploy.",
      );
    }

    switch (name) {
      case "list_connectors":
        return TEXT({ ok: true, ...summarise(runtime) });

      case "get_connector": {
        const slug = String(args.slug ?? "");
        const entry = rawEntry(runtime.document(), slug);
        if (!entry) return FAILURE(`No connector called ${slug}.`);
        return TEXT({
          ok: true,
          slug,
          source: runtime.sources().get(slug) ?? "file",
          entry: redacted(entry),
          immutableFields: immutableFields(String(entry.kind ?? "")),
          revision: runtime.overlay().revision,
        });
      }

      case "describe_connector_authorization":
        return describeAuthorization(runtime, String(args.slug ?? ""));

      case "save_connector":
      case "set_connector_enabled":
      case "remove_connector":
      case "restore_connector":
        // `ctx.principal` is who authenticated the /mcp request this call is
        // serving. It is what bounds the write to what its author can already
        // reach — the console hands `RuntimeConfig.assertAcceptable` the signed-in
        // human for the same reason (src/ui/servers.ts).
        return write(runtime, name, args, ctx.principal);

      default:
        return FAILURE(`connectors server has no tool "${name}".`);
    }
  },
};

/**
 * The three mutating tools, which share every step but the one that builds the
 * candidate overlay.
 */
async function write(
  runtime: RuntimeConfig,
  name: string,
  args: Record<string, unknown>,
  principal: WritingPrincipal | undefined,
): Promise<CallToolResult> {
  if (!runtime.writable) {
    return FAILURE(
      "This gateway holds no credential that can persist a roster change, so " +
        "the connector list is read-only here.",
    );
  }

  // An author confined to named slugs — an `/mcp` OAuth token scoped by
  // `slug:` (`Principal.slugs`) — writes only those slugs: no create, edit,
  // toggle, removal or restore of any other, whatever its roles reach. Every
  // slug the call names is checked, a rename's old name included.
  if (principal?.slugs) {
    const allowed = principal.slugs;
    const entrySlug =
      typeof args.entry === "object" && args.entry !== null
        ? (args.entry as Record<string, unknown>).slug
        : undefined;
    const named = [args.slug, entrySlug, args.previousSlug].filter(
      (s): s is string => typeof s === "string" && s !== "",
    );
    const outside = named.filter((s) => !allowed.includes(s));
    if (outside.length > 0) {
      return FAILURE(
        `This credential is confined to named servers, and ${outside.join(", ")} ` +
          `is not among them. Nothing was written.`,
      );
    }
  }

  const overlay = runtime.overlay();
  const expected = args.expectedRevision;
  if (typeof expected === "number" && expected !== overlay.revision) {
    return FAILURE(
      `The roster has moved: you computed this change against revision ` +
        `${expected}, and it is now ${overlay.revision}. Nothing was written. ` +
        `Re-read it with list_connectors and re-apply.`,
    );
  }

  const fileSlugs = runtime.fileSlugs();
  let next;
  let subject: string;

  try {
    if (name === "restore_connector") {
      subject = String(args.slug ?? "");
      if (!overlay.servers.removals.includes(subject)) {
        return FAILURE(
          `${subject} is not a removed connector. list_connectors reports the ` +
            `removed ones under \`removed\`.`,
        );
      }
      next = withRestore(overlay, subject, { by: "mcp" });
    } else if (name === "remove_connector") {
      subject = String(args.slug ?? "");
      if (!rawEntry(runtime.document(), subject)) {
        return FAILURE(`No connector called ${subject}.`);
      }
      next = withRemoval(overlay, subject, { fileSlugs, by: "mcp" });
    } else if (name === "set_connector_enabled") {
      subject = String(args.slug ?? "");
      const before = rawEntry(runtime.document(), subject);
      if (!before) return FAILURE(`No connector called ${subject}.`);
      // `=== true`, not `!== false`: `inputSchema` is documentation, not a
      // runtime validator, so a caller sending the STRING "false" would
      // otherwise enable the server it asked to disable.
      if (typeof args.enabled !== "boolean") {
        return FAILURE("`enabled` must be a boolean.");
      }
      next = withUpsert(
        overlay,
        { ...before, enabled: args.enabled === true },
        { fileSlugs, by: "mcp" },
      );
    } else {
      const entry = args.entry;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return FAILURE("`entry` must be an object.");
      }
      const candidate = entry as Record<string, unknown>;
      subject = String(candidate.slug ?? "");
      if (!subject) return FAILURE("`entry.slug` is required.");

      // `get_connector` redacts a literal credential, so a copy-and-save round
      // trip would otherwise write the sentinel string in as the value — a
      // connector that fails at the upstream with a baffling token. Refuse it
      // and say what to do instead.
      if (JSON.stringify(candidate).includes(REDACTED)) {
        return FAILURE(
          `This entry still carries ${JSON.stringify(REDACTED)}, which is what ` +
            `get_connector substitutes for a literal credential it will not ` +
            `hand out. Replace it with a \${NAME} ref pointing at a parameter ` +
            `in the store, or set the value through the secrets surface first.`,
        );
      }

      const previousSlug =
        typeof args.previousSlug === "string" ? args.previousSlug : undefined;
      // An edit is judged on what MOVED; a create on what it is. Which one this
      // is turns on whether the roster already holds the slug being written.
      const before = rawEntry(runtime.document(), previousSlug ?? subject);
      // Replacing the slug you named is this tool's documented semantic, so
      // `replacing` is that slug. What it refuses is a RENAME that lands on a
      // third entry — the accident the console refuses on create too.
      assertNoCollision(runtime.config(), subject, previousSlug ?? subject);
      runtime.assertAcceptable(candidate, before, principal);

      next = withUpsert(overlay, candidate, {
        ...(previousSlug && previousSlug !== subject ? { previousSlug } : {}),
        fileSlugs,
        by: "mcp",
      });
    }
  } catch (err) {
    if (
      err instanceof NotRuntimeCreatable ||
      err instanceof ImmutableFieldChanged ||
      err instanceof SlugCollision ||
      err instanceof AccessControlChanged ||
      err instanceof ReachExceeded ||
      err instanceof LiteralCredential
    ) {
      return FAILURE(err.message);
    }
    throw err;
  }

  try {
    await runtime.apply(next, "mcp");
  } catch (err) {
    if (err instanceof ConfigRejected) {
      return FAILURE(
        "That change would make the config invalid, so nothing was written.",
        err.problems,
      );
    }
    if (
      err instanceof ConfigStoreReadOnly ||
      err instanceof ConfigStoreTooLarge ||
      // Reachable from `set_connector_enabled` rather than from a composed
      // entry: it re-upserts an entry this tool never built, and `apply`
      // refuses one that would newly store a credential value.
      err instanceof LiteralCredential
    ) {
      return FAILURE(err.message);
    }
    // `errorSummary`, not `errorText`: this path has just been through a
    // parameter-store write, and a store client's exception can quote a
    // rendered value. src/util/error-text.ts makes that call for us.
    return FAILURE(
      "The change could not be applied, so nothing was written: " +
        errorSummary(err),
    );
  }

  return TEXT({
    ok: true,
    changed: subject,
    live: true,
    note: "Live on this gateway now — the next /mcp request can select it.",
    ...summarise(runtime),
  });
}

/**
 * What it takes to credential one connector, and which half a human owns.
 *
 * Computed from the entry alone. It does not read the store: whether the
 * credential is THERE is a different question with a different door (the
 * `secrets` surface), and answering it from here would mean this builtin
 * holding a store credential it otherwise has no use for.
 */
function describeAuthorization(
  runtime: RuntimeConfig,
  slug: string,
): CallToolResult {
  const entry = runtime.config().servers.find((s) => s.slug === slug);
  if (!entry) return FAILURE(`No connector called ${slug}.`);

  const publicUrl = runtime.config().gateway.publicUrl?.replace(/\/$/, "");
  const consolePage = publicUrl
    ? `${publicUrl}${serverConsolePath(slug)}`
    : `${serverConsolePath(slug)} (this gateway declares no gateway.publicUrl, so only the path is known)`;
  const env = runtime.config().gateway.env;

  if (entry.oauth) {
    // The connector's credential lands under the `oauth/` kind, not `static/`
    // — `refreshTokenPath` is the one place that knows, so this asks it rather
    // than spelling the path. `account` exists only on the Google flavour; the
    // generic one authorizes against whatever the provider's consent page
    // says, so it carries a `label` instead.
    const oauth = entry.oauth;
    const google = oauth.provider === "google";
    // Narrowed on the discriminant, not on the boolean above — TypeScript
    // does not carry a `const` narrowing across a spread.
    const who =
      oauth.provider === "google"
        ? { account: oauth.account }
        : { label: oauth.label, authorizeUrl: oauth.authorizeUrl };
    return TEXT({
      ok: true,
      slug,
      flow: google ? "google-connector" : "oauth-connector",
      completedBy: "human",
      provider: oauth.provider,
      ...who,
      scopes: oauth.scopes,
      humanUrl: consolePage,
      credentialPath: refreshTokenPath(runtime.config(), {
        server: entry,
        oauth,
      }),
      instructions:
        `Consent is a browser handshake with ${google ? "Google" : "the provider"} ` +
        "and cannot be completed by an agent. Give the person you are working with " +
        "`humanUrl`: the connector page there has a Connect button that runs the " +
        `authorization${google ? " as the account named above" : ""} and writes ` +
        "the credential to `credentialPath`. Once they say they have done it, the " +
        "connector works with no further action from you.",
    });
  }

  if (entry.kind === "remote-http" && entry.oauthRefresh) {
    const ref = entry.oauthRefresh.refreshToken;
    // The `?? ref` fallback cannot fire today, and it matters that it cannot:
    // `oauthRefresh.refreshToken` is superRefine'd to exactly one `${NAME}` in
    // src/config/schema.ts, and this reads a config that has already been
    // through the schema. If that rule is ever relaxed, this line starts
    // echoing a literal refresh token into `credentialPath` — relax the rule
    // and this needs a redaction, not a fallback.
    const variable = /^\$\{([^}]+)\}$/.exec(ref)?.[1] ?? ref;
    return TEXT({
      ok: true,
      slug,
      flow: "oauth-refresh",
      completedBy: "human",
      tokenUrl: entry.oauthRefresh.tokenUrl,
      humanUrl: consolePage,
      // Where the console's Connect writes it: the slug's own `oauth/` kind,
      // which the resolver and the rotation write-back both read first.
      credentialPath: oauthParameterPath(env, slug, variable),
      instructions:
        "strad mints this upstream's access tokens itself from a long-lived refresh " +
        "token, and rotates the stored one when the provider issues a new one — so " +
        "the authorization happens ONCE, and it is a browser sign-in an agent " +
        "cannot do. Give the person you are working with `humanUrl`: the page " +
        "there has a Connect button that discovers the upstream's authorization " +
        "server, registers a client where the upstream allows it, runs the " +
        "sign-in and writes the refresh token to `credentialPath`. If the page " +
        "refuses — for example, the upstream's metadata answers 403 to strad — it " +
        "says why. Once they say it is connected, the server works on its next " +
        "call with no further action from you.",
    });
  }

  return TEXT({
    ok: true,
    slug,
    flow: "none",
    completedBy: null,
    humanUrl: consolePage,
    instructions:
      "This connector declares no OAuth flow. If it needs a credential it is an " +
      "ordinary ${NAME} reference in its `url` or `headers`, resolved from the " +
      "parameter store on every call — create or rotate it through the secrets " +
      "surface and this entry picks it up with no further change.",
  });
}

export default mod;
