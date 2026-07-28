import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriteClient } from "../build/write-client.js";
import { parameterId } from "../build/parameter-manager.js";
// A REAL RSA key: the client signs a JWT before any fetch, so a placeholder
// string fails in node:crypto long before the stub is reached.
import { VIEWER_ACCOUNT } from "./fake-parameter-manager.mjs";

/**
 * The WRITE half, against a fake that actually accepts writes.
 *
 * The shared fake-parameter-manager is GET-only, which is why none of this was
 * covered — and three real bugs lived here as a result: a version id whose
 * numeric suffix read as 0, "current version" taken as list order, and an id
 * collision that let a write land outside the managed namespace. Each has a test
 * below, because each was invisible until something exercised a mutation.
 */

const PROJECT = "test-project";
const ACCOUNT = VIEWER_ACCOUNT;

/**
 * A Parameter Manager + Secret Manager stub that records what it is told.
 *
 * Version listing deliberately returns LEXICOGRAPHIC order, the way Parameter
 * Manager does, so `v9` comes after `v12`. A client that treats the last element
 * as current fails here, which is the point.
 */
function stubStore() {
  const params = new Map(); // id -> { labels, versions: Map<vid, envelopeJson> }
  const secrets = new Map(); // id -> [values]

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";

    if (u.hostname === "oauth2.test") return json({ access_token: "at", expires_in: 3600 });

    const path = u.pathname;
    const pmRoot = `/v1/projects/${PROJECT}/locations/global/parameters`;
    const smRoot = `/v1/projects/${PROJECT}/secrets`;

    // --- Secret Manager -----------------------------------------------------
    if (path === `${smRoot}` && method === "POST") {
      const id = u.searchParams.get("secretId");
      if (secrets.has(id)) return json({ error: "exists" }, 409);
      secrets.set(id, []);
      return json({});
    }
    let m = /^\/v1\/projects\/[^/]+\/secrets\/([^/:]+):addVersion$/.exec(path);
    if (m && method === "POST") {
      const body = JSON.parse(init.body);
      secrets.get(m[1]).push(Buffer.from(body.payload.data, "base64").toString("utf8"));
      return json({});
    }
    m = /^\/v1\/projects\/[^/]+\/secrets\/([^/]+)$/.exec(path);
    if (m && method === "DELETE") { secrets.delete(m[1]); return json({}); }

    // --- Parameter Manager --------------------------------------------------
    if (path === pmRoot && method === "POST") {
      const id = u.searchParams.get("parameter_id");
      if (params.has(id)) return json({ error: "exists" }, 409);
      params.set(id, { versions: new Map() });
      return json({});
    }
    m = new RegExp(`^${pmRoot}/([^/]+)/versions$`).exec(path);
    if (m && method === "POST") {
      const vid = u.searchParams.get("parameter_version_id");
      const body = JSON.parse(init.body);
      params.get(m[1]).versions.set(vid, Buffer.from(body.payload.data, "base64").toString("utf8"));
      return json({});
    }
    if (m && method === "GET") {
      const p = params.get(m[1]);
      if (!p) return json({ error: "no" }, 404);
      // Lexicographic, like the real API.
      const names = [...p.versions.keys()].sort().map((vid) => ({
        name: `projects/${PROJECT}/locations/global/parameters/${m[1]}/versions/${vid}`,
      }));
      return json({ parameterVersions: names });
    }
    // `:render` derefs a `__REF__` the way Parameter Manager does.
    m = new RegExp(`^${pmRoot}/([^/]+)/versions/([^/:]+):render$`).exec(path);
    if (m && method === "GET") {
      const payload = params.get(m[1])?.versions.get(m[2]);
      if (payload == null) return json({ error: "no" }, 404);
      const envelope = JSON.parse(payload);
      if (envelope.secret) {
        const versions = secrets.get(m[1]) ?? [];
        envelope.value = versions[versions.length - 1] ?? "";
      }
      return json({
        renderedPayload: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
      });
    }
    m = new RegExp(`^${pmRoot}/([^/]+)/versions/([^/:]+)$`).exec(path);
    if (m && method === "GET") {
      const payload = params.get(m[1])?.versions.get(m[2]);
      if (payload == null) return json({ error: "no" }, 404);
      return json({ payload: { data: Buffer.from(payload, "utf8").toString("base64") } });
    }
    m = new RegExp(`^${pmRoot}/([^/]+)$`).exec(path);
    if (m && method === "DELETE") { params.delete(m[1]); return json({}); }
    if (m && method === "GET") {
      return params.has(m[1]) ? json({}) : json({ error: "no" }, 404);
    }

    return json({ error: `unhandled ${method} ${path}` }, 500);
  };

  const client = createWriteClient({
    projectId: PROJECT,
    account: ACCOUNT,
    apiBase: "https://pm.test",
    smApiBase: "https://sm.test",
    tokenUrl: "https://oauth2.test/token",
    fetchImpl,
  });
  return { client, params, secrets };
}

