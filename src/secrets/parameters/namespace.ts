import {
  decodeStoredValue,
  isSecretRef,
  SECRET_VALUE_ENCODING,
  type ParameterEnvelope,
} from "./wire.ts";

/**
 * The canonical namespace scheme.
 *
 * Everything strad manages is addressed by ONE path:
 *
 *     /strad/{env}/mcp/{server-slug}/{kind}/{VARIABLE_NAME}
 *
 * `kind` names WHERE THE VALUE CAME FROM, and there are two of them. `static` is
 * a value a human typed into the console. `oauth` is a value strad MINTED — the
 * durable credential an authorization-code flow handed back. A "namespace" is a
 * prefix of that path — the secrets server is scoped to one (e.g.
 * `/strad/staging/mcp/`) and refuses to operate outside it.
 *
 * This module composes and validates those paths, and codes the envelope stored
 * at one. How a path becomes a GCP resource id, and how a value is encoded into
 * the envelope, live in `wire.ts` — that half is vendored into `servers/secrets`
 * and checked by `test/vendored.sync.test.ts`, because all three roles that touch
 * it (the MCP viewer, the console admin, the runtime resolver) must address the
 * same underlying resources.
 */

/**
 * The kinds one server's own namespace is divided into, HIGHEST PRECEDENCE
 * FIRST.
 *
 * The order is the resolution order, and it is the one thing about this list
 * that is a decision rather than a fact. `oauth` wins because it is the kind a
 * MACHINE writes: a human who typed a token into `static/` months ago and a
 * console consent completed this morning disagree about the same variable, and
 * the fresh grant is the one a call should carry. It also makes the migration
 * safe in the only direction that matters — a deployment whose connector token
 * still sits under `static/` keeps working, and the first reconnect moves it to
 * `oauth/` and takes precedence from then on.
 *
 * Two kinds and not five: a kind is a LINEAGE, not a category. Adding one means
 * strad has a new way of coming by a value, and every layered read below grows a
 * round trip. A second WRITER to an existing kind is not a new kind — see
 * `oauthNamespace` for the two that write `oauth/`.
 */
export const SERVER_PARAM_KINDS = ["oauth", "static"] as const;

export type ServerParamKind = (typeof SERVER_PARAM_KINDS)[number];

/** Is this path segment one of the kinds a resolver reads? */
export function isServerParamKind(kind: string): kind is ServerParamKind {
  return (SERVER_PARAM_KINDS as readonly string[]).includes(kind);
}

/** Build one kind's namespace for a server slug, e.g. `/strad/staging/mcp/gcs/oauth/`. */
export function serverKindNamespace(
  env: string,
  slug: string,
  kind: ServerParamKind,
): string {
  return `/strad/${env}/mcp/${slug}/${kind}/`;
}

/** Build the static-kind namespace for a server slug, e.g. `/strad/staging/mcp/gcs/static/`. */
export function staticNamespace(env: string, slug: string): string {
  return serverKindNamespace(env, slug, "static");
}

/**
 * Build the oauth-kind namespace for a server slug, e.g.
 * `/strad/staging/mcp/gcs/oauth/`.
 *
 * Everything under it is written as a SECRET parameter — the value in Secret
 * Manager, a `__REF__` pointer in Parameter Manager — so the `secrets` MCP
 * server lists it and can never read it.
 *
 * TWO WRITERS, AND ONE CREDENTIAL.
 *
 * The console's OAuth callback (src/ui/connector.ts) MINTS the credential: it
 * `create()`s the parameter, grants the `secretAccessor` a `:render` needs, and
 * records who consented to what in the note. Nothing else creates one.
 *
 * The parameter write-back route (src/http/params.ts) `rotate()`s it, for a
 * provider whose refresh tokens are single-use, as X's are. That is the SAME
 * credential continuing under the same variable:
 * the provider handed the new value back in exchange for the old one, so the
 * lineage this kind names is unchanged, and the write goes through core's admin
 * credential either way. `rotate()` is also the narrower verb — it refuses a
 * path that does not exist (404) and leaves the envelope, the secrecy and the
 * consent note alone — so a rotation cannot conjure a credential the console
 * never minted, and cannot erase the record of who consented.
 *
 * Whether the write-back may address this kind at all is decided by the CONFIG
 * — only a variable the server names on its `oauth:` connector is a candidate
 * here — and among the candidates it takes the highest kind the store holds.
 * Never by the request; see `kindsOf`.
 */
export function oauthNamespace(env: string, slug: string): string {
  return serverKindNamespace(env, slug, "oauth");
}

/**
 * Every namespace ONE server resolves from, in precedence order.
 *
 * Every layered read in strad — the runtime provider's per-server chain, the
 * registry's `params: true` cache, render-spec's substitution bag — walks this
 * list rather than naming `static` directly, so a kind added here is read by all
 * of them or by none of them.
 */
export function serverNamespaces(env: string, slug: string): string[] {
  return SERVER_PARAM_KINDS.map((kind) => serverKindNamespace(env, slug, kind));
}

