import { ENV_NAME_SOURCE } from "./env-name.ts";
import { soleRefName } from "./schema.ts";

/**
 * Where a server entry can carry a credential, and the one rule that says a
 * RUNTIME write may only ever name one.
 *
 * ## The claim
 *
 * The store is the source of truth for secret VALUES. A roster entry written at
 * runtime holds a REFERENCE to a name in it and never the value itself — so the
 * overlay document is not a place a credential can be, whatever anyone types
 * into either door.
 *
 * That was previously a convention. `src/config/schema.ts` says of `SecretRef`
 * that a bare string "is used literally — fine for non-secret values, but never
 * put a real credential in the config file", the console's headers hint said
 * "put the secret in the store, not here", and `get_connector` redacted a
 * literal on the way OUT. Nothing refused one on the way IN. A human or an agent
 * could save `Authorization: Bearer sk-live-…` through `/connectors` or
 * `save_connector` and it would be persisted, verbatim, into
 * `/strad/{env}/gateway/config/SERVERS` — which `src/config/store.ts` creates
 * with `secret: false`, because a roster is not a secret. This module is what
 * makes the convention a refusal.
 *
 * ## Why it binds the RUNTIME path and not the schema
 *
 * The schema is the product's contract and a checked-in document is reviewed by
 * a human before it deploys; a rule added there would refuse configs that are
 * legal today, and `env:` on a supplementary image legitimately carries
 * non-secret literals (`BILL_ENVIRONMENT: production`). A runtime write has
 * neither property: nobody reviews it, and it lands in a shared store rather
 * than in a repository. So the bound is on provenance, exactly like
 * `forServerIsolated` (a runtime-authored entry reads only its own namespace)
 * and `assertNoAccessControlChange` (a runtime write cannot move access control
 * the deploy authorised). This is the third of those bounds.
 *
 * ## The rule
 *
 * A value in a credential-carrying position must be a REFERENCE: one `${NAME}`,
 * optionally introduced by an auth scheme from {@link CREDENTIAL_SCHEMES}. That
 * is the shape every entry in this deployment already uses — `Bearer ${TOKEN}`,
 * or a bare `${TOKEN}` — so the rule is a description of correct practice
 * rather than a new thing to learn.
 *
 * A literal is refused even when it is NOT a credential (`Notion-Version:
 * 2022-06-28`), because nothing here can tell those apart and a rule that tried
 * would be a heuristic wearing a guarantee's clothes. The escape is the one the
 * product already has: put the value in the slug's own namespace as an ordinary
 * non-secret parameter and reference it. Both doors can do that — the console's
 * secrets pages and the `secrets` MCP server — so it costs a step, not a deploy.
 *
 * ## What it covers, and what it does not
 *
 * Covered: `headers:` on every kind that has one, `url:`'s userinfo, and
 * `oauthRefresh:`'s two credential fields.
 *
 * NOT covered, deliberately and stated rather than implied away:
 *
 *   A URL QUERY PARAMETER. `https://api.example.com/mcp?key=abc` is a literal
 *   credential and this module accepts it, because the alternative is refusing
 *   every URL that carries a query at all — there is no way to tell `?key=abc`
 *   from `?version=2`. Userinfo is different: `user:pass@` is a credential by
 *   definition, so that half IS refused.
 *
 *   A BUILTIN'S `options:`. An untyped bag whose ordinary contents are
 *   non-secret literals (`echo`'s `greeting`), so a ref-only rule there would
 *   refuse the normal case. A builtin cannot be CREATED at runtime — its module
 *   has to ship inside the image — so the reachable surface is editing the
 *   options of a builtin the checked-in document already declares.
 *
 * Both are in `docs/src/content/docs/limitations.md`, under the same entry as
 * the rest of the overlay's bounds.
 */

/**
 * The auth schemes a credential-carrying value may name before its reference.
 *
 * A closed set, matched case-insensitively (RFC 7235 §2.1 makes `auth-scheme`
 * case-insensitive). Closed is the point: a scheme is the only literal text
 * allowed to sit beside a reference, so the set of literal strings a runtime
 * write can put into a header is exactly these five plus a space.
 *
 * Extending it is a pull request, which is the right cost for widening the one
 * place this rule lets a literal through.
 */
export const CREDENTIAL_SCHEMES = [
  "Bearer",
  "Basic",
  "Token",
  "Bot",
  "ApiKey",
] as const;

const REFERENCE_ONLY = new RegExp(
  `^(?:(?:${CREDENTIAL_SCHEMES.join("|")}) )?\\$\\{${ENV_NAME_SOURCE}\\}$`,
  "i",
);

