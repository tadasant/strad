import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";

import { parameterId } from "../build/index.js";

/**
 * A fake Google Cloud **Parameter Manager**, good enough to prove the thing that
 * matters.
 *
 * It is a stand-in for GOOGLE, speaking the Parameter Manager REST API over a
 * real socket. It models the two-store split honestly:
 *
 *   - Every managed variable is one Parameter Manager parameter, labelled
 *     `managed-by: strad`. Its latest version's payload is base64 of a JSON
 *     ENVELOPE `{ path, secret, note, value }`.
 *   - For a NON-secret parameter, `value` in the envelope is the literal value —
 *     the viewer may read it.
 *   - For a SECRET parameter, `value` is a Secret Manager REFERENCE
 *     (`__REF__("//secretmanager.googleapis.com/...")`), NOT the bytes. The bytes
 *     live in this fake's `secretManager` map, which NO served endpoint exposes —
 *     because the viewer credential cannot reach Secret Manager at all. So a test
 *     can plant a canary secret value and prove it never crosses the wire: it is
 *     simply not in anything Parameter Manager hands back.
 *
 * The token endpoint is faked too, so no network and no real key are needed — but
 * the JWT is really signed with a really generated RSA key, so the client's
 * signing path is exercised rather than bypassed.
 */

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" });

/** The viewer service account: the identity the MCP container runs as. */
export const VIEWER_ACCOUNT = {
  client_email: "strad-secrets-viewer@example.iam.gserviceaccount.com",
  private_key: PRIVATE_KEY_PEM,
};

const VIEWER_TOKEN = "tok-viewer";

/** Build a Secret Manager reference string for a secret parameter's envelope. */
export function secretRef(projectId, secretId) {
  return `__REF__("//secretmanager.googleapis.com/projects/${projectId}/secrets/${secretId}/versions/latest")`;
}

/**
 * Build one seed parameter keyed by its deterministic parameterId.
 *
 * For a secret parameter, pass the Secret Manager `secretId` (and the bytes go
 * into the fake's Secret Manager, never into the envelope); the envelope carries
 * only the `__REF__`. For a non-secret parameter, pass the literal `value`.
 */
export function makeParameter(
  projectId,
  { path, secret = false, note, value, secretId, createTime },
) {
  const envelope = {
    path,
    secret,
    note,
    value: secret ? secretRef(projectId, secretId) : value,
  };
  return {
    id: parameterId(path),
    entry: {
      labels: { "managed-by": "strad", secret: String(secret) },
      createTime: createTime ?? "2026-03-01T10:00:00Z",
      updateTime: createTime ?? "2026-03-01T10:00:00Z",
      versions: [JSON.stringify(envelope)],
    },
  };
}

/**
 * Start the fake.
 *
 * @param parameters Map<id, { labels, createTime, updateTime, versions: string[] }>
 * @param secretManager Map<secretId, value> — the bytes the viewer can NEVER see.
 */
export async function startFakeParameterManager({
  projectId = "test-project",
  parameters = new Map(),
  secretManager = new Map(),
} = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");

    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const denied = (permission) =>
      send(403, {
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          message: `Permission '${permission}' denied on resource (or it may not exist).`,
        },
      });

    // --- the OAuth2 token endpoint ------------------------------------------
    if (url.pathname === "/token") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () =>
        send(200, { access_token: VIEWER_TOKEN, expires_in: 3600 }),
      );
      return;
    }

    // Any authenticated request needs a bearer. The viewer token is all this
    // server ever mints.
    if (!auth) return denied("parametermanager.parameters.list");

    // The viewer credential cannot reach Secret Manager. If any code path ever
    // tried (it does not), Google would refuse — and so does this fake.
    if (url.pathname.startsWith("/v1/") && url.pathname.includes("/secrets/")) {
      return denied("secretmanager.versions.access");
    }

    const prefix = `/v1/projects/${projectId}/locations/global/parameters`;
    if (!url.pathname.startsWith(prefix)) {
      return send(404, { error: { code: 404 } });
    }

    const rest = url.pathname.slice(prefix.length); // "" | "/<id>" | "/<id>/versions" | "/<id>/versions/v<n>"

    const paramMeta = (id, p) => ({
      name: `projects/${projectId}/locations/global/parameters/${id}`,
      format: "JSON",
      labels: p.labels ?? {},
      createTime: p.createTime ?? "2026-01-01T00:00:00Z",
      updateTime: p.updateTime ?? p.createTime ?? "2026-01-01T00:00:00Z",
    });

    // --- list -----------------------------------------------------------------
    if (rest === "" && req.method === "GET") {
      return send(200, {
        parameters: [...parameters.entries()].map(([id, p]) => paramMeta(id, p)),
      });
    }

    // --- :render — the deref of a secret ref. VIEWER IS DENIED. ---------------
    // The client has no code path here at all; a test may reach for it ON PURPOSE
    // to show what would happen if it did. (Checked before the plain version GET
    // so a `:render` suffix is never mistaken for a version id.)
    const render = rest.match(/^\/([^/]+)\/versions\/([^/:]+):render$/);
    if (render && req.method === "GET") {
      return denied("secretmanager.versions.access");
    }

    // --- versions LIST — viewer CAN do this -----------------------------------
    // Parameter Manager has no `latest` alias; a reader enumerates the versions
    // and picks the greatest enabled one. Versions are `v1..vN` in seed order.
    const versionsList = rest.match(/^\/([^/]+)\/versions$/);
    if (versionsList && req.method === "GET") {
      const p = parameters.get(decodeURIComponent(versionsList[1]));
      if (!p) return send(404, { error: { code: 404 } });
      const list = (p.versions ?? []).map((_, i) => ({
        name: `projects/${projectId}/locations/global/parameters/${versionsList[1]}/versions/v${i + 1}`,
        createTime: p.createTime ?? "2026-03-01T10:00:00Z",
        disabled: (p.disabledVersions ?? []).includes(i + 1),
      }));
      return send(200, { parameterVersions: list });
    }

    // --- explicit version GET (the envelope) — viewer CAN do this -------------
    const version = rest.match(/^\/([^/]+)\/versions\/v(\d+)$/);
    if (version && req.method === "GET") {
      const p = parameters.get(decodeURIComponent(version[1]));
      const n = Number(version[2]);
      if (!p || !p.versions || n < 1 || n > p.versions.length) {
        return send(404, { error: { code: 404 } });
      }
      return send(200, {
        name: `projects/${projectId}/locations/global/parameters/${version[1]}/versions/v${n}`,
        payload: {
          data: Buffer.from(p.versions[n - 1], "utf8").toString("base64"),
        },
        createTime: p.createTime ?? "2026-03-01T10:00:00Z",
        disabled: (p.disabledVersions ?? []).includes(n),
      });
    }

    // --- GET one --------------------------------------------------------------
    const one = rest.match(/^\/([^/:]+)$/);
    if (one && req.method === "GET") {
      const p = parameters.get(decodeURIComponent(one[1]));
      if (!p) return send(404, { error: { code: 404 } });
      return send(200, paramMeta(one[1], p));
    }

    // Everything else — POST/PATCH/DELETE — is a write, which the viewer cannot
    // do. There is no code path to any of these; refuse them like Google would.
    if (req.method !== "GET") {
      return denied("parametermanager.parameters.update");
    }

    send(404, { error: { code: 404 } });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    projectId,
    parameters,
    secretManager,
    apiBase: `http://127.0.0.1:${port}`,
    tokenUrl: `http://127.0.0.1:${port}/token`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