const NS = "/strad/test/mcp/";
const PATH = `${NS}demo/static/TOKEN`;

test("versions are numbered v1, v2, v3 — the ranking every reader uses", async () => {
  const { client, params } = stubStore();
  await client.create({ path: PATH, secret: false, value: "one" });
  await client.rotate(PATH, "two");
  await client.rotate(PATH, "three");

  const vids = [...params.get(parameterId(PATH)).versions.keys()];
  assert.deepEqual(vids, ["v1", "v2", "v3"]);
  // Every id must end in a NUMBER: the readers rank on /(\d+)$/ and anything
  // else ranks as 0, sorting the newest version below the oldest.
  for (const vid of vids) assert.match(vid, /^v\d+$/);
});

test("the current version is the greatest, not the last one listed", async () => {
  const { client } = stubStore();
  await client.create({ path: PATH, secret: false, value: "v1-value" });
  // Ten more, so lexicographic order (v1, v10, v11, v2, …) disagrees with numeric.
  for (let i = 2; i <= 12; i++) await client.rotate(PATH, `v${i}-value`);

  // setNote carries the CURRENT value forward. If "current" were the last listed
  // (v9, lexicographically), this would silently revert the value.
  await client.setNote(PATH, "a note");
  assert.equal(await client.readValue(PATH), "v12-value");
});

test("a write cannot escape the namespace through an id collision", async () => {
  const { client } = stubStore();
  // These two distinct paths fold to ONE parameter id.
  const inside = `${NS}evil/static/X`;
  const outside = "/strad/test/mcp-evil/static/X";
  assert.equal(parameterId(inside), parameterId(outside));

  await client.create({ path: outside, secret: false, value: "outside-value" });

  // The id resolves, but the envelope says it is a different parameter.
  await assert.rejects(() => client.readValue(inside), /does not exist/);
  await assert.rejects(() => client.rotate(inside, "x"), /does not exist/);
  await assert.rejects(() => client.setNote(inside, "x"), /does not exist/);
  await assert.rejects(() => client.destroy(inside), /does not exist/);
});

test("a secret create writes the value to Secret Manager and a ref to the envelope", async () => {
  const { client, params, secrets } = stubStore();
  const path = `${NS}demo/static/SECRET_TOKEN`;
  await client.create({ path, secret: true, value: "s3cr3t" });

  const id = parameterId(path);
  assert.deepEqual(secrets.get(id), ["s3cr3t"]);
  const envelope = JSON.parse(params.get(id).versions.get("v1"));
  assert.equal(envelope.secret, true);
  assert.match(envelope.value, /^__REF__\("\/\/secretmanager\.googleapis\.com\//);
  assert.ok(!JSON.stringify(envelope).includes("s3cr3t"));
});

test("a 409 on the parameter create does not delete the parameter that already exists", async () => {
  const { client, params } = stubStore();
  await client.create({ path: PATH, secret: false, value: "original" });
  await assert.rejects(() => client.create({ path: PATH, secret: false, value: "second" }));
  // The original survives — the rollback must not destroy someone else's resource.
  assert.ok(params.has(parameterId(PATH)));
  assert.equal(await client.readValue(PATH), "original");
});
