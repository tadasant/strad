import { describe, expect, it } from "vitest";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import { createGcpParameterStore } from "../src/secrets/parameters/gcp.ts";
import type { ServiceAccount } from "../src/secrets/parameters/service-account.ts";
import {
  decodeEnvelope,
  decodeEnvelopeValue,
  encodeEnvelope,
  gatewayParameterPath,
  staticNamespace,
  gatewayNamespace,
} from "../src/secrets/parameters/namespace.ts";
import {
  encodeSecretValue,
  isRenderSafe,
  parameterId,
  secretRef,
  SECRET_VALUE_ENCODING,
  variableOf,
} from "../src/secrets/parameters/wire.ts";

/**
 * A secret value that carries a STRUCTURAL character, end to end.
 *
 * ## The bug this is the regression test for
 *
 * A strad parameter is created with `parameter-format=JSON`, and its payload is a
 * JSON envelope whose `value` field holds a `__REF__(…)` pointer. `:render` does
 * not rebuild that object — it splices the secret's raw bytes into the payload
 * TEXT and then checks the result for structural damage. So a value carrying a
 * `"`, a `\`, a brace or a newline breaks the envelope, and Parameter Manager
 * answers `400 INVALID_ARGUMENT … injection detected`. Seeding prod's
 * `STRAD_TOKENS` (a JSON array of token records — 811 bytes, 80 double-quotes)
 * failed exactly this way, while a quote-free control value at the same path
 * rendered 200.
 *
 * ## Why nothing caught it
 *
 * The in-memory double did the substitution SEMANTICALLY: parse the payload,
 * assign the secret to the parsed field, re-stringify. That re-escapes the value
 * perfectly, so it could not fail for any input. The double accepted what the API
 * rejects, which is the actual root cause of the episode — not the envelope
 * format. `fake.ts` now substitutes textually and refuses what `isRenderSafe`
 * refuses, so the two cannot drift into different opinions: the encoding is built
 * to satisfy that predicate and the double is built to enforce it.
 *
 * ## Scope
 *
 * The trigger is any structural character, not the quote specifically, so the
 * matrix below is the three shapes the 23 supplementary names actually take —
 * a quote-bearing JSON array, a multi-line PEM, and a service-account blob
 * (quotes, braces AND escaped newlines inside string values). If one of these
 * fails, the migration is still blocked.
 *
 * LIVE VERIFICATION AGAINST REAL GOOGLE IS OUTSTANDING. Everything here runs
 * against strad's own double. That double now models the failure faithfully, but
 * a green suite here is NOT the evidence Tadas produced against the live API, and
 * conflating the two is what shipped this bug in the first place.
 */

const ENV = "prod";
const SLUG = "gcs";

/** The value that failed in production, in shape: a JSON array of token records. */
const TOKENS_VALUE = JSON.stringify([
  {
    pubid: "7f3a91c2",
    label: "tadas laptop",
    hash: "9f".repeat(32),
    roles: ["admin", "reader"],
    revokedAt: null,
    createdAt: "2026-03-01T10:00:00.000Z",
  },
  {
    pubid: "b41e0d55",
    label: 'ci "deploy" probe',
    hash: "1a".repeat(32),
    roles: ["deploy"],
    revokedAt: null,
    createdAt: "2026-03-02T11:00:00.000Z",
  },
]);

/** A real multi-line PEM: newlines, and the `-----` fences. */
const PEM_VALUE = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
  "MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu",
  "NMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s+CLOyS56YyCFGeJZ",
  "-----END PRIVATE KEY-----",
  "",
].join("\n");

/** A service-account blob: quotes, braces, AND `\n` escapes inside a string. */
const SA_JSON_VALUE = JSON.stringify({
  type: "service_account",
  project_id: "strad-secrets-prod",
  private_key_id: "0b1c2d3e",
  private_key: PEM_VALUE,
  client_email: "resolver@strad-secrets-prod.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
});

/** A value with no structural character — the CONTROL that rendered 200. */
const CONTROL_VALUE = "strad_prod_7f3a91c2_hZ3k9QwErTyUiOpAsDfGhJkL";

/**
 * Seed a parameter the way the PRE-FIX writer did: raw bytes in Secret Manager,
 * and an envelope with no `encoding` field. This is the exact on-store state of
 * the five names in `strad-secrets-prod` today, and the state every test about
 * "what the old code left behind" has to start from.
 */
