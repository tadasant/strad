import type { StradConfig } from "../config/schema.ts";
import type { SecretBag } from "../secrets/index.ts";
import type { ServerSecretProviders } from "../secrets/provider/index.ts";
import {
  gatewayParameterPath,
  ParameterStoreError,
} from "../secrets/parameters/index.ts";
import { storeForPath, type StoreClientOptions } from "../ui/store-client.ts";
import { event } from "../telemetry/index.ts";
import { errorSummary } from "../util/error-text.ts";
import {
  mintToken,
  parseTokenRecords,
  serializeTokenRecords,
  TOKENS_VARIABLE,
  type MintedToken,
  type TokenRecord,
} from "./tokens.ts";

/**
 * Mint, revoke and forget `/mcp` system tokens — the WRITE half of the token
 * store, and the only one that needs a credential.
 *
 * ## Why the parameter store, and not a database
 *
 * The records are already there. Under `gateway.secrets.provider:
 * gcp-parameter-store` the gateway's `STRAD_TOKENS` is a parameter at
 * `/strad/{env}/gateway/static/STRAD_TOKENS` that `hydrateBootEnv` reads once at
 * boot; all that was missing was reading it on the request path
 * (`ParameterTokenStore`) and writing it from somewhere other than a deploy —
 * this file. A database would be a fourth App Platform component, a client in
 * `package.json`, a migration story and a bill, for a document of a few hundred
 * bytes that changes a few times a month. Invariant 2 already says this class of
 * state lives in Parameter Manager, and the credential to reach it is the one
 * core already holds.
 *
 * ## The parameter is SECRET, and that is not decoration
 *
 * A non-secret parameter's value is readable by the `secrets` MCP server's
 * viewer credential — that is the whole point of the non-secret kind. A record
 * holds no secret (only the SHA-256 of one), but it does hold every token's
 * label, roles and pubid, which is the gateway's own access-control list. So a
 * parameter this code CREATES is created secret. A parameter that already exists
 * keeps whichever kind it was seeded as: `rotate()` writes through the envelope
 * it finds, and re-classifying somebody's parameter underneath them is not this
 * code's call.
 *
 * ## What it does NOT do: compare-and-swap
 *
 * Parameter Manager has no CAS, so every write here is a read-modify-write. The
 * read is a direct `reveal()` against the store (never the gateway's cached
 * reading), which narrows the window to the gap between two calls — but two
 * humans minting inside that window still lose one of the two mints. The same
 * limitation the connector write-back has, for the same reason; `HACKS.md` #91.
 * A lost MINT is a token that does not work, which is loud. A lost REVOKE would
 * be silent, so revoke and forget are keyed on a `pubid` and applied to whatever
 * the fresh read holds, rather than writing back a list the caller computed.
 */

/** Where the records live, under the store provider. */
export function tokensParameterPath(config: StradConfig): string {
  return gatewayParameterPath(config.gateway.env, TOKENS_VARIABLE);
}

export interface TokenAdminOptions {
  config: StradConfig;
  /** The boot bag, for resolving the `secrets` server's `consoleEnv:` refs. */
  secrets: SecretBag;
  /**
   * The runtime providers, so a write is visible to THIS process at once.
   *
   * The write goes through the admin client; `/mcp` reads through the resolver
   * client, which holds its own reading of the store for
   * `gateway.secrets.ttlSeconds`. Without this a revocation would take effect an
   * hour later, which is exactly the property this feature exists to fix.
   */
  secretProvider?: ServerSecretProviders;
  /** Test seam, threaded to `storeForPath`. */
  parametersStore?: StoreClientOptions["parametersStore"];
}

/**
 * Why this deployment cannot mint or revoke, or `null` if it can.
 *
 * Asked BEFORE anything is rendered, so the console page offers the forms only
 * where they would work. A form that is always going to 503 is worse than a
 * sentence explaining why there is no form.
 */
export function tokenWritability(opts: TokenAdminOptions): string | null {
  if (opts.config.auth.staticTokens.store !== "parameter-store") {
    return (
      `auth.staticTokens.store is "${opts.config.auth.staticTokens.store}", so the ` +
      `records are this container's ${TOKENS_VARIABLE} environment variable. ` +
      `Nothing in a running container can change one.`
    );
  }
  const resolved = storeForPath(
    opts.config,
    opts.secrets,
    tokensParameterPath(opts.config),
    opts,
  );
  return resolved.store ? null : resolved.reason;
}

