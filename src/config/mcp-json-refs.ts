/**
 * SEP-2633's `${scheme:value}` interpolation, rewritten into strad's `${NAME}`.
 *
 * This is the half of the `mcp.json` input dialect (`src/config/mcp-json.ts`)
 * that touches CREDENTIALS, so it is deliberately the most conservative part of
 * it: every form the draft SEP defines is either rewritten into a reference
 * strad already resolves, or REFUSED by name. Nothing is guessed and nothing
 * falls through.
 *
 * ## Why a rewrite and not a second resolver
 *
 * strad already has exactly one reference form — `${NAME}`, whose grammar lives
 * in `src/config/env-name.ts` — and four things read it: the deploy-time
 * renderer (`src/deploy/appspec.ts`), the request-time provider
 * (`src/secrets/provider/resolve.ts`), the unseeded-waiver gate
 * (`src/deploy/unseeded.ts`) and the console roster. A second reference form
 * understood by only some of them would be a credential baked under a name
 * nothing reads, which is the failure `env-name.ts` exists to prevent.
 *
 * So the dialect rewrites at DESUGAR time, before the schema sees the document,
 * and everything downstream keeps reading the one form it always did. A
 * `${env:GRANOLA_TOKEN}` in an `mcp.json` IS a `${GRANOLA_TOKEN}` by the time
 * anything in `src/secrets/` or `src/deploy/` is looking at it.
 *
 * ## What is refused, and why each one
 *
 *   BARE `${NAME}`. The Claude Code dialect, and the single likeliest thing to
 *   be pasted here by mistake. SEP-2633 makes the scheme explicit on purpose —
 *   including for `env` — so a bare reference in this dialect is an error that
 *   names the fix rather than a value silently treated as either form.
 *
 *   PIPE CHAINS (`${env:FOO | value:bar}`). The SEP resolves left to right and
 *   takes the first non-empty value. strad resolves a reference ONCE, and in two
 *   different places at two different times: the renderer bakes it in CI, the
 *   provider reads it per request. A fallback would have to mean the same thing
 *   in both, and under `gcp-parameter-store` the renderer cannot know what the
 *   provider will find later. Refused rather than half-implemented.
 *
 *   `input:`. The client collects the value from a human at runtime. strad's
 *   doors are `/mcp` (machines) and the console (a browser); neither is a
 *   prompt the config loader can reach, and a boot cannot block on one.
 *
 *   `op://` AND EVERY OTHER SCHEME. strad reads two backends and names them in
 *   `gateway.secrets.provider:` — the container's environment, or Google
 *   Parameter Manager. 1Password is reachable through strad as a MOUNTED MCP
 *   SERVER, which is a tool an agent calls, not a value the config layer
 *   resolves. Accepting the scheme would mean claiming a resolver that does not
 *   exist.
 *
 * `value:` is the one non-`env` scheme that is accepted, because it resolves to
 * itself: it is a literal, and a literal is what a config already holds.
 */

import { isEnvName } from "./env-name.ts";

/** A dialect input that cannot be expressed. Carries no value, only shape. */
export class McpJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpJsonError";
  }
}

/**
 * The URI form one element of an interpolation takes: `scheme:rest`.
 *
 * RFC 3986's own scheme production, which is what the SEP cites. The `rest` is
 * captured whole and never parsed further — `op://vault/item/field` is refused
 * on its scheme, so nothing here needs to understand an authority component.
 */
const ELEMENT_RE = /^([A-Za-z][A-Za-z0-9+.-]*):([\s\S]*)$/;

/** `where` is a key path for the error message, never a value. */
function refuse(where: string, reason: string): never {
  throw new McpJsonError(`${where}: ${reason}`);
}

/**
 * Resolve ONE `${...}` payload to the text that replaces it.
 *
 * Returns strad's own `${NAME}` for `env:`, and the literal for `value:`.
 */
