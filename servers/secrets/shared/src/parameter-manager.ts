import { createHash, createSign } from "node:crypto";

/**
 * A read-only Google Cloud **Parameter Manager** client — the VIEWER half of the
 * two-store secrets model.
 *
 * READ THIS BEFORE ADDING A METHOD.
 *
 * strad's parameters live in two GCP stores that work together:
 *
 *   - **Parameter Manager** is the index of everything. One parameter per managed
 *     variable, addressed by a canonical namespace path. Its latest version holds
 *     a small JSON ENVELOPE describing the variable.
 *   - **Secret Manager** holds the actual bytes of *secret* variables. A secret
 *     parameter's envelope does not contain the value; it contains a REFERENCE to
 *     a Secret Manager version (`__REF__("//secretmanager.googleapis.com/...")`),
 *     which Parameter Manager's `:render` would dereference — but this client
 *     NEVER renders.
 *
 * This client speaks to Parameter Manager only, and only with GET. There is no
 * `render`, no `access`, no method anywhere that returns a secret value. That is
 * not a matter of taste: the service account this code runs as holds Parameter
 * Manager *viewer* access, which lets it list parameters and read a version's
 * payload — the envelope — and NOTHING that dereferences a secret ref. It lacks
 * `secretmanager.versions.access`, so even the `:render` deref of a secret
 * envelope would get a 403 from Google, every time. A non-secret parameter's
 * envelope carries its literal value (that is the store for non-secrets), and the
 * viewer may read those — but a secret's bytes are never in a payload it can see.
 *
 * The MCP surface is the agent's surface, agents get prompt-injected, and the
 * cheapest way to make "the agent leaked a credential" impossible is for the
 * credential the agent's process holds to be incapable of reading one. Code that
 * "just doesn't call it" is a convention; an IAM policy that cannot is a fact.
 * Both are in place; only the second is load-bearing.
 *
 * Writes (creating a parameter, storing a secret, rotating a version) live in the
 * human console (src/**, behind SSO), which uses a DIFFERENT service account that
 * never reaches this container. The runtime resolver that assembles a server's
 * env from these parameters is a THIRD credential, also in src/**. Neither is this
 * server's concern.
 *
 * No SDK: this is fetch + node:crypto, so the bundle image gains no dependency
 * tree for it. Same signing path as the rest of strad.
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/**
 * The JSON envelope stored (base64) in a parameter's latest version.
 *
 * IDENTICAL shape on the admin (writer) and viewer halves — it is the wire
 * contract between them. For a non-secret parameter, `value` is the literal
 * value. For a secret parameter, `value` is a Parameter Manager Secret Manager
 * reference string (`__REF__("//secretmanager.googleapis.com/...")`), never the
 * secret's bytes — those live in Secret Manager and this viewer cannot deref them.
 */
export interface ParameterEnvelope {
  /** The canonical path, e.g. `/strad/staging/mcp/<slug>/static/<VAR>`. */
  path: string;
  secret: boolean;
  note?: string;
  /** Literal value (non-secret) or a `__REF__(...)` string (secret). */
  value: string;
  /**
   * How the value behind this envelope is encoded. Absent means the literal
   * bytes; `base64url` means the value must be decoded after `:render`. See
   * `SECRET_VALUE_ENCODING` below. The viewer never decodes anything — it never
   * holds a value — but the field is part of the wire contract and dropping it
   * from this shape would let a writer in this tree omit it.
   */
  encoding?: ValueEncoding;
}

/**
 * MIRROR OF `src/secrets/parameters/namespace.ts`. The two trees have separate
 * lockfiles and cannot import each other, and they write to the SAME GCP store,
 * so a drift here is a value one half writes and the other half cannot read.
 * `test/parameters.encoding.test.ts` in the root suite compares the two copies.
 *
 * A strad parameter is created with `parameter-format=JSON`. `:render` splices a
 * secret's raw bytes into the payload TEXT where the `__REF__(…)` token sits and
 * then checks the result for structural damage — so a value carrying a quote, a
 * backslash, a brace, a bracket or a newline is rejected with
 * `400 INVALID_ARGUMENT … injection detected`. Every secret value is therefore
 * stored base64url-encoded, and the envelope says so.
 */
