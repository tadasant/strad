import { describe, expect, it } from "vitest";

import { timingSafeEqual } from "node:crypto";

import {
  constantTimeEquals,
  MAX_PRESENCE_KEYS,
  presenceResponse,
  type PresenceReport,
  type PresenceResponse,
} from "../src/presence.js";

/**
 * The presence route, run against the COPY this image actually serves.
 *
 * `presence.ts` is vendored from core — vocabulary and route together — and the
 * source is tested there. This suite is not a second opinion about the wiring;
 * it is the assertion that the bytes compiled into the bundle image behave,
 * inside this tree's own compiler settings and its own `node:crypto`, exactly
 * as the source does. The image is what every deployment runs.
 */

const TOKEN = "internal-token-value";
const BOOTED_AT = new Date("2026-08-31T00:00:00.000Z");

function ask(
  overrides: {
    authorization?: string | undefined;
    body?: unknown;
    env?: NodeJS.ProcessEnv;
  } = {},
): PresenceResponse {
  return presenceResponse({
    authorization:
      "authorization" in overrides
        ? overrides.authorization
        : `Bearer ${TOKEN}`,
    body: "body" in overrides ? overrides.body : { keys: ["SLACK_BOT_TOKEN"] },
    env: (overrides.env ?? {
      STRAD_INTERNAL_TOKEN: TOKEN,
    }) as NodeJS.ProcessEnv,
    bootedAt: BOOTED_AT,
    image: "0.1.0",
    timingSafeEqual,
  });
}

function report(answer: PresenceResponse): PresenceReport {
  expect(answer.status).toBe(200);
  return answer.body as PresenceReport;
}

describe("the presence route's authorization", () => {
  it("answers a correctly presented token", () => {
    expect(ask().status).toBe(200);
  });

  it("fails CLOSED with 503 when no internal token is configured", () => {
    // A component with no token cannot distinguish core from anything else in
    // the VPC, and "the network is private" is a reachability property.
    const answer = ask({ env: {} as NodeJS.ProcessEnv });

    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: "internal token not configured" });
  });

  it("401s a wrong token, a missing header and a bare word", () => {
    for (const authorization of [
      "Bearer wrong-token-value",
      undefined,
      "",
      "Bearer ",
    ]) {
      const answer = ask({ authorization });
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual({ error: "invalid internal token" });
    }
  });

  it("accepts any casing of the scheme, and odd spacing after it", () => {
    expect(ask({ authorization: `bearer  ${TOKEN}  ` }).status).toBe(200);
    expect(ask({ authorization: `BEARER ${TOKEN}` }).status).toBe(200);
  });

  it("401s the right token with no scheme — the rule every door reads by", () => {
    const answer = ask({ authorization: TOKEN });
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ error: "invalid internal token" });
  });

  it("authorizes BEFORE parsing, so a refusal teaches nothing about the body", () => {
    // Same 401, same sentence, whatever the body was: an unauthorized caller
    // must not be able to probe which shapes this endpoint would have accepted.
    const bad = ask({ authorization: "Bearer nope", body: { keys: 5 } });
    const good = ask({ authorization: "Bearer nope" });

    expect(bad).toEqual(good);
    expect(bad.status).toBe(401);
  });

  it("carries no cache-control on a refusal — only an answer is cacheable", () => {
    expect(ask({ authorization: undefined }).headers).toEqual({});
  });
});

describe("the presence route's request parsing", () => {
  it("400s a body that is not a JSON object", () => {
    for (const body of [null, [], "keys", 7]) {
      const answer = ask({ body });
      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({ error: "body must be a JSON object" });
    }
  });

  it("400s when keys is not an array", () => {
    expect(ask({ body: {} }).body).toEqual({
      error: "keys must be an array of strings",
    });
  });

  it("400s a key that is not an environment-variable name, WITHOUT echoing it", () => {
    const hostile = "<script>alert(1)</script>";
    const answer = ask({ body: { keys: [hostile] } });

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({
      error: "every key must be an environment-variable name",
    });
    expect(JSON.stringify(answer.body)).not.toContain("script");
  });

  it("bounds the request at MAX_PRESENCE_KEYS", () => {
    const keys = Array.from({ length: MAX_PRESENCE_KEYS + 1 }, (_, i) => `K_${i}`);
    const answer = ask({ body: { keys } });

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({
      error: `at most ${MAX_PRESENCE_KEYS} keys per request`,
    });
  });
});

