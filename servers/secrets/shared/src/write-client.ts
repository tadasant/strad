import {
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  parameterId,
  ParameterManagerError,
  variableOf,
  type ParameterEnvelope,
} from "./parameter-manager.js";
import { tokenMinter, type ServiceAccount } from "./google-auth.js";

/**
 * The WRITE half of this server, and the deref that reads a secret value.
 *
 * WHY THIS IS A SEPARATE FILE. `parameter-manager.ts` claims, in its own header,
 * that it speaks no verb but GET and has no `:render` — and that claim is checked
 * by reading the file. Adding a POST to it would destroy the one review property
 * that makes the viewer half trustworthy at a glance. So the mutating surface
 * lives here, in a file whose name says what it is, and nothing constructs it
 * unless the capability probe says the credential can actually use it
 * (capabilities.ts).
 *
 * NOTHING HERE WEAKENS PROD. Prod's credential holds Parameter Manager viewer
 * access and no `secretmanager.versions.access`: the probe reports no write and
 * no read-value, this client is never built, and its tools are never listed. If
 * one were somehow called, Google would refuse it. The IAM boundary is doing the
 * work; this file only stops the surface from advertising what the boundary
 * forbids.
 *
 * STAGING IS THE CASE THIS EXISTS FOR. `strad-secrets-staging` holds nothing
 * sensitive, and being able to create, rotate, read and delete a parameter over
 * `/mcp` is what makes the store testable end to end instead of only through the
 * console.
 *
 * The two-store dance mirrors `src/secrets/parameters/gcp.ts` exactly, including
 * the one thing that is easy to get wrong: a 409 on the parameter-create must NOT
 * roll back, because the parameter it collided with is not this call's to delete.
 */

