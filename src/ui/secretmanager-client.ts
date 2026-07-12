import { createSign } from "node:crypto";
import type { ServiceAccount } from "./gcs-client.ts";

/**
 * A dependency-free Google Cloud Secret Manager client — the CONSOLE half of the
 * gcp-secrets server.
 *
 * This is the only place in strad that can read a secret VALUE, and it runs only
 * in the core gateway, behind the console SSO gate, driven by a human clicking a
 * button. The MCP half (servers/gcp-secrets) has its own client with no
 * value-reading method at all, and — the part that actually matters — runs as a
 * service account that lacks `secretmanager.versions.access`, so it could not
 * read one even if a bug or a prompt injection asked it to. Code-level absence
 * is the second lock; IAM is the first. See servers/gcp-secrets/README.md.
 *
 * No SDK, for the same reason gcs-client.ts has none: the core ships four
 * runtime deps and stays that way. Mint an OAuth2 access token by signing a JWT
 * with node:crypto (RFC 7523), then speak the Secret Manager REST API.
 *
 * LOGGING DISCIPLINE. A secret value crosses this module exactly twice: outbound
 * in `addVersion` (the payload a human typed), and inbound in `accessVersion`
 * (the reveal). It is never logged, never put in an Error message, and never
 * handed to telemetry. `SecretManagerError` carries the HTTP status and, for a
 * failure, at most the API's own error body — which, on the value endpoints,
 * Google does not echo the payload into. Errors thrown by THIS file never
 * interpolate a value.
 */

/** A Secret Manager secret, as the UI needs it. Metadata only — never a value. */
export interface SecretMeta {
  /** The short id, e.g. "mcp-openai-api-key" (not the full resource name). */
  name: string;
  /** The free-form note, stored as the `note` ANNOTATION on the secret. */
  note?: string;
  labels: Record<string, string>;
  createTime?: string;
  /** Latest enabled version number, if any, e.g. "3". */
  latestVersion?: string;
  /** When the latest version was added. */
  latestVersionTime?: string;
}

export interface SecretManagerConfig {
  projectId: string;
  account: ServiceAccount;
  /**
   * Test seam. Defaults to the real API. A local stub can be pointed at with
   * GCP_SECRETS_API_BASE (see servers/gcp-secrets/README.md); it exists so the
   * console and the MCP server can be exercised end-to-end without a live GCP
   * project, and it is NOT a production knob.
   */
  apiBase?: string;
  tokenUrl?: string;
}

/** The annotation key that holds a secret's free-form note. */
export const NOTE_ANNOTATION = "note";

/**
 * Why an annotation and not a label: Google's own docs draw exactly this line —
 * "Annotations are used to store arbitrary, non-identifying metadata"; labels
 * "are used for sorting, filtering and grouping" and restrict both the character
 * set and the length of a value. A note is prose. It gets an annotation.
 *
 * Limits, verified against the Secret Manager docs before committing to this:
 *   - annotation KEY: 1–63 chars, begins and ends alphanumeric, dashes /
 *     underscores / dots between. ("note" qualifies.)
 *   - the total size of all annotation keys and values on one secret must be
 *     < 16 KiB. We cap a note at 4 KiB so one note can never consume the budget.
 *   - written with PATCH ?updateMask=annotations, which REPLACES the whole map.
 *
 * The 16 KiB ceiling is why there is no side database: a note is metadata on the
 * secret itself, it moves with it, and it is deleted with it.
 */
export const MAX_NOTE_BYTES = 4096;

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_API_BASE = "https://secretmanager.googleapis.com";

export type FetchLike = typeof fetch;

/** A Secret Manager API error carrying the HTTP status, so the UI can explain a 403. */
export class SecretManagerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "SecretManagerError";
  }
}

/**
 * The surface the console depends on. Real Secret Manager in production; a fake
 * in tests. Every method here is a HUMAN action behind the SSO gate — there is
 * no path from /mcp to any of them.
 */
