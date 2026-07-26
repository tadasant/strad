import type { SecretProvider } from "./types.ts";

/**
 * Try each provider in order; the first definitive hit wins.
 *
 * This is what makes the migration off deploy-time baking non-atomic and
 * reversible. A deployment can put the store FIRST and the environment SECOND,
 * move secrets over one at a time, and never have a window where a name resolves
 * from neither. When the environment half is empty, the chain is a store; when
 * the store half is empty, the chain is the environment.
 *
 * A provider that THROWS does not fall through. An unreachable store is not the
 * same as a store that does not hold the name, and silently falling back to a
 * stale env var during an outage is how a rotated credential comes back from the
 * dead. The error propagates; the caller fails loudly.
 */
export class ChainSecretProvider implements SecretProvider {
  readonly name: string;

  constructor(private readonly providers: readonly SecretProvider[]) {
    if (providers.length === 0) {
      throw new Error("ChainSecretProvider requires at least one provider");
    }
    this.name = `chain(${providers.map((p) => p.name).join(",")})`;
  }

  async get(name: string): Promise<string | null> {
    for (const provider of this.providers) {
      const value = await provider.get(name);
      if (value !== null) return value;
    }
    return null;
  }

  invalidate(name?: string): void {
    for (const provider of this.providers) provider.invalidate(name);
  }
}
