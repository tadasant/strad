import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { componentToken } from "../src/auth/internal-token.ts";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import {
  constantTimeEquals,
  MAX_PRESENCE_KEYS,
  PRESENCE_PROTOCOL,
  PRESENCE_ROUTE,
  presenceResponse,
  type PresenceReport,
  type PresenceResponse,
} from "../src/secrets/presence.ts";
import {
  probeBundles,
  refDelivery,
  validateReport,
} from "../src/gateway/bundle-presence.ts";

/**
 * `POST /_strad/presence` over a real socket, and the client that drives it.
 *
 * The unit tests in presence.test.ts hold the vocabulary; this one holds the
 * WIRE. It is the only place a value could actually leave the process that owns
 * it, so the leak assertion is made against the bytes a caller receives.
 *
 * The route is mounted here on the strad image in BUNDLE mode. The bundle host
 * image serves the identical route from the vendored copy of the same module —
 * see test/vendored.sync.test.ts, which is what keeps them the same.
 */

const YAML = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
servers:
  - slug: slack
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /slack
    entitlements: [admin]
    env:
      SLACK_BOT_TOKEN: "\${SLACK_TOKEN}"
      SLACK_TEAM: "T123"
`;

const CONFIG = parseConfig(YAML);
const TOKEN = "InternalTokenValueNeverShown";
const VALUE = "xoxb-7777777777-ZzYyXxWwVvUu";

describe("the presence route, over a socket", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const env: NodeJS.ProcessEnv = {
      STRAD_MODE: "bundle",
      STRAD_BUNDLE: "bundle",
      STRAD_COMPONENT: "bundle",
      STRAD_VERSION: "0.4.2",
      STRAD_INTERNAL_TOKEN: TOKEN,
      SLACK_BOT_TOKEN: VALUE,
      SLACK_EMPTY: "",
      STRAD_PARAM_KEYS: JSON.stringify({ rfs: ["GCS_KEY_JSON"] }),
    };
    const app = createApp({
      config: CONFIG,
      registry: await Registry.build({
        config: CONFIG,
        secrets: sharedSecretProviders(new EnvSecretProvider({})),
        mode: "bundle",
        env,
      }),
      tokenStore: tokenStoreFromConfig(CONFIG, env),
      mode: "bundle",
      env,
    });
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  async function ask(
    body: unknown,
    headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
  ) {
    return fetch(`${baseUrl}${PRESENCE_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("401s a caller with no internal token", async () => {
    const res = await ask({ keys: ["SLACK_BOT_TOKEN"] }, {});
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(VALUE);
  });

  it("401s a caller with the wrong internal token", async () => {
    const res = await ask(
      { keys: ["SLACK_BOT_TOKEN"] },
      {
        authorization: "Bearer wrong",
      },
    );
    expect(res.status).toBe(401);
  });

  it("answers presence, and no value, for the keys it is asked about", async () => {
    const res = await ask({
      keys: ["SLACK_BOT_TOKEN", "SLACK_EMPTY", "SLACK_ABSENT"],
    });
    expect(res.status).toBe(200);
    const text = await res.text();

    // THE ASSERTION THIS WHOLE SURFACE HAS TO SURVIVE.
    expect(text).not.toContain(VALUE);
    for (let i = 0; i + 6 <= VALUE.length; i += 1) {
      expect(text).not.toContain(VALUE.slice(i, i + 6));
    }
    // Not even the internal token it just authenticated, which is also in env.
    expect(text).not.toContain(TOKEN);

    const body = JSON.parse(text) as Record<string, unknown>;
    const keys = body.keys as Record<string, { presence: string }>;
    expect(keys.SLACK_BOT_TOKEN!.presence).toBe("present");
    expect(keys.SLACK_EMPTY!.presence).toBe("empty");
    expect(keys.SLACK_ABSENT!.presence).toBe("absent");
  });

  it("answers about the requested keys and its own baked ones, and nothing else", () =>
    ask({ keys: ["SLACK_EMPTY"] })
      .then((res) => res.json() as Promise<{ keys: Record<string, unknown> }>)
      .then((body) => {
        // The union is exactly two things: what core asked, and what this
        // component's own STRAD_PARAM_KEYS names. Neither comes from anywhere a
        // caller could reach, which is what keeps this from being an oracle —
        // and the environment holds SLACK_BOT_TOKEN and the internal token too,
        // neither of which appears.
        expect(Object.keys(body.keys).sort()).toEqual([
          "GCS_KEY_JSON",
          "SLACK_EMPTY",
        ]);
      }));

  it("reports the baked managed-parameter names and its own freshness", async () => {
    const res = await ask({ keys: [] });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.component).toBe("bundle");
    expect(body.image).toBe("0.4.2");
    expect(typeof body.bootedAt).toBe("string");
    expect(body.paramKeys).toEqual({ rfs: ["GCS_KEY_JSON"] });
  });

  it("is never cached", async () => {
    // A stale "absent" is exactly the thing that would keep a fixed connector
    // looking broken.
    const res = await ask({ keys: [] });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("400s a body it cannot parse, without echoing it", async () => {
    const res = await ask({ keys: ["A; rm -rf /"] });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("rm -rf");
  });

  it("503s over the wire when no internal token is configured", async () => {
    // Fail-closed, on a real socket rather than only in the unit. A component
    // that cannot tell core from anything else in the VPC must refuse; serving
    // anonymously because it sits on the private network is the mistake.
    const env: NodeJS.ProcessEnv = { STRAD_MODE: "bundle", STRAD_TOKENS: "[]" };
    const app = createApp({
      config: CONFIG,
      registry: await Registry.build({
        config: CONFIG,
        secrets: sharedSecretProviders(new EnvSecretProvider({})),
        mode: "bundle",
        env,
      }),
      tokenStore: tokenStoreFromConfig(CONFIG, env),
      mode: "bundle",
      env,
    });
    const naked = app.listen(0);
    await new Promise((r) => naked.once("listening", r));
    const port = (naked.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${PRESENCE_ROUTE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ keys: ["SLACK_BOT_TOKEN"] }),
    });
    expect(res.status).toBe(503);
    await new Promise((r) => naked.close(r));
  });

  it("answers for a managed parameter core never asked about", async () => {
    // Core CANNOT ask: a managed parameter is not a ${NAME} reference, so the
    // config does not name it. The component adds it from its own baked
    // STRAD_PARAM_KEYS. Without that, the console reports every one of them
    // absent on a perfectly healthy component.
    const res = await ask({ keys: ["SLACK_BOT_TOKEN"] });
    const body = (await res.json()) as {
      keys: Record<string, { presence: string }>;
    };
    expect(Object.keys(body.keys).sort()).toEqual([
      "GCS_KEY_JSON",
      "SLACK_BOT_TOKEN",
    ]);
    expect(body.keys.GCS_KEY_JSON!.presence).toBe("absent");
  });

  it("is NOT mounted on core", async () => {
    // Core reads its own environment directly; a presence surface there would
    // buy nothing and would put one on the component with a public route.
    const env: NodeJS.ProcessEnv = {
      STRAD_TOKENS: "[]",
      STRAD_INTERNAL_TOKEN: TOKEN,
      STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
    };
    const app = createApp({
      config: CONFIG,
      registry: await Registry.build({
        config: CONFIG,
        secrets: sharedSecretProviders(new EnvSecretProvider({})),
        mode: "core",
        env,
      }),
      tokenStore: tokenStoreFromConfig(CONFIG, env),
      mode: "core",
      env,
    });
    const core = app.listen(0);
    await new Promise((r) => core.once("listening", r));
    const port = (core.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${PRESENCE_ROUTE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ keys: ["SLACK_BOT_TOKEN"] }),
    });
    expect(res.status).toBe(404);
    await new Promise((r) => core.close(r));
  });
});

