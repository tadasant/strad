/**
 * `mcp.json` — draft SEP-2633 — as an INPUT DIALECT for strad's server list.
 *
 * [SEP-2633](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2633)
 * is a Draft, Standards-Track proposal for the file a client writes to say which
 * MCP servers it connects to. This module accepts that file's `mcpServers` map
 * and DESUGARS it into ordinary `servers:` entries, before Zod sees the
 * document. Nothing downstream of `parseConfig` knows the dialect exists: the
 * `ServerConfig` discriminated union in `src/config/schema.ts` is unchanged, and
 * `src/config/schema.ts` remains the contract.
 *
 * ## The shape of the bet
 *
 * SEP-2633 is an OPEN DRAFT, not a merged standard. Its `oauth` object is being
 * renegotiated upstream (SEP-2742), its reference-implementation section is a
 * `TODO`, and there is therefore no published JSON schema to validate against —
 * which is why nothing here, and nothing in the docs, names a `$schema` URL.
 * So the dialect is ADDITIVE and deliberately narrow: the YAML interface stays
 * authoritative, a config that does not write `mcpServers:` is parsed by exactly
 * the code path it always was, and the parts of the draft strad would have to
 * guess at are REFUSED BY NAME rather than defaulted.
 *
 * ## What maps, and what cannot
 *
 * One of strad's four kinds is expressible in the format, and it is the one the
 * format was designed for:
 *
 *   `type: "streamable-http"` + `url` + `headers`  ->  `kind: remote-http`
 *   the `mcpServers` key                           ->  `slug`
 *   `title`, `description`                         ->  the same two fields
 *   `${env:NAME}`                                  ->  `${NAME}` (mcp-json-refs.ts)
 *
 * The rest of strad has no home in a single-principal client config, and this
 * module does not invent one. `kind: supplementary-image` and `kind: builtin`
 * are deployment topology and an in-process import; `bundles:` is the container
 * the image lands in; `entitlements:` and `roles:` are a two-way agreement
 * (`src/gateway/entitlements.ts`) that presumes the config's reader is NOT its
 * only user, which is the assumption `mcp.json` is written under. `type:
 * "stdio"` looks like the nearest analog to a container and is not one: it
 * launches a local process, which strad never does.
 *
 * ## The gateway fields, when you want them: `strad:`
 *
 * An entry may carry an OPTIONAL `strad:` object holding the gateway-only fields
 * the format has no slot for — `entitlements`, `tools`, `enabled`, `timeoutMs`,
 * `mayBeUnseeded`, and a `slug` override. It is namespaced under one key so that
 * the rest of the entry stays a conforming `mcp.json` entry, and so that a host
 * which ignores keys it does not know reads the file as the format intends.
 *
 * An entry WITHOUT it attaches a server with `entitlements: []`, which is
 * fail-closed and correct and also means NOBODY CAN REACH IT. That is the cliff
 * this dialect creates and it is not left silent: every such slug comes back in
 * `notices`, which `scripts/check-config.ts` prints as a CI warning and boot
 * emits as `strad.mcp_json_unentitled`. Fail-closed, and loud about it.
 *
 * ## Two ways in, one transform
 *
 *   ROOT KEY. `mcpServers:` beside `servers:` in a strad config. The desugared
 *   entries are APPENDED to `servers:`, so `roles:`, `auth:` and `bundles:` are
 *   right there in the same document and the reachability cliff is one line away
 *   from being closed.
 *
 *   WHOLE DOCUMENT. A file that is just an `mcp.json` — `mcpServers` and no
 *   `version:`. `version: 1` and an empty `auth:` are supplied, which are the
 *   only two root fields with no default, so a pasted `mcp.json` is a config
 *   `npm run config:check` can validate and strad can boot. It will serve
 *   nothing to anyone until roles and entitlements exist; the notices say so.
 *
 * JSON is a subset of YAML, so both forms are parsed by the one YAML parser in
 * `src/config/load.ts` and no second parser is introduced.
 */

