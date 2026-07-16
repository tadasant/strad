import {
  mintAccessToken,
  parseServiceAccount,
  SCOPE_CLOUD_PLATFORM,
  type FetchLike,
  type MintedToken,
  type ServiceAccount,
} from "./service-account.ts";
import {
  decodeEnvelope,
  encodeEnvelope,
  parameterId,
  secretRef,
  variableOf,
  type ParameterEnvelope,
} from "./namespace.ts";
import {
  ParameterStoreError,
  type CreateParameterInput,
  type ParameterMeta,
  type ParameterStore,
} from "./types.ts";

/**
 * The GCP implementation of the parameter store: Parameter Manager as the index
 * of everything, Secret Manager backing the secret parts.
 *
 * A non-secret parameter is a Parameter Manager parameter whose latest version's
 * payload IS the value (inside a small JSON envelope — see namespace.ts). A
 * secret parameter is the same Parameter Manager parameter, but its envelope
 * `value` is a `__REF__(…)` pointer at a Secret Manager version, and the real
 * value lives in Secret Manager. `:render` dereferences the pointer — for a
 * credential that can reach Secret Manager.
 *
 * This is the ADMIN + RESOLVER client (src/, core gateway). Its credential can
 * read secret values (admin: for the console reveal, behind SSO; resolver: to
 * build a child's env). The MCP viewer is a DIFFERENT credential in a DIFFERENT
 * process (servers/secrets) and cannot. No SDK: fetch + node:crypto.
 */

export interface GcpParameterStoreConfig {
  projectId: string;
  /** Parameter Manager location. `global` unless a deployment says otherwise. */
  location?: string;
  account: ServiceAccount;
  /** Test seams. Default to the real APIs. */
  pmApiBase?: string;
  smApiBase?: string;
  tokenUrl?: string;
  fetchImpl?: FetchLike;
}

const DEFAULT_PM_BASE = "https://parametermanager.googleapis.com";
const DEFAULT_SM_BASE = "https://secretmanager.googleapis.com";