function rewriteOne(payload: string, where: string): string {
  // Every message below names the FIELD and, at most, a scheme or a variable
  // NAME — never the payload as written. A `${value:...}` payload is a config
  // literal, and this message reaches stderr, the CI annotation and the
  // exception reporter.
  if (payload.includes("|")) {
    refuse(
      where,
      `pipe-chained interpolation is not supported. SEP-2633 resolves a chain ` +
        `left to right and takes the first non-empty value; strad resolves a ` +
        `reference once — the renderer bakes it at deploy time, the provider ` +
        `reads it per request — and neither can see the other's fallback. ` +
        `Write a single \${env:NAME} or \${value:literal}.`,
    );
  }

  const trimmed = payload.trim();
  if (trimmed === "") {
    refuse(where, "empty interpolation ${}");
  }

  const parts = ELEMENT_RE.exec(trimmed);
  if (!parts) {
    // The overwhelmingly likely cause: a config written in the Claude Code
    // dialect, where the scheme is implicit. Say so, rather than "malformed".
    if (isEnvName(trimmed)) {
      refuse(
        where,
        `\${${trimmed}} has no scheme. SEP-2633 makes the scheme explicit, ` +
          `including for environment variables — write \${env:${trimmed}}. ` +
          `(The bare form is strad's own YAML interface, not this dialect.)`,
      );
    }
    refuse(
      where,
      `an interpolation is not scheme-qualified. SEP-2633 expects ` +
        `\${scheme:value} — strad accepts \`env\` and \`value\`.`,
    );
  }

  const scheme = (parts[1] ?? "").toLowerCase();
  const rest = parts[2] ?? "";

  if (scheme === "env") {
    if (!isEnvName(rest)) {
      refuse(
        where,
        `an \${env:...} does not name an environment variable ` +
          `(letters, digits and underscores; not starting with a digit).`,
      );
    }
    return `\${${rest}}`;
  }

  if (scheme === "value") {
    // A literal is spliced into a value that is scanned for `${NAME}` later,
    // by something that cannot tell a reference the operator wrote from one
    // the splice assembled. Refusing the substring `${` is not enough —
    // `${value:$}{SECRET}` puts the `$` in the literal and the `{` in the
    // surrounding text. Refusing the three characters is: a `${` can then only
    // come from the source text, where it is an interpolation of its own.
    if (/[${}]/.test(rest)) {
      refuse(
        where,
        `a \${value:...} literal may not contain "$", "{" or "}" — it is ` +
          `spliced into a config value that is scanned for \${NAME} ` +
          `references later, and SEP-2633 defines no escape for them.`,
      );
    }
    return rest;
  }

  if (scheme === "input") {
    refuse(
      where,
      `the \`input\` scheme asks the client to collect the value from a human. ` +
        `strad's doors are /mcp and the console; a boot has no one to ask. ` +
        `Seed the value and reference it as \${env:NAME}.`,
    );
  }

  refuse(
    where,
    `the \`${scheme}\` scheme is not one strad resolves. Its backends are ` +
      `named in \`gateway.secrets.provider:\` — the container's environment, or ` +
      `Google Parameter Manager — and both are reached as \${env:NAME}.`,
  );
}

/**
 * Rewrite every `${...}` in a dialect string value into strad's reference form.
 *
 * A string with no `${` comes back unchanged, which is the common case: a URL,
 * a literal header. `where` names the field for the error message and is one of
 * the dialect's own key paths, never a value.
 */
export function rewriteInterpolations(value: string, where: string): string {
  let out = "";
  let i = 0;
  let emitted = 0;
  for (;;) {
    const open = value.indexOf("${", i);
    if (open === -1) {
      out += value.slice(i);
      break;
    }
    const close = value.indexOf("}", open + 2);
    if (close === -1) {
      refuse(where, 'an interpolation is opened with "${" and never closed.');
    }
    out += value.slice(i, open);
    const replacement = rewriteOne(value.slice(open + 2, close), where);
    if (replacement.startsWith("${")) emitted += 1;
    out += replacement;
    i = close + 1;
  }
  // The invariant the `value:` guard exists for, checked on the way out: every
  // `${` in the result is one this function emitted for an `env:`. Anything
  // else is a reference assembled out of pieces, and it is refused here rather
  // than resolved later against a name nobody wrote.
  if (out.split("${").length - 1 !== emitted) {
    refuse(
      where,
      `the rewritten value contains a \${ that no \${env:NAME} produced.`,
    );
  }
  return out;
}