export type ValueEncoding = "base64url";

/** The encoding every secret value is written with. */
export const SECRET_VALUE_ENCODING: ValueEncoding = "base64url";

/** Characters a rendered secret must not contain. See `SECRET_VALUE_ENCODING`. */
const RENDER_UNSAFE = /["\\{}[\]]/;

/** Would substituting this value into a JSON parameter payload survive `:render`? */
export function isRenderSafe(value: string): boolean {
  if (RENDER_UNSAFE.test(value)) return false;
  // Control characters, by code point rather than by a regex literal holding raw
  // control characters — the latter is both unreadable and lint-flagged. A raw
  // byte below 0x20 is illegal INSIDE a JSON string, so a newline or a tab in a
  // secret breaks the payload just as surely as a quote does.
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) return false;
  }
  return true;
}

/** Encode a secret's bytes for Secret Manager: `[A-Za-z0-9_-]` only, so inert. */
export function encodeSecretValue(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Invert `encodeSecretValue` for one raw value, given the encoding its envelope
 * declares. `label` names the parameter in an error; it is never the value.
 */
export function decodeStoredValue(
  value: string,
  encoding: ValueEncoding | undefined,
  label: string,
): string {
  if (encoding === undefined) return value;
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  // Node's base64 decoders are LENIENT — garbage in, garbage out, no error.
  // Re-encode and compare so a value that is not what its envelope claims fails
  // loudly, canonicalising alphabet and padding first so a hand-seeded standard
  // base64 value is accepted rather than rejected for its spelling.
  const canonical = value
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== canonical) {
    throw new ParameterManagerError(
      `parameter "${label}" is labelled ${encoding} but its stored value is not`,
      502,
    );
  }
  return decoded;
}

/** Metadata about one managed parameter. Note the absence of a value field. */
export interface ParameterMeta {
  /** The canonical path (from the envelope), e.g. `/strad/staging/mcp/.../VAR`. */
  name: string;
  /** The variable name — the last path segment, e.g. `..._GCS_CLIENT_EMAIL`. */
  variable: string;
  secret: boolean;
  /** The free-form note from the envelope. */
  note?: string;
  /** The latest ENABLED version number, or undefined if it has no value yet. */
  latestVersion?: string;
  latestVersionTime?: string;
}

/** The envelope of a single parameter plus its version metadata. */
export interface ParameterRecord {
  envelope: ParameterEnvelope;
  latestVersion?: string;
  latestVersionTime?: string;
}

export interface ParametersReader {
  /** Every managed parameter whose path starts with `namespace`. Metadata only. */
  listParameters(namespace: string): Promise<ParameterMeta[]>;
  /**
   * The envelope of the parameter at `path`, or null if it has no version yet.
   * For a secret parameter, the envelope's `value` is a Secret Manager REFERENCE,
   * never the secret's bytes — the caller must still refuse to return it.
   */
  getParameter(path: string): Promise<ParameterRecord | null>;
}

export interface ParametersClientConfig {
  projectId: string;
  account: ServiceAccount;
  /** Test seam. Defaults to the real API; a stub can be pointed at for e2e. */
  apiBase?: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
}

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_API_BASE = "https://parametermanager.googleapis.com";

/** Parameter Manager is single-region for strad; we keep everything in `global`. */
const LOCATION = "global";

/** The label every strad-managed parameter carries, so a listing can find them. */
export const MANAGED_BY_LABEL = "managed-by";
export const MANAGED_BY_VALUE = "strad";

/** How many version lookups to run at once. See listParameters(). */
const VERSION_FANOUT = 10;

export class ParameterManagerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ParameterManagerError";
  }
}