import { z } from "zod";
import { Role, SLUG, ToolPolicySchema } from "./schema.ts";
import { McpJsonError, rewriteInterpolations } from "./mcp-json-refs.ts";

/** The root key that says a document is speaking the dialect. */
export const MCP_SERVERS_KEY = "mcpServers";

/**
 * SEP-2633's server-name production.
 *
 * Wider than strad's `slug` in three directions — uppercase, `_`, and `[`/`]` —
 * which is the whole of the identifier mismatch between the two formats.
 */
const SEP_NAME_RE = /^[a-zA-Z0-9_[\]-]+$/;

/** The SEP's caps on the two human-facing fields. */
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 500;

/** Every key SEP-2633 defines on an entry, plus strad's one extension. */
const ENTRY_KEYS = [
  "title",
  "description",
  "type",
  "command",
  "args",
  "env",
  "url",
  "headers",
  "oauth",
  "strad",
] as const;

/** Every key the `strad:` extension defines. */
const EXTENSION_KEYS = [
  "slug",
  "entitlements",
  "enabled",
  "tools",
  "timeoutMs",
  "mayBeUnseeded",
] as const;

/**
 * The `strad:` extension — the gateway fields `mcp.json` has no slot for.
 *
 * Every field is validated against the SAME sub-schema `servers:` uses, so a
 * problem is reported against the key the operator WROTE (`mcpServers.foo.strad`)
 * rather than against the `servers[7]` index the desugar happens to produce.
 *
 * `oauth:` and `oauthRefresh:` are deliberately absent. A server that
 * authenticates as a person is configured in the YAML interface; binding either
 * of them here would mean taking a position on the draft's own contested `oauth`
 * object, which is the one thing this dialect is built not to do.
 */
