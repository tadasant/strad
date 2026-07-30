import { test } from "node:test";
import assert from "node:assert/strict";
import { PROBE_PERMISSIONS, probeCapabilities } from "../build/capabilities.js";
// A REAL RSA key: the probe signs a JWT before any fetch, so a placeholder
// string fails in node:crypto long before the stub is reached.
import { VIEWER_ACCOUNT } from "./fake-parameter-manager.mjs";

/**
 * The probe's PERMISSION STRINGS, pinned literally.
 *
 * This server's ENTIRE tool surface is derived from the probe's answer, so a
 * permission string Google does not recognise does not fail loudly — it comes
 * back outside the held set, reads as "not granted", and quietly withholds
 * `get_secret_value` and the write tools from a credential that can in fact use
 * them. Nothing in the type system knows these are Google's identifiers, so this
 * is the only place that can catch a plausible-looking typo.
 *
 * That exact typo shipped in PROSE — `docs/operate/secrets-iam.md` documented a
 * custom role containing `parametermanager.parameterVersions.access`, borrowing
 * Secret Manager's verb for a permission Parameter Manager does not define (it
 * reads a version's payload with `parameterVersions.get`). This file's copy of
 * the strings was correct, and this is what keeps it that way. The names are
 * verified against
 * https://cloud.google.com/iam/docs/roles-permissions/parametermanager and the
 * secretmanager page next to it.
 */

const EXPECTED = {
  readSecretValue: "secretmanager.versions.access",
  writeSecretValue: "secretmanager.versions.add",
  createSecret: "secretmanager.secrets.create",
  readSecretIamPolicy: "secretmanager.secrets.getIamPolicy",
  bindSecret: "secretmanager.secrets.setIamPolicy",
  createParameter: "parametermanager.parameters.create",
  writeParameter: "parametermanager.parameterVersions.create",
  deleteParameter: "parametermanager.parameters.delete",
  renderParameter: "parametermanager.parameterVersions.render",
};

/**
 * A Cloud Resource Manager stub that records the request. `held: undefined`
 * answers the way Google answers "none of them" — an empty body, not a list of
 * false.
 */
function stubCrm(held) {
  const calls = [];
  const json = (body) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith("http://token")) {
      return json({ access_token: "at", expires_in: 3600 });
    }
    calls.push({
      url: href,
      method: init.method,
      body: JSON.parse(String(init.body ?? "{}")),
    });
    return json(held ? { permissions: held } : {});
  };
  return { calls, fetchImpl };
}

const probe = (crm) =>
  probeCapabilities({
    projectId: "strad-secrets-staging",
    account: VIEWER_ACCOUNT,
    crmApiBase: "http://crm",
    tokenUrl: "http://token/token",
    fetchImpl: crm.fetchImpl,
  });

test("every probed permission is Google's identifier", () => {
  assert.deepEqual(PROBE_PERMISSIONS, EXPECTED);
  assert.ok(
    !Object.values(PROBE_PERMISSIONS).includes(
      "parametermanager.parameterVersions.access",
    ),
    "Parameter Manager has no `parameterVersions.access` — the verb is `.get`",
  );
});

test("the probe POSTs exactly those strings to CRM's testIamPermissions", async () => {
  const crm = stubCrm([]);
  await probe(crm);

  assert.equal(crm.calls.length, 1);
  // `testIamPermissions` is a method on the resource. There is no gcloud verb
  // for it, and the audit in docs/operate/secrets-iam.md must call this same URL.
  assert.equal(
    crm.calls[0].url,
    "http://crm/v1/projects/strad-secrets-staging:testIamPermissions",
  );
  assert.equal(crm.calls[0].method, "POST");
  assert.deepEqual(crm.calls[0].body, {
    permissions: Object.values(EXPECTED),
  });
});

test("either read path grants readSecretValues", async () => {
  const viaSm = await probe(stubCrm([EXPECTED.readSecretValue]));
  assert.equal(viaSm.readSecretValues, true);

  // `:render` derefs as the PARAMETER's principal, not the caller's, so this
  // credential genuinely can read a secret value once that principal holds
  // secretAccessor. Missing it would be a security property that exists only
  // in prose.
  const viaRender = await probe(stubCrm([EXPECTED.renderParameter]));
  assert.equal(viaRender.readSecretValues, true);
});

test("a staging-shaped grant lights up the write tools", async () => {
  const caps = await probe(stubCrm(Object.values(EXPECTED)));
  assert.deepEqual(caps, {
    readSecretValues: true,
    writeParameters: true,
    writeSecretValues: true,
    deleteParameters: true,
    probed: true,
  });
});

test("without the IAM-policy grant, a secret write is not claimed", async () => {
  // `create()` grants the PARAMETER's own principal secretAccessor on its
  // secret; `:render` derefs as that principal, so a create without the binding
  // produces a parameter nothing can read. A credential that can write the
  // values but not set the policy fails the create and rolls it back.
  for (const missing of [EXPECTED.bindSecret, EXPECTED.readSecretIamPolicy]) {
    const caps = await probe(
      stubCrm(Object.values(EXPECTED).filter((p) => p !== missing)),
    );
    assert.equal(caps.writeParameters, true);
    assert.equal(caps.writeSecretValues, false);
  }
});

test("a prod-shaped viewer grant lights up nothing, and still counts as probed", async () => {
  const caps = await probe(stubCrm(undefined));
  assert.deepEqual(caps, {
    readSecretValues: false,
    writeParameters: false,
    writeSecretValues: false,
    deleteParameters: false,
    probed: true,
  });
});

test("a refused probe fails closed and names the API, not the grant", async () => {
  // The 403 a project without cloudresourcemanager.googleapis.com returns — to
  // this probe AND to the documented audit command, which is the same call.
  const fetchImpl = async (url) => {
    if (String(url).startsWith("http://token")) {
      return new Response(
        JSON.stringify({ access_token: "at", expires_in: 3600 }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("forbidden", { status: 403 });
  };

  const caps = await probeCapabilities({
    projectId: "strad-secrets-staging",
    account: VIEWER_ACCOUNT,
    crmApiBase: "http://crm",
    tokenUrl: "http://token/token",
    fetchImpl,
  });
  assert.equal(caps.probed, false);
  assert.equal(caps.readSecretValues, false);
  assert.match(caps.reason, /403/);
  assert.match(caps.reason, /cloudresourcemanager\.googleapis\.com/);
});