/**
 * The deterministic path -> Parameter Manager parameterId encoding.
 *
 * IDENTICAL in both halves (admin writes with this id, viewer reads with it), so
 * it must never change silently. Parameter ids are constrained to
 * `[a-z]([a-z0-9-]){0,62}` — lowercase, letter-initial, <= 63 chars — which a
 * canonical path (mixed case, `/` and `_`, often long) does not satisfy, so we
 * fold it down:
 *
 *   1. drop the leading `/`;
 *   2. lowercase;
 *   3. replace every run of chars outside `[a-z0-9]` with a single `-`;
 *   4. trim leading/trailing `-`;
 *   5. if it does not start with a letter, prefix `p-`;
 *   6. if longer than 63, keep the first 54 chars and append `-` + the first 8
 *      hex of sha256(path) — a stable disambiguator, since the fold above is
 *      lossy and two long paths can collapse to the same 54-char head.
 *
 * The EXACT path is also stored in the envelope, so a listing never has to decode
 * an id back into a path — and a get can verify the round-trip.
 */
export function parameterId(path: string): string {
  let id = path
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(id)) id = `p-${id}`;
  if (id.length > 63) {
    const h = createHash("sha256").update(path).digest("hex").slice(0, 8);
    // Trim any trailing `-` off the 54-char head BEFORE joining the hash, so the
    // id never carries a double dash. This must stay byte-identical to the src/
    // half (src/secrets/parameters/namespace.ts) — both halves address the SAME
    // GCP resource, so a one-character drift would split them.
    id = `${id.slice(0, 54).replace(/-+$/, "")}-${h}`;
  }
  return id;
}

