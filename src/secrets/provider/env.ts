import type { SecretProvider } from "./types.ts";

/**
 * Secrets from the process environment.
 *
 * The zero-config default, and the reason strad stays vendor-neutral: an OSS
 * deployment, a local `npm run dev`, and a CI test all run with this and never
 * touch a cloud store. It is also what a deployment using deploy-time SECRET
 * env vars runs with, unchanged.
 *
 * It caches nothing because there is nothing to cache: `process.env` is already
 * in memory, and it does not change under a running container. `invalidate()`
 * is therefore honestly a no-op, not a stub.
 */
export class EnvSecretProvider implements SecretProvider {
  readonly name = "env";

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(name: string): Promise<string | null> {
    const value = this.env[name];
    return typeof value === "string" ? value : null;
  }

  invalidate(): void {
    // Nothing is cached.
  }
}
