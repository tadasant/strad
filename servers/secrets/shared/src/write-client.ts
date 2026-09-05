import {
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  ParameterManagerError,
} from "./parameter-manager.js";
import {
  decodeStoredValue,
  encodeSecretValue,
  isSecretRef,
  parameterId,
  secretRef,
  SECRET_VALUE_ENCODING,
  type ParameterEnvelope,
} from "./parameter-wire.js";
import {
  nextVersionId,
  rankVersions,
  versionIdOf,
  withSecretAccessor,
  type IamPolicy,
} from "./parameter-write-rules.js";
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
 * STAGING IS THE CASE THIS EXISTS FOR. `strad-secrets-staging` is a project
 * separate from the one holding strad's own `strad-<env>-*` secrets, so the
 * blast radius of a write surface there is bounded — it is not empty, and
 * `get_secret_value` on staging returns real per-server credentials (issue #59).
 * Being able to create, rotate, read and delete a parameter over `/mcp` is what
 * makes the store testable end to end instead of only through the console.
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

  /**
   * The greatest `v{n}` among a parameter's ENABLED versions.
   *
   * This ranking is a contract, not a detail, so the ranking itself is not
   * written here: `rankVersions` is vendored from `src/secrets/parameters/write-rules.ts`,
   * and `test/vendored.sync.test.ts` fails CI when the two copies drift. Three
   * readers rank versions — this tree's reader, the console's client and the
   * runtime resolver — and a writer that disagrees writes versions the others
   * skip, silently: the tool reports success and the value never takes effect.
   *
   * What stays here is the LISTING — this tree's own call, its own error type.
   */
  async function currentVersionId(id: string): Promise<string | undefined> {
    const listed = (await pm(
      "GET",
      `${pmParent}/parameters/${id}/versions`,
    )) as {
      parameterVersions?: { name?: string; disabled?: boolean }[];
    };
    return rankVersions(listed.parameterVersions ?? [])?.vid;
  }

  /**
   * Every version of a parameter, deleted. All of them must go before the
   * parameter itself can: Parameter Manager refuses to delete a parameter that
   * still has one.
   *
   * Mirrors `deleteAllVersions` in `src/secrets/parameters/gcp.ts`, including
   * its tolerances: a 404 listing means there is nothing to delete (the caller
   * goes on to delete the parameter), and an individual version delete that
   * fails is swallowed, because the parameter delete that follows is the thing
   * that actually reports failure.
   */
  async function deleteAllVersions(id: string): Promise<void> {
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (pageToken) qs.set("pageToken", pageToken);
      const page = (await pm(
        "GET",
        `${pmParent}/parameters/${id}/versions?${qs}`,
      ).catch((err) => {
        if (err instanceof ParameterManagerError && err.status === 404) {
          return { parameterVersions: [] };
        }
        throw err;
      })) as {
        parameterVersions?: { name?: string }[];
        nextPageToken?: string;
      };
      for (const v of page.parameterVersions ?? []) {
        const vid = versionIdOf(v.name);
        if (!vid) continue;
        await pm("DELETE", `${pmParent}/parameters/${id}/versions/${vid}`).catch(
          () => {},
        );
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  async function addVersion(
    id: string,
    envelope: ParameterEnvelope,
  ): Promise<void> {
    // `v{n+1}`, from the same ranking every reader uses — the shared mint, not a
    // second reading of the same suffix. A timestamp-shaped id would be unique
    // and legal and still wrong: `Date.now().toString(36)` ends in a letter most
    // of the time, so its numeric suffix reads as 0 and the version sorts BELOW
    // `v1`.
    const versionId = nextVersionId(await currentVersionId(id));
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

  /**
   * The current envelope, VERIFIED to be the one that was asked for.
   *
   * `parameterId` is a lossy fold: it collapses every run of non-alphanumerics
   * to one `-`, so `/strad/staging/mcp/evil/static/X` (inside the namespace) and
   * `/strad/staging/mcp-evil/static/X` (outside it) land on the same id. The
   * namespace check upstream passes on the path the caller supplied; without
   * this comparison the WRITE would land on, and `readValue` would return, a
   * parameter the namespace does not cover. The read half of this tree already
   * defends against exactly this (see `getParameter`); so does this half now.
   */
  async function currentEnvelope(path: string): Promise<ParameterEnvelope> {
    const id = parameterId(path);
    const vid = await currentVersionId(id);
    if (!vid) {
      throw new ParameterManagerError(`"${path}" has no version yet`, 404);
    }
    const got = (await pm(
      "GET",
      `${pmParent}/parameters/${id}/versions/${vid}`,
    )) as { payload?: { data?: string } };
    const data = got.payload?.data;
    if (!data) {
      throw new ParameterManagerError(`"${path}" version has no payload`, 502);
    }
    const envelope = JSON.parse(
      Buffer.from(data, "base64").toString("utf8"),
    ) as ParameterEnvelope;
    assertSamePath(envelope, path);
    return envelope;
  }

  /**
   * Make a secret parameter's `__REF__` resolvable — the same grant as
   * `grantRenderAccess` in `src/secrets/parameters/gcp.ts`, and now literally the
   * same policy edit: `withSecretAccessor` is vendored from
   * `src/secrets/parameters/write-rules.ts`.
   *
   * Parameter Manager derefs a reference as the PARAMETER's own principal, so a
   * secret written here without this binding renders `400 SECRET_REFERENCE_ERROR`
   * for every reader forever. This tree writes to the same store the gateway's
   * resolver reads, so omitting it here would leave exactly half the defect fixed.
   */
  async function grantRenderAccess(id: string): Promise<void> {
    const param = (await pm("GET", `${pmParent}/parameters/${id}`)) as {
      policyMember?: { iamPolicyUidPrincipal?: string };
    };
    const principal = param.policyMember?.iamPolicyUidPrincipal;
    if (!principal) {
      throw new ParameterManagerError(
        `parameter "${id}" reported no policyMember.iamPolicyUidPrincipal, so its secret reference could not be made resolvable`,
        502,
      );
    }

    // `requestedPolicyVersion=3` is REQUIRED: without it IAM returns a version-1
    // VIEW that omits conditional bindings, and writing that view back deletes
    // them. The query string is this call site's — `withSecretAccessor` never
    // sees it — so the requirement is written where the request is made, in both
    // trees.
    const policy = (await sm(
      "GET",
      `${smParent}/secrets/${id}:getIamPolicy?options.requestedPolicyVersion=3`,
    )) as IamPolicy;

    // `null` is "already a member": nothing to write.
    const next = withSecretAccessor(policy, principal);
    if (!next) return;

    await sm("POST", `${smParent}/secrets/${id}:setIamPolicy`, {
      policy: next,
    });
  }

  /** The id collision guard. A mismatch is a 404: this is not that parameter. */
  function assertSamePath(envelope: ParameterEnvelope, path: string): void {
    if (envelope.path !== path) {
      throw new ParameterManagerError(
        `"${path}" does not exist (the id it folds to belongs to another parameter)`,
        404,
      );
    }
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
              // base64url of the value, THEN base64 for the wire. The inner
              // encoding is what `:render` substitutes into a JSON payload, so it
              // is the one that has to be inert — a PEM key or a JSON blob is
              // rejected as an injection without it. Same as the src/ half.
              data: Buffer.from(
                encodeSecretValue(input.value),
                "utf8",
              ).toString("base64"),
            },
          });
        } catch (err) {
          await sm("DELETE", `${smParent}/secrets/${id}`).catch(() => {});
          throw err;
        }
        envelopeValue = secretRef(cfg.projectId, id);
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
        // BEFORE the version: a complete-looking secret parameter must never
        // exist with an unresolvable reference. Inside the existing rollback, so
        // a grant that fails leaves nothing behind.
        if (input.secret) await grantRenderAccess(id);
        await addVersion(id, {
          path: input.path,
          secret: input.secret,
          note: input.note,
          value: envelopeValue,
          ...(input.secret ? { encoding: SECRET_VALUE_ENCODING } : {}),
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
        // Declare the encoding BEFORE writing the bytes, for a parameter written
        // before strad encoded them. Same ordering, same reason, as the src/ half:
        // bytes-first would make the gap read an encoded value as a literal and
        // hand a child base64 text as its credential, silently; envelope-first
        // makes the gap fail `decodeStoredValue` loudly instead.
        const upgraded = prev.encoding !== SECRET_VALUE_ENCODING;
        if (upgraded) {
          await addVersion(id, { ...prev, encoding: SECRET_VALUE_ENCODING });
        }
        try {
          // A secret's bytes go to Secret Manager; the envelope's ref is unchanged
          // because it points at `versions/latest`.
          await sm("POST", `${smParent}/secrets/${id}:addVersion`, {
            payload: {
              data: Buffer.from(encodeSecretValue(value), "utf8").toString(
                "base64",
              ),
            },
          });
        } catch (err) {
          // Put the envelope back, so a failed second write does not strand the
          // parameter declaring an encoding its bytes do not have. Same rollback
          // discipline `create()` applies, and the same one the src/ half uses.
          if (upgraded) await addVersion(id, prev).catch(() => {});
          throw err;
        }
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
      // The envelope read is REQUIRED here, not best-effort, and that is the
      // whole difference between deleting this parameter and deleting whatever
      // else folded onto the same id. Swallowing the error and deleting anyway
      // would make an id collision a destructive one.
      const prev = await currentEnvelope(path);
      // VERSIONS FIRST. Parameter Manager refuses to delete a parameter that
      // still has versions, so deleting the parameter directly is a `400 Bad
      // Request` for every parameter that has ever held a value — which is all
      // of them, because `create` writes v1.
      await deleteAllVersions(id);
      await pm("DELETE", `${pmParent}/parameters/${id}`).catch((err) => {
        if (err instanceof ParameterManagerError && err.status === 404) return;
        throw err;
      });
      if (prev.secret) {
        await sm("DELETE", `${smParent}/secrets/${id}`).catch(() => {});
      }
    },

    async readValue(path) {
      const id = parameterId(path);
      // Verify the id belongs to THIS path before rendering it. `:render` is the
      // one call here that returns a secret value, so an id collision must not
      // be able to hand back a parameter outside the managed namespace.
      await currentEnvelope(path);
      const vid = await currentVersionId(id);
      if (!vid) {
        throw new ParameterManagerError(`"${path}" has no version yet`, 404);
      }
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
      // A `:render` that could not dereference hands the POINTER back rather
      // than failing, and decoding a pointer would turn a diagnosable state into
      // mojibake. Everything else is decoded per the envelope's own declaration.
      if (isSecretRef(envelope.value)) return envelope.value;
      return decodeStoredValue(envelope.value, envelope.encoding, path);
    },
  };
}
