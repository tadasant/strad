import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createFakeGcp,
  PARAMETER_VIEWER_PERMISSIONS,
} from "../src/secrets/parameters/fake.ts";
import {
  createGcpParameterStore,
  parameterId,
  parameterPath,
  resolveServerParams,
  staticNamespace,
} from "../src/secrets/parameters/index.ts";
import { encodeSecretValue } from "../src/secrets/parameters/wire.ts";

/**
 * The two-store model, exercised end to end against the in-memory GCP fake.
 *
 * The load-bearing assertion is not "create works" — it is that a SECRET value
 * lives in Secret Manager and is NEVER written into a Parameter Manager payload,
 * and that the resolver still recovers it via `:render`. That is the whole point
 * of splitting the stores.
 */

const ENV = "staging";
const SLUG = "remote-filesystem-tmp-public";
const EMAIL_VAR = "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL";
const KEY_VAR = "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY";
const emailPath = parameterPath(ENV, SLUG, EMAIL_VAR);
const keyPath = parameterPath(ENV, SLUG, KEY_VAR);

const EMAIL_VALUE = "svc@proj.iam.gserviceaccount.com";
const KEY_VALUE =
  "-----BEGIN PRIVATE KEY-----\\nSUPER-SECRET-CANARY\\n-----END-----";

describe("gcp parameter store — two-store model", () => {
  it("stores a non-secret parameter's value in Parameter Manager", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({
      path: emailPath,
      secret: false,
      value: EMAIL_VALUE,
    });

    expect(gcp.secrets.size).toBe(0); // nothing in Secret Manager
    expect(gcp.pmPayloads().join("\n")).toContain(EMAIL_VALUE);

    const list = await gcp.store.list(staticNamespace(ENV, SLUG));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      path: emailPath,
      variable: EMAIL_VAR,
      secret: false,
    });
    expect(await gcp.store.reveal(emailPath)).toBe(EMAIL_VALUE);
  });

  it("keeps a secret parameter's value in Secret Manager, not Parameter Manager", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({
      path: keyPath,
      secret: true,
      value: KEY_VALUE,
      note: "rotate quarterly",
    });

    // The value is in Secret Manager — base64url-encoded, which is what makes it
    // survive `:render`'s substitution into a JSON payload. See
    // `test/parameters.encoding.test.ts` for why it is encoded at all; here the
    // load-bearing claim is unchanged, that the bytes are in the OTHER store.
    expect([...gcp.secrets.values()].flat()).toContain(
      encodeSecretValue(KEY_VALUE),
    );
    // ...and NEVER in any Parameter Manager payload — only a __REF__ is.
    const pm = gcp.pmPayloads().join("\n");
    expect(pm).not.toContain("SUPER-SECRET-CANARY");
    expect(pm).toContain("__REF__(");

    const list = await gcp.store.list(staticNamespace(ENV, SLUG));
    expect(list[0]).toMatchObject({ secret: true, note: "rotate quarterly" });

    // The admin reveal (a human, behind SSO) still returns it.
    expect(await gcp.store.reveal(keyPath)).toBe(KEY_VALUE);
  });

  it("resolves a whole namespace into an env map, dereferencing secrets", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({
      path: emailPath,
      secret: false,
      value: EMAIL_VALUE,
    });
    await gcp.store.create({ path: keyPath, secret: true, value: KEY_VALUE });

    const envMap = await resolveServerParams(gcp.store, ENV, SLUG);
    expect(envMap).toEqual({
      [EMAIL_VAR]: EMAIL_VALUE,
      [KEY_VAR]: KEY_VALUE, // the secret, dereferenced by :render
    });
  });

  it("rotates both kinds and keeps the newest value", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({
      path: emailPath,
      secret: false,
      value: EMAIL_VALUE,
    });
    await gcp.store.create({ path: keyPath, secret: true, value: KEY_VALUE });

    await gcp.store.rotate(emailPath, "new@proj.iam.gserviceaccount.com");
    await gcp.store.rotate(keyPath, "ROTATED-SECRET");

    expect(await gcp.store.reveal(emailPath)).toBe(
      "new@proj.iam.gserviceaccount.com",
    );
    expect(await gcp.store.reveal(keyPath)).toBe("ROTATED-SECRET");
    const envMap = await resolveServerParams(gcp.store, ENV, SLUG);
    expect(envMap[KEY_VAR]).toBe("ROTATED-SECRET");
  });

  it("sets a note without disturbing the value", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({ path: keyPath, secret: true, value: KEY_VALUE });
    await gcp.store.setNote(keyPath, "owner: tadas");
    const list = await gcp.store.list(staticNamespace(ENV, SLUG));
    expect(list[0]!.note).toBe("owner: tadas");
    expect(await gcp.store.reveal(keyPath)).toBe(KEY_VALUE);
  });

  it("destroys a secret parameter from both stores", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({ path: keyPath, secret: true, value: KEY_VALUE });
    await gcp.store.destroy(keyPath);
    expect(gcp.parameters.size).toBe(0);
    expect(gcp.secrets.size).toBe(0);
    expect(await gcp.store.list(staticNamespace(ENV, SLUG))).toHaveLength(0);
  });

  it("only lists parameters inside the requested namespace", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({
      path: emailPath,
      secret: false,
      value: EMAIL_VALUE,
    });
    await gcp.store.create({
      path: parameterPath(ENV, "gcs", "GCS_BUCKET"),
      secret: false,
      value: "other-bucket",
    });
    const list = await gcp.store.list(staticNamespace(ENV, SLUG));
    expect(list).toHaveLength(1);
    expect(list[0]!.path).toBe(emailPath);
  });
});