/**
 * Is this resolved value something a caller can actually USE as a credential?
 *
 * `resolve()` does not promise one. A `:render` that could not dereference hands
 * the `__REF__` pointer back rather than failing — deliberately, so `checkStore`
 * can report "present but unrenderable" — and an empty payload resolves to `""`.
 * Neither is a credential, and both are indistinguishable from one to any caller
 * that only checks for `undefined`.
 *
 * It is exported because the rule has to hold in TWO places that read a layered
 * namespace by different routes: `layerNamespaces` below, and the runtime
 * provider chain (src/secrets/provider/store.ts), which asks one namespace at a
 * time and would otherwise treat an unusable hit as a definitive one and never
 * consult the layer beneath it.
 */
export function isUsableValue(value: string): boolean {
  return value !== "" && !isSecretRef(value);
}

/**
 * Collapse several namespace readings into one, EARLIER WINS.
 *
 * The wrinkle is that "has a value" and "has a USABLE value" are different
 * questions, and layering has to respect the second. `resolve()` does not
 * promise a value: a `:render` that could not dereference hands the `__REF__`
 * pointer back rather than failing, and an empty payload resolves to `""`. A
 * higher layer holding one of those must NOT shadow a lower layer that holds a
 * real credential — that would be the worst of both, a non-credential baked onto
 * a container AND the working value suppressed.
 *
 * So an unusable value loses to any usable one below it, and is kept only when
 * nothing below has anything better. Keeping it rather than dropping it is
 * deliberate: `substitutionBag` reports an unusable value by name, and a name
 * that vanished here would be reported as absent instead.
 */
export function layerNamespaces(
  readings: readonly Readonly<Record<string, string>>[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const reading of readings) {
    for (const [name, value] of Object.entries(reading)) {
      const held = out[name];
      if (
        held === undefined ||
        (!isUsableValue(held) && isUsableValue(value))
      ) {
        out[name] = value;
      }
    }
  }
  return out;
}

/**
 * The GATEWAY namespace: `/strad/{env}/gateway/static/`.
 *
 * `/mcp/{slug}/` addresses a parameter that belongs to ONE server. This one
 * addresses the deployment itself — the `${NAME}` references a config makes
 * outside any single server (a remote-http bearer token, a builtin option), plus
 * the gateway's own keys (`STRAD_TOKENS`, `GOOGLE_CLIENT_SECRET`, …).
 *
 * It sits beside `mcp/` rather than above it so the two never collide: no server
 * slug can be `gateway`-shaped into this path, because the segment after `{env}`
 * is a literal, not a slug.
 */
export function gatewayNamespace(env: string): string {
  return `/strad/${env}/gateway/static/`;
}

/** Build a full parameter path for one gateway-level variable. */
export function gatewayParameterPath(env: string, variable: string): string {
  return `${gatewayNamespace(env)}${variable}`;
}

/**
 * Build a full parameter path for one variable under ONE named kind.
 *
 * The general form, and the one a caller that has resolved a kind should use.
 * `parameterPath` and `oauthParameterPath` below are the two fixed-kind
 * spellings of it — the same pair `staticNamespace` and `oauthNamespace` are of
 * `serverKindNamespace`, and kept for the same reason: a call site that can only
 * mean one kind says so in its own name rather than in an argument a reader has
 * to follow. There is deliberately no DEFAULT kind here. A caller that forgot to
 * pass one would silently get `static/`, which is exactly the shadowed write
 * this signature exists to make impossible.
 */
export function serverParameterPath(
  env: string,
  slug: string,
  kind: ServerParamKind,
  variable: string,
): string {
  return `${serverKindNamespace(env, slug, kind)}${variable}`;
}

/** Build a full parameter path for one variable under a server's static kind. */
export function parameterPath(
  env: string,
  slug: string,
  variable: string,
): string {
  return serverParameterPath(env, slug, "static", variable);
}

/** Build a full parameter path for one variable under a server's oauth kind. */
export function oauthParameterPath(
  env: string,
  slug: string,
  variable: string,
): string {
  return serverParameterPath(env, slug, "oauth", variable);
}

/**
 * The envelope CODEC. The envelope's shape is the wire contract (`wire.ts`); the
 * validating read of one is core's alone — `servers/secrets` casts a bare
 * `JSON.parse` at its two parse sites, which is why its unknown-encoding refusal
 * lives in `decodeStoredValue` instead.
 */
export function encodeEnvelope(env: ParameterEnvelope): string {
  return JSON.stringify(env);
}

export function decodeEnvelope(payload: string): ParameterEnvelope {
  const parsed = JSON.parse(payload) as Partial<ParameterEnvelope>;
  if (
    typeof parsed.path !== "string" ||
    typeof parsed.secret !== "boolean" ||
    typeof parsed.value !== "string"
  ) {
    throw new Error("parameter payload is not a strad envelope");
  }
  // An encoding this reader does not know is a HARD failure, not an absent one.
  // Falling back to "literal" would hand the caller an encoded blob dressed as a
  // value — a wrong secret injected into a child process, silently, which is
  // strictly worse than a parameter that does not resolve.
  if (
    parsed.encoding !== undefined &&
    parsed.encoding !== SECRET_VALUE_ENCODING
  ) {
    throw new Error(
      `parameter payload declares an unknown value encoding: ${JSON.stringify(String(parsed.encoding))}`,
    );
  }
  return {
    path: parsed.path,
    secret: parsed.secret,
    note: typeof parsed.note === "string" ? parsed.note : undefined,
    value: parsed.value,
    ...(parsed.encoding === undefined ? {} : { encoding: parsed.encoding }),
  };
}

