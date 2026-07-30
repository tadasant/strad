import { generateKeyPairSync } from "node:crypto";
import { createGcpParameterStore } from "./gcp.ts";
import type { FetchLike, ServiceAccount } from "./service-account.ts";
import type { ParameterStore } from "./types.ts";

/**
 * An in-memory Parameter Manager + Secret Manager, spoken over a stub `fetch`.
 *
 * It exists so the console, the resolver and the deploy-time renderer can be
 * exercised END TO END without a live GCP project — the same discipline PR #30
 * used for Secret Manager. It models the two stores as two maps and, crucially,
 * models the ONE interaction that makes the security story real: a secret
 * parameter's Parameter Manager payload holds only a `__REF__(…)` pointer, and
 * the actual value is in the Secret Manager map. `:render` is the only path that
 * joins them.
 *
 * `store` is the client under test (admin/resolver). `raw` exposes both maps so a
 * test can assert, directly, that a secret value lives in Secret Manager and NOT
 * in any Parameter Manager payload.
 */

export interface FakeGcp {
  store: ParameterStore;
  fetchImpl: FetchLike;
  /**
   * The addresses and credential the fake answers on.
   *
   * Exposed so a test can put the fake behind a real HTTP server and point a
   * SUBPROCESS at it — which is how `render-spec` gets exercised against a store
   * without a live GCP project. In-process tests use `fetchImpl` and ignore this.
   */
  endpoints: {
    projectId: string;
    location: string;
    pmApiBase: string;
    smApiBase: string;
    tokenUrl: string;
    /** A service-account key JSON that `parseServiceAccount` accepts. */
    keyJson: string;
  };
  /** The Parameter Manager map: parameterId -> { labels, versions }. */
  parameters: Map<string, FakeParameter>;
  /** The Secret Manager map: secretId -> string[] (versions, newest last). */
  secrets: Map<string, string[]>;
  /**
   * The Secret Manager IAM map: secretId -> bindings.
   *
   * `:render` is GATED on this (see `renderRefs`), which is the whole reason it
   * is modelled. A secret parameter whose principal was never granted
   * `secretAccessor` renders 400 here exactly as it does at Google, so a
   * regression that drops the grant fails a test instead of failing a deploy.
   */
  secretPolicies: Map<string, FakeBinding[]>;
  /** The principal Parameter Manager derefs a `__REF__` as, for a given parameter. */
  principalOf(parameterId: string): string;
  /** Every payload string ever written to Parameter Manager (for canary checks). */
  pmPayloads(): string[];
}

export interface FakeBinding {
  role: string;
  members: string[];
}

interface FakeParameter {
  labels: Record<string, string>;
  versions: { id: string; data: string; disabled?: boolean }[];
}

const PROJECT = "strad-secrets-test";
const PROJECT_NUMBER = "100000000001";
const PM_BASE = "https://pm.test";
const SM_BASE = "https://sm.test";
const TOKEN_URL = "https://token.test/token";
const LOCATION = "global";
const SECRET_ACCESSOR_ROLE = "roles/secretmanager.secretAccessor";

/**
 * The principal a `:render` runs as — the PARAMETER, not the caller.
 *
 * Google's shape, and the shape matters: the real one is minted per parameter and
 * exposed as `policyMember.iamPolicyUidPrincipal`, so a client that grants
 * `secretAccessor` to its own service account instead builds a member string that
 * never matches this and gets a 400 it cannot explain.
 */
function principalFor(parameterId: string): string {
  return (
    `principal://parametermanager.googleapis.com/projects/${PROJECT_NUMBER}` +
    `/uid/locations/${LOCATION}/parameters/${parameterId}`
  );
}

// mintAccessToken RSA-signs the JWT before POSTing to the (stubbed) token
// endpoint, so it needs a real key. Generated once per process; a credential to
// nothing.
const TEST_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const ACCOUNT: ServiceAccount = {
  client_email: "admin@strad-secrets-test.iam.gserviceaccount.com",
  private_key: TEST_PRIVATE_KEY,
};

const REF_RE =
  /^__REF__\("\/\/secretmanager\.googleapis\.com\/projects\/([^/]+)\/secrets\/([^/]+)\/versions\/([^"]+)"\)$/;