// ---------------------------------------------------------------------------
// The handler itself, without a socket — the half the bundle host runs
// ---------------------------------------------------------------------------

/**
 * `presenceResponse` is the route, and both components serve it.
 *
 * The suite above drives it through express on core. Every deployed bundle is a
 * `supplementary-image` bundle, which runs the `strad-bundle` host image rather
 * than the strad image in bundle mode — so the answers a console actually
 * renders come from the vendored copy of this function, three lines of express
 * away. Testing it here rather than only through `createApp` is what makes that
 * path covered at all; `test/vendored.sync.test.ts` is what makes this the same
 * function.
 */
describe("presenceResponse", () => {
  const INTERNAL = "internal-token-value";
  const BOOTED = new Date("2026-08-31T00:00:00.000Z");
  const OBSERVED = new Date("2026-09-01T12:00:00.000Z");

  function ask(
    overrides: {
      authorization?: string | undefined;
      body?: unknown;
      env?: Record<string, string | undefined>;
      component?: string;
      image?: string | null;
      now?: () => Date;
    } = {},
  ) {
    return presenceResponse({
      authorization:
        "authorization" in overrides
          ? overrides.authorization
          : `Bearer ${INTERNAL}`,
      body:
        "body" in overrides ? overrides.body : { keys: ["SLACK_BOT_TOKEN"] },
      env: overrides.env ?? { STRAD_INTERNAL_TOKEN: INTERNAL },
      bootedAt: BOOTED,
      component: overrides.component,
      image: overrides.image,
      now: "now" in overrides ? overrides.now : () => OBSERVED,
      timingSafeEqual,
    });
  }

  function answered(response: PresenceResponse): PresenceReport {
    expect(response.status).toBe(200);
    return response.body as PresenceReport;
  }

  describe("authorization", () => {
    it("fails CLOSED with 503 when no internal token is configured", () => {
      // A component that cannot tell core from anything else in the VPC must
      // refuse. "On the private network" is a reachability property.
      const response = ask({ env: {} });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: "internal token not configured" });
    });

    it("401s a wrong token, a missing header and a bare Bearer", () => {
      for (const authorization of [
        "Bearer wrong-token-value",
        undefined,
        "",
        "Bearer ",
      ]) {
        const response = ask({ authorization });
        expect(response.status, String(authorization)).toBe(401);
        expect(response.body).toEqual({ error: "invalid internal token" });
      }
    });

    it("takes the token under any casing of the scheme, with odd spacing", () => {
      expect(ask({ authorization: `bearer  ${INTERNAL}  ` }).status).toBe(200);
      expect(ask({ authorization: `BEARER ${INTERNAL}` }).status).toBe(200);
    });

    it("401s the right token with no scheme — the rule every door reads by", () => {
      const response = ask({ authorization: INTERNAL });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "invalid internal token" });
    });

    it("authorizes BEFORE parsing, so a refusal teaches nothing about the body", () => {
      const malformed = ask({
        authorization: "Bearer nope",
        body: { keys: 5 },
      });
      const wellFormed = ask({ authorization: "Bearer nope" });

      expect(malformed).toEqual(wellFormed);
      expect(malformed.status).toBe(401);
    });

    it("compares the token in constant time, over bytes", () => {
      // The comparator is injected because this module is vendored and cannot
      // import node:crypto. Both branches of that injection are the same rule.
      expect(constantTimeEquals("token", "token", timingSafeEqual)).toBe(true);
      expect(constantTimeEquals("token", "token")).toBe(true);
      // A length mismatch must not throw, which is what timingSafeEqual does.
      expect(constantTimeEquals("short", "much-longer", timingSafeEqual)).toBe(
        false,
      );
      expect(constantTimeEquals("short", "much-longer")).toBe(false);
      // Equal `.length`, different utf-8 bytes: a charCode loop would compare
      // them as equal-length, and this does not.
      expect(constantTimeEquals("é", "e", timingSafeEqual)).toBe(false);
      expect(constantTimeEquals("é", "e")).toBe(false);
    });
  });

  describe("request parsing", () => {
    it("400s a body that is not a JSON object", () => {
      for (const body of [null, [], "keys", 7]) {
        const response = ask({ body });
        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: "body must be a JSON object" });
      }
    });

    it("400s when keys is not an array", () => {
      expect(ask({ body: {} }).body).toEqual({
        error: "keys must be an array of strings",
      });
    });

    it("400s a key that is not an env-var name, WITHOUT echoing it", () => {
      const response = ask({ body: { keys: ["<script>alert(1)</script>"] } });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain("script");
    });

    it("bounds one request at MAX_PRESENCE_KEYS", () => {
      const keys = Array.from(
        { length: MAX_PRESENCE_KEYS + 1 },
        (_, i) => `K_${i}`,
      );
      const response = ask({ body: { keys } });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: `at most ${MAX_PRESENCE_KEYS} keys per request`,
      });
    });
  });

  describe("the answer", () => {
    it("is never cached", () => {
      // Load-bearing, and the reason this assertion exists on the handler
      // rather than only on core's express route: a stale "absent" is what
      // keeps a fixed connector looking broken in the console.
      expect(ask().headers).toEqual({ "cache-control": "no-store" });
    });

    it("carries no headers on a refusal — only an answer is cacheable", () => {
      expect(ask({ authorization: undefined }).headers).toEqual({});
      expect(ask({ body: {} }).headers).toEqual({});
      expect(ask({ env: {} }).headers).toEqual({});
    });

    it("reports a verdict per requested key, and never a value", () => {
      const report = answered(
        ask({
          body: { keys: ["SET_KEY", "EMPTY_KEY", "MISSING_KEY", "FILLER_KEY"] },
          env: {
            STRAD_INTERNAL_TOKEN: INTERNAL,
            SET_KEY: "xoxb-an-actual-credential",
            EMPTY_KEY: "",
            FILLER_KEY: "change-me",
          },
        }),
      );

      expect(report.keys.SET_KEY?.presence).toBe("present");
      expect(report.keys.EMPTY_KEY?.presence).toBe("empty");
      expect(report.keys.MISSING_KEY?.presence).toBe("absent");
      expect(report.keys.FILLER_KEY?.presence).toBe("placeholder");
      expect(JSON.stringify(report)).not.toContain("an-actual-credential");
      expect(JSON.stringify(report)).not.toContain(INTERNAL);
    });

    it("answers about this component's own params, which core cannot name", () => {
      const report = answered(
        ask({
          body: { keys: [] },
          env: {
            STRAD_INTERNAL_TOKEN: INTERNAL,
            STRAD_PARAM_KEYS: JSON.stringify({ telegram: ["TELEGRAM_API_ID"] }),
            TELEGRAM_API_ID: "12345",
          },
        }),
      );

      expect(report.paramKeys).toEqual({ telegram: ["TELEGRAM_API_ID"] });
      expect(report.keys.TELEGRAM_API_ID?.presence).toBe("present");
    });

    it("names the component and image the environment names", () => {
      const report = answered(
        ask({
          env: {
            STRAD_INTERNAL_TOKEN: INTERNAL,
            STRAD_COMPONENT: "bundle-zimmer-secrets",
            STRAD_VERSION: "sha-abc123",
          },
          component: "ignored-fallback",
          image: "ignored-fallback",
        }),
      );

      expect(report.component).toBe("bundle-zimmer-secrets");
      expect(report.image).toBe("sha-abc123");
    });

    it("falls back to STRAD_BUNDLE, then to what the adapter supplied", () => {
      // The two callers know different things about themselves: the host image
      // knows its own package version, core in bundle mode knows only what the
      // spec baked. The env lookup is shared; the fallback is the adapter's.
      expect(
        answered(
          ask({
            env: { STRAD_INTERNAL_TOKEN: INTERNAL, STRAD_BUNDLE: "bundle-api" },
          }),
        ).component,
      ).toBe("bundle-api");

      const hostShaped = answered(ask({ component: "bundle", image: "0.1.0" }));
      expect(hostShaped.component).toBe("bundle");
      expect(hostShaped.image).toBe("0.1.0");

      // Core in bundle mode supplies neither.
      const coreShaped = answered(ask());
      expect(coreShaped.component).toBe("bundle");
      expect(coreShaped.image).toBeNull();
    });

    it("reports when THIS process booted, not when the value was baked", () => {
      // The freshness half. A container that predates the last render holds the
      // previous deploy's environment, and this is what lets core tell them
      // apart — HACKS.md #35 is entirely about a process that can lie by being
      // old.
      const report = answered(ask());

      expect(report.bootedAt).toBe(BOOTED.toISOString());
      expect(report.observedAt).toBe(OBSERVED.toISOString());
      expect(report.protocol).toBe(PRESENCE_PROTOCOL);
    });

    it("observes at the wall clock when no clock is injected", () => {
      const before = Date.now();
      const report = answered(ask({ now: undefined }));

      expect(Date.parse(report.observedAt)).toBeGreaterThanOrEqual(before);
    });
  });
});

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

