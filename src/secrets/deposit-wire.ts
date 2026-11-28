/**
 * The DEPOSIT wire: how strad-hostd's custody server hands core a secret it
 * captured in the owner's browser, without the value ever passing through a
 * model, a transcript or Zimmer.
 *
 * BOTH ENDS live in this one module, because they are in two npm trees: core
 * serves `POST /_strad/deposit/{slug}/{VARIABLE}` and its one reserved form
 * `POST /_strad/deposit/_gateway/{VARIABLE}` (src/http/deposit.ts), and
 * hostd is its only caller (`hostd/src/custody/deposit-wire.ts` is the vendored
 * copy, written by `npm run deposit:sync`). What the two must agree on is
 * small and every disagreement is a refused deposit — the route's path, the
 * body, the receipt, and above all how the bearer is derived.
 *
 * ## The bearer is DERIVED, not minted
 *
 * The custody server is a `local-tunnel` slug like every other hostd server,
 * so strad already holds its bearer key: it is the `${NAME}` in that entry's
 * `Authorization: Bearer ${NAME}` header, and the daemon holds the same key in
 * its own config. The deposit bearer is an HMAC of that key under a fixed
 * context string. Both sides compute it; neither stores it; nothing new has to
 * be seeded anywhere. It is still a DIFFERENT string from the slug key, so a
 * value captured off the wire to one door does not open the other, and core
 * knows which caller is depositing from WHICH key matched, never from anything
 * the caller claims.
 *
 * ## A deposit into a named STORE
 *
 * `POST {prefix}/_store/{store}/{target}` writes into a store core can reach
 * that is not this strad's own slug namespace: another system's parameter
 * store (Zimmer's), or a plain Secret Manager project (a deploy workflow's).
 * The store is addressed by a NAME the checked-in config gives it
 * (`depositStores:` on the secrets server) and the caller must list that name
 * in `deposit.stores:`. `target` is ONE segment, percent-encoded: a whole
 * parameter path for a parameter store, a secret id for Secret Manager. Both
 * ends check its shape; core also checks it against the store's prefixes.
 * That is the one deposit that may REPLACE a value, and only when the body
 * says `replace: true` AND the store's own entry says `replace: true`.
 *
 * Revoking it is revoking the `deposit:` block in strad's checked-in config, or
 * rotating the slug's key — which the console does without a deploy.
 *
 * ## Import-free but for `node:crypto`
 *
 * A vendored copy cannot import a sibling, so the shapes it checks are spelled
 * here rather than imported from the config schema. `test/deposit.test.ts`
 * holds them equal to `SLUG_PATTERN` and `ENV_NAME_SOURCE`.
 */
import { createHmac } from "node:crypto";

/** The route's prefix. The full path is `{prefix}/{slug}/{VARIABLE}`. */
export const DEPOSIT_ROUTE_PREFIX = "/_strad/deposit";

/**
 * The reserved target segment for the GATEWAY namespace:
 * `{prefix}/_gateway/{VARIABLE}` creates `/strad/{env}/gateway/static/{VARIABLE}`
 * instead of a slug's `static/`. An underscore is outside the slug alphabet,
 * so no slug can be spelled this way and no slug can be mistaken for it.
 * Core accepts it only for a name the caller lists in
 * `deposit.gatewayVariables:` that is some bundle's `tailnet.authKey`.
 */
export const DEPOSIT_GATEWAY_TARGET = "_gateway";

/**
 * The reserved target segment for a deposit into a NAMED store:
 * `{prefix}/_store/{store}/{target}`. Underscored for the reason `_gateway`
 * is: no slug can be spelled this way.
 */
export const DEPOSIT_STORE_TARGET = "_store";

/** Bumped on any change a peer one version behind would misread. */
export const DEPOSIT_PROTOCOL = 1;

/**
 * The HMAC context. Versioned so a future change to what the bearer authorises
 * can retire every derived bearer at once by changing one string.
 */
export const DEPOSIT_TOKEN_CONTEXT = "strad-deposit-v1";

/**
 * The largest value a deposit carries, in characters. The same ceiling as the
 * parameter write-back route: a PEM key or a service-account JSON fits with
 * room to spare, and a runaway caller does not.
 */
export const MAX_DEPOSIT_VALUE_LENGTH = 64 * 1024;

/** The config schema's slug alphabet (`SLUG_PATTERN`), plus its length cap. */
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 63;
/** An environment-variable name (`ENV_NAME_SOURCE`), plus its length cap. */
const VARIABLE_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VARIABLE_LENGTH = 200;

/**
 * A deposit store's name: the slug alphabet. It is a config string the caller
 * repeats, never a project id or a URL.
 */
const STORE_NAME_SHAPE = SLUG_SHAPE;
/**
 * A store target: a parameter path (`/a/b/VAR`) or a Secret Manager secret id
 * (`app-otel-token`). No `.`, no `//`, no trailing `/`, at most 255 long.
 */
const STORE_TARGET_SHAPE = /^\/?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const MAX_STORE_TARGET_LENGTH = 255;

/** True when `name` could name a deposit store. */
export function isDepositStoreName(name: string): boolean {
  return name.length <= MAX_SLUG_LENGTH && STORE_NAME_SHAPE.test(name);
}

/**
 * True when `target` has a shape a store target could have. Core narrows it
 * further, per store format and against the store's prefixes.
 */
export function isDepositStoreTarget(target: string): boolean {
  return (
    target.length <= MAX_STORE_TARGET_LENGTH && STORE_TARGET_SHAPE.test(target)
  );
}