/**
 * The grant that makes a `__REF__` resolvable at all.
 *
 * `:render` derefs a reference as the PARAMETER's own principal, not as the
 * caller, so a secret parameter is born unresolvable: every resource exists and
 * every render fails until the parameter's principal holds `secretAccessor` on
 * the secret. The fake enforces this the way Google does, which is what makes
 * these assertions about behaviour rather than about call shape — the first test
 * below removes the binding and watches `resolve()` break.
 */
describe("secret parameters grant their own principal secretAccessor", () => {
  it("makes the binding during create, and :render depends on it", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({ path: keyPath, secret: true, value: KEY_VALUE });

    const id = parameterId(keyPath);
    expect(gcp.secretPolicies.get(id)).toEqual([
      {
        role: "roles/secretmanager.secretAccessor",
        members: [gcp.principalOf(id)],
      },
    ]);

    // With the binding, the value resolves.
    expect(await resolveServerParams(gcp.store, ENV, SLUG)).toEqual({
      [KEY_VAR]: KEY_VALUE,
    });

    // Take ONLY the binding away — every other resource is untouched — and the
    // resolve that just worked stops working. This is the production failure
    // this whole change exists to prevent, and it is what a regression that
    // dropped the grant from create() would produce.
    gcp.secretPolicies.set(id, []);
    await expect(resolveServerParams(gcp.store, ENV, SLUG)).rejects.toThrow(
      /400/,
    );
  });

  it("grants the PARAMETER's principal, not the caller's service account", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({ path: keyPath, secret: true, value: KEY_VALUE });

    const members = gcp.secretPolicies.get(parameterId(keyPath))![0]!.members;
    // The distinction the defect turned on: granting the resolver/admin identity
    // instead looks equally plausible and resolves nothing.
    expect(members[0]).toMatch(
      /^principal:\/\/parametermanager\.googleapis\.com\/projects\/\d+\/uid\/locations\/global\/parameters\//,
    );
    expect(members.join()).not.toContain("gserviceaccount.com");
  });

  it("makes no binding for a NON-secret parameter", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({
      path: emailPath,
      secret: false,
      value: EMAIL_VALUE,
    });
    // Nothing in Secret Manager to bind, and nothing bound.
    expect(gcp.secretPolicies.size).toBe(0);
    expect(await resolveServerParams(gcp.store, ENV, SLUG)).toEqual({
      [EMAIL_VAR]: EMAIL_VALUE,
    });
  });

  /**
   * Seed a pre-existing policy on the secret the moment it is created, then run
   * the real client's `create()` over it. The interceptor is the only way to
   * construct "the secret already had a policy", because `create()` makes the
   * secret itself.
   */
  const createOverExistingPolicy = async (
    gcp: ReturnType<typeof createFakeGcp>,
    seed: Parameters<typeof gcp.secretPolicies.set>[1],
  ) => {
    const id = parameterId(keyPath);
    const realFetch = gcp.fetchImpl;
    const store = createGcpParameterStore({
      projectId: gcp.endpoints.projectId,
      location: gcp.endpoints.location,
      account: JSON.parse(gcp.endpoints.keyJson) as {
        client_email: string;
        private_key: string;
      },
      pmApiBase: gcp.endpoints.pmApiBase,
      smApiBase: gcp.endpoints.smApiBase,
      tokenUrl: gcp.endpoints.tokenUrl,
      fetchImpl: async (input, init) => {
        const res = await realFetch(input, init);
        if (String(input).includes("/secrets?secretId=")) {
          gcp.secretPolicies.set(id, seed);
        }
        return res;
      },
    });
    await store.create({ path: keyPath, secret: true, value: KEY_VALUE });
  };

  it("preserves a CONDITIONAL binding instead of joining or dropping it", async () => {
    // Two ways to get this wrong, both silent. Reading the policy without
    // `options.requestedPolicyVersion=3` returns a view with conditional
    // bindings OMITTED, and writing that view back DELETES them. Matching the
    // role without checking `condition` appends the parameter's principal to the
    // conditional binding, so the grant only applies while the condition holds —
    // which fails exactly like no grant at all.
    const gcp = createFakeGcp();
    const id = parameterId(keyPath);
    const conditional = {
      role: "roles/secretmanager.secretAccessor",
      members: ["user:a@b.c"],
      condition: {
        title: "expires",
        expression: "request.time < timestamp(0)",
      },
    };

    await createOverExistingPolicy(gcp, [conditional]);

    // The conditional binding survives, untouched — the principal was NOT added
    // to it — and the parameter got its own unconditional one.
    expect(gcp.secretPolicies.get(id)).toEqual([
      conditional,
      {
        role: "roles/secretmanager.secretAccessor",
        members: [gcp.principalOf(id)],
      },
    ]);
    // And it actually resolves, which the conditional binding alone would not do.
    expect(await resolveServerParams(gcp.store, ENV, SLUG)).toEqual({
      [KEY_VAR]: KEY_VALUE,
    });
  });

  it("survives a policy that already carries other bindings", async () => {
    const gcp = createFakeGcp();
    const id = parameterId(keyPath);
    // A read-modify-write, not an overwrite: an unrelated binding must survive,
    // or create() silently revokes whatever else was on the secret.
    const other = {
      role: "roles/secretmanager.viewer",
      members: ["user:a@b.c"],
    };
    const realFetch = gcp.fetchImpl;
    const store = createGcpParameterStore({
      projectId: gcp.endpoints.projectId,
      location: gcp.endpoints.location,
      account: JSON.parse(gcp.endpoints.keyJson) as {
        client_email: string;
        private_key: string;
      },
      pmApiBase: gcp.endpoints.pmApiBase,
      smApiBase: gcp.endpoints.smApiBase,
      tokenUrl: gcp.endpoints.tokenUrl,
      fetchImpl: async (input, init) => {
        // Seed the pre-existing binding the moment the secret exists.
        const res = await realFetch(input, init);
        if (String(input).includes("/secrets?secretId=")) {
          gcp.secretPolicies.set(id, [other]);
        }
        return res;
      },
    });

    await store.create({ path: keyPath, secret: true, value: KEY_VALUE });

    expect(gcp.secretPolicies.get(id)).toEqual([
      other,
      {
        role: "roles/secretmanager.secretAccessor",
        members: [gcp.principalOf(id)],
      },
    ]);
  });
});