async function seedLegacySecret(
  gcp: ReturnType<typeof createFakeGcp>,
  path: string,
  value: string,
): Promise<void> {
  const id = parameterId(path);
  await gcp.store.create({ path, secret: true, value: "placeholder" });
  // Raw bytes, as the newest Secret Manager version...
  gcp.secrets.get(id)!.push(value);
  // ...under an envelope with the `encoding` field stripped back out.
  const param = gcp.parameters.get(id)!;
  const latest = param.versions[param.versions.length - 1]!;
  const env = decodeEnvelope(Buffer.from(latest.data, "base64").toString());
  delete env.encoding;
  latest.data = Buffer.from(encodeEnvelope(env), "utf8").toString("base64");
}

const MATRIX: [name: string, value: string][] = [
  ["a quote-bearing JSON array (STRAD_TOKENS)", TOKENS_VALUE],
  ["a multi-line PEM", PEM_VALUE],
  ["a service-account JSON blob", SA_JSON_VALUE],
  ["a value with a lone backslash", "domain\\user"],
  ["a value with a trailing newline", "token-with-newline\n"],
  ["a value with a tab and a control character", "a\tbc"],
  ["a multi-byte value", "clé—secrète 🔐"],
  ["an empty value", ""],
];

describe("the rule: which segment of a path is the variable", () => {
  /**
   * The two trees disagreed here, and nothing noticed: one took the text after
   * the final `/`, the other the last NON-EMPTY segment. They agree on every
   * well-formed path and part company on a trailing slash. This pins the
   * surviving answer, so the reconciliation is a decision rather than a
   * coincidence — the vendored copy is byte-identical, so it answers the same.
   */
  it("is the text after the final slash", () => {
    expect(variableOf(gatewayParameterPath(ENV, "STRAD_TOKENS"))).toBe(
      "STRAD_TOKENS",
    );
    expect(variableOf(`${staticNamespace(ENV, SLUG)}GCS_PRIVATE_KEY`)).toBe(
      "GCS_PRIVATE_KEY",
    );
  });

  it("answers nothing for a NAMESPACE, which has no variable", () => {
    // A path ending in `/` names a namespace. Reporting the last non-empty
    // segment would answer "static" here, and that name would travel into a
    // tool response and onto a console row as if a variable by that name
    // existed. Empty is visibly wrong where "static" is invisibly wrong.
    expect(variableOf(staticNamespace(ENV, SLUG))).toBe("");
    expect(variableOf(gatewayNamespace(ENV))).toBe("");
  });
});

describe("the rule: what a rendered secret may contain", () => {
  it("refuses every character that breaks a JSON payload", () => {
    for (const ch of ['"', "\\", "{", "}", "[", "]", "\n", "\r", "\t", "\0"]) {
      expect(isRenderSafe(`a${ch}b`)).toBe(false);
    }
  });

  it("permits what prod's working five already render with", () => {
    // OTEL_EXPORTER_OTLP_HEADERS carries `,` and `=`; GOOGLE_CLIENT_ID carries
    // `.` and `-`. All five render 200 today, so the predicate must not call
    // them unsafe — a rule stricter than the API would fail honest values.
    expect(isRenderSafe("authorization=Bearer abc,x-scope=strad")).toBe(true);
    expect(isRenderSafe("123-abc.apps.googleusercontent.com")).toBe(true);
    expect(isRenderSafe(CONTROL_VALUE)).toBe(true);
  });

  it("encodes every value in the matrix into something render-safe", () => {
    for (const [name, value] of MATRIX) {
      const encoded = encodeSecretValue(value);
      expect(isRenderSafe(encoded), name).toBe(true);
      // Stronger than the predicate: base64url's alphabet only. The encoding is
      // deliberately above the strictest rule Parameter Manager could apply, so
      // it does not depend on the predicate's boundary being in the right place.
      expect(encoded, name).toMatch(/^[A-Za-z0-9_-]*$/);
    }
  });
});

describe("the double refuses what Google refuses", () => {
  // The proof that constraint 1 holds. Reach past `create()` and put a RAW
  // structural value into the fake's Secret Manager, the way the old writer did,
  // then render. Before this change the double returned 200 and the value; it
  // must now answer the 400 the live API answers.
  it.each(MATRIX.filter(([, v]) => !isRenderSafe(v)))(
    "renders 400 for a raw, unencoded value — %s",
    async (_name, value) => {
      const gcp = createFakeGcp();
      const path = gatewayParameterPath(ENV, "STRAD_TOKENS");
      await seedLegacySecret(gcp, path, value);

      await expect(gcp.store.resolve(gatewayNamespace(ENV))).rejects.toThrow(
        /400/,
      );
    },
  );

  it("still renders 200 for a raw value with no structural character", async () => {
    // The control half of the repro. Same envelope, same `__REF__`, same grant —
    // the ONLY difference is the value, which is what pins the cause.
    const gcp = createFakeGcp();
    const path = gatewayParameterPath(ENV, "STRAD_INTERNAL_TOKEN");
    await seedLegacySecret(gcp, path, CONTROL_VALUE);

    const resolved = await gcp.store.resolve(gatewayNamespace(ENV));
    expect(resolved.STRAD_INTERNAL_TOKEN).toBe(CONTROL_VALUE);
  });
});

