import {
  mintAccessToken,
  SCOPE_CLOUD_PLATFORM,
  type FetchLike,
  type MintedToken,
  type ServiceAccount,
} from "./parameters/service-account.ts";
import { ParameterStoreError } from "./parameters/types.ts";

/**
 * A WRITE-ONLY client for one plain Secret Manager project: the half of a
 * `format: secret-manager` deposit store (src/config/schema.ts, `DepositStore`)
 * that talks to Google.
 *
 * Three verbs and no fourth:
 *
 *   - `exists` — `GET projects/{p}/secrets/{id}`, the secret's METADATA. It
 *     needs `secretmanager.secrets.get` and returns no version and no value.
 *   - `create` — `POST projects/{p}/secrets?secretId={id}`, automatic
 *     replication, the store's labels. Needs `secretmanager.secrets.create`.
 *   - `addVersion` — `POST projects/{p}/secrets/{id}:addVersion`, the bytes as
 *     they are. Needs `secretmanager.versions.add`.
 *
 * There is no `:access`, no list and no delete in this module, so the identity
 * it is built for — a custom role holding exactly those three permissions —
 * can be granted nothing that reads a value, and this code would not use it if
 * it were. The payload is never logged and never echoed into an error: an
 * error carries the method, the resource and Google's status.
 */
export interface SecretManagerDepositor {
  exists(secretId: string): Promise<boolean>;
  create(secretId: string, labels: Record<string, string>): Promise<void>;
  /** Returns the version number Google assigned, e.g. `"3"`. */
  addVersion(secretId: string, value: string): Promise<{ version: string }>;
}

export interface SecretManagerDepositorConfig {
  projectId: string;
  account: ServiceAccount;
  smApiBase?: string;
  tokenUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_SM_BASE = "https://secretmanager.googleapis.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export function createSecretManagerDepositor(
  cfg: SecretManagerDepositorConfig,
): SecretManagerDepositor {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = cfg.smApiBase ?? DEFAULT_SM_BASE;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const parent = `projects/${cfg.projectId}`;
  let cached: MintedToken | undefined;

  async function token(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    cached = await mintAccessToken(cfg.account, {
      scope: SCOPE_CLOUD_PLATFORM,
      tokenUrl: cfg.tokenUrl,
      fetchImpl: (input, init) =>
        fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    });
    return cached.token;
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const bearer = await token();
    const res = await fetchImpl(`${base}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // The resource names a secret id, never a value; the body is dropped.
      const resource = (path.split("?")[0] ?? path).split(":")[0];
      throw new ParameterStoreError(
        `${method} ${resource} failed: ${res.status}`,
        res.status,
      );
    }
    return ((await res.json().catch(() => ({}))) ?? {}) as Record<
      string,
      unknown
    >;
  }

  const secretPath = (id: string) =>
    `${parent}/secrets/${encodeURIComponent(id)}`;

  return {
    async exists(secretId) {
      try {
        await call("GET", secretPath(secretId));
        return true;
      } catch (err) {
        if (err instanceof ParameterStoreError && err.status === 404)
          return false;
        throw err;
      }
    },
    async create(secretId, labels) {
      await call(
        "POST",
        `${parent}/secrets?secretId=${encodeURIComponent(secretId)}`,
        {
          replication: { automatic: {} },
          ...(Object.keys(labels).length > 0 ? { labels } : {}),
        },
      );
    },
    async addVersion(secretId, value) {
      const out = await call("POST", `${secretPath(secretId)}:addVersion`, {
        payload: { data: Buffer.from(value, "utf8").toString("base64") },
      });
      const name = typeof out.name === "string" ? out.name : "";
      return { version: name.slice(name.lastIndexOf("/") + 1) || "unknown" };
    },
  };
}