describe("probeBundles", () => {
  it("asks about the declared KEYS, never about the ref names", async () => {
    // `env: { SLACK_BOT_TOKEN: "${SLACK_TOKEN}" }` puts the value under
    // SLACK_BOT_TOKEN. Asking for SLACK_TOKEN would report a healthy deployment
    // broken — the mistake src/ui/resolve.ts carries the scar from.
    let asked: string[] = [];
    await probeBundles({
      config: CONFIG,
      env: { STRAD_BUNDLE_URL_BUNDLE: "http://bundle:8080" },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        asked = (JSON.parse(String(init.body)) as { keys: string[] }).keys;
        return new Response("{}", { status: 404 });
      }) as unknown as typeof fetch,
    });
    expect(asked).toEqual(["SLACK_BOT_TOKEN", "SLACK_TEAM"]);
    expect(asked).not.toContain("SLACK_TOKEN");
  });

  it("presents the component's own internal token, derived from the root", async () => {
    let auth: string | null = null;
    await probeBundles({
      config: CONFIG,
      env: {
        STRAD_BUNDLE_URL_BUNDLE: "http://bundle:8080",
        STRAD_INTERNAL_TOKEN: TOKEN,
      },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        auth = (init.headers as Record<string, string>).authorization ?? null;
        return new Response("{}", { status: 404 });
      }) as unknown as typeof fetch,
    });
    expect(auth).toBe(`Bearer ${componentToken(TOKEN, "bundle")}`);
    // Never the root: no component holds it, so presenting it would be
    // refused — and would hand a component every other component's token.
    expect(auth).not.toBe(`Bearer ${TOKEN}`);
  });

  it("calls a 404 UNSUPPORTED — a pin bump, not an outage", async () => {
    const { probes } = await probeBundles({
      config: CONFIG,
      env: { STRAD_BUNDLE_URL_BUNDLE: "http://bundle:8080" },
      fetchImpl: (async () =>
        new Response("{}", { status: 404 })) as unknown as typeof fetch,
    });
    const outcome = probes.get("bundle")!;
    expect(outcome.kind).toBe("unsupported");
    if (outcome.kind !== "unsupported") throw new Error("unreachable");
    expect(outcome.detail).toContain("bump its pin");
  });

  it("calls anything else UNREACHABLE, without quoting the body", async () => {
    // A component's error body is the one piece of text on this path that did
    // not come from code promising to be value-free.
    const { probes } = await probeBundles({
      config: CONFIG,
      env: { STRAD_BUNDLE_URL_BUNDLE: "http://bundle:8080" },
      fetchImpl: (async () =>
        new Response("leaked-secret-in-a-body", {
          status: 500,
        })) as unknown as typeof fetch,
    });
    const outcome = probes.get("bundle")!;
    expect(outcome.kind).toBe("unreachable");
    if (outcome.kind !== "unreachable") throw new Error("unreachable");
    expect(outcome.detail).not.toContain("leaked-secret");
  });

  it("names a 401 as a token mismatch rather than an outage", async () => {
    // Different fault, different fix: one is "restart the component", the other
    // is "the two halves of STRAD_INTERNAL_TOKEN do not match".
    const { probes } = await probeBundles({
      config: CONFIG,
      env: { STRAD_BUNDLE_URL_BUNDLE: "http://bundle:8080" },
      fetchImpl: (async () =>
        new Response("{}", { status: 401 })) as unknown as typeof fetch,
    });
    const outcome = probes.get("bundle")!;
    expect(outcome.kind).toBe("unreachable");
    if (outcome.kind !== "unreachable") throw new Error("unreachable");
    expect(outcome.detail).toContain("STRAD_INTERNAL_TOKEN");
  });

  it("says UNWIRED when the deployment binds no private URL for a bundle", async () => {
    const { probes } = await probeBundles({ config: CONFIG, env: {} });
    expect(probes.get("bundle")).toEqual({ kind: "unwired" });
  });

  it("never hangs the page on a component that does not answer", async () => {
    const { probes } = await probeBundles({
      config: CONFIG,
      env: { STRAD_BUNDLE_URL_BUNDLE: "http://bundle:8080" },
      timeoutMs: 20,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })) as unknown as typeof fetch,
    });
    const outcome = probes.get("bundle")!;
    expect(outcome.kind).toBe("unreachable");
    if (outcome.kind !== "unreachable") throw new Error("unreachable");
    expect(outcome.detail).toContain("deadline");
  });
});

