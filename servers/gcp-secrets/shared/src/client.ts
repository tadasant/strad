import { createSign } from "node:crypto";

/**
 * A read-only Google Cloud Secret Manager client.
 *
 * READ THIS BEFORE ADDING A METHOD.
 *
 * There is no `accessVersion`. There is no `getValue`. There is no method on
 * this client, or on the `SecretsReader` interface it implements, that returns a
 * secret's payload — and adding one is not a matter of taste. The service
 * account this code runs as holds `roles/secretmanager.viewer`, which grants
 * `secrets.get`, `secrets.list`, `versions.get` and `versions.list` and NOT
 * `secretmanager.versions.access`. A method that called
 * `…/versions/latest:access` would get a 403 from Google, every time, and the
 * only thing it would achieve is a confusing error in an agent's transcript.
 *
 * That is the design. The MCP surface is the agent's surface, agents get
 * prompt-injected, and the cheapest way to make "the agent leaked a credential"
 * impossible is for the credential the agent's process holds to be incapable of
 * reading one. Code that "just doesn't call it" is a convention; an IAM policy
 * that cannot is a fact. Both are in place; only the second is load-bearing.
 *
 * Writes live in the human console (src/ui, core gateway, behind SSO), which
 * uses a DIFFERENT service account that never reaches this container.
 *
 * No SDK: this is fetch + node:crypto, so the bundle image gains no dependency
 * tree for it. Same shape as strad's own src/ui/gcs-client.ts.
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/** Metadata about one secret. Note the absence of a `value` field. */
export interface SecretMeta {
  /** The short id, e.g. "mcp-openai-api-key". */
  name: string;
  /** The free-form note — the `note` annotation on the Secret resource. */
  note?: string;
  labels?: Record<string, string>;
  createTime?: string;
  /** The latest ENABLED version number, or undefined if it has no value yet. */
  latestVersion?: string;
  latestVersionTime?: string;
}

export interface SecretsReader {
  /** Every secret whose id starts with `namespace`. Metadata only. */
  listSecrets(namespace: string): Promise<SecretMeta[]>;
}

export interface SecretsClientConfig {
  projectId: string;
  account: ServiceAccount;
  /** Test seam. Defaults to the real API; a stub can be pointed at for e2e. */
  apiBase?: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
}

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_API_BASE = "https://secretmanager.googleapis.com";

/** The annotation that carries a secret's note. See the README on why not a label. */
export const NOTE_ANNOTATION = "note";

export class SecretManagerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SecretManagerError";
  }
}

export class SecretManagerReadClient implements SecretsReader {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly tokenUrl: string;
  private cached?: { token: string; expiresAt: number };

  constructor(private readonly cfg: SecretsClientConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.apiBase = cfg.apiBase ?? DEFAULT_API_BASE;
    this.tokenUrl = cfg.tokenUrl ?? DEFAULT_TOKEN_URL;
  }

  async listSecrets(namespace: string): Promise<SecretMeta[]> {
    const parent = `projects/${this.cfg.projectId}`;
    const out: SecretMeta[] = [];
    let pageToken: string | undefined;

    do {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = (await this.get(`${parent}/secrets?${qs.toString()}`)) as {
        secrets?: RawSecret[];
        nextPageToken?: string;
      };
      for (const raw of page.secrets ?? []) {
        const id = raw.name?.split("/").pop();
        if (!id || !id.startsWith(namespace)) continue;
        out.push({
          name: id,
          note: raw.annotations?.[NOTE_ANNOTATION],
          labels: raw.labels,
          createTime: raw.createTime,
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    // `versions/latest` returns the version's METADATA (name, state, createTime)
    // and no payload: it is `versions.get`, a permission the viewer role DOES
    // hold. It answers "does this secret have a value yet, and how old is it" —
    // which is the useful thing an agent can know without knowing the value.
    await Promise.all(
      out.map(async (meta) => {
        try {
          const latest = (await this.get(
            `${parent}/secrets/${encodeURIComponent(meta.name)}/versions/latest`,
          )) as { name?: string; createTime?: string; state?: string };
          if (latest.name && latest.state === "ENABLED") {
            meta.latestVersion = latest.name.split("/").pop();
            meta.latestVersionTime = latest.createTime;
          }
        } catch (err) {
          // A secret with no version 404s. That is a state, not a failure.
          if (err instanceof SecretManagerError && err.status === 404) return;
          throw err;
        }
      }),
    );

    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * The ONLY HTTP verb this client speaks. There is no post(), no patch(), no
   * delete() — the credential could not use them anyway, and their absence is
   * what makes "this server cannot mutate anything" reviewable at a glance.
   */
  private async get(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}/v1/${path}`, {
      headers: { authorization: `Bearer ${await this.token()}` },
    });
    if (!res.ok) {
      throw new SecretManagerError(
        `Secret Manager GET ${path.split("?")[0]} failed: ${res.status} ${res.statusText}`,
        res.status,
      );
    }
    return (await res.json()) as unknown;
  }

  private async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > Date.now()) {
      return this.cached.token;
    }
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      iss: this.cfg.account.client_email,
      scope: SCOPE,
      aud: this.tokenUrl,
      iat,
      exp: iat + 3600,
    };
    const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
      JSON.stringify(claims),
    )}`;
    const pem = this.cfg.account.private_key.includes("\\n")
      ? this.cfg.account.private_key.replace(/\\n/g, "\n")
      : this.cfg.account.private_key;
    const sig = fromB64(
      createSign("RSA-SHA256").update(input).sign(pem, "base64"),
    );

    const res = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${input}.${sig}`,
      }),
    });
    if (!res.ok) {
      throw new SecretManagerError(
        `Secret Manager token exchange failed: ${res.status} ${res.statusText}`,
        res.status,
      );
    }
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      throw new SecretManagerError("token exchange returned no access_token", 502);
    }
    this.cached = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return this.cached.token;
  }
}

interface RawSecret {
  name?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  createTime?: string;
}

function b64url(input: string): string {
  return fromB64(Buffer.from(input, "utf8").toString("base64"));
}

function fromB64(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
