import { describe, expect, it } from "vitest";
import {
  authorizePresence,
  buildPresenceReport,
  isPresence,
  MAX_PRESENCE_KEYS,
  parseParamKeys,
  parsePresenceRequest,
  placeholderReason,
  presenceOf,
  PRESENCE_PROTOCOL,
  PRESENCE_ROUTE,
} from "../src/secrets/presence.ts";

/**
 * The presence vocabulary — the five words a component may use about a secret it
 * holds, and the one rule that makes the whole feature safe to ship.
 *
 * THE RULE: a verdict is derived FROM a value and carries nothing OF it. This is
 * the file that holds it. Everything downstream — the probe client, the console
 * row, the readiness JSON — renders these strings verbatim, so if a byte can
 * escape it escapes here.
 */

/**
 * Values chosen to be hostile in every way a value can be: a real-looking
 * credential, a structural one, one that IS a placeholder word, and ones whose
 * characters would break out of a message if they were ever interpolated.
 */
const HOSTILE = [
  "xoxb-1234567890-AbCdEfGhIjKlMnOp",
  '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nMIIE"}',
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
  "change-me",
  "placeholder",
  "${SLACK_BOT_TOKEN}",
  "",
  "s3cr3t'; DROP TABLE--",
  "<script>alert(1)</script>",
  "£€¥ 🔑 unicode",
];

describe("presenceOf", () => {
  it("never puts any part of a value in its reason", () => {
    for (const value of HOSTILE) {
      const verdict = presenceOf(value);
      if (!verdict.reason) continue;
      // Every substring of length >= 4 that appears in the value must NOT appear
      // in the reason. Four is short enough to catch a prefix leak and long
      // enough that ordinary English words in a reason do not trip it.
      for (let i = 0; i + 4 <= value.length; i += 1) {
        const window = value.slice(i, i + 4);
        expect(
          verdict.reason.includes(window),
          `reason for a value leaked "${window.replace(/./g, "*")}"`,
        ).toBe(false);
      }
    }
  });

  it("never reports a length, and never a hash", () => {
    // A digit in a reason is the shape a length leak takes. The reasons this
    // module produces are prose about shapes; none of them counts anything.
    for (const value of HOSTILE) {
      const verdict = presenceOf(value);
      if (!verdict.reason) continue;
      expect(verdict.reason).not.toMatch(/\d/);
    }
  });

  it("separates absent from empty", () => {
    // Different mistakes with different fixes: nobody set it, versus something
    // set it to nothing. Collapsing them sends a human to create a secret that
    // is already there.
    expect(presenceOf(undefined).presence).toBe("absent");
    expect(presenceOf(null).presence).toBe("absent");
    expect(presenceOf("").presence).toBe("empty");
  });

  it("names an unexpanded reference as its own shape", () => {
    // The literal text `${FOO}` means nothing resolved it, and the process would
    // send that text upstream verbatim.
    expect(presenceOf("${SLACK_BOT_TOKEN}").presence).toBe("unexpanded");
    expect(presenceOf("  ${A_B_C}  ").presence).toBe("unexpanded");
    // NOT a bare reference: a real value that happens to contain one.
    expect(presenceOf("Bearer ${X}").presence).toBe("present");
  });

  it("calls a well-known filler string a placeholder", () => {
    for (const filler of ["placeholder", "CHANGE-ME", " todo ", "xxx"]) {
      expect(presenceOf(filler).presence).toBe("placeholder");
    }
  });

  it("calls a credential-shaped value present, and claims nothing more", () => {
    for (const real of [
      "xoxb-1234567890-AbCdEfGhIjKlMnOp",
      "-----BEGIN RSA PRIVATE KEY-----\nMII\n-----END RSA PRIVATE KEY-----",
      '{"type":"service_account"}',
    ]) {
      const verdict = presenceOf(real);
      expect(verdict.presence).toBe("present");
      expect(verdict.reason).toBeNull();
    }
  });

  it("agrees with placeholderReason, which the console still uses directly", () => {
    for (const value of HOSTILE) {
      if (value === "") continue;
      const reason = placeholderReason(value);
      const verdict = presenceOf(value);
      expect(verdict.presence === "present").toBe(reason === null);
    }
  });
});

