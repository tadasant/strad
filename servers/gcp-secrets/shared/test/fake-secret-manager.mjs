import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";

/**
 * A fake Google Cloud Secret Manager, good enough to prove the thing that
 * matters.
 *
 * It is not a mock of our client — it is a stand-in for GOOGLE, speaking the
 * REST API over a real socket, and crucially it enforces IAM the way Google
 * does: a caller presenting the VIEWER credential gets 403 PERMISSION_DENIED on
 * `:access`, exactly as a service account without `secretmanager.versions.access`
 * would. So a test can ask "what happens if this server tries to read a value?"
 * and get the real answer (it cannot) rather than a stubbed one.
 *
 * The token endpoint is faked too, so no network and no real key are needed —
 * but the JWT is really signed with a really generated RSA key, so the client's
 * signing path is exercised rather than bypassed.
 */

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" });

/** A viewer service account: the identity the MCP container runs as. */
export const VIEWER_ACCOUNT = {
  client_email: "strad-secrets-viewer@example.iam.gserviceaccount.com",
  private_key: PRIVATE_KEY_PEM,
};

/** An admin service account: the identity the SSO-gated console runs as. */
export const ADMIN_ACCOUNT = {
  client_email: "strad-secrets-admin@example.iam.gserviceaccount.com",
  private_key: PRIVATE_KEY_PEM,
};

const VIEWER_TOKEN = "tok-viewer";
const ADMIN_TOKEN = "tok-admin";

/**
 * Start the fake. `secrets` is a Map<id, {annotations, labels, createTime,
 * versions: string[]}>.
 */
export async function startFakeSecretManager({ projectId = "test-project", secrets = new Map() } = {}) {
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
      req.on("end", () => {
        const assertion = new URLSearchParams(body).get("assertion") ?? "";
        const claims = JSON.parse(
          Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString("utf8"),
        );
        const token = claims.iss === ADMIN_ACCOUNT.client_email ? ADMIN_TOKEN : VIEWER_TOKEN;
        send(200, { access_token: token, expires_in: 3600 });
      });
      return;
    }

    const prefix = `/v1/projects/${projectId}/secrets`;
    if (!url.pathname.startsWith(prefix)) return send(404, { error: { code: 404 } });

    const rest = url.pathname.slice(prefix.length); // "" | "/<id>" | "/<id>/versions/latest" | "/<id>:addVersion"
    const isAdmin = auth === ADMIN_TOKEN;

    const readBody = (cb) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => cb(body ? JSON.parse(body) : {}));
    };

    const meta = (id, s) => ({
      name: `projects/${projectId}/secrets/${id}`,
      annotations: s.annotations ?? {},
      labels: s.labels ?? {},
      createTime: s.createTime ?? "2026-01-01T00:00:00Z",
    });

    // --- list -----------------------------------------------------------------
    if (rest === "" && req.method === "GET") {
      return send(200, {
        secrets: [...secrets.entries()].map(([id, s]) => meta(id, s)),
      });
    }

    // --- create (admin only) --------------------------------------------------
    if (rest === "" && req.method === "POST") {
      if (!isAdmin) return denied("secretmanager.secrets.create");
      const id = url.searchParams.get("secretId");
      return readBody((body) => {
        secrets.set(id, {
          annotations: body.annotations ?? {},
          labels: body.labels ?? {},
          createTime: "2026-07-12T00:00:00Z",
          versions: [],
        });
        send(200, meta(id, secrets.get(id)));
      });
    }

    // --- :addVersion (admin only) --------------------------------------------
    const addVersion = rest.match(/^\/([^/:]+):addVersion$/);
    if (addVersion && req.method === "POST") {
      if (!isAdmin) return denied("secretmanager.versions.add");
      const s = secrets.get(decodeURIComponent(addVersion[1]));
      if (!s) return send(404, { error: { code: 404 } });
      return readBody((body) => {
        s.versions.push(Buffer.from(body.payload.data, "base64").toString("utf8"));
        send(200, { name: `${meta(addVersion[1], s).name}/versions/${s.versions.length}` });
      });
    }

    // --- versions/latest:access — THE value endpoint. VIEWER IS DENIED. -------
    const access = rest.match(/^\/([^/]+)\/versions\/([^/:]+):access$/);
    if (access && req.method === "GET") {
      // This is the whole point of the fake. roles/secretmanager.viewer does not
      // include secretmanager.versions.access, so Google answers 403 — and so
      // does this. The MCP server has no code path here at all; the test that
      // reaches for it does so ON PURPOSE, to show what would happen if it did.
      if (!isAdmin) return denied("secretmanager.versions.access");
      const s = secrets.get(decodeURIComponent(access[1]));
      const value = s?.versions.at(-1);
      if (value === undefined) return send(404, { error: { code: 404 } });
      return send(200, {
        payload: { data: Buffer.from(value, "utf8").toString("base64") },
      });
    }

    // --- versions/latest (metadata) — viewer CAN do this ----------------------
    const version = rest.match(/^\/([^/]+)\/versions\/([^/:]+)$/);
    if (version && req.method === "GET") {
      const s = secrets.get(decodeURIComponent(version[1]));
      if (!s || s.versions.length === 0) return send(404, { error: { code: 404 } });
      return send(200, {
        name: `projects/${projectId}/secrets/${version[1]}/versions/${s.versions.length}`,
        state: "ENABLED",
        createTime: "2026-07-12T00:00:00Z",
      });
    }

    // --- PATCH annotations (admin only) --------------------------------------
    const one = rest.match(/^\/([^/:]+)$/);
    if (one && req.method === "PATCH") {
      if (!isAdmin) return denied("secretmanager.secrets.update");
      const s = secrets.get(decodeURIComponent(one[1]));
      if (!s) return send(404, { error: { code: 404 } });
      return readBody((body) => {
        s.annotations = body.annotations ?? {};
        send(200, meta(one[1], s));
      });
    }

    // --- DELETE (admin only) --------------------------------------------------
    if (one && req.method === "DELETE") {
      if (!isAdmin) return denied("secretmanager.secrets.delete");
      secrets.delete(decodeURIComponent(one[1]));
      return send(200, {});
    }

    // --- GET one --------------------------------------------------------------
    if (one && req.method === "GET") {
      const s = secrets.get(decodeURIComponent(one[1]));
      if (!s) return send(404, { error: { code: 404 } });
      return send(200, meta(one[1], s));
    }

    send(404, { error: { code: 404 } });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    projectId,
    secrets,
    apiBase: `http://127.0.0.1:${port}`,
    tokenUrl: `http://127.0.0.1:${port}/token`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