export type TokenWriteResult<T> =
  ({ ok: true } & T) | { ok: false; status: number; reason: string };

/**
 * Read-modify-write, with the read as late as it can be.
 *
 * `mutate` is handed the records the STORE holds right now — not the gateway's
 * cached reading, and not a list that travelled through a form — and returns the
 * list to persist. Returning a refusal instead leaves the store untouched.
 */
async function mutate<T>(
  opts: TokenAdminOptions,
  apply: (
    current: TokenRecord[],
  ) =>
    | { records: TokenRecord[]; result: T }
    | { refusal: { status: number; reason: string } },
): Promise<TokenWriteResult<T>> {
  const path = tokensParameterPath(opts.config);

  const blocked = tokenWritability(opts);
  if (blocked) return { ok: false, status: 503, reason: blocked };

  const resolved = storeForPath(opts.config, opts.secrets, path, opts);
  if (!resolved.store) {
    return { ok: false, status: 503, reason: resolved.reason };
  }
  const store = resolved.store;

  let current: TokenRecord[];
  let exists = true;
  try {
    current = parseTokenRecords(await store.reveal(path));
  } catch (err) {
    if (err instanceof ParameterStoreError && err.status === 404) {
      // THE MIGRATION, and it is the reason this branch is not just a `[]`.
      //
      // A deployment moving off the baked env var has records the gateway is
      // serving right now and a parameter that does not exist yet. Seeding the
      // first write from what the gateway CURRENTLY reads — the provider chain,
      // which is the store in front of the environment — means the first mint
      // carries every existing token across instead of silently replacing the
      // fleet's credentials with one new one.
      exists = false;
      try {
        current = parseTokenRecords(
          (await opts.secretProvider?.shared.get(TOKENS_VARIABLE)) ?? undefined,
        );
      } catch (seedErr) {
        return {
          ok: false,
          status: 502,
          reason:
            `there is no ${TOKENS_VARIABLE} parameter yet, and the records this ` +
            `gateway is serving could not be read to seed one: ${errorSummary(seedErr)}`,
        };
      }
    } else {
      return { ok: false, status: statusOf(err), reason: errorSummary(err) };
    }
  }

  const applied = apply(current);
  if ("refusal" in applied) {
    return { ok: false, ...applied.refusal };
  }

  const payload = serializeTokenRecords(applied.records);
  try {
    if (exists) {
      await store.rotate(path, payload);
    } else {
      await store.create({
        path,
        secret: true,
        value: payload,
        note: "strad /mcp system tokens — managed from the console at /tokens",
      });
    }
  } catch (err) {
    event({ evt: "strad.token_write_failed" });
    console.error(
      `[strad] could not write ${path}: ${errorSummary(err)}. No record changed.`,
    );
    return { ok: false, status: statusOf(err), reason: errorSummary(err) };
  }

  // The gateway reads through the resolver's snapshot; this is what makes a
  // revocation land NOW rather than within gateway.secrets.ttlSeconds.
  opts.secretProvider?.invalidate();

  return { ok: true, ...applied.result };
}

function statusOf(err: unknown): number {
  const status = err instanceof ParameterStoreError ? err.status : 502;
  return status >= 400 && status < 600 ? status : 502;
}

/** Every record, as the STORE holds them. For the console's roster. */
export async function readTokenRecords(
  opts: TokenAdminOptions,
): Promise<TokenRecord[]> {
  const provider = opts.secretProvider?.shared;
  if (!provider) return [];
  return parseTokenRecords((await provider.get(TOKENS_VARIABLE)) ?? undefined);
}