/**
 * THE INVARIANT THIS CHANGE PUTS WEIGHT ON.
 *
 * Granting the parameter's principal `secretAccessor` is what makes `:render`
 * able to return a secret value at all — and `:render` is a SECOND read path,
 * independent of `secretmanager.versions.access`. Before that grant existed, two
 * separate things kept the `/mcp` channel away from prod secret values. Now one
 * does: prod's `secrets` MCP credential holds `roles/parametermanager.parameterViewer`
 * (get/list) and NOT `roles/parametermanager.parameterAccessor` (which carries
 * `parameterVersions.render`).
 *
 * That single distinction is now load-bearing, and this repo has misstated the
 * viewer/accessor split in four separate documents. Someone "fixing" the viewer
 * by granting it `parameterAccessor` — entirely plausible reasoning, it does need
 * to read parameters — would silently open the path. These tests are what turns
 * that into a CI failure instead of a quiet capability.
 */
describe("resolveDetailed keeps the failures apart from the values", () => {
  /**
   * `resolve()` is fail-fast because a child process started with half its
   * environment is worse than one that does not start. That is also why it can
   * never say WHICH parameter broke: the first `:render` to throw ends the loop.
   *
   * The console needs the other half of that fact — "rotate this ONE value"
   * versus "the secret backend is down" are the same symptom and opposite
   * responses — which is what `resolveDetailed()` is for.
   */
  it("names the parameter that will not render, and still returns the ones that do", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({
      path: emailPath,
      secret: false,
      value: EMAIL_VALUE,
    });
    await gcp.store.create({ path: keyPath, secret: true, value: KEY_VALUE });

    // Break exactly ONE parameter: take away the secret one's own binding, which
    // is what makes its `:render` fail while everything else in the namespace is
    // untouched. That is the real production shape — one bad value, not an
    // outage — and it is the one `resolve()` cannot describe.
    gcp.secretPolicies.set(parameterId(keyPath), []);
    const detailed = await gcp.store.resolveDetailed!(
      staticNamespace(ENV, SLUG),
    );

    expect(detailed.unrenderable.map((u) => u.variable)).toEqual([KEY_VAR]);
    expect(detailed.unrenderable[0]!.hard).toBe(true);
    expect(detailed.unrenderable[0]!.reason).toContain("400");
    // The 400 is the shape an operator can act on, so it is named rather than
    // passed through as a bare status.
    expect(detailed.unrenderable[0]!.reason).toContain("dereference");
    // The reason describes the failure, never the payload it failed on.
    expect(detailed.unrenderable[0]!.reason).not.toContain(
      "SUPER-SECRET-CANARY",
    );

    // One refusal did not cost the other name its answer — which is the whole
    // difference from `resolve()`.
    expect(detailed.values).toEqual({ [EMAIL_VAR]: EMAIL_VALUE });
  });

  it("leaves resolve() throwing on exactly what it threw on before", async () => {
    // The regression this guards: `resolve()` now goes through the same loop, so
    // widening what counts as a failure would break deploys that work today.
    const gcp = createFakeGcp();
    await gcp.store.create({ path: keyPath, secret: true, value: KEY_VALUE });
    const viewer = gcp.storeAs(PARAMETER_VIEWER_PERMISSIONS);

    await expect(viewer.resolve(staticNamespace(ENV, SLUG))).rejects.toThrow(
      /403/,
    );
    // And the accessor-holding caller is unaffected.
    expect(await gcp.store.resolve(staticNamespace(ENV, SLUG))).toEqual({
      [KEY_VAR]: KEY_VALUE,
    });
  });

  it("reports an empty namespace as neither values nor failures", async () => {
    const gcp = createFakeGcp();
    expect(
      await gcp.store.resolveDetailed!(staticNamespace(ENV, SLUG)),
    ).toEqual({ values: {}, unrenderable: [] });
  });
});