describe("the presence report this process answers with", () => {
  it("reports a verdict per requested key, and never a value", () => {
    const answer = ask({
      body: { keys: ["SET_KEY", "EMPTY_KEY", "MISSING_KEY", "FILLER_KEY"] },
      env: {
        STRAD_INTERNAL_TOKEN: TOKEN,
        SET_KEY: "an-actual-credential",
        EMPTY_KEY: "",
        FILLER_KEY: "change-me",
      } as NodeJS.ProcessEnv,
    });

    const body = report(answer);
    expect(body.keys.SET_KEY?.presence).toBe("present");
    expect(body.keys.EMPTY_KEY?.presence).toBe("empty");
    expect(body.keys.MISSING_KEY?.presence).toBe("absent");
    expect(body.keys.FILLER_KEY?.presence).toBe("placeholder");
    expect(JSON.stringify(body)).not.toContain("an-actual-credential");
  });

  it("never leaks the internal token it was authorized with", () => {
    const body = report(ask({ body: { keys: ["STRAD_INTERNAL_TOKEN"] } }));

    expect(body.keys.STRAD_INTERNAL_TOKEN?.presence).toBe("present");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("says which component answered, and which image", () => {
    const body = report(
      ask({
        env: {
          STRAD_INTERNAL_TOKEN: TOKEN,
          STRAD_COMPONENT: "bundle-zimmer-secrets",
          STRAD_VERSION: "sha-abc123",
        } as NodeJS.ProcessEnv,
      }),
    );

    expect(body.component).toBe("bundle-zimmer-secrets");
    expect(body.image).toBe("sha-abc123");
  });

  it("defaults to `bundle` and to the host's own version", () => {
    // The second bundle component is the only one that renames itself; every
    // other deployment answers under the name core expects.
    const body = report(ask());

    expect(body.component).toBe("bundle");
    expect(body.image).toBe("0.1.0");
  });

  it("reports when THIS process booted, not when the value was baked", () => {
    // The freshness half: a container that predates the last render holds the
    // previous deploy's environment, and this is what lets core tell them apart.
    const body = report(ask());

    expect(body.bootedAt).toBe(BOOTED_AT.toISOString());
    expect(Date.parse(body.observedAt)).toBeGreaterThanOrEqual(
      BOOTED_AT.getTime(),
    );
  });

  it("answers about this component's own params, which core cannot name", () => {
    // A managed parameter is not a `${NAME}` reference in the config, so core
    // cannot ask about it. Answering only what was asked would report every one
    // of them absent on a perfectly healthy component.
    const body = report(
      ask({
        body: { keys: [] },
        env: {
          STRAD_INTERNAL_TOKEN: TOKEN,
          STRAD_PARAM_KEYS: JSON.stringify({ telegram: ["TELEGRAM_API_ID"] }),
          TELEGRAM_API_ID: "12345",
        } as NodeJS.ProcessEnv,
      }),
    );

    expect(body.paramKeys).toEqual({ telegram: ["TELEGRAM_API_ID"] });
    expect(body.keys.TELEGRAM_API_ID?.presence).toBe("present");
  });

  it("is never cached", () => {
    expect(ask().headers).toEqual({ "cache-control": "no-store" });
  });
});

describe("constantTimeEquals, with this tree's own node:crypto", () => {
  it("does not throw on a length mismatch, which timingSafeEqual would", () => {
    expect(
      constantTimeEquals("short", "a-much-longer-token", timingSafeEqual),
    ).toBe(false);
  });

  it("is true only for identical bytes", () => {
    expect(constantTimeEquals("token", "token", timingSafeEqual)).toBe(true);
    expect(constantTimeEquals("token", "tokeN", timingSafeEqual)).toBe(false);
    expect(constantTimeEquals("", "", timingSafeEqual)).toBe(true);
  });

  it("compares BYTES, not UTF-16 code units", () => {
    // Two strings of equal `.length` whose utf-8 encodings differ in length —
    // the case a naive charCode loop would call equal-length and this does not.
    expect(constantTimeEquals("é", "e", timingSafeEqual)).toBe(false);
  });
});
