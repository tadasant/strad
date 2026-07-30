import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NO_CAPABILITIES,
  PROBE_PERMISSIONS,
  probeCapabilities,
} from "../src/secrets/parameters/capabilities.ts";

/**
 * The probe's PERMISSION STRINGS, pinned literally.
 *
 * These are Google's identifiers, not strad's, and nothing in the type system
 * knows that. A plausible-looking typo — `parametermanager.parameterVersions.access`
 * borrowing Secret Manager's verb, say — compiles, lints, and produces a probe
 * that is wrong in the silent direction: a permission Google does not recognise is
 * never in the held set, so the capability reads false and the surface withholds a
 * tool the credential can in fact use. `docs/operate/secrets-iam.md` shipped exactly
 * that mistake in a custom role, which is what these assertions exist to catch.
 *
 * So the test spells each one out. Changing a value here should require having
 * looked it up at
 * https://cloud.google.com/iam/docs/roles-permissions/parametermanager (and the
 * secretmanager page next to it) — which is the whole point of making it a diff.
 */

const ACCOUNT = {
  client_email: "probe@test.iam.gserviceaccount.com",
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
};

/** Every string the probe may send, verified against Google's own reference. */
const EXPECTED = {
  readSecretValue: "secretmanager.versions.access",
  writeSecretValue: "secretmanager.versions.add",
  createSecret: "secretmanager.secrets.create",
  createParameter: "parametermanager.parameters.create",
  writeParameter: "parametermanager.parameterVersions.create",
  deleteParameter: "parametermanager.parameters.delete",
  renderParameter: "parametermanager.parameterVersions.render",
} as const;

/**
 * A CRM stub that records the request and answers with a chosen held-set.
 * `held: undefined` answers the way Google answers "none of them" — an empty
 * body, not a list of false.
 */
function stubCrm(held?: string[]) {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href = String(url);
    if (href.startsWith("http://token")) {
      return new Response(
        JSON.stringify({ access_token: "at", expires_in: 3600 }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }
    calls.push({
      url: href,
      method: init?.method,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(JSON.stringify(held ? { permissions: held } : {}), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const probe = (crm: ReturnType<typeof stubCrm>) =>
  probeCapabilities({
    projectId: "strad-secrets-test",
    account: ACCOUNT,
    crmApiBase: "http://crm",
    tokenUrl: "http://token/token",
    fetchImpl: crm.fetchImpl,
  });

describe("capability probe — the permission strings it sends", () => {
  it("pins every permission to Google's identifier", () => {
    expect(PROBE_PERMISSIONS).toStrictEqual(EXPECTED);
  });

  it("never asks for a permission Parameter Manager does not define", () => {
    // The specific spelling that broke the documented custom role. Parameter
    // Manager reads a version's payload with `parameterVersions.get`; `.access`
    // is Secret Manager's verb and does not exist here.
    expect(Object.values(PROBE_PERMISSIONS)).not.toContain(
      "parametermanager.parameterVersions.access",
    );
  });

  it("sends exactly those strings, to Cloud Resource Manager's REST method", async () => {
    const crm = stubCrm([]);
    await probe(crm);

    expect(crm.calls).toHaveLength(1);
    const call = crm.calls[0]!;
    // `testIamPermissions` is a method on the resource. There is no gcloud verb
    // for it, and the audit in docs/operate/secrets-iam.md must call the same URL.
    expect(call.url).toBe(
      "http://crm/v1/projects/strad-secrets-test:testIamPermissions",
    );
    expect(call.method).toBe("POST");
    expect(call.body).toStrictEqual({ permissions: Object.values(EXPECTED) });
  });
});

describe("capability probe — how it reads the answer", () => {
  it("reports read access from secretmanager.versions.access", async () => {
    const caps = await probe(stubCrm([EXPECTED.readSecretValue]));
    expect(caps).toMatchObject({ probed: true, readSecretValues: true });
  });

  it("reports read access from parameterVersions.render alone", async () => {
    // The second read path: `:render` derefs as the PARAMETER's principal, so
    // render-without-versions.access still yields a secret value once that
    // principal holds secretAccessor. Missing this reads as a security property
    // that exists in prose and not in IAM.
    const caps = await probe(stubCrm([EXPECTED.renderParameter]));
    expect(caps).toMatchObject({ probed: true, readSecretValues: true });
  });

  it("needs BOTH stores before it claims a secret can be written", async () => {
    const halfWay = await probe(
      stubCrm([EXPECTED.createParameter, EXPECTED.writeParameter]),
    );
    expect(halfWay).toMatchObject({
      writeParameters: true,
      writeSecretValues: false,
    });

    const full = await probe(stubCrm(Object.values(EXPECTED)));
    expect(full).toMatchObject({
      readSecretValues: true,
      writeParameters: true,
      writeSecretValues: true,
      deleteParameters: true,
      probed: true,
    });
  });

  it("treats an empty body as 'holds none of them', not as an error", async () => {
    const caps = await probe(stubCrm(undefined));
    expect(caps).toMatchObject({ ...NO_CAPABILITIES, probed: true });
  });

  it("fails closed and names the API when Cloud Resource Manager refuses", async () => {
    // The 403 a project without cloudresourcemanager.googleapis.com returns —
    // to the runtime probe AND to the documented audit, which is the same call.
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).startsWith("http://token")) {
        return new Response(
          JSON.stringify({ access_token: "at", expires_in: 3600 }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;

    const caps = await probeCapabilities({
      projectId: "strad-secrets-test",
      account: ACCOUNT,
      crmApiBase: "http://crm",
      tokenUrl: "http://token/token",
      fetchImpl,
    });
    expect(caps).toMatchObject({ ...NO_CAPABILITIES, probed: false });
    expect(caps.reason).toContain("403");
    expect(caps.reason).toContain("Cloud Resource Manager");
  });
});

describe("the bundle's copy of the probe", () => {
  /**
   * `servers/**` is outside the core TS program, so the secrets server carries
   * its own copy of these strings and its own comment saying it is "kept
   * identical to the src/ copy". That claim is only worth anything if something
   * checks it — a drift here means prod's `/mcp` surface and the console's
   * reveal posture are derived from different questions.
   */
  it("asks for the same permissions as the console's", () => {
    const source = readFileSync(
      new URL("../servers/secrets/shared/src/capabilities.ts", import.meta.url),
      "utf8",
    );
    for (const permission of Object.values(EXPECTED)) {
      expect(source).toContain(`"${permission}"`);
    }
    expect(source).not.toContain("parametermanager.parameterVersions.access");
    expect(source).toContain(":testIamPermissions");
  });
});