describe("a parameterViewer credential cannot reach a secret VALUE", () => {
  it("lists and reads envelopes, and is refused the render", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({
      path: emailPath,
      secret: false,
      value: EMAIL_VALUE,
    });
    await gcp.store.create({ path: keyPath, secret: true, value: KEY_VALUE });

    // The grant landed: an accessor-holding caller resolves the secret. So what
    // follows is not "nothing works" — it is the caller layer doing the work.
    expect(await resolveServerParams(gcp.store, ENV, SLUG)).toEqual({
      [EMAIL_VAR]: EMAIL_VALUE,
      [KEY_VAR]: KEY_VALUE,
    });

    const viewer = gcp.storeAs(PARAMETER_VIEWER_PERMISSIONS);

    // The viewer can still do its job: enumerate the namespace...
    const listed = await viewer.list(staticNamespace(ENV, SLUG));
    expect(listed.map((m) => m.path).sort()).toEqual(
      [emailPath, keyPath].sort(),
    );
    // ...and read a NON-secret value, whose envelope holds the value itself.
    expect(await viewer.reveal(emailPath)).toBe(EMAIL_VALUE);

    // The DIRECT read path to the secret's value — Secret Manager `:access` —
    // is refused, named on the secret parameter specifically.
    await expect(viewer.reveal(keyPath)).rejects.toThrow(/403/);
    // And a namespace resolve cannot complete. Note this 403 lands on whichever
    // parameter sorts first, so it proves the resolve is blocked, NOT that the
    // secret's own `:render` is; the next test isolates the secret and proves
    // that. Asserting more here would be asserting less than it appears.
    await expect(resolveServerParams(viewer, ENV, SLUG)).rejects.toThrow(/403/);

    // And nothing leaked through the path it CAN reach: the raw envelope the
    // viewer is allowed to read carries a pointer, never the value.
    expect(gcp.pmPayloads().join("\n")).not.toContain("SUPER-SECRET-CANARY");
    expect(gcp.pmPayloads().join("\n")).toContain("__REF__(");
  });

  it("is refused even though the parameter's own grant is present", async () => {
    // The distinction that matters: the 403 is about the CALLER, not about the
    // binding. The binding is present and correct — an accessor-holding caller
    // reads the value through it in the test above. Withholding `render` is what
    // closes the path, and it is the only thing closing it.
    const gcp = createFakeGcp();
    await gcp.store.create({ path: keyPath, secret: true, value: KEY_VALUE });

    const id = parameterId(keyPath);
    expect(gcp.secretPolicies.get(id)).toEqual([
      {
        role: "roles/secretmanager.secretAccessor",
        members: [gcp.principalOf(id)],
      },
    ]);

    await expect(
      resolveServerParams(gcp.storeAs(PARAMETER_VIEWER_PERMISSIONS), ENV, SLUG),
    ).rejects.toThrow(/403/);

    // And the moment `render` is added — i.e. someone grants parameterAccessor —
    // the value comes straight out. This asserts the mechanism rather than
    // trusting the sentence above it.
    const withRender = gcp.storeAs([
      ...PARAMETER_VIEWER_PERMISSIONS,
      "parametermanager.parameterVersions.render",
    ]);
    expect(await resolveServerParams(withRender, ENV, SLUG)).toEqual({
      [KEY_VAR]: KEY_VALUE,
    });
  });

  it("pins the viewer role's contents, so `render` cannot drift into it", () => {
    // If a future edit adds `parameterVersions.render` here, the two tests above
    // would still pass while asserting nothing. This is the guard on the guard.
    expect([...PARAMETER_VIEWER_PERMISSIONS]).toEqual([
      "parametermanager.parameters.get",
      "parametermanager.parameters.list",
      "parametermanager.parameterVersions.get",
      "parametermanager.parameterVersions.list",
      "resourcemanager.projects.get",
      "resourcemanager.projects.list",
    ]);
  });
});

