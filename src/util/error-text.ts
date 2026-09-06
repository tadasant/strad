/**
 * The two ways to turn a thrown thing into text, and the choice between them.
 *
 * There were six functions and twenty inline copies of
 * `err instanceof Error ? err.message : String(err)`, so there was no answer to
 * "how do I turn an error into text here" — each new site decided it from
 * scratch, and the SAFE one lived in the secrets provider layer where most of
 * the repo could not reach it without a dependency it did not want. Both live
 * here instead: this module imports nothing, so no layer has a reason to
 * restate either.
 *
 * ## Which one
 *
 * `errorSummary` for anything that could have touched a store read, a rendered
 * payload, or a secret value. `errorText` for a path where the message is
 * strad's own or an upstream's and no secret is in scope — a fetch that could
 * not connect, a CLI's own argument parsing, a JSON-RPC refusal on the
 * playground.
 *
 * The asymmetry is deliberate and it is not stylistic: `errorText` is the
 * default only where the input to the failing operation is known not to be a
 * secret. When in doubt the answer is `errorSummary`, because the cost of
 * getting it wrong is a credential in an HTML page and the cost of getting it
 * right is a class name in a log line.
 */

/**
 * A one-line description of a failure, safe to log and safe to render.
 *
 * A `ParameterStoreError` is built from a method and a resource path with the
 * query string and any `:verb` stripped (see `src/secrets/parameters/gcp.ts`),
 * so its message is known not to carry a value and is passed through. ANYTHING
 * else is reduced to its class name: a `SyntaxError` from a malformed response
 * body embeds a window of that body, and on this path the body can be a
 * rendered secret.
 *
 * Matched by `err.name` rather than `instanceof` on purpose — this module
 * imports nothing, and the check has to survive a `ParameterStoreError` that
 * crossed a module boundary.
 */
export function errorSummary(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "ParameterStoreError"
      ? `${err.name}: ${err.message}`
      : err.name;
  }
  return "unknown error";
}

/**
 * The message, whatever it says.
 *
 * The one implementation of `err instanceof Error ? err.message : String(err)`.
 * Use it where the text is strad's own or an upstream's and the failing
 * operation had no secret as input; use `errorSummary` everywhere else. A site
 * that shapes the message further — stripping a duplicated JSON-RPC prefix,
 * naming a status an operator can act on — builds on top of one of these two
 * rather than deriving the string a third way.
 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