const StradExtension = z
  .object({
    slug: SLUG.optional(),
    entitlements: z.array(Role).optional(),
    enabled: z.boolean().optional(),
    tools: ToolPolicySchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    mayBeUnseeded: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

/**
 * One `mcpServers` entry, as WRITTEN.
 *
 * Types only. Which combination of fields is legal for which `type` is decided
 * in `desugarEntry`, where a refusal can say why in the dialect's own terms —
 * "strad runs no local processes" is a more useful sentence than a union error.
 *
 * `.passthrough()`, not `.strict()`, and that is the same split
 * `src/config/strict.ts` draws for the YAML interface: an unknown key is
 * reported by the deploy-time check and shrugged at by boot, because an image
 * that refused to start on a key it had not heard of would turn a rollback into
 * an outage — and this dialect's upstream is a DRAFT, so new keys are expected.
 */
const McpJsonEntry = z
  .object({
    title: z.string().max(MAX_TITLE).optional(),
    description: z.string().max(MAX_DESCRIPTION).optional(),
    type: z.string(),
    command: z.unknown().optional(),
    args: z.unknown().optional(),
    env: z.unknown().optional(),
    url: z.string().optional(),
    headers: z.record(z.string()).optional(),
    oauth: z.unknown().optional(),
    strad: StradExtension.optional(),
  })
  .passthrough();

/**
 * The document's `mcpServers` node — a MAP, and nothing said about its values.
 *
 * Deliberately not `z.record(McpJsonEntry)`: a record schema fails as a whole on
 * the first bad value, which would collapse every per-entry refusal below into
 * one message about the map. Each entry is parsed on its own, so a document with
 * two mistakes in it reports two.
 */
const McpServersMap = z.record(z.unknown());

/** A slug the dialect attached that nothing can reach yet. */
export interface DialectNotice {
  slug: string;
  code: "no-entitlements";
  /** One line, written for a human, naming both halves of the fix. */
  message: string;
}

/**
 * A key the dialect did not recognise.
 *
 * `known` travels with it so `src/config/strict.ts` can suggest the nearest
 * spelling with its own `nearest()` — which lives there, and which this module
 * must not import (`strict.ts` imports `load.ts`, which imports this).
 */
export interface DialectUnknownKey {
  path: string;
  key: string;
  known: readonly string[];
}

export interface DesugarResult {
  /** The document with `mcpServers` folded into `servers:`, ready for Zod. */
  doc: unknown;
  /** True when the document spoke the dialect at all. */
  used: boolean;
  /** True when the document was an `mcp.json` rather than a strad config. */
  whole: boolean;
  /** Slugs the dialect contributed, in document order. */
  slugs: string[];
  notices: DialectNotice[];
  unknownKeys: DialectUnknownKey[];
  /** Everything the dialect refused, all of it, never just the first. */
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Whether a parsed document speaks the dialect at all. */
export function hasMcpServers(doc: unknown): boolean {
  return isPlainObject(doc) && MCP_SERVERS_KEY in doc;
}

/**
 * The nearest legal strad slug for a SEP server name — as a SUGGESTION only.
 *
 * Never applied automatically, and the reason is collision. `My_Server` and
 * `my-server` are two distinct, legal SEP names that fold to one strad slug, and
 * a slug is not a label: it prefixes every tool name (`<slug>__<tool>`), selects
 * the server in `?servers=`, and NAMES THIS SERVER'S VARIABLES ON THE CONTAINER
 * (`src/secrets/env-prefix.ts`). Silently folding two names into one identity is
 * exactly the class of failure the `SLUG` regex in `src/config/schema.ts` refuses
 * a doubled dash to prevent. So the operator writes the slug they meant, under
 * `strad: { slug: ... }`, and the dialect only tells them what it would have been.
 */
export function suggestedSlug(name: string): string | undefined {
  const folded = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (folded === "") return undefined;
  return SLUG.safeParse(folded).success ? folded : undefined;
}

/** `mcpServers.<name>` / `mcpServers.<name>.<field>` — a key path, never a value. */
function at(name: string, field?: string): string {
  return field
    ? `${MCP_SERVERS_KEY}.${name}.${field}`
    : `${MCP_SERVERS_KEY}.${name}`;
}

function unknownIn(
  value: Record<string, unknown>,
  known: readonly string[],
  path: string,
  out: DialectUnknownKey[],
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) out.push({ path, key, known });
  }
}

/**
 * One entry -> one `servers:` object, or one or more errors.
 *
 * Only the keys the entry actually WROTE are emitted. A field the dialect has no
 * value for is left off entirely, so the schema's own default applies and
 * `src/config/strict.ts` sees a minimal object with nothing to report.
 */
function desugarEntry(
  name: string,
  raw: unknown,
  errors: string[],
  notices: DialectNotice[],
  unknownKeys: DialectUnknownKey[],
): Record<string, unknown> | undefined {
  const parsed = McpJsonEntry.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${at(name, issue.path.join("."))}: ${issue.message}`);
    }
    return undefined;
  }
  const entry = parsed.data;

  if (isPlainObject(raw)) unknownIn(raw, ENTRY_KEYS, at(name), unknownKeys);
  const rawExtension = isPlainObject(raw) ? raw.strad : undefined;
  if (isPlainObject(rawExtension)) {
    unknownIn(rawExtension, EXTENSION_KEYS, at(name, "strad"), unknownKeys);
  }

  const before = errors.length;
  const refuse = (message: string): void => {
    errors.push(message);
  };

  // --- identity ------------------------------------------------------------
  if (!SEP_NAME_RE.test(name)) {
    refuse(
      `${at(name)}: "${name}" is not a legal mcp.json server name ` +
        `(SEP-2633: ^[a-zA-Z0-9_[\\]-]+$).`,
    );
  }

  const override = entry.strad?.slug;
  let slug: string | undefined = override;
  if (slug === undefined) {
    if (SLUG.safeParse(name).success) {
      slug = name;
    } else {
      const suggestion = suggestedSlug(name);
      refuse(
        `${at(name)}: "${name}" is a legal mcp.json server name and not a legal ` +
          `strad slug (^[a-z0-9]+(-[a-z0-9]+)*$, max 63) — strad forbids ` +
          `uppercase, "_" and "[]". A slug prefixes every tool name and names ` +
          `this server's variables on the container, so it is not transliterated ` +
          `automatically: two different mcp.json names can fold to one slug. ` +
          (suggestion
            ? `Write it explicitly: strad: { slug: ${suggestion} }.`
            : `Give it one under strad: { slug: ... }.`),
      );
    }
  }

  // --- transport -----------------------------------------------------------
  //
  // A transport strad cannot serve ends the entry here. Everything below is a
  // rule about a `streamable-http` entry, and applying those to a `stdio` one
  // would report "a remote entry requires a url" against a config that never
  // claimed to be one — three consequences of a single mistake, dressed as
  // three findings.
  if (entry.type !== "streamable-http") {
    if (entry.type === "stdio") {
      refuse(
        `${at(name, "type")}: strad runs no local processes, so \`stdio\` has no ` +
          `equivalent. A container image is \`kind: supplementary-image\` and an ` +
          `in-process module is \`kind: builtin\`; neither is expressible in ` +
          `mcp.json, so both stay in the YAML interface.`,
      );
    } else if (entry.type === "sse") {
      refuse(
        `${at(name, "type")}: strad proxies Streamable HTTP only. Use ` +
          `type: "streamable-http".`,
      );
    } else {
      refuse(
        `${at(name, "type")}: "${entry.type}" is not a SEP-2633 transport ` +
          `("stdio", "sse" or "streamable-http"); strad accepts ` +
          `"streamable-http".`,
      );
    }
    return undefined;
  }

  for (const forbidden of ["command", "args", "env"] as const) {
    if (entry[forbidden] !== undefined) {
      refuse(
        `${at(name, forbidden)}: SEP-2633 forbids \`${forbidden}\` on a remote ` +
          `entry. A server's process environment is a deployment concern strad ` +
          `keeps in \`kind: supplementary-image\`.`,
      );
    }
  }

  if (entry.oauth !== undefined) {
    refuse(
      `${at(name, "oauth")}: strad does not bind to SEP-2633's \`oauth\` object. ` +
        `It is a Draft field under active renegotiation upstream (SEP-2742), and ` +
        `its three fields describe a client driving a consent flow — which is ` +
        `the console's job here, not the config's. An upstream whose bearer ` +
        `expires takes \`oauthRefresh:\` in the YAML interface; one whose ` +
        `credential a person mints takes \`oauth:\`.`,
    );
  }

  if (entry.url === undefined) {
    refuse(`${at(name, "url")}: a remote entry requires a url.`);
  }

  // --- values --------------------------------------------------------------
  //
  // Interpolation is rewritten in the two fields strad RESOLVES a reference in
  // (see `UNHOSTED_SECRET_FIELDS` in src/config/schema.ts). A `${...}` anywhere
  // else would be rewritten into a `${NAME}` nothing looks up, and would ship as
  // that literal text — so it is refused rather than passed through.
  const rewrite = (value: string, field: string): string | undefined => {
    try {
      return rewriteInterpolations(value, at(name, field));
    } catch (err) {
      if (err instanceof McpJsonError) {
        refuse(err.message);
        return undefined;
      }
      throw err;
    }
  };

  const url = entry.url === undefined ? undefined : rewrite(entry.url, "url");

  let headers: Record<string, string> | undefined;
  if (entry.headers) {
    headers = {};
    for (const [key, value] of Object.entries(entry.headers)) {
      const rewritten = rewrite(value, `headers.${key}`);
      if (rewritten !== undefined) headers[key] = rewritten;
    }
  }

  for (const field of ["title", "description"] as const) {
    const value = entry[field];
    if (value !== undefined && value.includes("${")) {
      refuse(
        `${at(name, field)}: strad resolves references in \`url\` and ` +
          `\`headers\` only, so an interpolation here would ship as literal ` +
          `text. Write the value out.`,
      );
    }
  }

  if (errors.length > before || slug === undefined || url === undefined) {
    return undefined;
  }

  // --- emit ----------------------------------------------------------------
  const out: Record<string, unknown> = { slug, kind: "remote-http", url };
  if (entry.title !== undefined) out.title = entry.title;
  if (entry.description !== undefined) out.description = entry.description;
  if (headers !== undefined) out.headers = headers;

  const ext = entry.strad;
  if (ext?.entitlements !== undefined) out.entitlements = ext.entitlements;
  if (ext?.enabled !== undefined) out.enabled = ext.enabled;
  if (ext?.tools !== undefined) out.tools = ext.tools;
  if (ext?.timeoutMs !== undefined) out.timeoutMs = ext.timeoutMs;
  if (ext?.mayBeUnseeded !== undefined) out.mayBeUnseeded = ext.mayBeUnseeded;

  if (ext?.entitlements === undefined || ext.entitlements.length === 0) {
    notices.push({
      slug,
      code: "no-entitlements",
      message:
        `${at(name)} attaches "${slug}" with no entitlements, so no principal ` +
        `can reach it. mcp.json has no notion of who a server is for; strad ` +
        `needs both halves — \`strad: { entitlements: [<role>] }\` on this ` +
        `entry, and \`<role>\` naming "${slug}" under \`roles:\`.`,
    });
  }

  return out;
}