/** True when `slug` has a shape the config schema could accept. */
export function isDepositSlug(slug: string): boolean {
  return slug.length <= MAX_SLUG_LENGTH && SLUG_SHAPE.test(slug);
}

/** True when `variable` could name an environment variable at all. */
export function isDepositVariable(variable: string): boolean {
  return (
    variable.length <= MAX_VARIABLE_LENGTH && VARIABLE_SHAPE.test(variable)
  );
}

/**
 * The deposit bearer for a custody slug whose own bearer key is `slugKey`.
 *
 * An HMAC rather than the key itself, so the two doors never accept each
 * other's credential. Deterministic, so neither side has to store it.
 */
export function depositToken(slugKey: string): string {
  return createHmac("sha256", slugKey)
    .update(DEPOSIT_TOKEN_CONTEXT)
    .digest("base64url");
}

/**
 * The route path for one target. Both segments are percent-encoded although
 * their shapes need no encoding, so a future alphabet cannot turn one segment
 * into two.
 */
export function depositRoutePath(slug: string, variable: string): string {
  return `${DEPOSIT_ROUTE_PREFIX}/${encodeURIComponent(slug)}/${encodeURIComponent(variable)}`;
}

/** The route path for one GATEWAY-namespace name (`DEPOSIT_GATEWAY_TARGET`). */
export function gatewayDepositRoutePath(variable: string): string {
  return `${DEPOSIT_ROUTE_PREFIX}/${DEPOSIT_GATEWAY_TARGET}/${encodeURIComponent(variable)}`;
}

/** The route path for one target in a NAMED store (`DEPOSIT_STORE_TARGET`). */
export function storeDepositRoutePath(store: string, target: string): string {
  return `${DEPOSIT_ROUTE_PREFIX}/${DEPOSIT_STORE_TARGET}/${encodeURIComponent(store)}/${encodeURIComponent(target)}`;
}

/**
 * The request body. The value, and — for a named store only — `replace: true`,
 * the explicit ask to write over a value that exists. Every other route
 * refuses a body that carries it, so it can never be ignored silently.
 */
export interface DepositRequest {
  value: string;
  replace?: boolean;
}

/**
 * What core answers on success: WHERE the value went, never the value.
 * `version` is the version the deposit wrote — `v1` on a create. `replaced`
 * is true only when a named-store deposit wrote over an existing value.
 * `valueVersion` is the Secret Manager version that holds the bytes, when it
 * differs from `version`: a replaced secret PARAMETER keeps its version and
 * gets a new value version behind it.
 */
export interface DepositReceipt {
  protocol: number;
  path: string;
  version: string;
  replaced?: boolean;
  valueVersion?: string;
}

/**
 * Every refusal the route can answer, as the `error` field of a JSON body.
 *
 * - `unauthorized` — no deposit caller's bearer matched (401).
 * - `bad_target` — the slug or variable has an impossible shape (400).
 * - `not_permitted` — the caller's `deposit.into:` list does not name the slug,
 *   or, for `_gateway`, its `deposit.gatewayVariables:` does not name the
 *   variable, or, for `_store`, its `deposit.stores:` does not name the store,
 *   no prefix of that store covers the target, or `replace` was asked of a
 *   store that does not allow it (403).
 * - `bad_body` — no value, a non-string value, or an over-long one (400 / 413).
 * - `exists` — a parameter already exists under that name, in `static/` or
 *   `oauth/`, or the named-store target exists and `replace` was not asked
 *   (409).
 * - `store_unavailable` — no parameter store owns the path (503).
 * - `write_failed` — the store refused the create (its own status).
 */
export type DepositRefusal =
  | "unauthorized"
  | "bad_target"
  | "not_permitted"
  | "bad_body"
  | "exists"
  | "store_unavailable"
  | "write_failed";

export type DepositParse<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: DepositRefusal; message: string };

/** Validate a deposit body. Never echoes the value back, whatever is wrong with it. */
export function parseDepositRequest(body: unknown): DepositParse<string> {
  const value =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).value
      : undefined;
  if (typeof value !== "string" || value.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "bad_body",
      message: 'the body must be JSON {"value": "<non-empty string>"}',
    };
  }
  if (value.length > MAX_DEPOSIT_VALUE_LENGTH) {
    return {
      ok: false,
      status: 413,
      error: "bad_body",
      message: `a deposited value may be at most ${MAX_DEPOSIT_VALUE_LENGTH} characters`,
    };
  }
  return { ok: true, value };
}

/**
 * Whether the body asks to REPLACE an existing value. Only `true` asks; a
 * non-boolean `replace` is a malformed body rather than a no.
 */
export function parseDepositReplace(body: unknown): DepositParse<boolean> {
  const replace =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).replace
      : undefined;
  if (replace === undefined || replace === false)
    return { ok: true, value: false };
  if (replace === true) return { ok: true, value: true };
  return {
    ok: false,
    status: 400,
    error: "bad_body",
    message: "replace, when present, must be true or false",
  };
}

/** Read a success body, or null when it is not one this protocol wrote. */
export function parseDepositReceipt(body: unknown): DepositReceipt | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (
    typeof b.protocol !== "number" ||
    typeof b.path !== "string" ||
    typeof b.version !== "string"
  )
    return null;
  return {
    protocol: b.protocol,
    path: b.path,
    version: b.version,
    ...(b.replaced === true ? { replaced: true } : {}),
    ...(typeof b.valueVersion === "string"
      ? { valueVersion: b.valueVersion }
      : {}),
  };
}