describe("a secret value survives the round trip, whatever it contains", () => {
  it.each(MATRIX)("resolves %s byte for byte", async (_name, value) => {
    const gcp = createFakeGcp();
    const path = gatewayParameterPath(ENV, "SECRET_UNDER_TEST");
    await gcp.store.create({ path, secret: true, value });

    const resolved = await gcp.store.resolve(gatewayNamespace(ENV));
    expect(resolved.SECRET_UNDER_TEST).toBe(value);
    // The console's reveal reads Secret Manager DIRECTLY — no `:render` in the
    // path to undo the encoding — so it is a separate decode and a separate risk.
    expect(await gcp.store.reveal(path)).toBe(value);
  });

  it.each(MATRIX)("rotates to %s and resolves the new value", async (_n, v) => {
    const gcp = createFakeGcp();
    const path = gatewayParameterPath(ENV, "SECRET_UNDER_TEST");
    await gcp.store.create({ path, secret: true, value: CONTROL_VALUE });
    await gcp.store.rotate(path, v);

    const resolved = await gcp.store.resolve(gatewayNamespace(ENV));
    expect(resolved.SECRET_UNDER_TEST).toBe(v);
    expect(await gcp.store.reveal(path)).toBe(v);
  });

  it("never writes the secret's bytes into a Parameter Manager payload", async () => {
    const gcp = createFakeGcp();
    const path = gatewayParameterPath(ENV, "GOOGLE_CLIENT_SECRET");
    await gcp.store.create({ path, secret: true, value: SA_JSON_VALUE });

    // The canary the two-store split exists for. Encoding a value must not
    // become a way of smuggling it into the store the viewer CAN read.
    const pm = gcp.pmPayloads().join("\n");
    expect(pm).not.toContain("strad-secrets-prod");
    expect(pm).not.toContain(encodeSecretValue(SA_JSON_VALUE));
    expect(pm).toContain("__REF__(");
  });

  it("leaves a NON-secret value literal, so the console still shows it", async () => {
    // A non-secret value is never substituted by `:render` — there is no
    // `__REF__` — so it has nothing to survive, and encoding it would only make
    // the console and the `secrets` MCP viewer display base64 to a human.
    const gcp = createFakeGcp();
    const path = gatewayParameterPath(ENV, "PUBLIC_NOTE");
    const value = '{"not":"a secret"}';
    await gcp.store.create({ path, secret: false, value });

    expect(gcp.pmPayloads().join("\n")).toContain(
      JSON.stringify(value).slice(1, -1),
    );
    expect(await gcp.store.reveal(path)).toBe(value);
    expect((await gcp.store.resolve(gatewayNamespace(ENV))).PUBLIC_NOTE).toBe(
      value,
    );
  });

  it("survives a setNote, which rewrites the envelope", async () => {
    // `setNote` writes a NEW envelope version carrying the same value pointer.
    // It is the one write that touches a secret parameter's envelope without
    // touching its bytes, so dropping `encoding` there would leave the pointer
    // valid, the secret intact, and every subsequent read decoding base64url as
    // if it were the literal value.
    const gcp = createFakeGcp();
    const path = gatewayParameterPath(ENV, "SECRET_UNDER_TEST");
    await gcp.store.create({ path, secret: true, value: SA_JSON_VALUE });

    await gcp.store.setNote(path, "rotate quarterly");

    const param = gcp.parameters.get(parameterId(path))!;
    const latest = param.versions[param.versions.length - 1]!;
    const envelope = decodeEnvelope(
      Buffer.from(latest.data, "base64").toString(),
    );
    expect(envelope.note).toBe("rotate quarterly");
    expect(envelope.encoding).toBe(SECRET_VALUE_ENCODING);
    expect(
      (await gcp.store.resolve(gatewayNamespace(ENV))).SECRET_UNDER_TEST,
    ).toBe(SA_JSON_VALUE);
    expect(await gcp.store.reveal(path)).toBe(SA_JSON_VALUE);
  });
});