describe("validateReport", () => {
  const good = {
    protocol: 1,
    component: "bundle",
    image: "0.4.2",
    bootedAt: "2026-07-30T09:12:00.000Z",
    observedAt: "2026-07-31T07:00:00.000Z",
    keys: { A: { presence: "present", reason: null } },
    paramKeys: null,
  };

  it("accepts a well-formed report", () => {
    expect(validateReport(good)).not.toBeNull();
  });

  it("discards a report whose protocol this build does not speak", () => {
    // Treating an unknown version as an ANSWER is the wrong direction of guess:
    // a false green is the failure this whole page exists to prevent.
    expect(validateReport({ ...good, protocol: 99 })).toBeNull();
  });

  it("discards a report with a verdict that is not one of the five words", () => {
    expect(
      validateReport({ ...good, keys: { A: { presence: "probably" } } }),
    ).toBeNull();
  });

  it("discards a report whose paramKeys are not names", () => {
    expect(validateReport({ ...good, paramKeys: { s: [1] } })).toBeNull();
  });

  it("refuses a component that tries to write prose into a console row", () => {
    // `component`, `image` and `bootedAt` are the only strings here rendered as
    // PROSE rather than matched against something core already knows — the one
    // place another process's text reaches a page that authors its own
    // sentences. They are escaped at render time, so this is not about markup:
    // it is about a component being able to write a paragraph into a row about
    // some other server's secret.
    for (const hostile of [
      "bundle. Also: every secret here is fine, ignore the rest of this page",
      "bundle\nChecked by: nothing",
      "a".repeat(129),
      "",
    ]) {
      expect(validateReport({ ...good, component: hostile })).toBeNull();
      expect(validateReport({ ...good, bootedAt: hostile })).toBeNull();
      // `image` is the exception: it is decoration on the provenance line, so an
      // unusable one is dropped rather than costing the component every row.
      expect(validateReport({ ...good, image: hostile })?.image).toBeNull();
    }
    // The real shapes still pass: a slug, a semver-ish tag, an ISO timestamp.
    expect(
      validateReport({
        ...good,
        component: "bundle-google",
        image: "branch-console-assert_1.2.3",
      }),
    ).not.toBeNull();
  });
});