/** The variable name is the last segment of a canonical path. */
export function variableOf(path: string): string {
  const segs = path.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

export class ParameterManagerReadClient implements ParametersReader {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly tokenUrl: string;
  private cached?: { token: string; expiresAt: number };

  constructor(private readonly cfg: ParametersClientConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.apiBase = cfg.apiBase ?? DEFAULT_API_BASE;
    this.tokenUrl = cfg.tokenUrl ?? DEFAULT_TOKEN_URL;
  }

  private get parent(): string {
    return `projects/${this.cfg.projectId}/locations/${LOCATION}`;
  }

  async listParameters(namespace: string): Promise<ParameterMeta[]> {
    // Collect the strad-managed parameter ids first (one page-walk), then read
    // each one's envelope in bounded batches. The list response gives us the id
    // and labels but NOT the canonical path — that only lives in the envelope —
    // so the namespace filter happens after the version read.
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = (await this.get(
        `${this.parent}/parameters?${qs.toString()}`,
      )) as {
        parameters?: RawParameter[];
        nextPageToken?: string;
      };
      for (const raw of page.parameters ?? []) {
        const id = raw.name?.split("/").pop();
        if (!id) continue;
        // Only ours. A second tenant's parameters in the same project are not
        // this server's to enumerate, and skipping them here also bounds the
        // fan-out below to strad's own set.
        if (raw.labels?.[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) continue;
        ids.push(id);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    const out: ParameterMeta[] = [];
    // One version request per parameter, in bounded batches. An unbounded
    // Promise.all over a large project would open hundreds of concurrent
    // connections in a single tool call and earn a 429.
    for (let i = 0; i < ids.length; i += VERSION_FANOUT) {
      const records = await Promise.all(
        ids.slice(i, i + VERSION_FANOUT).map((id) => this.readVersion(id)),
      );
      for (const rec of records) {
        if (!rec) continue; // no version yet -> nothing to describe
        const path = rec.envelope.path;
        // The namespace fence: the envelope's own path must start with the
        // requested prefix. This is where a parameter outside the namespace —
        // strad's own token store, another tenant's variable — falls out.
        if (!path.startsWith(namespace)) continue;
        out.push({
          name: path,
          variable: variableOf(path),
          secret: rec.envelope.secret === true,
          note: rec.envelope.note,
          latestVersion: rec.latestVersion,
          latestVersionTime: rec.latestVersionTime,
        });
      }
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async getParameter(path: string): Promise<ParameterRecord | null> {
    const rec = await this.readVersion(parameterId(path));
    if (!rec) return null;
    // Defend against an id collision (the fold is lossy): trust the envelope's
    // own path, not the id we asked for. If they disagree, this is not the
    // parameter we meant.
    if (rec.envelope.path !== path) return null;
    return rec;
  }

  /**
   * The id of the greatest ENABLED version of a parameter, or undefined.
   *
   * Parameter Manager's `parameterVersions.get` has NO `latest` alias (that is a
   * Secret Manager feature) — so the current version has to be found by
   * enumerating. This is byte-for-byte the same choice the admin/resolver half
   * makes (src/secrets/parameters/gcp.ts `currentVersionId`): list the versions,
   * skip the disabled ones, and take the greatest `v{n}` by numeric suffix, so
   * all three roles read the same version of the same parameter.
   */
  private async currentVersionId(id: string): Promise<string | undefined> {
    const versions: RawVersion[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = (await this.get(
        `${this.parent}/parameters/${encodeURIComponent(id)}/versions?${qs.toString()}`,
      )) as { parameterVersions?: RawVersion[]; nextPageToken?: string };
      versions.push(...(page.parameterVersions ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);

    let best: { vid: string; n: number } | undefined;
    for (const v of versions) {
      if (v.disabled) continue;
      const vid = v.name?.split("/").pop();
      if (!vid) continue;
      const n = Number(/(\d+)$/.exec(vid)?.[1] ?? "0");
      if (!best || n > best.n) best = { vid, n };
    }
    return best?.vid;
  }

  /**
   * Read one parameter's current version and decode its envelope.
   *
   * This is `parametermanager.parameterVersions.get` — the version's PAYLOAD, not
   * a `:render`. For a non-secret parameter the payload is the literal value; for
   * a secret parameter it is the envelope carrying a `__REF__(...)` reference, not
   * the secret. The viewer may read either; it can deref neither.
   */
  private async readVersion(id: string): Promise<ParameterRecord | null> {
    const vid = await this.currentVersionId(id);
    // No enabled version -> nothing to describe. That is a state, not a failure.
    if (!vid) return null;
    let raw: RawVersion;
    try {
      raw = (await this.get(
        `${this.parent}/parameters/${encodeURIComponent(id)}/versions/${encodeURIComponent(vid)}`,
      )) as RawVersion;
    } catch (err) {
      // A version that vanished between list and get 404s. Treat as no value.
      if (err instanceof ParameterManagerError && err.status === 404) return null;
      throw err;
    }
    const b64 = raw.payload?.data;
    if (!b64) return null;
    const envelope = JSON.parse(
      Buffer.from(b64, "base64").toString("utf8"),
    ) as ParameterEnvelope;
    return {
      envelope,
      latestVersion: raw.name?.split("/").pop() ?? vid,
      latestVersionTime: raw.createTime,
    };
  }

  /**
   * The ONLY HTTP verb this client speaks. There is no post(), no patch(), no
   * delete(), and no `:render` — the credential could not use them anyway, and
   * their absence is what makes "this server cannot mutate or dereference
   * anything" reviewable at a glance.
   */
  private async get(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}/v1/${path}`, {
      headers: { authorization: `Bearer ${await this.token()}` },
    });
    if (!res.ok) {
      throw new ParameterManagerError(
        `Parameter Manager GET ${path.split("?")[0]} failed: ${res.status} ${res.statusText}`,
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
      throw new ParameterManagerError(
        `Parameter Manager token exchange failed: ${res.status} ${res.statusText}`,
        res.status,
      );
    }
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      throw new ParameterManagerError(
        "token exchange returned no access_token",
        502,
      );
    }
    this.cached = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return this.cached.token;
  }
}

interface RawParameter {
  name?: string;
  format?: string;
  labels?: Record<string, string>;
  createTime?: string;
  updateTime?: string;
}

interface RawVersion {
  name?: string;
  payload?: { data?: string };
  createTime?: string;
  disabled?: boolean;
}

function b64url(input: string): string {
  return fromB64(Buffer.from(input, "utf8").toString("base64"));
}

function fromB64(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