describe("the five names already seeded in prod", () => {
  /**
   * They were written by the OLD code path: raw bytes in Secret Manager, an
   * envelope with no `encoding` field. None contains a structural character,
   * which is the only reason they render today.
   *
   * A scheme that fixes `STRAD_TOKENS` by breaking these would be a net loss, so
   * this is the constraint stated as a test: an envelope with no `encoding` means
   * the literal bytes, and RE-SEEDING IS NOT REQUIRED.
   */
  const LEGACY_FIVE = {
    STRAD_INTERNAL_TOKEN: CONTROL_VALUE,
    GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "GOCSPX-aBcDeFgHiJkLmNoPqRsTuVwXyZ",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer abc,x-scope=strad",
    GRANOLA_TOKEN: "gra_live_9f8e7d6c5b4a3210",
  };

  async function seedLegacy(gcp: ReturnType<typeof createFakeGcp>) {
    for (const [name, value] of Object.entries(LEGACY_FIVE)) {
      await seedLegacySecret(gcp, gatewayParameterPath(ENV, name), value);
    }
  }

  it("still resolve, untouched, with no re-seeding", async () => {
    const gcp = createFakeGcp();
    await seedLegacy(gcp);
    expect(await gcp.store.resolve(gatewayNamespace(ENV))).toEqual(LEGACY_FIVE);
  });

  it("still reveal", async () => {
    const gcp = createFakeGcp();
    await seedLegacy(gcp);
    for (const [name, value] of Object.entries(LEGACY_FIVE)) {
      expect(await gcp.store.reveal(gatewayParameterPath(ENV, name))).toBe(
        value,
      );
    }
  });

  it("upgrade to the new encoding on their next rotate, structural or not", async () => {
    const gcp = createFakeGcp();
    await seedLegacy(gcp);
    const path = gatewayParameterPath(ENV, "STRAD_INTERNAL_TOKEN");

    await gcp.store.rotate(path, TOKENS_VALUE);

    // The value a legacy parameter could never have held before.
    expect(
      (await gcp.store.resolve(gatewayNamespace(ENV))).STRAD_INTERNAL_TOKEN,
    ).toBe(TOKENS_VALUE);
    const param = gcp.parameters.get(parameterId(path))!;
    const latest = param.versions[param.versions.length - 1]!;
    expect(
      decodeEnvelope(Buffer.from(latest.data, "base64").toString()).encoding,
    ).toBe(SECRET_VALUE_ENCODING);
  });
});

describe("a rotate that half-fails", () => {
  /**
   * The upgrade writes the envelope first and the bytes second, so a failure
   * between them is the one state that can strand a parameter declaring an
   * encoding its bytes do not have. Nothing about the END state distinguishes
   * the two orderings, so only a failure injected in the middle pins the choice.
   */
  function failSecretWrites(gcp: ReturnType<typeof createFakeGcp>) {
    const real = gcp.fetchImpl;
    return ((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes(":addVersion") && url.includes("/secrets/")) {
        return Promise.resolve({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          text: async () => "",
          json: async () => ({}),
        } as Response);
      }
      return real(input, init);
    }) as typeof gcp.fetchImpl;
  }

  it("rolls the envelope back, leaving the parameter readable", async () => {
    const gcp = createFakeGcp();
    const path = gatewayParameterPath(ENV, "STRAD_INTERNAL_TOKEN");
    await seedLegacySecret(gcp, path, CONTROL_VALUE);

    const failing = createGcpParameterStore({
      projectId: gcp.endpoints.projectId,
      location: gcp.endpoints.location,
      account: JSON.parse(gcp.endpoints.keyJson) as ServiceAccount,
      pmApiBase: gcp.endpoints.pmApiBase,
      smApiBase: gcp.endpoints.smApiBase,
      tokenUrl: gcp.endpoints.tokenUrl,
      fetchImpl: failSecretWrites(gcp),
    });

    await expect(failing.rotate(path, TOKENS_VALUE)).rejects.toThrow(/503/);

    // The envelope is back where it started, so the OLD value still resolves.
    // Without the rollback this parameter would declare base64url over literal
    // bytes forever, and `resolve()` would fail for the whole namespace.
    const param = gcp.parameters.get(parameterId(path))!;
    const latest = param.versions[param.versions.length - 1]!;
    expect(
      decodeEnvelope(Buffer.from(latest.data, "base64").toString()).encoding,
    ).toBeUndefined();
    expect(
      (await gcp.store.resolve(gatewayNamespace(ENV))).STRAD_INTERNAL_TOKEN,
    ).toBe(CONTROL_VALUE);
    expect(await gcp.store.reveal(path)).toBe(CONTROL_VALUE);
  });

  it("does not roll back an envelope it did not upgrade", async () => {
    // A parameter already carrying the encoding has nothing to restore, and
    // writing a redundant version on every failed rotate would be noise.
    const gcp = createFakeGcp();
    const path = gatewayParameterPath(ENV, "SECRET_UNDER_TEST");
    await gcp.store.create({ path, secret: true, value: CONTROL_VALUE });
    const before = gcp.parameters.get(parameterId(path))!.versions.length;

    const failing = createGcpParameterStore({
      projectId: gcp.endpoints.projectId,
      location: gcp.endpoints.location,
      account: JSON.parse(gcp.endpoints.keyJson) as ServiceAccount,
      pmApiBase: gcp.endpoints.pmApiBase,
      smApiBase: gcp.endpoints.smApiBase,
      tokenUrl: gcp.endpoints.tokenUrl,
      fetchImpl: failSecretWrites(gcp),
    });
    await expect(failing.rotate(path, TOKENS_VALUE)).rejects.toThrow(/503/);

    expect(gcp.parameters.get(parameterId(path))!.versions.length).toBe(before);
    expect(
      (await gcp.store.resolve(gatewayNamespace(ENV))).SECRET_UNDER_TEST,
    ).toBe(CONTROL_VALUE);
  });
});