describe("two-store create rollback", () => {
  it("rolls back the Secret Manager secret when the parameter version fails", async () => {
    // Drive the REAL client over a stub fetch, so the rollback is asserted on the
    // code that ships. A secret create is: SM create secret, SM addVersion, PM
    // create parameter, the IAM grant that makes the `__REF__` resolvable, PM
    // addVersion. If the LAST call fails, both the empty parameter and the Secret
    // Manager secret must be rolled back, or a retry hits "already exists".
    const calls: string[] = [];
    const stub = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/token")) {
        return jsonRes({ access_token: "t", expires_in: 3600 });
      }
      const path = url.split("/v1/")[1] ?? "";
      calls.push(`${method} ${path.split("?")[0]}`);
      // Fail the PM version create (the LAST of the writes).
      if (method === "POST" && /parameters\/[^/]+\/versions/.test(path)) {
        return jsonRes({ error: { code: 503 } }, 503);
      }
      // The parameter GET the IAM grant reads its principal from. Without a
      // principal the grant fails first and this test would assert on the wrong
      // failure.
      if (method === "GET" && /parameters\/[^/]+$/.test(path)) {
        return jsonRes({
          policyMember: { iamPolicyUidPrincipal: "principal://pm/uid/p" },
        });
      }
      // Any versions LIST (to compute the next id) returns empty.
      if (method === "GET" && /parameters\/[^/]+\/versions$/.test(path)) {
        return jsonRes({ parameterVersions: [] });
      }
      return jsonRes({ name: path });
    }) as typeof fetch;

    const store = createGcpParameterStore({
      projectId: "p",
      account: {
        client_email: "admin@demo.iam.gserviceaccount.com",
        private_key: generateKeyPairSync("rsa", { modulusLength: 2048 })
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      },
      pmApiBase: "http://pm",
      smApiBase: "http://sm",
      tokenUrl: "http://token/token",
      fetchImpl: stub,
    });

    await expect(
      store.create({ path: keyPath, secret: true, value: "v" }),
    ).rejects.toThrow(/503/);

    const id = parameterId(keyPath);
    // The two rollbacks: DELETE the empty parameter, DELETE the secret.
    expect(calls).toContain(
      `DELETE projects/p/locations/global/parameters/${id}`,
    );
    expect(calls).toContain(`DELETE projects/p/secrets/${id}`);
  });

  it("rolls back both stores when the IAM GRANT fails", async () => {
    // The failure mode this change introduces. A grant that does not land leaves
    // a parameter whose `__REF__` can never render, so it must roll back exactly
    // like the version-create failure above rather than reporting success for a
    // secret nothing can read.
    const calls: string[] = [];
    const stub = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/token")) {
        return jsonRes({ access_token: "t", expires_in: 3600 });
      }
      const path = url.split("/v1/")[1] ?? "";
      calls.push(`${method} ${path.split("?")[0]}`);
      if (method === "POST" && /:setIamPolicy$/.test(path)) {
        return jsonRes({ error: { code: 503 } }, 503);
      }
      if (method === "GET" && /parameters\/[^/]+$/.test(path)) {
        return jsonRes({
          policyMember: { iamPolicyUidPrincipal: "principal://pm/uid/p" },
        });
      }
      return jsonRes({ name: path });
    }) as typeof fetch;

    const store = createGcpParameterStore({
      projectId: "p",
      account: {
        client_email: "admin@demo.iam.gserviceaccount.com",
        private_key: generateKeyPairSync("rsa", { modulusLength: 2048 })
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      },
      pmApiBase: "http://pm",
      smApiBase: "http://sm",
      tokenUrl: "http://token/token",
      fetchImpl: stub,
    });

    await expect(
      store.create({ path: keyPath, secret: true, value: "v" }),
    ).rejects.toThrow(/503/);

    const id = parameterId(keyPath);
    expect(calls).toContain(
      `DELETE projects/p/locations/global/parameters/${id}`,
    );
    expect(calls).toContain(`DELETE projects/p/secrets/${id}`);
    // And it failed BEFORE writing a version, so no half-built parameter ever
    // became visible to a reader.
    expect(
      calls.filter((c) => /^POST .*parameters\/[^/]+\/versions$/.test(c)),
    ).toEqual([]);
  });

  it("rolls back the Secret Manager secret when the PARAMETER create fails", async () => {
    // The subtle case: the Secret Manager secret + version succeed, but the very
    // next call — creating the Parameter Manager parameter — fails. The secret
    // must still be rolled back, or a retry hits a 409 on the orphaned secret.
    const calls: string[] = [];
    const stub = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/token")) {
        return jsonRes({ access_token: "t", expires_in: 3600 });
      }
      const path = url.split("/v1/")[1] ?? "";
      calls.push(`${method} ${path.split("?")[0]}`);
      // Fail the Parameter Manager PARAMETER create (not the version).
      if (
        method === "POST" &&
        /locations\/global\/parameters$/.test(path.split("?")[0] ?? "")
      ) {
        return jsonRes({ error: { code: 503 } }, 503);
      }
      return jsonRes({ name: path });
    }) as typeof fetch;

    const store = createGcpParameterStore({
      projectId: "p",
      account: {
        client_email: "admin@demo.iam.gserviceaccount.com",
        private_key: generateKeyPairSync("rsa", { modulusLength: 2048 })
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      },
      pmApiBase: "http://pm",
      smApiBase: "http://sm",
      tokenUrl: "http://token/token",
      fetchImpl: stub,
    });

    await expect(
      store.create({ path: keyPath, secret: true, value: "v" }),
    ).rejects.toThrow(/503/);

    // The orphaned Secret Manager secret is rolled back.
    expect(calls).toContain(
      `DELETE projects/p/secrets/${parameterId(keyPath)}`,
    );
  });
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parameterId encoding", () => {
  it("is deterministic, legal and letter-initial", () => {
    for (const p of [
      emailPath,
      keyPath,
      "/strad/staging/mcp/gcs/static/GCS_BUCKET",
    ]) {
      const id = parameterId(p);
      expect(id).toBe(parameterId(p)); // deterministic
      expect(id.length).toBeLessThanOrEqual(63);
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("hash-truncates a path that would exceed 63 chars", () => {
    const id = parameterId(keyPath); // long
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id).toMatch(/-[0-9a-f]{8}$/);
  });
});
