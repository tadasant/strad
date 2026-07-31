import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriteClient } from "../build/write-client.js";
import {
  encodeSecretValue,
  isRenderSafe,
  parameterId,
} from "../build/parameter-manager.js";
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

/** The principal `:render` derefs as — the PARAMETER's, not the caller's. */
function principalFor(id) {
  return `principal://parametermanager.googleapis.com/projects/100000000001/uid/locations/global/parameters/${id}`;
}

const SECRET_ACCESSOR_ROLE = "roles/secretmanager.secretAccessor";

/**
 * The ref token AS IT APPEARS IN THE RAW PAYLOAD TEXT — its quotes JSON-escaped,
 * because the envelope is a JSON object and the token sits inside a string.
 * Matching the text rather than a parsed field is what makes the stub's
 * substitution textual, which is what makes it able to fail the way Google does.
 */
const RAW_REF_RE =
  /__REF__\(\\?"\/\/secretmanager\.googleapis\.com\/projects\/[^/]+\/secrets\/[^/"\\]+\/versions\/[^"\\]+\\?"\)/g;

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
  const secretPolicies = new Map(); // id -> [{ role, members, condition? }]
  const policyWrites = new Map(); // id -> count; the etag is derived from it
  const etagOf = (id) => `etag-${policyWrites.get(id) ?? 0}`;
  let setIamPolicyFails = false;
  // Seeds survive the secret-create that would otherwise reset the policy, so a
  // test can construct "this secret already had a policy" — which create() alone
  // cannot produce, since it makes the secret itself.
  const seeded = new Map();

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
      secretPolicies.set(id, seeded.get(id) ?? []);
      return json({});
    }
    // The IAM policy on a secret — what makes a `__REF__` resolvable at all.
    // Modelled the way IAM behaves, not the way it is convenient: a read that
    // does not ask for version 3 gets a VIEW with conditional bindings omitted,
    // and the etag is enforced on write.
    let m = /^\/v1\/projects\/[^/]+\/secrets\/([^/:]+):getIamPolicy$/.exec(path);
    if (m && method === "GET") {
      if (!secrets.has(m[1])) return json({ error: "no" }, 404);
      const wantsV3 = u.searchParams.get("options.requestedPolicyVersion") === "3";
      const all = secretPolicies.get(m[1]) ?? [];
      return json({
        bindings: wantsV3 ? all : all.filter((b) => !b.condition),
        etag: etagOf(m[1]),
        version: wantsV3 ? 3 : 1,
      });
    }
    m = /^\/v1\/projects\/[^/]+\/secrets\/([^/:]+):setIamPolicy$/.exec(path);
    if (m && method === "POST") {
      if (!secrets.has(m[1])) return json({ error: "no" }, 404);
      if (setIamPolicyFails) return json({ error: { code: 503 } }, 503);
      const policy = JSON.parse(init.body).policy;
      if (policy.etag !== etagOf(m[1])) return json({ error: "etag" }, 409);
      secretPolicies.set(m[1], policy.bindings ?? []);
      policyWrites.set(m[1], (policyWrites.get(m[1]) ?? 0) + 1);
      return json({});
    }
    m = /^\/v1\/projects\/[^/]+\/secrets\/([^/:]+):addVersion$/.exec(path);
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
    // `:render` derefs a `__REF__` the way Parameter Manager does — TEXTUALLY,
    // and with the injection check. Substituting into the parsed object and
    // re-stringifying (which is what this stub used to do) re-escapes the secret
    // perfectly and so can never fail, which is exactly how a value that cannot
    // render in production passed here. See `isRenderSafe`.
    m = new RegExp(`^${pmRoot}/([^/]+)/versions/([^/:]+):render$`).exec(path);
    if (m && method === "GET") {
      const payload = params.get(m[1])?.versions.get(m[2]);
      if (payload == null) return json({ error: "no" }, 404);
      let rendered = payload;
      if (JSON.parse(payload).secret) {
        // The deref runs as the PARAMETER. Without its binding on the secret,
        // Google answers 400 SECRET_REFERENCE_ERROR — so the stub does too, and
        // a client that skips the grant fails here instead of silently passing.
        const granted = (secretPolicies.get(m[1]) ?? []).some(
          (b) =>
            b.role === SECRET_ACCESSOR_ROLE &&
            !b.condition &&
            b.members.includes(principalFor(m[1])),
        );
        if (!granted) return json({ error: "SECRET_REFERENCE_ERROR" }, 400);
        const versions = secrets.get(m[1]) ?? [];
        const value = versions[versions.length - 1] ?? "";
        if (!isRenderSafe(value)) {
          return json({ error: "INVALID_ARGUMENT: injection detected" }, 400);
        }
        // A FUNCTION replacement: a string one would interpret `$&`, `$1` and
        // friends inside the secret, quietly mangling any value containing `$`.
        rendered = payload.replace(RAW_REF_RE, () => value);
        try {
          JSON.parse(rendered);
        } catch {
          return json({ error: "INVALID_ARGUMENT: injection detected" }, 400);
        }
      }
      return json({
        renderedPayload: Buffer.from(rendered, "utf8").toString("base64"),
      });
    }
    m = new RegExp(`^${pmRoot}/([^/]+)/versions/([^/:]+)$`).exec(path);
    if (m && method === "GET") {
      const payload = params.get(m[1])?.versions.get(m[2]);
      if (payload == null) return json({ error: "no" }, 404);
      return json({ payload: { data: Buffer.from(payload, "utf8").toString("base64") } });
    }
    if (m && method === "DELETE") {
      const p = params.get(m[1]);
      if (!p?.versions.has(m[2])) return json({ error: "no" }, 404);
      p.versions.delete(m[2]);
      return json({});
    }
    m = new RegExp(`^${pmRoot}/([^/]+)$`).exec(path);
    if (m && method === "DELETE") {
      const p = params.get(m[1]);
      if (!p) return json({ error: "no" }, 404);
      // Google refuses to delete a parameter that still has versions, so the
      // stub does too. A client that skips its version deletes fails here rather
      // than only against the real store.
      if (p.versions.size > 0) return json({ error: "has versions" }, 400);
      params.delete(m[1]);
      return json({});
    }
    if (m && method === "GET") {
      return params.has(m[1])
        ? json({ policyMember: { iamPolicyUidPrincipal: principalFor(m[1]) } })
        : json({ error: "no" }, 404);
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
  return {
    client,
    params,
    secrets,
    secretPolicies,
    fetchImpl,
    /**
     * A second client over the SAME store state whose Secret Manager
     * `:addVersion` always 503s. The only way to observe the ordering inside
     * `rotate`: both orderings reach the same end state when both writes land.
     */
    clientWithFailingSecretWrites: () =>
      createWriteClient({
        projectId: PROJECT,
        account: ACCOUNT,
        pmApiBase: "https://pm.test",
        smApiBase: "https://sm.test",
        tokenUrl: "https://oauth2.test/token",
        fetchImpl: (url, init) =>
          String(url).includes(":addVersion") &&
          String(url).includes("/secrets/")
            ? Promise.resolve(json({ error: "unavailable" }, 503))
            : fetchImpl(url, init),
      }),
    failSetIamPolicy: () => {
      setIamPolicyFails = true;
    },
    seedPolicy: (id, bindings) => seeded.set(id, bindings),
  };
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
  // base64url in Secret Manager, and the envelope says so. The encoding is what
  // lets `:render` splice the value into a JSON payload without breaking it.
  assert.deepEqual(secrets.get(id), [encodeSecretValue("s3cr3t")]);
  const envelope = JSON.parse(params.get(id).versions.get("v1"));
  assert.equal(envelope.secret, true);
  assert.equal(envelope.encoding, "base64url");
  assert.match(envelope.value, /^__REF__\("\/\/secretmanager\.googleapis\.com\//);
  assert.ok(!JSON.stringify(envelope).includes("s3cr3t"));
  // Encoding a value must not become a way of smuggling it into the store the
  // VIEWER can read.
  assert.ok(!JSON.stringify(envelope).includes(encodeSecretValue("s3cr3t")));
});

/**
 * The three value shapes the supplementary names actually take, plus the control.
 *
 * `:render` splices a secret's raw bytes into the JSON payload TEXT and rejects
 * the result if it looks structurally damaged, so a quote, a brace, a backslash
 * or a newline is a `400 INVALID_ARGUMENT … injection detected`. This tree writes
 * to the SAME store the gateway's resolver reads, so a fix only in `src/` would
 * leave exactly half the defect standing.
 */
const STRUCTURAL_VALUES = {
  "a quote-bearing JSON array": JSON.stringify([
    { pubid: "7f3a91c2", label: 'ci "deploy" probe', roles: ["admin"] },
  ]),
  "a multi-line PEM": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\n",
  "a service-account JSON blob": JSON.stringify({
    type: "service_account",
    private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  }),
  "a value with a lone backslash": "domain\\user",
};

for (const [name, value] of Object.entries(STRUCTURAL_VALUES)) {
  test(`create then readValue round-trips ${name}`, async () => {
    const { client } = stubStore();
    const path = `${NS}demo/static/SECRET_TOKEN`;
    await client.create({ path, secret: true, value });
    assert.equal(await client.readValue(path), value);
  });

  test(`rotate to ${name} round-trips, including from a legacy envelope`, async () => {
    const { client, params, secrets } = stubStore();
    const path = `${NS}demo/static/SECRET_TOKEN`;
    await client.create({ path, secret: true, value: "plain-token" });

    // Rewrite v1 the way the PRE-FIX writer left it: raw bytes in Secret
    // Manager, no `encoding` in the envelope. This is the on-store state of the
    // names seeded before this change.
    const id = parameterId(path);
    const legacy = JSON.parse(params.get(id).versions.get("v1"));
    delete legacy.encoding;
    params.get(id).versions.set("v1", JSON.stringify(legacy));
    secrets.set(id, ["plain-token"]);
    assert.equal(await client.readValue(path), "plain-token");

    await client.rotate(path, value);
    assert.equal(await client.readValue(path), value);
  });
}

test("the stub refuses a raw structural value, the way Parameter Manager does", async () => {
  // Constraint 1, in this tree: the double must reject what Google rejects.
  // Before this change the stub substituted into the PARSED envelope and
  // re-stringified, which re-escapes any value and so could never fail.
  const { client, params, secrets } = stubStore();
  const path = `${NS}demo/static/SECRET_TOKEN`;
  await client.create({ path, secret: true, value: "plain-token" });

  const id = parameterId(path);
  const legacy = JSON.parse(params.get(id).versions.get("v1"));
  delete legacy.encoding;
  params.get(id).versions.set("v1", JSON.stringify(legacy));
  secrets.set(id, [STRUCTURAL_VALUES["a quote-bearing JSON array"]]);

  await assert.rejects(() => client.readValue(path), /400/);
});

test("setNote rewrites the envelope without dropping the encoding", async () => {
  // The one write that touches a secret parameter's envelope without touching
  // its bytes. Dropping `encoding` here would leave the pointer valid, the
  // secret intact, and every subsequent read decoding base64url as a literal.
  const { client, params } = stubStore();
  const path = `${NS}demo/static/SECRET_TOKEN`;
  const value = STRUCTURAL_VALUES["a service-account JSON blob"];
  await client.create({ path, secret: true, value });

  await client.setNote(path, "rotate quarterly");

  const envelope = JSON.parse(params.get(parameterId(path)).versions.get("v2"));
  assert.equal(envelope.note, "rotate quarterly");
  assert.equal(envelope.encoding, "base64url");
  assert.equal(await client.readValue(path), value);
});

test("a rotate whose Secret Manager write fails rolls the envelope back", async () => {
  // The upgrade writes the envelope first and the bytes second, so a failure
  // between them is the one state that can strand a parameter declaring an
  // encoding its bytes do not have. Nothing about the END state distinguishes
  // the two orderings — only a failure injected in the middle pins the choice.
  const { client, params, secrets, clientWithFailingSecretWrites } = stubStore();
  const path = `${NS}demo/static/SECRET_TOKEN`;
  await client.create({ path, secret: true, value: "plain-token" });

  // Back to the pre-fix on-store shape: raw bytes, no `encoding`.
  const id = parameterId(path);
  const legacy = JSON.parse(params.get(id).versions.get("v1"));
  delete legacy.encoding;
  params.get(id).versions.set("v1", JSON.stringify(legacy));
  secrets.set(id, ["plain-token"]);

  await assert.rejects(
    () =>
      clientWithFailingSecretWrites().rotate(
        path,
        STRUCTURAL_VALUES["a multi-line PEM"],
      ),
    /503/,
  );

  // The envelope is back where it started, so the OLD value still reads.
  const latest = [...params.get(id).versions.keys()].sort().pop();
  assert.equal(JSON.parse(params.get(id).versions.get(latest)).encoding, undefined);
  assert.equal(await client.readValue(path), "plain-token");
});

test("readValue hands back an unrendered pointer untouched", async () => {
  // `:render` returns the pointer rather than failing when the parameter's own
  // principal cannot reach the secret. Decoding it would turn a diagnosable
  // state into mojibake, so `isSecretRef` short-circuits before the decode.
  const { client, params } = stubStore();
  const path = `${NS}demo/static/SECRET_TOKEN`;
  await client.create({ path, secret: true, value: "s3cr3t" });

  // Flip the envelope to non-secret so the stub's `:render` leaves the pointer
  // in place — exactly the shape a caller sees when the deref does not happen.
  const id = parameterId(path);
  const envelope = JSON.parse(params.get(id).versions.get("v1"));
  const ref = envelope.value;
  params.get(id).versions.set("v1", JSON.stringify({ ...envelope, secret: false }));

  assert.equal(await client.readValue(path), ref);
});

test("readValue refuses an encoding this build does not know", async () => {
  // Not "treat it as literal", and not "decode it as base64url anyway": either
  // hands a caller bytes that are not the value. This tree has no
  // `decodeEnvelope`, so the refusal lives in `decodeStoredValue`.
  const { client, params } = stubStore();
  const path = `${NS}demo/static/SECRET_TOKEN`;
  await client.create({ path, secret: true, value: "s3cr3t" });

  const id = parameterId(path);
  const envelope = JSON.parse(params.get(id).versions.get("v1"));
  params
    .get(id)
    .versions.set("v1", JSON.stringify({ ...envelope, encoding: "gzip+base64" }));

  await assert.rejects(() => client.readValue(path), /unknown value encoding/);
});

test("a non-secret value stays literal, so the viewer still shows it", async () => {
  const { client, params } = stubStore();
  const path = `${NS}demo/static/PUBLIC_NOTE`;
  await client.create({ path, secret: false, value: '{"not":"a secret"}' });

  const envelope = JSON.parse(params.get(parameterId(path)).versions.get("v1"));
  assert.equal(envelope.value, '{"not":"a secret"}');
  assert.equal(envelope.encoding, undefined);
});

test("a secret create grants the parameter's own principal secretAccessor", async () => {
  // Without this the ref is written, the secret exists, and every read of it
  // fails with 400 SECRET_REFERENCE_ERROR — for the console, the resolver and
  // this server alike. The grant is on the PARAMETER, never on a caller.
  const { client, secretPolicies } = stubStore();
  const path = `${NS}demo/static/SECRET_TOKEN`;
  await client.create({ path, secret: true, value: "s3cr3t" });

  const id = parameterId(path);
  assert.deepEqual(secretPolicies.get(id), [
    { role: SECRET_ACCESSOR_ROLE, members: [principalFor(id)] },
  ]);
  // And it is the grant, not the create, that the read depends on: this is the
  // same client reading back through `:render`.
  assert.equal(await client.readValue(path), "s3cr3t");

  secretPolicies.set(id, []);
  await assert.rejects(() => client.readValue(path), /400/);
});

test("a non-secret create touches no IAM policy", async () => {
  const { client, secretPolicies } = stubStore();
  await client.create({ path: `${NS}demo/static/PLAIN`, secret: false, value: "v" });
  assert.equal(secretPolicies.size, 0);
});

test("a failed IAM grant rolls back both stores and writes no version", async () => {
  // Mirrors the src/ rollback test. A grant that does not land leaves a
  // parameter whose `__REF__` can never render, so it must roll back rather than
  // report success for a secret nothing can read.
  const { client, params, secrets, failSetIamPolicy } = stubStore();
  failSetIamPolicy();
  const path = `${NS}demo/static/SECRET_TOKEN`;

  await assert.rejects(
    () => client.create({ path, secret: true, value: "s3cr3t" }),
    /503/,
  );

  const id = parameterId(path);
  assert.equal(params.has(id), false, "the parameter was rolled back");
  assert.equal(secrets.has(id), false, "the secret was rolled back");
});

test("a conditional binding is preserved, not joined and not dropped", async () => {
  // Reading without options.requestedPolicyVersion=3 hides conditional bindings
  // and writing that view back DELETES them; matching the role without checking
  // `condition` appends the principal to a binding that only applies while the
  // condition holds. Both are silent, and both break rendering.
  const { client, secretPolicies, seedPolicy } = stubStore();
  const path = `${NS}demo/static/SECRET_TOKEN`;
  const conditional = {
    role: SECRET_ACCESSOR_ROLE,
    members: ["user:a@b.c"],
    condition: { title: "expires", expression: "request.time < timestamp(0)" },
  };
  seedPolicy(parameterId(path), [conditional]);

  await client.create({ path, secret: true, value: "s3cr3t" });

  assert.deepEqual(secretPolicies.get(parameterId(path)), [
    conditional,
    { role: SECRET_ACCESSOR_ROLE, members: [principalFor(parameterId(path))] },
  ]);
  assert.equal(await client.readValue(path), "s3cr3t");
});

test("a 409 on the parameter create does not delete the parameter that already exists", async () => {
  const { client, params } = stubStore();
  await client.create({ path: PATH, secret: false, value: "original" });
  await assert.rejects(() => client.create({ path: PATH, secret: false, value: "second" }));
  // The original survives — the rollback must not destroy someone else's resource.
  assert.ok(params.has(parameterId(PATH)));
  assert.equal(await client.readValue(PATH), "original");
});

/**
 * DELETE, which this tree could not do.
 *
 * Parameter Manager refuses to delete a parameter that still has versions, and
 * `create` writes v1 — so a client that deletes the parameter directly gets a
 * `400 Bad Request` for every parameter that has ever held a value. The stub
 * refuses the same way, so this pair fails against a client that skips its
 * version deletes.
 */
test("destroy deletes a parameter's versions before the parameter itself", async () => {
  const { client, params } = stubStore();
  await client.create({ path: PATH, secret: false, value: "one" });
  await client.rotate(PATH, "two");
  assert.equal(params.get(parameterId(PATH)).versions.size, 2);

  await client.destroy(PATH);

  assert.equal(params.has(parameterId(PATH)), false);
});

test("destroy of a secret parameter also drops its Secret Manager secret", async () => {
  const { client, params, secrets } = stubStore();
  const path = `${NS}demo/static/SECRET_TOKEN`;
  await client.create({ path, secret: true, value: "s3cr3t" });

  await client.destroy(path);

  assert.equal(params.has(parameterId(path)), false);
  assert.equal(secrets.has(parameterId(path)), false);
});