describe("decoding refuses to guess", () => {
  it("fails loudly on an encoding it does not know", () => {
    const payload = JSON.stringify({
      path: "/strad/prod/gateway/static/X",
      secret: true,
      value: "abc",
      encoding: "gzip+base64",
    });
    // Not "treat it as literal". A reader that shrugs hands a child process an
    // encoded blob as its credential — silently wrong beats loudly broken only
    // if you never have to debug it.
    expect(() => decodeEnvelope(payload)).toThrow(/unknown value encoding/);
  });

  it("fails loudly on a value that is not the encoding it claims", () => {
    // The state a half-completed rotate leaves behind: the envelope has been
    // upgraded, the Secret Manager version has not. Reading it must not produce
    // mojibake.
    expect(() =>
      decodeEnvelopeValue({
        path: "/strad/prod/gateway/static/X",
        secret: true,
        value: 'not base64url — it has spaces and a "',
        encoding: SECRET_VALUE_ENCODING,
      }),
    ).toThrow(/labelled base64url/);
  });

  it("accepts a value hand-seeded with padded standard base64", () => {
    // `base64 -w0` output, `+/=` and all. It decodes correctly, so rejecting it
    // for its spelling would fail an honest operator.
    const value = "sécret?>~ok";
    const standard = Buffer.from(value, "utf8").toString("base64");
    expect(standard).toMatch(/[+/=]/);
    expect(
      decodeEnvelopeValue({
        path: "/strad/prod/gateway/static/X",
        secret: true,
        value: standard,
        encoding: SECRET_VALUE_ENCODING,
      }),
    ).toBe(value);
  });

  it("hands back an UNRENDERED pointer untouched", () => {
    // `:render` returns the pointer rather than failing when the parameter's own
    // principal cannot reach the secret. `checkStore` recognises that string to
    // report "present but unrenderable"; decoding it would erase the diagnosis.
    const ref = secretRef("strad-secrets-prod", "strad-prod-gateway-static-x");
    expect(
      decodeEnvelopeValue({
        path: "/strad/prod/gateway/static/X",
        secret: true,
        value: ref,
        encoding: SECRET_VALUE_ENCODING,
      }),
    ).toBe(ref);
  });
});

describe("the encoding, where the resolver actually reads", () => {
  it("round-trips a PEM under a SERVER namespace", async () => {
    // The server namespace is the one the RESOLVER reads for a baked server's
    // env, and the gateway namespace above is a different prefix. Both go
    // through the same encode/decode, and only this one exercises the path a
    // mounted server's credential travels.
    const gcp = createFakeGcp();
    const path = `${staticNamespace(ENV, SLUG)}GCS_PRIVATE_KEY`;
    await gcp.store.create({ path, secret: true, value: PEM_VALUE });
    expect(
      (await gcp.store.resolve(staticNamespace(ENV, SLUG))).GCS_PRIVATE_KEY,
    ).toBe(PEM_VALUE);
  });
});