describe("parsePresenceRequest", () => {
  it("accepts a list of environment-variable names, deduplicated", () => {
    const parsed = parsePresenceRequest({ keys: ["A", "B", "A", "_C1"] });
    expect(parsed).toEqual({ ok: true, keys: ["A", "B", "_C1"] });
  });

  it("refuses a body it cannot parse rather than answering the readable half", () => {
    // A confident answer to a question nobody asked is the failure mode this
    // whole surface exists to avoid.
    for (const body of [null, "keys", ["A"], {}, { keys: "A" }]) {
      const parsed = parsePresenceRequest(body);
      expect(parsed.ok).toBe(false);
    }
  });

  it("refuses a key that is not an env-var name, and does not echo it", () => {
    const hostile = "A; rm -rf /";
    const parsed = parsePresenceRequest({ keys: [hostile] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    // The offending entry is attacker-controlled text. It must not reach a log
    // line, and on the core side it must not reach a console sentence.
    expect(parsed.error).not.toContain("rm -rf");
    expect(parsed.status).toBe(400);
  });

  it("caps how many keys one request may ask about", () => {
    const many = Array.from(
      { length: MAX_PRESENCE_KEYS + 1 },
      (_v, i) => `K${i}`,
    );
    const parsed = parsePresenceRequest({ keys: many });
    expect(parsed.ok).toBe(false);
  });
});

describe("authorizePresence", () => {
  it("FAILS CLOSED when no internal token is configured", () => {
    // "On the private network" is a reachability property, not an authorization
    // one. A component that cannot tell core from anything else in the VPC must
    // refuse rather than serve.
    const denied = authorizePresence("Bearer anything", undefined);
    expect(denied).toEqual({
      ok: false,
      status: 503,
      error: "internal token not configured",
    });
  });

  it("rejects a wrong or absent token with an opaque 401", () => {
    for (const header of [undefined, "", "Bearer nope", "Basic secret"]) {
      const denied = authorizePresence(header, "secret");
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error("unreachable");
      expect(denied.status).toBe(401);
      // Telling a caller WHICH half of their credential failed tells an attacker
      // which half they got right.
      expect(denied.error).toBe("invalid internal token");
    }
  });

  it("accepts the shared internal token, with or without the Bearer prefix", () => {
    expect(authorizePresence("Bearer secret", "secret")).toEqual({ ok: true });
    expect(authorizePresence("secret", "secret")).toEqual({ ok: true });
  });
});

describe("buildPresenceReport", () => {
  const bootedAt = new Date("2026-07-30T09:12:00.000Z");
  const observedAt = new Date("2026-07-31T07:00:00.000Z");

  it("answers for exactly the keys asked about, and no others", () => {
    const report = buildPresenceReport({
      component: "bundle",
      image: "0.4.2",
      bootedAt,
      observedAt,
      env: { A: "xoxb-real", B: "", SECRET_NOT_ASKED_ABOUT: "value" },
      keys: ["A", "B", "C"],
    });
    expect(Object.keys(report.keys).sort()).toEqual(["A", "B", "C"]);
    expect(report.keys.A!.presence).toBe("present");
    expect(report.keys.B!.presence).toBe("empty");
    expect(report.keys.C!.presence).toBe("absent");
  });

  it("carries no value anywhere in the serialised body", () => {
    // The wire is where a leak would actually matter, so the assertion is made
    // against the JSON a caller receives rather than against the object.
    const value = "xoxb-7777777777-ZzYyXxWwVvUu";
    const report = buildPresenceReport({
      component: "bundle",
      bootedAt,
      observedAt,
      env: { SLACK_BOT_TOKEN: value },
      keys: ["SLACK_BOT_TOKEN"],
    });
    const wire = JSON.stringify(report);
    expect(wire).not.toContain(value);
    for (let i = 0; i + 6 <= value.length; i += 1) {
      expect(wire).not.toContain(value.slice(i, i + 6));
    }
  });

  it("reports freshness: who answered, on which image, up since when", () => {
    const report = buildPresenceReport({
      component: "bundle",
      image: "0.4.2",
      bootedAt,
      observedAt,
      env: {},
      keys: [],
    });
    expect(report.protocol).toBe(PRESENCE_PROTOCOL);
    expect(report.component).toBe("bundle");
    expect(report.image).toBe("0.4.2");
    expect(report.bootedAt).toBe("2026-07-30T09:12:00.000Z");
    expect(report.observedAt).toBe("2026-07-31T07:00:00.000Z");
  });

  it("passes through the baked managed-parameter names, and nothing else", () => {
    const report = buildPresenceReport({
      component: "bundle",
      bootedAt,
      observedAt,
      env: {
        STRAD_PARAM_KEYS: JSON.stringify({ "rfs-tmp": ["GCS_KEY_JSON"] }),
      },
      keys: [],
    });
    expect(report.paramKeys).toEqual({ "rfs-tmp": ["GCS_KEY_JSON"] });
  });
});

describe("parseParamKeys", () => {
  it("is null rather than half-trusted on anything malformed", () => {
    for (const raw of [
      undefined,
      "",
      "not json",
      "[]",
      '"a string"',
      '{"slug": "not an array"}',
      '{"slug": ["a bad name"]}',
      '{"slug": [1]}',
    ]) {
      expect(parseParamKeys(raw)).toBeNull();
    }
  });

  it("parses the shape appspec.ts bakes", () => {
    expect(parseParamKeys('{"a":["X","Y"],"b":[]}')).toEqual({
      a: ["X", "Y"],
      b: [],
    });
  });
});

describe("the protocol constants", () => {
  it("keeps the route off every slug-shaped namespace", () => {
    // A bundle's mounts are named after server slugs, and a slug cannot start
    // with an underscore — so this prefix is the one that cannot collide.
    expect(PRESENCE_ROUTE.startsWith("/_strad/")).toBe(true);
  });

  it("recognises exactly the five words", () => {
    for (const word of [
      "absent",
      "empty",
      "unexpanded",
      "placeholder",
      "present",
    ]) {
      expect(isPresence(word)).toBe(true);
    }
    for (const other of ["ok", "PRESENT", "", null, 1, undefined]) {
      expect(isPresence(other)).toBe(false);
    }
  });
});