export function createGcpParameterStore(
  cfg: GcpParameterStoreConfig,
): ParameterStore {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const location = cfg.location ?? "global";
  const pmBase = cfg.pmApiBase ?? DEFAULT_PM_BASE;
  const smBase = cfg.smApiBase ?? DEFAULT_SM_BASE;
  const pmParent = `projects/${cfg.projectId}/locations/${location}`;
  const smParent = `projects/${cfg.projectId}`;
  let cached: MintedToken | undefined;

  async function token(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    cached = await mintAccessToken(cfg.account, {
      scope: SCOPE_CLOUD_PLATFORM,
      tokenUrl: cfg.tokenUrl,
      fetchImpl,
    });
    return cached.token;
  }

  async function call(
    base: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetchImpl(`${base}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await token()}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      // The path names a resource; it never carries a value (values travel in
      // the body, which is not echoed here). Strip the query and any `:verb`.
      const resource = (path.split("?")[0] ?? path).split(":")[0];
      throw new ParameterStoreError(
        `${method} ${resource} failed: ${res.status} ${res.statusText}`,
        res.status,
      );
    }
    if (res.status === 204) return {};
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : {};
  }

  const pm = (m: string, p: string, b?: unknown) => call(pmBase, m, p, b);
  const sm = (m: string, p: string, b?: unknown) => call(smBase, m, p, b);

  // --- Parameter Manager version plumbing ---------------------------------

  interface RawVersion {
    name?: string;
    payload?: { data?: string };
    createTime?: string;
    disabled?: boolean;
  }

  function versionIdOf(name: string | undefined): string | undefined {
    return name?.split("/").pop();
  }

  /** The greatest `v{n}` among a parameter's enabled versions, or undefined. */
  async function currentVersionId(id: string): Promise<string | undefined> {
    const versions: RawVersion[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = (await pm(
        "GET",
        `${pmParent}/parameters/${id}/versions?${qs}`,
      )) as { parameterVersions?: RawVersion[]; nextPageToken?: string };
      versions.push(...(page.parameterVersions ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);

    let best: { vid: string; n: number } | undefined;
    for (const v of versions) {
      if (v.disabled) continue;
      const vid = versionIdOf(v.name);
      if (!vid) continue;
      const n = Number(/(\d+)$/.exec(vid)?.[1] ?? "0");
      if (!best || n > best.n) best = { vid, n };
    }
    return best?.vid;
  }

  async function nextVersionId(id: string): Promise<string> {
    const current = await currentVersionId(id);
    const n = current ? Number(/(\d+)$/.exec(current)?.[1] ?? "0") : 0;
    return `v${n + 1}`;
  }

  async function addVersion(
    id: string,
    envelope: ParameterEnvelope,
  ): Promise<string> {
    const vid = await nextVersionId(id);
    await pm(
      "POST",
      `${pmParent}/parameters/${id}/versions?parameter_version_id=${vid}`,
      {
        payload: {
          data: Buffer.from(encodeEnvelope(envelope), "utf8").toString(
            "base64",
          ),
        },
      },
    );
    return vid;
  }

  /** The current envelope (raw — a secret one still holds a `__REF__`, not a value). */
  async function currentEnvelope(id: string): Promise<{
    envelope: ParameterEnvelope;
    versionId: string;
    createTime?: string;
  } | null> {
    const vid = await currentVersionId(id);
    if (!vid) return null;
    const raw = (await pm(
      "GET",
      `${pmParent}/parameters/${id}/versions/${vid}`,
    )) as RawVersion;
    const data = raw.payload?.data;
    if (data == null) return null;
    return {
      envelope: decodeEnvelope(Buffer.from(data, "base64").toString("utf8")),
      versionId: vid,
      createTime: raw.createTime,
    };
  }

  // --- ParameterStore surface ---------------------------------------------

  async function list(namespace: string): Promise<ParameterMeta[]> {
    const params: { id: string }[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = (await pm("GET", `${pmParent}/parameters?${qs}`)) as {
        parameters?: { name?: string; labels?: Record<string, string> }[];
        nextPageToken?: string;
      };
      for (const raw of page.parameters ?? []) {
        if (raw.labels?.["managed-by"] !== "strad") continue;
        const id = raw.name?.split("/").pop();
        if (id) params.push({ id });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    // One version read per parameter to recover its envelope (path, secret,
    // note) and whether it has a value. Bounded fan-out: a store of 500
    // parameters must not open 500 connections to render one page.
    const out: ParameterMeta[] = [];
    const FANOUT = 10;
    for (let i = 0; i < params.length; i += FANOUT) {
      const batch = await Promise.all(
        params.slice(i, i + FANOUT).map(async ({ id }) => {
          const cur = await currentEnvelope(id).catch((err) => {
            if (err instanceof ParameterStoreError && err.status === 404)
              return null;
            throw err;
          });
          if (!cur) return null;
          const { path, secret, note } = cur.envelope;
          if (!path.startsWith(namespace)) return null;
          const meta: ParameterMeta = {
            path,
            variable: variableOf(path),
            secret,
            note,
            hasValue: true,
            latestVersion: cur.versionId,
            updatedAt: cur.createTime,
          };
          return meta;
        }),
      );
      for (const m of batch) if (m) out.push(m);
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  async function create(input: CreateParameterInput): Promise<ParameterMeta> {
    const id = parameterId(input.path);

    // A secret parameter's value goes to Secret Manager FIRST, so the Parameter
    // Manager envelope can point at a version that already exists.
    let envelopeValue = input.value;
    if (input.secret) {
      await sm("POST", `${smParent}/secrets?secretId=${id}`, {
        replication: { automatic: {} },
        labels: { "managed-by": "strad" },
      });
      try {
        await sm("POST", `${smParent}/secrets/${id}:addVersion`, {
          payload: {
            data: Buffer.from(input.value, "utf8").toString("base64"),
          },
        });
      } catch (err) {
        // Roll the empty secret back so a retry is not met with "already exists".
        await sm("DELETE", `${smParent}/secrets/${id}`).catch(() => {});
        throw err;
      }
      envelopeValue = secretRef(cfg.projectId, id);
    }

    await pm("POST", `${pmParent}/parameters?parameter_id=${id}`, {
      format: "JSON",
      labels: { "managed-by": "strad", secret: String(input.secret) },
    });
    try {
      await addVersion(id, {
        path: input.path,
        secret: input.secret,
        note: input.note,
        value: envelopeValue,
      });
    } catch (err) {
      // Two-call create failed between the parameter and its version: roll the
      // empty parameter (and any secret) back so the user's retry works.
      await pm("DELETE", `${pmParent}/parameters/${id}`).catch(() => {});
      if (input.secret)
        await sm("DELETE", `${smParent}/secrets/${id}`).catch(() => {});
      throw err;
    }

    return {
      path: input.path,
      variable: variableOf(input.path),
      secret: input.secret,
      note: input.note,
      hasValue: true,
      latestVersion: "v1",
    };
  }

  async function rotate(path: string, value: string): Promise<void> {
    const id = parameterId(path);
    const cur = await currentEnvelope(id);
    if (!cur) throw new ParameterStoreError(`no such parameter: ${path}`, 404);

    if (cur.envelope.secret) {
      // The Secret Manager version is the value; the Parameter Manager `__REF__`
      // already points at `versions/latest`, so it needs no new version.
      await sm("POST", `${smParent}/secrets/${id}:addVersion`, {
        payload: { data: Buffer.from(value, "utf8").toString("base64") },
      });
    } else {
      await addVersion(id, { ...cur.envelope, value });
    }
  }

  async function setNote(path: string, note: string): Promise<void> {
    const id = parameterId(path);
    const cur = await currentEnvelope(id);
    if (!cur) throw new ParameterStoreError(`no such parameter: ${path}`, 404);
    // The note lives in the envelope, so a note change is a new version that
    // carries the SAME value pointer (or literal). A secret's value is untouched.
    await addVersion(id, { ...cur.envelope, note: note || undefined });
  }

  async function reveal(path: string): Promise<string> {
    const id = parameterId(path);
    const cur = await currentEnvelope(id);
    if (!cur) throw new ParameterStoreError(`no such parameter: ${path}`, 404);
    if (!cur.envelope.secret) return cur.envelope.value;
    // Secret: read the value from Secret Manager directly (the admin credential
    // can). This is the only place a secret value is read for DISPLAY, and it is
    // a human behind the SSO gate.
    const res = (await sm(
      "GET",
      `${smParent}/secrets/${id}/versions/latest:access`,
    )) as { payload?: { data?: string } };
    const data = res.payload?.data;
    if (data == null) {
      throw new ParameterStoreError(
        `secret "${path}" has no version to reveal`,
        404,
      );
    }
    return Buffer.from(data, "base64").toString("utf8");
  }

  async function destroy(path: string): Promise<void> {
    const id = parameterId(path);
    const cur = await currentEnvelope(id).catch(() => null);
    // Delete the Parameter Manager parameter's versions then the parameter, then
    // the Secret Manager secret if this was a secret parameter.
    await deleteAllVersions(id);
    await pm("DELETE", `${pmParent}/parameters/${id}`).catch((err) => {
      if (err instanceof ParameterStoreError && err.status === 404) return;
      throw err;
    });
    if (cur?.envelope.secret) {
      await sm("DELETE", `${smParent}/secrets/${id}`).catch((err) => {
        if (err instanceof ParameterStoreError && err.status === 404) return;
        throw err;
      });
    }
  }

  async function deleteAllVersions(id: string): Promise<void> {
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = (await pm(
        "GET",
        `${pmParent}/parameters/${id}/versions?${qs}`,
      ).catch((err) => {
        if (err instanceof ParameterStoreError && err.status === 404) {
          return { parameterVersions: [] };
        }
        throw err;
      })) as { parameterVersions?: RawVersion[]; nextPageToken?: string };
      for (const v of page.parameterVersions ?? []) {
        const vid = versionIdOf(v.name);
        if (vid) {
          await pm(
            "DELETE",
            `${pmParent}/parameters/${id}/versions/${vid}`,
          ).catch(() => {});
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  async function resolve(namespace: string): Promise<Record<string, string>> {
    const metas = await list(namespace);
    const out: Record<string, string> = {};
    for (const meta of metas) {
      const id = parameterId(meta.path);
      const vid = await currentVersionId(id);
      if (!vid) continue;
      // `:render` returns the payload with every `__REF__` dereferenced against
      // Secret Manager. For a non-secret parameter it is the raw payload; for a
      // secret one it now contains the actual value. Either way we parse the
      // envelope and take `.value`.
      const rendered = (await pm(
        "GET",
        `${pmParent}/parameters/${id}/versions/${vid}:render`,
      )) as { renderedPayload?: string; payload?: { data?: string } };
      const data = rendered.renderedPayload ?? rendered.payload?.data;
      if (data == null) continue;
      const envelope = decodeEnvelope(
        Buffer.from(data, "base64").toString("utf8"),
      );
      out[variableOf(meta.path)] = envelope.value;
    }
    return out;
  }

  return {
    backend: "gcp",
    list,
    create,
    rotate,
    setNote,
    reveal,
    destroy,
    resolve,
  };
}

/** Parse an admin service-account key; report malformed keys by shape, not content. */
export function parseAdminAccount(raw: string | undefined): {
  account: ServiceAccount | null;
  reason?: string;
} {
  return parseServiceAccount(raw);
}