/**
 * The real value behind a RENDERED envelope.
 *
 * The `isSecretRef` guard is not defensive tidiness. A `:render` that could not
 * dereference hands the pointer back rather than failing, and the pointer is the
 * one string that must reach the caller UNTOUCHED — `checkStore` recognises it to
 * report "present but unrenderable", and base64url-decoding it would turn that
 * diagnosis into a shrug.
 */
export function decodeEnvelopeValue(envelope: ParameterEnvelope): string {
  if (isSecretRef(envelope.value)) return envelope.value;
  return decodeStoredValue(envelope.value, envelope.encoding, envelope.path);
}

/**
 * Normalise a NAMESPACE — an absolute canonical-path prefix like
 * `/strad/prod/mcp/`. Always starts and ends with exactly one `/`.
 */
export function normaliseNamespace(namespace: string): string {
  const trimmed = namespace.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "/" : `/${trimmed}/`;
}

/**
 * Validate a namespace, or return null.
 *
 * The configured `SECRETS_NAMESPACES` list is a CONVENIENCE, not the fence. A
 * human running the console may address any namespace in the project, because
 * the project IS the boundary — an IAM binding the console cannot talk its way
 * past — and a hardcoded list would only ever be a code-level guard over the
 * same credential. Adding a namespace should not require a redeploy.
 *
 * So this checks SHAPE, not membership. What it refuses is a value that would
 * make a malformed or ambiguous path: traversal, empty segments, whitespace,
 * uppercase (a slug is lowercase, and `parameterId` folds case, so an uppercase
 * spelling names a path no resolver matches while colliding with one that does).
 */
export function validateNamespace(namespace: string): string | null {
  const trimmed = namespace.trim();
  if (trimmed === "") return "A namespace is required.";
  if (!trimmed.startsWith("/")) {
    return 'A namespace is an absolute path prefix — it must start with "/", e.g. "/strad/prod/mcp/".';
  }
  if (trimmed.length > 200) {
    return "A namespace may be at most 200 characters.";
  }
  const normalised = normaliseNamespace(trimmed);
  if (normalised === "/") {
    return 'A namespace of "/" would cover every parameter in the project. Name one, e.g. "/strad/prod/mcp/".';
  }
  for (const segment of normalised.slice(1, -1).split("/")) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(segment)) {
      return (
        "A namespace is slash-separated segments of LOWERCASE letters, digits, dots, " +
        'dashes and underscores — e.g. "/strad/prod/mcp/".'
      );
    }
  }
  return null;
}

/**
 * Normalise the PATH PREFIX — the segments between a namespace and the variable
 * name. `""` stays `""`; `"/gcs/static"` becomes `"gcs/static/"`.
 *
 * A namespace is where a parameter is allowed to live; the prefix is where
 * inside it the parameter actually sits, and for a server parameter that prefix
 * (`{slug}/static/`) is what decides which server resolves it. Composing the two
 * separately is what lets the console write a full canonical path without the
 * human typing the namespace again.
 */
export function normalisePathPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "" : `${trimmed}/`;
}

/**
 * Validate a path prefix, or return null.
 *
 * Prefix segments become part of a GCP resource id (see `parameterId`) and part
 * of a path the resolver matches on, so they are bounded to the same alphabet a
 * slug and a `kind` use. `.` and `..` are excluded by the leading-character rule:
 * a segment must start with a lowercase letter or a digit.
 *
 * LOWERCASE IS LOAD-BEARING, not tidiness. A resolver builds the path it reads
 * from the server's slug, which the schema constrains to lowercase, so `GCS/`
 * could never match one. `parameterId` meanwhile lowercases before it hashes, so
 * `GCS/Static/FOO` and `gcs/static/FOO` collapse onto ONE resource id: the
 * uppercase spelling is a path no server reads that collides with the path a
 * server does. Rejecting it is cheaper than explaining it.
 */
export function validatePathPrefix(prefix: string): string | null {
  const trimmed = prefix.trim();
  if (trimmed === "") return null;
  if (trimmed.length > 200) {
    return "A path prefix may be at most 200 characters.";
  }
  const normalised = normalisePathPrefix(trimmed);
  for (const segment of normalised.slice(0, -1).split("/")) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(segment)) {
      return (
        "A path prefix is slash-separated segments of LOWERCASE letters, digits, dots, " +
        'dashes and underscores — e.g. "gcs/static/". A server slug is lowercase, and an ' +
        "uppercase prefix names a path no server resolves."
      );
    }
  }
  return null;
}
