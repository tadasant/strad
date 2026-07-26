/**
 * The RUNTIME secret-provider seam.
 *
 * This is the read path a live strad process uses to turn a `${NAME}` reference
 * into a value. It is deliberately narrow — one name in, one value or `null`
 * out — because that is the only shape that supports the property this seam
 * exists for: **a secret rotated in the backing store takes effect on a running
 * gateway, without a redeploy**.
 *
 * The older `SecretSource` (see ../index.ts) loads a whole bag ONCE, at boot,
 * from the process environment. That is still the right thing for a deployment
 * whose secrets arrive as App Platform SECRET env vars, and `EnvSecretProvider`
 * is exactly that, behind this interface. What it cannot do is notice a change,
 * because process.env does not change under a running container.
 *
 * `null` means DEFINITIVELY ABSENT — the provider reached its backend and the
 * name was not there. A backend that is unreachable throws instead; the two are
 * not the same, and collapsing them would turn an outage into a config error.
 *
 * Nothing here is vendor-specific. It speaks names and values; it does not know
 * what a project, a version or a service account is.
 */
export interface SecretProvider {
  /** Backend name, for diagnostics. Never carries a value. */
  readonly name: string;

  /**
   * Resolve one secret. `null` = the backend answered, and there is no such
   * secret. Throws only when the backend could not be consulted.
   */
  get(name: string): Promise<string | null>;

  /**
   * Drop cached state so the next `get` re-reads the backend.
   *
   * With no argument, drop everything. This is what makes a change made THROUGH
   * strad (the SSO-gated console) visible immediately rather than at the next
   * TTL boundary — the writer invalidates what it just wrote.
   *
   * A provider that holds no cache implements this as a no-op.
   */
  invalidate(name?: string): void;
}

/**
 * Raised when a `${NAME}` cannot be resolved.
 *
 * The message carries the NAME and nothing else. There is no value in it, no
 * backend payload, and no request body — this error is thrown on the request
 * path and will be logged, so it is held to the same rule as everything else
 * that touches a credential. `test/secrets.provider.test.ts` enforces that.
 */
export class SecretNotFoundError extends Error {
  constructor(readonly secretName: string) {
    super(
      `unresolved secret reference \${${secretName}}: no such secret in the provider`,
    );
    this.name = "SecretNotFoundError";
  }
}