/**
 * Whether a value NAMES a credential rather than carrying one.
 *
 * Exported for the two doors' hint text and for the tests, which is also why it
 * takes `unknown`: a form post and a tool argument both arrive untyped, and a
 * non-string in a header is not a reference either.
 */
export function isCredentialReference(value: unknown): boolean {
  return typeof value === "string" && REFERENCE_ONLY.test(value);
}

/** A runtime write that would put a credential VALUE into the roster. */
export class LiteralCredential extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The sentence both doors end on, so neither invents its own advice. */
function useTheStore(slug: string): string {
  return (
    `The store holds values and the roster holds references: put it in this ` +
    `slug's own namespace — /strad/{env}/mcp/${slug || "{slug}"}/static/{NAME} ` +
    `— through the secrets console or the secrets MCP server, and write ` +
    `\${NAME} here. A value that is not secret goes there too, as an ordinary ` +
    `non-secret parameter; strad cannot tell the two apart and does not guess.`
  );
}

/**
 * Refuse an entry that carries a credential VALUE in any position strad knows
 * to be credential-carrying.
 *
 * Called on the per-entry write path (`RuntimeConfig.assertAcceptable`, which
 * both doors call) and again over every upsert a write would newly place in the
 * store (`RuntimeConfig.apply`). The second is not redundant: `toggle` and
 * `set_connector_enabled` re-upsert an entry they did not compose, so without it
 * a literal in a checked-in entry would be copied into the store by a button
 * that only meant to disable something.
 *
 * Never quotes the offending value. The whole point of this refusal is that the
 * value is a credential, and an error message is rendered into an HTML page and
 * returned over `/mcp`.
 */
export function assertSecretsByReference(entry: Record<string, unknown>): void {
  const slug = typeof entry.slug === "string" ? entry.slug : "";

  const headers = entry.headers;
  if (isPlainObject(headers)) {
    const literal = Object.keys(headers).filter(
      (name) => !isCredentialReference(headers[name]),
    );
    if (literal.length > 0) {
      throw new LiteralCredential(
        `${literal.map((n) => `${n}:`).join(", ")} ` +
          `${literal.length > 1 ? "carry values" : "carries a value"} rather ` +
          `than a reference, and a runtime write may not store one. A header ` +
          `value must be one \${NAME}, optionally after an auth scheme ` +
          `(${CREDENTIAL_SCHEMES.join(", ")}) — for example ` +
          `"Bearer \${GRANOLA_TOKEN}". ${useTheStore(slug)}`,
      );
    }
  }

  if (typeof entry.url === "string") assertNoUserinfo(entry.url, slug);

  const oauth = entry.oauthRefresh;
  if (isPlainObject(oauth)) {
    const literal = (["clientSecret", "refreshToken"] as const).filter(
      (field) => {
        const value = oauth[field];
        if (value === undefined) return false;
        return typeof value !== "string" || soleRefName(value) === null;
      },
    );
    if (literal.length > 0) {
      throw new LiteralCredential(
        `oauthRefresh.${literal.join(", oauthRefresh.")} must be exactly one ` +
          `\${NAME}. ${useTheStore(slug)}`,
      );
    }
  }
}

/**
 * Refuse `https://user:pass@host/mcp`.
 *
 * A URL that does not parse is left to the schema, which is the thing that
 * decides whether a `url:` is well-formed at all — reporting "this is not a
 * URL" from a credential rule would be the wrong error from the wrong place.
 */
function assertNoUserinfo(url: string, slug: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.username === "" && parsed.password === "") return;
  throw new LiteralCredential(
    `url: carries userinfo (the user:password@ before the host), which is a ` +
      `credential written into the roster. Send it as a header instead — ` +
      `"Authorization: Basic \${NAME}" — and drop it from the URL. ` +
      `${useTheStore(slug)}`,
  );
}

/**
 * The upserts a write would newly place in the store: the ones this overlay
 * does not already hold byte-identically.
 *
 * The narrowing is what keeps the `apply`-level check from wedging a console. A
 * literal written before this rule existed is still served — boot and poll stay
 * lenient on purpose, so that an image rollback cannot be taken down by
 * something a console wrote — and refusing every later write because of it
 * would mean one old entry froze the whole roster. Bound the rule to what the
 * write is actually adding, and the entry carrying the literal is refused on
 * the next write that touches it, which is where a human can act on it.
 */
export function changedUpserts(
  before: readonly Record<string, unknown>[],
  after: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const held = new Map(
    before.map((entry) => [String(entry.slug), JSON.stringify(entry)]),
  );
  return after.filter(
    (entry) => held.get(String(entry.slug)) !== JSON.stringify(entry),
  );
}