export interface WriteClientConfig {
  projectId: string;
  account: ServiceAccount;
  /** Test seams. Default to the real APIs. */
  pmApiBase?: string;
  smApiBase?: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_PM_BASE = "https://parametermanager.googleapis.com";
const DEFAULT_SM_BASE = "https://secretmanager.googleapis.com";
const LOCATION = "global";

export interface ParametersWriter {
  create(input: {
    path: string;
    secret: boolean;
    value: string;
    note?: string;
  }): Promise<void>;
  rotate(path: string, value: string): Promise<void>;
  setNote(path: string, note: string): Promise<void>;
  destroy(path: string): Promise<void>;
  /** The resolved value, dereferencing a secret ref. Needs versions.access. */
  readValue(path: string): Promise<string>;
}

export function createWriteClient(cfg: WriteClientConfig): ParametersWriter {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const pmBase = cfg.pmApiBase ?? DEFAULT_PM_BASE;
  const smBase = cfg.smApiBase ?? DEFAULT_SM_BASE;
  const pmParent = `projects/${cfg.projectId}/locations/${LOCATION}`;
  const smParent = `projects/${cfg.projectId}`;
  const token = tokenMinter({
    account: cfg.account,
    tokenUrl: cfg.tokenUrl,
    fetchImpl,
  });

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
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      // Path and status only. A value never reaches a message from here: the
      // caller's `value` is not interpolated, and a response body that might
      // echo one is not read.
      throw new ParameterManagerError(
        `${method} ${path.split("?")[0]} failed: ${res.status} ${res.statusText}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined;
    return (await res.json().catch(() => undefined)) as unknown;
  }

  const pm = (m: string, p: string, b?: unknown) => call(pmBase, m, p, b);
  const sm = (m: string, p: string, b?: unknown) => call(smBase, m, p, b);

  function secretRef(secretId: string): string {
    return `__REF__("//secretmanager.googleapis.com/projects/${cfg.projectId}/secrets/${secretId}/versions/latest")`;
  }

  async function addVersion(
    id: string,
    envelope: ParameterEnvelope,
  ): Promise<void> {
    // A version id must be unique per parameter and legal as a resource id.
    const versionId = `v${Date.now().toString(36)}`;
    await pm(
      "POST",
      `${pmParent}/parameters/${id}/versions?parameter_version_id=${versionId}`,
      {
        payload: {
          data: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
        },
      },
    );
  }

  async function currentEnvelope(path: string): Promise<ParameterEnvelope> {
    const id = parameterId(path);
    const listed = (await pm(
      "GET",
      `${pmParent}/parameters/${id}/versions`,
    )) as {
      parameterVersions?: { name?: string; disabled?: boolean }[];
    };
    const versions = (listed.parameterVersions ?? []).filter(
      (v) => !v.disabled && v.name,
    );
    const last = versions[versions.length - 1];
    if (!last?.name) {
      throw new ParameterManagerError(`"${path}" has no version yet`, 404);
    }
    const vid = last.name.slice(last.name.lastIndexOf("/") + 1);
    const got = (await pm(
      "GET",
      `${pmParent}/parameters/${id}/versions/${vid}`,
    )) as { payload?: { data?: string } };
    const data = got.payload?.data;
    if (!data) {
      throw new ParameterManagerError(`"${path}" version has no payload`, 502);
    }
    return JSON.parse(
      Buffer.from(data, "base64").toString("utf8"),
    ) as ParameterEnvelope;
  }

  return {
    async create(input) {
      const id = parameterId(input.path);
      let envelopeValue = input.value;

      if (input.secret) {
        // Secret Manager FIRST, so the envelope can point at a version that
        // already exists.
        await sm("POST", `${smParent}/secrets?secretId=${id}`, {
          replication: { automatic: {} },
          labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
        });
        try {
          await sm("POST", `${smParent}/secrets/${id}:addVersion`, {
            payload: {
              data: Buffer.from(input.value, "utf8").toString("base64"),
            },
          });
        } catch (err) {
          await sm("DELETE", `${smParent}/secrets/${id}`).catch(() => {});
          throw err;
        }
        envelopeValue = secretRef(id);
      }

      try {
        await pm("POST", `${pmParent}/parameters?parameter_id=${id}`, {
          format: "JSON",
          labels: {
            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
            secret: String(input.secret),
          },
        });
      } catch (err) {
        // A 409 means the parameter already exists. It is not this call's to
        // delete, and rolling it back would destroy someone else's parameter and
        // every version of it. Same reasoning as src/secrets/parameters/gcp.ts.
        if (!(err instanceof ParameterManagerError && err.status === 409)) {
          await pm("DELETE", `${pmParent}/parameters/${id}`).catch(() => {});
        }
        if (input.secret) {
          await sm("DELETE", `${smParent}/secrets/${id}`).catch(() => {});
        }
        throw err;
      }

      try {
        await addVersion(id, {
          path: input.path,
          secret: input.secret,
          note: input.note,
          value: envelopeValue,
        });
      } catch (err) {
        await pm("DELETE", `${pmParent}/parameters/${id}`).catch(() => {});
        if (input.secret) {
          await sm("DELETE", `${smParent}/secrets/${id}`).catch(() => {});
        }
        throw err;
      }
    },

    async rotate(path, value) {
      const id = parameterId(path);
      const prev = await currentEnvelope(path);
      if (prev.secret) {
        // A secret's bytes go to Secret Manager; the envelope's ref is unchanged
        // because it points at `versions/latest`.
        await sm("POST", `${smParent}/secrets/${id}:addVersion`, {
          payload: { data: Buffer.from(value, "utf8").toString("base64") },
        });
        return;
      }
      await addVersion(id, { ...prev, value });
    },

    async setNote(path, note) {
      const id = parameterId(path);
      const prev = await currentEnvelope(path);
      await addVersion(id, { ...prev, note: note || undefined });
    },

    async destroy(path) {
      const id = parameterId(path);
      const prev = await currentEnvelope(path).catch(() => undefined);
      await pm("DELETE", `${pmParent}/parameters/${id}`);
      if (prev?.secret) {
        await sm("DELETE", `${smParent}/secrets/${id}`).catch(() => {});
      }
    },

    async readValue(path) {
      const id = parameterId(path);
      const listed = (await pm(
        "GET",
        `${pmParent}/parameters/${id}/versions`,
      )) as { parameterVersions?: { name?: string; disabled?: boolean }[] };
      const versions = (listed.parameterVersions ?? []).filter(
        (v) => !v.disabled && v.name,
      );
      const last = versions[versions.length - 1];
      if (!last?.name) {
        throw new ParameterManagerError(`"${path}" has no version yet`, 404);
      }
      const vid = last.name.slice(last.name.lastIndexOf("/") + 1);
      // `:render` dereferences a `__REF__`. This is the ONE call in this tree
      // that can return a secret value, and it is reachable only when the probe
      // reported `readSecretValues` — which is Google's answer, not ours.
      const rendered = (await pm(
        "GET",
        `${pmParent}/parameters/${id}/versions/${vid}:render`,
      )) as { renderedPayload?: string; payload?: { data?: string } };
      const data = rendered.renderedPayload ?? rendered.payload?.data;
      if (data == null) {
        throw new ParameterManagerError(`"${path}" rendered no payload`, 502);
      }
      const envelope = JSON.parse(
        Buffer.from(data, "base64").toString("utf8"),
      ) as ParameterEnvelope;
      return envelope.value;
    },
  };
}

export { variableOf };