export interface SecretsAdmin {
  list(namespace: string): Promise<SecretMeta[]>;
  create(input: {
    name: string;
    value: string;
    note?: string;
  }): Promise<SecretMeta>;
  /** Rotate: add a new version. The previous version is left enabled. */
  addVersion(name: string, value: string): Promise<void>;
  setNote(name: string, note: string): Promise<void>;
  /** The reveal. The ONLY method in strad that returns a secret value. */
  accessLatest(name: string): Promise<string>;
  destroy(name: string): Promise<void>;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export function createSecretsAdmin(
  cfg: SecretManagerConfig,
  fetchImpl: FetchLike = fetch,
): SecretsAdmin {
  const apiBase = cfg.apiBase ?? DEFAULT_API_BASE;
  const tokenUrl = cfg.tokenUrl ?? DEFAULT_TOKEN_URL;
  const parent = `projects/${cfg.projectId}`;
  let cached: CachedToken | undefined;

  async function token(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    cached = await mintAccessToken(cfg.account, tokenUrl, fetchImpl);
    return cached.token;
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetchImpl(`${apiBase}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await token()}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      // The path can name a secret; it never carries a value (values travel in
      // the BODY, and the body is not echoed here).
      throw new SecretManagerError(
        `Secret Manager ${method} ${path.split("?")[0]} failed: ${res.status} ${res.statusText}`,
        res.status,
        await safeText(res),
      );
    }
    if (res.status === 204) return {};
    return (await res.json()) as unknown;
  }

  return {
    async list(namespace: string): Promise<SecretMeta[]> {
      const out: SecretMeta[] = [];
      let pageToken: string | undefined;

      do {
        const qs = new URLSearchParams({ pageSize: "100" });
        if (pageToken) qs.set("pageToken", pageToken);
        const page = (await call("GET", `${parent}/secrets?${qs}`)) as {
          secrets?: RawSecret[];
          nextPageToken?: string;
        };
        for (const raw of page.secrets ?? []) {
          const meta = toMeta(raw);
          if (meta && meta.name.startsWith(namespace)) out.push(meta);
        }
        pageToken = page.nextPageToken;
      } while (pageToken);

      // One extra call per secret to learn its latest version. Cheap at this
      // scale (a human's secret store, not a fleet), and worth it: "has this
      // ever been given a value?" is the first thing the page must answer.
      //
      // GET .../versions/latest returns the version's METADATA — name, state,
      // createTime. It is `secretmanager.versions.get`, not `.access`: no
      // payload comes back, and it is a permission the read-only MCP service
      // account holds too. A secret with no version yet 404s; that is a state,
      // not an error.
      await Promise.all(
        out.map(async (meta) => {
          try {
            const latest = (await call(
              "GET",
              `${parent}/secrets/${encodeURIComponent(meta.name)}/versions/latest`,
            )) as { name?: string; createTime?: string; state?: string };
            if (latest.name && latest.state === "ENABLED") {
              meta.latestVersion = latest.name.split("/").pop();
              meta.latestVersionTime = latest.createTime;
            }
          } catch (err) {
            if (
              err instanceof SecretManagerError &&
              (err.status === 404 || err.status === 403)
            ) {
              return; // no version yet, or not visible — render it as "no value"
            }
            throw err;
          }
        }),
      );

      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    },

    async create({ name, value, note }): Promise<SecretMeta> {
      const annotations: Record<string, string> = {};
      if (note) annotations[NOTE_ANNOTATION] = note;

      const created = (await call(
        "POST",
        `${parent}/secrets?secretId=${encodeURIComponent(name)}`,
        {
          replication: { automatic: {} },
          annotations,
          labels: { "managed-by": "strad" },
        },
      )) as RawSecret;

      await this.addVersion(name, value);
      return toMeta(created) ?? { name, note, labels: {} };
    },

    async addVersion(name: string, value: string): Promise<void> {
      await call(
        "POST",
        `${parent}/secrets/${encodeURIComponent(name)}:addVersion`,
        // The one place a value leaves strad, and it goes to Google.
        { payload: { data: Buffer.from(value, "utf8").toString("base64") } },
      );
    },

    async setNote(name: string, note: string): Promise<void> {
      // updateMask=annotations REPLACES the annotation map, so an empty note
      // clears it rather than leaving a stale one behind.
      await call(
        "PATCH",
        `${parent}/secrets/${encodeURIComponent(name)}?updateMask=annotations`,
        { annotations: note ? { [NOTE_ANNOTATION]: note } : {} },
      );
    },

    async accessLatest(name: string): Promise<string> {
      const res = (await call(
        "GET",
        `${parent}/secrets/${encodeURIComponent(name)}/versions/latest:access`,
      )) as { payload?: { data?: string } };
      const data = res.payload?.data;
      if (data == null) {
        throw new SecretManagerError(
          `secret "${name}" has no enabled version to reveal`,
          404,
        );
      }
      return Buffer.from(data, "base64").toString("utf8");
    },

    async destroy(name: string): Promise<void> {
      await call("DELETE", `${parent}/secrets/${encodeURIComponent(name)}`);
    },
  };
}

interface RawSecret {
  name?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  createTime?: string;
}

function toMeta(raw: RawSecret): SecretMeta | null {
  const id = raw.name?.split("/").pop();
  if (!id) return null;
  return {
    name: id,
    note: raw.annotations?.[NOTE_ANNOTATION],
    labels: raw.labels ?? {},
    createTime: raw.createTime,
  };
}

/** The signed-JWT bearer flow (RFC 7523). Identical in spirit to gcs-client.ts. */
async function mintAccessToken(
  account: ServiceAccount,
  tokenUrl: string,
  fetchImpl: FetchLike,
): Promise<CachedToken> {
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iss: account.client_email,
    scope: SCOPE,
    aud: tokenUrl,
    iat,
    exp: iat + 3600,
  };
  const signingInput = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify(claims),
  )}`;

  // A key that travelled through an env var carries "\n" as two characters.
  const pem = account.private_key.includes("\\n")
    ? account.private_key.replace(/\\n/g, "\n")
    : account.private_key;

  const signature = fromB64(
    createSign("RSA-SHA256").update(signingInput).sign(pem, "base64"),
  );

  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${signature}`,
    }),
  });

  if (!res.ok) {
    throw new SecretManagerError(
      `Secret Manager token exchange failed: ${res.status} ${res.statusText}`,
      res.status,
      await safeText(res),
    );
  }

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new SecretManagerError(
      "token exchange returned no access_token",
      502,
    );
  }
  return {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

function b64url(input: string): string {
  return fromB64(Buffer.from(input, "utf8").toString("base64"));
}

function fromB64(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function safeText(res: Response): Promise<string | undefined> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return undefined;
  }
}

/**
 * GCP secret ids are `[A-Za-z0-9_-]{1,255}`. Enforce it here (and in the MCP
 * server's namespace check) rather than letting a 400 from Google be the UI.
 */
export function validateSecretName(
  name: string,
  namespace: string,
): string | null {
  if (!name) return "A name is required.";
  if (!name.startsWith(namespace)) {
    return `The name must start with the managed namespace "${namespace}".`;
  }
  if (name.length > 255) return "A name may be at most 255 characters.";
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return "A name may contain only letters, digits, underscores and dashes.";
  }
  return null;
}

export function validateNote(note: string): string | null {
  if (Buffer.byteLength(note, "utf8") > MAX_NOTE_BYTES) {
    return `A note may be at most ${MAX_NOTE_BYTES} bytes (Secret Manager caps all annotations on one secret at 16 KiB).`;
  }
  return null;
}