export function createFakeGcp(): FakeGcp {
  const parameters = new Map<string, FakeParameter>();
  const secrets = new Map<string, string[]>();
  const secretPolicies = new Map<string, FakeBinding[]>();

  const json = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: STATUS_TEXT[status] ?? "",
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
      json: async () => body,
    }) as Response;

  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = (init?.method ?? "GET").toUpperCase();

    // The token endpoint takes a form-encoded body, not JSON — handle it before
    // any JSON parse.
    if (url === TOKEN_URL) {
      return json(200, { access_token: "fake-token", expires_in: 3600 });
    }

    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    const pm = url.startsWith(`${PM_BASE}/v1/`)
      ? url.slice(`${PM_BASE}/v1/`.length)
      : null;
    const sm = url.startsWith(`${SM_BASE}/v1/`)
      ? url.slice(`${SM_BASE}/v1/`.length)
      : null;

    try {
      if (pm !== null) return handlePm(pm, method, body);
      if (sm !== null) return handleSm(sm, method, body);
    } catch (e) {
      if (e instanceof HttpError)
        return json(e.status, { error: { code: e.status } });
      throw e;
    }
    return json(404, { error: { code: 404 } });
  };

  const paramParent = `projects/${PROJECT}/locations/${LOCATION}/parameters`;

  function handlePm(path: string, method: string, body: unknown): Response {
    const [pathOnly, query] = splitQuery(path);
    const q = new URLSearchParams(query);

    // list parameters
    if (pathOnly === paramParent && method === "GET") {
      return json(200, {
        parameters: [...parameters.entries()].map(([id, p]) => ({
          name: `projects/${PROJECT}/locations/${LOCATION}/parameters/${id}`,
          labels: p.labels,
        })),
      });
    }
    // create parameter
    if (pathOnly === paramParent && method === "POST") {
      const id = q.get("parameter_id")!;
      if (parameters.has(id)) throw new HttpError(409);
      parameters.set(id, {
        labels: (body as { labels?: Record<string, string> }).labels ?? {},
        versions: [],
      });
      return json(200, { name: `${paramParent}/${id}` });
    }

    const rest = pathOnly.startsWith(`${paramParent}/`)
      ? pathOnly.slice(`${paramParent}/`.length)
      : null;
    if (rest === null) return json(404, { error: { code: 404 } });

    const [id = "", ...tail] = rest.split("/");
    const param = parameters.get(id);

    // DELETE parameter
    if (tail.length === 0 && method === "DELETE") {
      if (!param) throw new HttpError(404);
      parameters.delete(id);
      return json(200, {});
    }
    if (!param) throw new HttpError(404);

    // GET parameter — labels, and the principal `:render` derefs as.
    if (tail.length === 0 && method === "GET") {
      return json(200, {
        name: `${paramParent}/${id}`,
        labels: param.labels,
        policyMember: { iamPolicyUidPrincipal: principalFor(id) },
      });
    }

    // versions
    if (tail[0] === "versions") {
      // list versions
      if (tail.length === 1 && method === "GET") {
        return json(200, {
          parameterVersions: param.versions.map((v) => ({
            name: `${paramParent}/${id}/versions/${v.id}`,
            payload: { data: v.data },
            disabled: v.disabled,
          })),
        });
      }
      // create version
      if (tail.length === 1 && method === "POST") {
        const vid = q.get("parameter_version_id")!;
        param.versions.push({
          id: vid,
          data: (body as { payload: { data: string } }).payload.data,
        });
        return json(200, { name: `${paramParent}/${id}/versions/${vid}` });
      }
      const vpart = tail[1] ?? "";
      const render = vpart.endsWith(":render");
      const vid = render ? vpart.slice(0, -":render".length) : vpart;
      const version = param.versions.find((v) => v.id === vid);
      if (!version) throw new HttpError(404);
      if (method === "DELETE") {
        param.versions = param.versions.filter((v) => v.id !== vid);
        return json(200, {});
      }
      if (render && method === "GET") {
        const decoded = Buffer.from(version.data, "base64").toString("utf8");
        const rendered = renderRefs(decoded, id);
        return json(200, {
          renderedPayload: Buffer.from(rendered, "utf8").toString("base64"),
        });
      }
      if (method === "GET") {
        return json(200, {
          name: `${paramParent}/${id}/versions/${vid}`,
          payload: { data: version.data },
        });
      }
    }
    return json(404, { error: { code: 404 } });
  }

  /**
   * Dereference every `__REF__`, AS THE PARAMETER.
   *
   * The IAM check is the point of this function, not decoration. Parameter
   * Manager resolves a reference under the parameter's own principal, so a
   * reference whose target has not granted that principal `secretAccessor`
   * fails — `400 SECRET_REFERENCE_ERROR` — no matter what the caller holds.
   * Modelling that is what lets a test prove `create()` makes the grant: delete
   * the binding and `resolve()` stops working, which is precisely the production
   * failure.
   */
  function renderRefs(payload: string, parameterId: string): string {
    const principal = principalFor(parameterId);
    const env = JSON.parse(payload) as Record<string, unknown>;
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== "string") continue;
      const m = REF_RE.exec(v);
      if (!m) continue;
      const secretId = m[2]!;
      const versions = secrets.get(secretId);
      if (!versions || versions.length === 0) throw new HttpError(404);
      const granted = (secretPolicies.get(secretId) ?? []).some(
        (b) => b.role === SECRET_ACCESSOR_ROLE && b.members.includes(principal),
      );
      if (!granted) throw new HttpError(400);
      env[k] = versions[versions.length - 1]!;
    }
    return JSON.stringify(env);
  }

  function handleSm(path: string, method: string, body: unknown): Response {
    const secretsParent = `projects/${PROJECT}/secrets`;
    const [pathOnly, query] = splitQuery(path);
    const q = new URLSearchParams(query);

    if (pathOnly === secretsParent && method === "POST") {
      const id = q.get("secretId")!;
      if (secrets.has(id)) throw new HttpError(409);
      secrets.set(id, []);
      secretPolicies.set(id, []);
      return json(200, { name: `${secretsParent}/${id}` });
    }
    const rest = pathOnly.startsWith(`${secretsParent}/`)
      ? pathOnly.slice(`${secretsParent}/`.length)
      : null;
    if (rest === null) return json(404, { error: { code: 404 } });

    // {id}:getIamPolicy / {id}:setIamPolicy — the binding that makes a `__REF__`
    // resolvable. Read-modify-write, so the etag is echoed back.
    if (rest.endsWith(":getIamPolicy") && method === "GET") {
      const id = rest.slice(0, -":getIamPolicy".length);
      if (!secrets.has(id)) throw new HttpError(404);
      return json(200, {
        bindings: secretPolicies.get(id) ?? [],
        etag: "BwXhAAAA",
        version: 1,
      });
    }
    if (rest.endsWith(":setIamPolicy") && method === "POST") {
      const id = rest.slice(0, -":setIamPolicy".length);
      if (!secrets.has(id)) throw new HttpError(404);
      const policy = (body as { policy?: { bindings?: FakeBinding[] } }).policy;
      secretPolicies.set(
        id,
        (policy?.bindings ?? []).map((b) => ({
          role: b.role,
          members: [...(b.members ?? [])],
        })),
      );
      return json(200, { bindings: secretPolicies.get(id), etag: "BwXhAAAB" });
    }

    // {id}:addVersion
    if (rest.endsWith(":addVersion") && method === "POST") {
      const id = rest.slice(0, -":addVersion".length);
      const versions = secrets.get(id);
      if (!versions) throw new HttpError(404);
      versions.push(
        Buffer.from(
          (body as { payload: { data: string } }).payload.data,
          "base64",
        ).toString("utf8"),
      );
      return json(200, {});
    }
    const [id = "", ...tail] = rest.split("/");
    if (tail.length === 0 && method === "DELETE") {
      if (!secrets.has(id)) throw new HttpError(404);
      secrets.delete(id);
      // An IAM policy does not outlive its resource.
      secretPolicies.delete(id);
      return json(200, {});
    }
    // versions/latest:access
    if (
      tail[0] === "versions" &&
      (tail[1] ?? "").endsWith(":access") &&
      method === "GET"
    ) {
      const versions = secrets.get(id);
      if (!versions || versions.length === 0) throw new HttpError(404);
      return json(200, {
        payload: {
          data: Buffer.from(versions[versions.length - 1]!, "utf8").toString(
            "base64",
          ),
        },
      });
    }
    return json(404, { error: { code: 404 } });
  }

  const store = createGcpParameterStore({
    projectId: PROJECT,
    location: LOCATION,
    account: ACCOUNT,
    pmApiBase: PM_BASE,
    smApiBase: SM_BASE,
    tokenUrl: TOKEN_URL,
    fetchImpl,
  });

  return {
    store,
    fetchImpl,
    endpoints: {
      projectId: PROJECT,
      location: LOCATION,
      pmApiBase: PM_BASE,
      smApiBase: SM_BASE,
      tokenUrl: TOKEN_URL,
      keyJson: JSON.stringify(ACCOUNT),
    },
    parameters,
    secrets,
    secretPolicies,
    principalOf: principalFor,
    pmPayloads: () =>
      [...parameters.values()].flatMap((p) =>
        p.versions.map((v) => Buffer.from(v.data, "base64").toString("utf8")),
      ),
  };
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(String(status));
  }
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  204: "No Content",
  // What `:render` answers when a reference cannot be dereferenced — Google's
  // `SECRET_REFERENCE_ERROR`. It is a 400, not a 403: the CALLER was permitted,
  // the parameter was not.
  400: "Bad Request",
  404: "Not Found",
  409: "Conflict",
};

function splitQuery(path: string): [string, string] {
  const i = path.indexOf("?");
  return i === -1 ? [path, ""] : [path.slice(0, i), path.slice(i + 1)];
}