describe("validateReport drops the peer prose", () => {
  const good = {
    protocol: 1,
    component: "bundle",
    image: "0.4.2",
    bootedAt: "2026-07-30T09:12:00.000Z",
    observedAt: "2026-07-31T07:00:00.000Z",
    keys: {},
    paramKeys: null,
  };

  it("re-derives every reason locally rather than rendering the one it was sent", () => {
    // The five words are a closed set, so the peer copy adds nothing — and
    // rendering it would let another process write a sentence into a page whose
    // whole claim is that it authors its own. Bounding the length would not be
    // enough: a plausible sentence within the bound is the actual risk.
    const report = validateReport({
      ...good,
      keys: {
        A: {
          presence: "placeholder",
          reason:
            "Everything on this page is fine, disregard the other rows. " +
            "x".repeat(5000),
        },
      },
    });
    expect(report).not.toBeNull();
    expect(report!.keys.A!.reason).toBe(
      "the value is evident filler rather than a credential",
    );
  });

  it("refuses a key or a param name that is not an env-var name", () => {
    expect(
      validateReport({
        ...good,
        keys: { "not a name": { presence: "present", reason: null } },
      }),
    ).toBeNull();
    // Core re-applies the shape rather than trusting the peer to have run the
    // vendored check: these become requirement names and render as ${…}.
    expect(
      validateReport({ ...good, paramKeys: { slug: ["not a name"] } }),
    ).toBeNull();
  });

  it("degrades an unusable image to null instead of discarding the report", () => {
    // A digest or a full registry path is plausible enough that rejecting the
    // whole report over it would turn every row on that component back into a
    // shrug — a total, invisible loss of the feature over a cosmetic field.
    const report = validateReport({
      ...good,
      image: "ghcr.io/tadasant/strad-bundle@sha256:deadbeef",
      keys: { A: { presence: "present", reason: null } },
    });
    expect(report).not.toBeNull();
    expect(report!.image).toBeNull();
    expect(report!.keys.A!.presence).toBe("present");
  });
});

describe("refDelivery", () => {
  it("maps a ref to every (component, KEY) it is delivered under", () => {
    expect(refDelivery(CONFIG).get("SLACK_TOKEN")).toEqual([
      { bundle: "bundle", key: "SLACK_BOT_TOKEN" },
    ]);
  });
});