/**
 * Fold a document's `mcpServers` into its `servers:`, before the schema sees it.
 *
 * Total and non-throwing: a document that does not speak the dialect comes back
 * untouched with `used: false`, and one that does but is wrong comes back with
 * every refusal in `errors` — the caller decides how to report them. That is
 * what lets `scripts/check-config.ts` print all of them at once rather than the
 * first, and what keeps the desugar usable from the strict check, which needs
 * the transformed DOCUMENT rather than a thrown error.
 */
export function desugarDocument(doc: unknown): DesugarResult {
  const empty: DesugarResult = {
    doc,
    used: false,
    whole: false,
    slugs: [],
    notices: [],
    unknownKeys: [],
    errors: [],
  };
  if (!hasMcpServers(doc) || !isPlainObject(doc)) return empty;

  const errors: string[] = [];
  const notices: DialectNotice[] = [];
  const unknownKeys: DialectUnknownKey[] = [];

  const map = McpServersMap.safeParse(doc[MCP_SERVERS_KEY]);
  if (!map.success) {
    return {
      ...empty,
      used: true,
      errors: [
        `${MCP_SERVERS_KEY}: must be a map of server names to server ` +
          `configurations (SEP-2633).`,
      ],
    };
  }

  const desugared: Record<string, unknown>[] = [];
  const rawMap = doc[MCP_SERVERS_KEY] as Record<string, unknown>;
  for (const name of Object.keys(rawMap)) {
    const entry = desugarEntry(
      name,
      rawMap[name],
      errors,
      notices,
      unknownKeys,
    );
    if (entry) desugared.push(entry);
  }

  // A document with no `version:` is an mcp.json rather than a strad config.
  // `version` and `auth` are the only two root fields with no default, so
  // supplying them is what makes a pasted file parseable — and nothing else is
  // supplied, because everything else already has an answer.
  const whole = !("version" in doc);

  const existing = Array.isArray(doc.servers) ? (doc.servers as unknown[]) : [];
  const out: Record<string, unknown> = { ...doc };
  delete out[MCP_SERVERS_KEY];
  out.servers = [...existing, ...desugared];
  if (whole) {
    out.version = 1;
    if (!("auth" in out)) out.auth = {};
  }

  return {
    doc: out,
    used: true,
    whole,
    slugs: desugared.map((s) => String(s.slug)),
    notices,
    unknownKeys,
    errors,
  };
}
