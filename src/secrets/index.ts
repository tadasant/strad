/**
 * The boot-time secret BAG, and `${NAME}` resolution against it.
 *
 * This module reads every secret ONCE into a flat frozen record, and resolves
 * `${NAME}` references against that snapshot synchronously. Two callers want
 * exactly that shape. Boot (`src/index.ts`) needs a bag before anything can
 * serve a request, and backs the console's `consoleEnv:` resolution with it.
 * The App Platform spec render (`src/deploy/appspec.ts`) resolves references at
 * deploy time, against secrets CI holds and the container never will.
 * `SecretBag`, `loadSecrets`, `resolveRefs` and `resolveMap` are those two
 * paths, and they are the whole of what this module does for a live gateway.
 *
 * A snapshot cannot notice a rotation. The read path a running gateway takes for
 * a server's `${NAME}` is `src/secrets/provider/` — one name in, one value or
 * `null` out, per request — and the store behind it is `src/secrets/parameters/`,
 * which speaks Google Cloud **Parameter** Manager. Which of the two a deployment
 * resolves from is `gateway.secrets.provider: env | gcp-parameter-store` in the
 * config (`src/config/schema.ts`), validated by Zod and checked by
 * `npm run config:check`. `docs/operate/secrets.md` is the prose for all of it.
 *
 * **`SecretSource`, `EnvSecretSource`, `GcpSecretManagerSource` and
 * `secretSourceFromEnv` below are residue.** No backend is selected through
 * them. `secretSourceFromEnv` is reachable only as `loadSecrets`'s default
 * argument, and the `STRAD_SECRET_SOURCE` switch inside it is set by no config,
 * workflow, infra file or test in this repo, so the branch it guards picks
 * `EnvSecretSource` every time. `GcpSecretManagerSource` names Google Secret
 * Manager — a different product, reached through different IAM roles, from the
 * Parameter Manager strad reads — and `@google-cloud/secret-manager` appears in
 * no `package.json` here, so its lazy import throws on the one branch that
 * would reach it. `interface SecretSource` has no importers at all. A reader
 * asking how a secret backend is chosen wants the config field, not these
 * symbols.
 *
 * The name `SecretSource` is taken a second time, unrelatedly, by the
 * `"GSM" | "ENV"` badge type in `src/ui/secret-status.ts`. That is the one with
 * importers, and it describes where the console says a value came from.
 */

import { secretRefRe } from "../config/env-name.ts";

export interface SecretSource {
  readonly name: string;
  /** Return every secret this source can see, as a flat bag. */
  load(): Promise<Record<string, string>>;
}

export type SecretBag = Readonly<Record<string, string>>;

/**
 * Reads secrets from the process environment.
 *
 * App Platform SECRET env vars are indistinguishable from plain ones at
 * runtime, which is exactly what we want.
 */
export class EnvSecretSource implements SecretSource {
  readonly name = "env";

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async load(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
}

/**
 * Reads `strad-<env>-<NAME>` secrets from Google Cloud Secret Manager.
 *
 * Auth is Application Default Credentials, so this works with Workload Identity
 * Federation in CI (keyless) and with a service-account key locally, without
 * this class knowing which.
 *
 * The dependency is imported lazily: the runtime image does not ship
 * `@google-cloud/secret-manager`, and must not need to.
 */
export class GcpSecretManagerSource implements SecretSource {
  readonly name = "gcp-secret-manager";

  constructor(
    private readonly projectId: string,
    /** e.g. "staging" -> reads secrets prefixed `strad-staging-` */
    private readonly envName: string,
  ) {}

  async load(): Promise<Record<string, string>> {
    // The specifier is a variable so TypeScript does not try to resolve it at
    // build time: the runtime image deliberately does not depend on this
    // package, and must not be made to.
    const specifier = "@google-cloud/secret-manager";
    const mod = await import(specifier).catch(() => {
      throw new Error(
        "GcpSecretManagerSource requires @google-cloud/secret-manager. " +
          "Install it in the CI/deploy environment; the runtime image does not need it.",
      );
    });

    const { SecretManagerServiceClient } = mod as unknown as {
      SecretManagerServiceClient: new () => {
        listSecrets(req: { parent: string }): Promise<[{ name?: string }[]]>;
        accessSecretVersion(req: {
          name: string;
        }): Promise<[{ payload?: { data?: Uint8Array | string } }]>;
      };
    };

    const client = new SecretManagerServiceClient();
    const parent = `projects/${this.projectId}`;
    const prefix = `strad-${this.envName}-`;

    const [secrets] = await client.listSecrets({ parent });
    const out: Record<string, string> = {};

    for (const secret of secrets) {
      const id = secret.name?.split("/").pop();
      if (!id || !id.startsWith(prefix)) continue;

      const [version] = await client.accessSecretVersion({
        name: `${secret.name}/versions/latest`,
      });
      const data = version.payload?.data;
      if (data == null) continue;

      const value =
        typeof data === "string"
          ? Buffer.from(data, "base64").toString("utf8")
          : Buffer.from(data).toString("utf8");

      // strad-staging-GOOGLE_CLIENT_SECRET -> GOOGLE_CLIENT_SECRET
      out[id.slice(prefix.length)] = value;
    }

    return out;
  }
}

/**
 * Pick a source from the environment.
 *
 * STRAD_SECRET_SOURCE=gcp requires GCP_PROJECT_ID. Anything else (the default)
 * uses the environment, which is what the deployed container does.
 */
export function secretSourceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SecretSource {
  if (env.STRAD_SECRET_SOURCE === "gcp") {
    const projectId = env.GCP_PROJECT_ID;
    if (!projectId) {
      throw new Error("STRAD_SECRET_SOURCE=gcp requires GCP_PROJECT_ID");
    }
    return new GcpSecretManagerSource(projectId, env.STRAD_ENV ?? "staging");
  }
  return new EnvSecretSource(env);
}

export async function loadSecrets(
  source: SecretSource = secretSourceFromEnv(),
): Promise<SecretBag> {
  return Object.freeze(await source.load());
}

/**
 * Resolve `${NAME}` references in a config value against the secret bag.
 *
 * Throws on an unresolved reference. A config that silently ships the literal
 * string "${GRANOLA_TOKEN}" as a bearer token is worse than a boot failure.
 */
export function resolveRefs(value: string, secrets: SecretBag): string {
  return value.replace(secretRefRe(), (_match, name: string) => {
    const found = secrets[name];
    if (found === undefined) {
      throw new Error(
        `unresolved secret reference \${${name}}: no such key in the secret bag`,
      );
    }
    return found;
  });
}

/** Resolve every `${NAME}` in a string-valued map. */
export function resolveMap(
  map: Record<string, string>,
  secrets: SecretBag,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[k] = resolveRefs(v, secrets);
  return out;
}
