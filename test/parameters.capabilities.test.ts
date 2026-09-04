import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cachedProbe,
  NO_CAPABILITIES,
  PROBE_PERMISSIONS,
  probeCapabilities,
} from "../src/secrets/parameters/capabilities.ts";
import { parseServiceAccount } from "../src/secrets/parameters/service-account.ts";

/**
 * The probe's PERMISSION STRINGS, pinned literally.
 *
 * These are Google's identifiers, not strad's, and nothing in the type system
 * knows that. A plausible-looking typo — `parametermanager.parameterVersions.access`
 * borrowing Secret Manager's verb, say — compiles, lints, and produces a probe
 * that is wrong in the silent direction: a permission Google does not recognise is
 * never in the held set, so the capability reads false and the surface withholds a
 * tool the credential can in fact use.
 *
 * That exact typo shipped — in PROSE, in `docs/operate/secrets-iam.md`'s custom
 * role, where `docs.iam-identifiers.test.ts` now guards it. The probe was right.
 * This suite is what keeps it right, since the same mistake in this file would
 * cost capability rather than a Google error.
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
  readSecretIamPolicy: "secretmanager.secrets.getIamPolicy",
  bindSecret: "secretmanager.secrets.setIamPolicy",
  createParameter: "parametermanager.parameters.create",
  readParameter: "parametermanager.parameters.get",
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

  it("does not claim a secret write without the IAM-policy permissions", async () => {
    // `create()` grants the parameter's own principal `secretAccessor` on the
    // secret, because `:render` derefs as the parameter and not as the caller.
    // A credential that can write every VALUE but cannot set that binding fails
    // the create and rolls it back, so reporting `writeSecretValues` would offer
    // a button that always errors.
    for (const missing of [EXPECTED.bindSecret, EXPECTED.readSecretIamPolicy]) {
      const caps = await probe(
        stubCrm(Object.values(EXPECTED).filter((p) => p !== missing)),
      );
      expect(caps).toMatchObject({
        writeParameters: true,
        writeSecretValues: false,
      });
    }
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

describe("parsing the key the probe runs as", () => {
  /**
   * `null`, `"str"` and `123` are all VALID JSON. They clear `JSON.parse` and
   * then throw on property access, so a malformed key surfaced as a TypeError
   * out of `src/ui/resolve.ts` — the console's credential diagnostics, whose
   * entire job is to explain a bad key in words.
   */
  it("reports a JSON non-object by shape instead of throwing", () => {
    for (const raw of ["null", '"a string"', "123", "[]"]) {
      const { account, reason } = parseServiceAccount(raw);
      expect(account).toBeNull();
      expect(reason).toBeTruthy();
    }
  });

  it("still reports the ordinary malformed cases, and never echoes the key", () => {
    expect(parseServiceAccount(undefined).reason).toBe("no key JSON provided");
    expect(parseServiceAccount("{oops").reason).toBe("is not valid JSON");

    const secret = "-----BEGIN PRIVATE KEY-----CANARY-----END-----";
    const { account, reason } = parseServiceAccount(
      JSON.stringify({ private_key: secret }),
    );
    expect(account).toBeNull();
    expect(reason).toBe("is missing client_email / private_key");
    expect(reason).not.toContain("CANARY");
  });

  it("accepts a well-formed key", () => {
    const { account } = parseServiceAccount(JSON.stringify(ACCOUNT));
    expect(account).toStrictEqual(ACCOUNT);
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

/**
 * A stub whose TOKEN leg can be made to hang forever, which is the failure the
 * deadline exists for. `probeCapabilities` builds its own AbortController after
 * the mint returns, so on this path nothing of the probe's own ever fires — the
 * only thing that can end the call is a bound the caller brought.
 *
 * It records the signal each mint was given, because "the caller stopped
 * waiting" and "the request stopped running" are two different claims and the
 * second is the one that keeps a socket per render from piling up.
 */
function stallingMint(held: string[] = []) {
  const state = {
    stall: true,
    mints: 0,
    signals: [] as (AbortSignal | null | undefined)[],
    crmCalls: 0,
  };
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(url).startsWith("http://token")) {
      state.mints += 1;
      state.signals.push(init?.signal);
      if (state.stall) return new Promise<Response>(() => {});
      return new Response(
        JSON.stringify({ access_token: "at", expires_in: 3600 }),
        { headers: { "content-type": "application/json" } },
      );
    }
    state.crmCalls += 1;
    return new Response(JSON.stringify({ permissions: held }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { state, fetchImpl };
}

/** A prober with a 25ms deadline, so the test costs 25ms rather than six seconds. */
function cachedWithClock(
  fetchImpl: typeof fetch,
  clock: () => number,
  deadlineMs = 25,
) {
  return cachedProbe(
    {
      projectId: "strad-secrets-test",
      account: ACCOUNT,
      crmApiBase: "http://crm",
      tokenUrl: "http://token/token",
      fetchImpl,
    },
    5 * 60_000,
    clock,
    15_000,
    deadlineMs,
  );
}

describe("the memoised probe — a call cannot outlive its bound", () => {
  it("fails closed on a mint that never settles, and cancels the abandoned request", async () => {
    const { state, fetchImpl } = stallingMint();
    const probe = cachedWithClock(fetchImpl, () => 0);

    const caps = await probe();

    expect(caps).toMatchObject({ ...NO_CAPABILITIES, probed: false });
    expect(caps.reason).toContain("did not answer within");
    expect(state.mints).toBe(1);
    // Not merely dropped. Nothing else aborts this leg, and a socket per page
    // render left running is the cost of "abandoned" without "cancelled".
    expect(state.signals[0]?.aborted).toBe(true);
    // The probe never reached Google, so nothing may be claimed from it.
    expect(state.crmCalls).toBe(0);
  });

  it("does not poison the memo — the next call after the TTL probes afresh", async () => {
    // The defect: the in-flight promise was cleared only in `.finally()`, so a
    // probe that never settled was joined by every later render for the life of
    // the process. Against that code this test hangs rather than fails.
    const { state, fetchImpl } = stallingMint([
      EXPECTED.createParameter,
      EXPECTED.writeParameter,
    ]);
    let clock = 0;
    const probe = cachedWithClock(fetchImpl, () => clock);

    const first = await probe();
    expect(first.probed).toBe(false);

    // Inside the failure TTL the non-answer stands: this is a memo, not a stall.
    clock += 1_000;
    expect(await probe()).toStrictEqual(first);
    expect(state.mints).toBe(1);

    // Past it, a FRESH probe — which is the whole point. The store recovers, and
    // the console's page recovers with it, with no restart.
    clock += 15_000;
    state.stall = false;
    const recovered = await probe();
    expect(state.mints).toBe(2);
    expect(recovered).toMatchObject({ probed: true, writeParameters: true });

    // And a real answer is kept for the full TTL, unchanged by any of this.
    clock += 60_000;
    expect(await probe()).toStrictEqual(recovered);
    expect(state.mints).toBe(2);
  });

  it("still shares ONE probe across concurrent renders", async () => {
    // The bound must not become a probe per render: one console page fronts
    // several stores and a stalled one would then mint per row, per reload.
    const { state, fetchImpl } = stallingMint();
    const probe = cachedWithClock(fetchImpl, () => 0);

    const [a, b] = await Promise.all([probe(), probe()]);

    expect(state.mints).toBe(1);
    expect(a).toStrictEqual(b);
    expect(a.probed).toBe(false);
  });

  it("leaves a healthy probe alone — one round trip, memoised", async () => {
    const { state, fetchImpl } = stallingMint([EXPECTED.deleteParameter]);
    state.stall = false;
    let clock = 0;
    const probe = cachedWithClock(fetchImpl, () => clock);

    const caps = await probe();
    expect(caps).toMatchObject({ probed: true, deleteParameters: true });

    clock += 4 * 60_000;
    expect(await probe()).toStrictEqual(caps);
    expect(state.mints).toBe(1);
    expect(state.crmCalls).toBe(1);
  });
});