export async function mintTokenRecord(
  opts: TokenAdminOptions,
  input: { label: string; roles: string[] },
): Promise<TokenWriteResult<{ minted: MintedToken }>> {
  const label = input.label.trim();
  if (!label) {
    return { ok: false, status: 400, reason: "A label is required." };
  }
  if (label.length > 120) {
    return {
      ok: false,
      status: 400,
      reason: "A label may be at most 120 characters.",
    };
  }
  if (input.roles.length === 0) {
    return {
      ok: false,
      status: 400,
      reason:
        "At least one role is required. A token with no roles is entitled to " +
        "nothing and would fail every request it made.",
    };
  }

  // Minted OUTSIDE the read-modify-write, so the plaintext exists exactly once
  // whatever the store does. A mint retried inside `apply` would produce a
  // different secret from the one this function is about to return.
  const minted = mintToken({
    env: opts.config.gateway.env,
    label,
    roles: input.roles,
  });

  const out = await mutate(opts, (current) => ({
    records: [...current, minted.record],
    result: { minted },
  }));
  if (out.ok) event({ evt: "strad.token_minted", pubid: minted.record.pubid });
  return out;
}

export async function revokeTokenRecord(
  opts: TokenAdminOptions,
  pubid: string,
): Promise<TokenWriteResult<{ record: TokenRecord }>> {
  const at = new Date().toISOString();
  const out = await mutate(opts, (current) => {
    const found = current.find((r) => r.pubid === pubid);
    if (!found) return { refusal: notInStore(pubid) };
    // Already revoked keeps its ORIGINAL timestamp. The field is when the
    // credential stopped working, and a second click is not a second event.
    const record: TokenRecord = found.revokedAt
      ? found
      : { ...found, revokedAt: at };
    return {
      records: current.map((r) => (r.pubid === pubid ? record : r)),
      result: { record },
    };
  });
  if (out.ok) event({ evt: "strad.token_revoked", pubid });
  return out;
}

/**
 * Drop a REVOKED record entirely.
 *
 * Housekeeping, and bounded to revoked records on purpose. Forgetting an ACTIVE
 * record is a revocation with no trail — the credential stops working and the
 * roster cannot say it ever existed — so it is refused rather than offered with
 * a warning. Revoke first; the record is then a tombstone, and dropping a
 * tombstone is the only thing this does.
 */
export async function forgetTokenRecord(
  opts: TokenAdminOptions,
  pubid: string,
): Promise<TokenWriteResult<{ record: TokenRecord }>> {
  const out = await mutate(opts, (current) => {
    const found = current.find((r) => r.pubid === pubid);
    if (!found) return { refusal: notInStore(pubid) };
    if (!found.revokedAt) {
      return {
        refusal: {
          status: 400,
          reason:
            `"${found.label}" is still active. Revoke it first — forgetting an ` +
            `active record would stop the credential working with nothing left ` +
            `to say it ever existed.`,
        },
      };
    }
    return {
      records: current.filter((r) => r.pubid !== pubid),
      result: { record: found },
    };
  });
  if (out.ok) event({ evt: "strad.token_forgotten", pubid });
  return out;
}

function notInStore(pubid: string): { status: number; reason: string } {
  return {
    status: 404,
    reason:
      `No token with id ${pubid} is in the store. It may have been revoked and ` +
      `forgotten from another tab — reload the page.`,
  };
}

/**
 * The roles a console reader may tick, and what each one reaches.
 *
 * A CLOSED set, taken from `roles:` in the config — the same reasoning the
 * secrets page's store picker uses. A role is defined by the config and by
 * nothing else: a token minted for a role nobody declared is entitled to
 * nothing, fails its first call with a 424, and nothing about that failure
 * points back at the typo that caused it. Adding a role is a config change, so
 * the set is closed here rather than free text.
 *
 * `servers` is what the role actually reaches, resolved the way
 * `src/gateway/entitlements.ts` resolves it, so the form can say what ticking
 * the box grants instead of only naming it.
 */
export function offerableRoles(
  config: StradConfig,
): { role: string; servers: string[] }[] {
  const enabled = config.servers.filter((s) => s.enabled);
  return Object.entries(config.roles)
    .map(([role, def]) => ({
      role,
      servers: def.servers.includes("*")
        ? enabled.map((s) => s.slug)
        : enabled
            .filter((s) => def.servers.includes(s.slug))
            .map((s) => s.slug),
    }))
    .sort((a, b) => a.role.localeCompare(b.role));
}
