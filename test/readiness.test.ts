import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import type { Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  EnvSecretProvider,
  type SecretProvider,
} from "../src/secrets/provider/index.ts";
import { buildReadiness } from "../src/http/readiness.ts";
import type { ReadinessReport } from "../src/http/readiness.ts";
import { deriveServerStatuses } from "../src/ui/secret-status.ts";
import type { ParameterStore } from "../src/secrets/parameters/index.ts";

/**
 * `GET /api/secrets/readiness` — the machine's read of the secret roster.
 *
 * The consumer is Zimmer, holding one static bearer token, asking one question:
 * is Google Secret Manager / Parameter Manager wired up on this gateway? The
 * properties that make the answer worth acting on:
 *
 *   1. IT AUTHENTICATES LIKE /mcp. Static bearer, the same STRAD_TOKENS roster,
 *      the same environment check — not the console's Google-SSO path, which a
 *      machine cannot walk.
 *   2. `ready` MEANS OBSERVED. A server whose secrets could not be checked makes
 *      it false, exactly as it makes the console badge ISSUE. `true` that means
 *      "not known to be broken" is worse than no field.
 *   3. IT NEVER CONTAINS A VALUE. Names, paths, states and sentences about
 *      shapes. This file is the canary.
 */

const ENV_NAME = "test";

/** A real token record, so the endpoint is exercised through actual auth. */
function mint(
  env: string,
  roles: string[] = ["admin"],
): { pubid: string; plaintext: string; record: unknown } {
  const pubid = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(secret, "utf8").digest("hex");
  return {
    pubid,
    plaintext: `strad_${env}_${pubid}_${secret}`,
    record: { pubid, label: `token-${roles.join("-")}`, hash, roles },
  };
}

const TOKEN = mint(ENV_NAME);
/** Entitled to `alpha` and nothing else — the 403 case. */
const NARROW = mint(ENV_NAME, ["alpha-only"]);
const TOKENS_JSON = JSON.stringify([TOKEN.record, NARROW.record]);

const YAML = `
version: 1
gateway:
  name: strad
  env: ${ENV_NAME}
  publicUrl: https://staging.strad.example.com
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
  # A deliberately narrow role. The entitlement gate is only meaningful if some
  # token is genuinely entitled to less than the whole gateway.
  alpha-only: { servers: [alpha] }
bundles:
  - name: bundle
servers:
  - slug: alpha
    kind: remote-http
    url: https://alpha.example.com/mcp
    headers: { Authorization: "Bearer \${ALPHA_TOKEN}" }
    entitlements: [admin, alpha-only]
  - slug: beta
    kind: remote-http
    url: https://beta.example.com/mcp
    headers: { Authorization: "Bearer \${BETA_TOKEN}" }
    entitlements: [admin]
  - slug: gamma
    kind: remote-http
    url: https://gamma.example.com/mcp
    headers: { Authorization: "Bearer \${GAMMA_TOKEN}" }
    entitlements: [admin]
  - slug: retired
    kind: remote-http
    url: https://retired.example.com/mcp
    enabled: false
    headers: { Authorization: "Bearer \${RETIRED_TOKEN}" }
    entitlements: [admin]
`;

const CONFIG = parseConfig(YAML);
const STORE_CONFIG = parseConfig(
  YAML.replace(
    "  publicUrl: https://staging.strad.example.com",
    "  publicUrl: https://staging.strad.example.com\n  secrets: { provider: gcp-parameter-store }",
  ),
);

/** alpha resolves; beta is absent; gamma is filler. */
const BAG: Record<string, string> = {
  ALPHA_TOKEN: "alpha-real-credential-value-abcdef",
  GAMMA_TOKEN: "change-me",
  STRAD_TOKENS: TOKENS_JSON,
  STRAD_INTERNAL_TOKEN: "internal-token-value-abcdef",
};

const ENV: NodeJS.ProcessEnv = {
  STRAD_TOKENS: TOKENS_JSON,
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
};

async function boot(
  config: typeof CONFIG,
  provider: SecretProvider,
  bag: Record<string, string>,
  env: NodeJS.ProcessEnv = ENV,
  mode: "core" | "bundle" = "core",
  diagnosticStore?: Pick<ParameterStore, "list" | "resolveDetailed"> | null,
): Promise<{ url: string; close: () => void }> {
  const registry = await Registry.build({
    config,
    secrets: sharedSecretProviders(provider),
    mode,
    bundleName: mode === "bundle" ? "bundle" : undefined,
    env,
  });
  const app = createApp({
    config,
    registry,
    tokenStore: tokenStoreFromConfig(config, env),
    mode,
    env,
    secrets: bag,
    secretProvider: sharedSecretProviders(provider),
    diagnosticStore,
  });
  const s: Server = app.listen(0);
  await new Promise<void>((r) => s.on("listening", () => r()));
  const addr = s.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return { url: `http://127.0.0.1:${addr.port}`, close: () => s.close() };
}

let baseUrl: string;
let close: () => void;
let report: ReadinessReport;

beforeAll(async () => {
  const booted = await boot(CONFIG, new EnvSecretProvider(BAG), BAG);
  baseUrl = booted.url;
  close = booted.close;
  report = (await (
    await fetch(`${baseUrl}/api/secrets/readiness`, {
      headers: { authorization: `Bearer ${TOKEN.plaintext}` },
    })
  ).json()) as ReadinessReport;
});

afterAll(() => close?.());

describe("GET /api/secrets/readiness auth", () => {
  it("401s an anonymous request and leaks no secret NAME", async () => {
    const res = await fetch(`${baseUrl}/api/secrets/readiness`);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("unauthenticated");
    for (const name of ["ALPHA_TOKEN", "BETA_TOKEN", "beta"]) {
      expect(body).not.toContain(name);
    }
  });

  it("401s a bogus bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/secrets/readiness`, {
      headers: { authorization: "Bearer strad_test_deadbeef_nope" },
    });
    expect(res.status).toBe(401);
  });

  it("401s a token minted for a DIFFERENT environment", async () => {
    // The same env check /mcp applies. A prod token must not read staging's
    // secret roster because someone pasted the wrong URL into a config.
    const other = mint("prod");
    const res = await fetch(`${baseUrl}/api/secrets/readiness`, {
      headers: { authorization: `Bearer ${other.plaintext}` },
    });
    expect(res.status).toBe(401);
  });

  it("does NOT accept the console session cookie or the dev bypass", async () => {
    // Deliberately a different door from the human console: this is the /mcp
    // credential shape, and nothing else opens it.
    const res = await fetch(`${baseUrl}/api/secrets/readiness`, {
      headers: { authorization: "Bearer bootstrap-secret-xyz" },
    });
    expect(res.status).toBe(401);
  });

  it("403s a VALID token entitled to less than the whole gateway", async () => {
    // Authenticated is not entitled. /mcp narrows the identical credential
    // through entitledServers(), so a surface that authenticated the same way and
    // then answered for EVERY server would be a strict widening on the same
    // token: `alpha-only` would learn beta's and gamma's slugs, their secret
    // NAMES and the canonical paths. The report is deployment-wide, so the
    // credential has to be too.
    const res = await fetch(`${baseUrl}/api/secrets/readiness`, {
      headers: { authorization: `Bearer ${NARROW.plaintext}` },
    });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("forbidden");
    // And the refusal itself leaks nothing about what it withheld.
    for (const name of ["BETA_TOKEN", "GAMMA_TOKEN", "beta", "gamma"]) {
      expect(body).not.toContain(name);
    }
  });

  it("accepts the static bearer token and answers JSON", async () => {
    const res = await fetch(`${baseUrl}/api/secrets/readiness`, {
      headers: { authorization: `Bearer ${TOKEN.plaintext}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    // Never cached: the answer changes the moment someone seeds a value.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the report", () => {
  it("is NOT ready while a secret is unseeded, and says which", () => {
    expect(report.ready).toBe(false);
    expect(report.env).toBe("test");
    const slugs = report.issues.map((i) => i.slug);
    expect(slugs).toContain("beta");
    expect(slugs).toContain("gamma");
    expect(slugs).not.toContain("alpha");
  });

  it("counts ENABLED servers only — a disabled one is mounted by nothing", () => {
    expect(report.servers.total).toBe(3);
    expect(report.servers.ready).toBe(1);
    expect(report.servers.issues).toBe(2);
    expect(report.issues.map((i) => i.slug)).not.toContain("retired");
  });

  it("orders the issues worst-first", () => {
    // `missing` outranks `placeholder`: each step down is a weaker claim, and a
    // consumer paging through the list should meet the unambiguous one first.
    expect(report.issues[0]?.slug).toBe("beta");
    expect(report.issues[0]?.state).toBe("missing");
    expect(report.issues[1]?.state).toBe("placeholder");
  });

  it("names both GCP routes for each outstanding secret", () => {
    const beta = report.issues.find((i) => i.slug === "beta");
    const secret = beta?.secrets[0];
    expect(secret?.name).toBe("BETA_TOKEN");
    expect(secret?.state).toBe("missing");
    expect(secret?.source).toBe("GSM");
    expect(secret?.path).toBe("/strad/test/gateway/static/BETA_TOKEN");
    expect(secret?.secretManagerName).toBe("strad-test-BETA_TOKEN");
    expect(secret?.deliveries).toEqual(["gateway"]);
  });

  it("carries the full state breakdown, not just the boolean", () => {
    expect(report.servers.states).toMatchObject({
      ready: 1,
      missing: 1,
      placeholder: 1,
    });
  });

  it("reports the store itself separately from what is in it", () => {
    // "Can this gateway reach the store" and "is every credential seeded" are
    // different failures with different fixes, so they are different fields.
    expect(report.store.provider).toBe("env");
    expect(report.store.wired).toBe(true);
    expect(report.store.gatewayNamespace).toBe("/strad/test/gateway/static/");
    expect(report.store.resolverCredential).toBe(false);
    expect(report.store.project).toBe("strad-secrets-test");
    expect(report.store.projectGuessed).toBe(true);
  });

  it("lists the gateway's own boot keys, and marks the required ones", () => {
    const byName = new Map(report.boot.map((b) => [b.name, b]));
    expect(byName.get("STRAD_TOKENS")?.required).toBe(true);
    expect(byName.get("STRAD_TOKENS")?.state).toBe("present");
    expect(byName.get("GOOGLE_CLIENT_ID")?.required).toBe(false);
  });

  it("NEVER contains a secret value", () => {
    const json = JSON.stringify(report);
    for (const value of Object.values(BAG)) {
      if (value.length < 12) continue;
      expect(json).not.toContain(value);
    }
    expect(json).not.toContain(TOKEN.plaintext);
  });
});

describe("readiness under a store-backed provider", () => {
  it("is NOT wired when the resolver credential is absent", async () => {
    // `gcp-parameter-store` with no STRAD_PARAMS_* behind it reads nothing at
    // all. That is a deploy-shaped problem, not a value-shaped one, and it must
    // not be reported as "some secrets are missing".
    const { url, close: shut } = await boot(
      STORE_CONFIG,
      new EnvSecretProvider(BAG),
      BAG,
    );
    const body = (await (
      await fetch(`${url}/api/secrets/readiness`, {
        headers: { authorization: `Bearer ${TOKEN.plaintext}` },
      })
    ).json()) as ReadinessReport;
    expect(body.store.provider).toBe("gcp-parameter-store");
    expect(body.store.wired).toBe(false);
    expect(body.store.detail).toContain("no resolver credential");
    expect(body.ready).toBe(false);
    shut();
  });

  it("is wired when the resolver credential IS present", async () => {
    const withResolver = {
      ...ENV,
      STRAD_PARAMS_PROJECT_ID: "strad-secrets-declared",
      STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON: "{}",
    };
    const { url, close: shut } = await boot(
      STORE_CONFIG,
      new EnvSecretProvider(BAG),
      BAG,
      withResolver,
    );
    const body = (await (
      await fetch(`${url}/api/secrets/readiness`, {
        headers: { authorization: `Bearer ${TOKEN.plaintext}` },
      })
    ).json()) as ReadinessReport;
    expect(body.store.wired).toBe(true);
    expect(body.store.resolverCredential).toBe(true);
    expect(body.store.project).toBe("strad-secrets-declared");
    expect(body.store.projectGuessed).toBe(false);
    shut();
  });
});

describe("readiness when everything resolves", () => {
  it("is ready:true, and that means OBSERVED", async () => {
    const full = {
      ...BAG,
      BETA_TOKEN: "beta-real-credential-value-abcdef",
      GAMMA_TOKEN: "gamma-real-credential-value-abcdef",
    };
    const { url, close: shut } = await boot(
      CONFIG,
      new EnvSecretProvider(full),
      full,
    );
    const body = (await (
      await fetch(`${url}/api/secrets/readiness`, {
        headers: { authorization: `Bearer ${TOKEN.plaintext}` },
      })
    ).json()) as ReadinessReport;
    expect(body.ready).toBe(true);
    expect(body.issues).toEqual([]);
    expect(body.servers.ready).toBe(3);
    shut();
  });

  it("is ready:false when a REQUIRED boot key is absent, whatever the servers say", async () => {
    // Without STRAD_INTERNAL_TOKEN the core cannot reach its own bundles. Every
    // per-server green in the world does not make that deployment usable.
    const noInternal = {
      ALPHA_TOKEN: "alpha-real-credential-value-abcdef",
      BETA_TOKEN: "beta-real-credential-value-abcdef",
      GAMMA_TOKEN: "gamma-real-credential-value-abcdef",
      STRAD_TOKENS: TOKENS_JSON,
    };
    const { url, close: shut } = await boot(
      CONFIG,
      new EnvSecretProvider(noInternal),
      noInternal,
    );
    const body = (await (
      await fetch(`${url}/api/secrets/readiness`, {
        headers: { authorization: `Bearer ${TOKEN.plaintext}` },
      })
    ).json()) as ReadinessReport;
    expect(body.issues).toEqual([]);
    expect(body.ready).toBe(false);
    const internal = body.boot.find((b) => b.name === "STRAD_INTERNAL_TOKEN");
    expect(internal?.required).toBe(true);
    expect(internal?.state).toBe("missing");
    shut();
  });
});

describe("readiness on a server whose managed namespace nobody checked", () => {
  // `unverified` holds `ready` at false — true has to mean observed — but it is
  // NOT an issue. It lands in `unverified[]`, the console's UNVERIFIED badge,
  // so `issues[]` and the roster's "Needs attention" group are the same
  // servers. The entry carries an EMPTY `secrets[]`, and the summary carries
  // the answer.
  const cfg = parseConfig(`
version: 1
gateway: { name: strad, env: ${ENV_NAME} }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle-internal
servers:
  - slug: craigslist
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle-internal:sha-7344fb47
    bundle: bundle-internal
    path: /craigslist
    entitlements: [admin]
    params: true
    env: { SOME_KEY: "\${SOME_REF}" }
`);

  it("holds ready:false and files it under unverified, not issues", () => {
    const [status] = deriveServerStatuses(
      cfg,
      [
        {
          requirement: {
            name: "SOME_REF",
            deliveries: ["bundle"],
            slugs: ["craigslist"],
            consoleKeys: [],
            paramsSlugs: ["craigslist"],
          },
          state: "present",
          source: "ENV",
          detail: "plumbed",
          evidence: { by: "core" },
        },
      ],
      {
        probes: new Map([
          ["bundle-internal", { kind: "unreachable", detail: "ECONNREFUSED" }],
        ]),
      },
    );
    const report = buildReadiness({
      config: cfg,
      env: ENV,
      reading: { statuses: [status!], boot: [], storeDiagnosis: null },
    });

    expect(report.ready).toBe(false);
    expect(report.servers.states.unverified).toBe(1);
    expect(report.servers.states.ready).toBe(0);
    expect(report.issues).toEqual([]);
    expect(report.servers.issues).toBe(0);
    expect(report.servers.unverified).toBe(1);
    expect(report.unverified).toHaveLength(1);
    expect(report.unverified[0]!.slug).toBe("craigslist");
    expect(report.unverified[0]!.state).toBe("unverified");
    // The resolving name is NOT an outstanding secret, so it is filtered out and
    // the sentence in `summary` carries the whole of the answer.
    expect(report.unverified[0]!.secrets).toEqual([]);
    expect(report.unverified[0]!.summary).toContain(
      "/strad/test/mcp/craigslist/static/",
    );
  });
});

describe("readiness on a name that is both a reference and a parameter", () => {
  // TWO CLAIMS, TWO ENTRIES, AND THEY MUST NOT BE INDISTINGUISHABLE. A `params:
  // true` server can declare `${FOO}` while its component manifests a managed
  // parameter also called `FOO`, and both reach the roster (#280). In the JSON
  // that is two objects under one `name`, so `managed` discriminates them and
  // carries the only route that is true for a parameter: its server's static
  // namespace, never the gateway namespace and never `strad-<env>-FOO`.
  const cfg = parseConfig(`
version: 1
gateway: { name: strad, env: ${ENV_NAME} }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle-internal
servers:
  - slug: craigslist
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle-internal:sha-7344fb47
    bundle: bundle-internal
    path: /craigslist
    entitlements: [admin]
    params: true
    env: { SOME_KEY: "\${FOO}" }
`);

  it("tells the two entries apart, and routes each to its own resource", () => {
    const [status] = deriveServerStatuses(
      cfg,
      [
        {
          requirement: {
            name: "FOO",
            deliveries: ["bundle"],
            slugs: ["craigslist"],
            consoleKeys: [],
            paramsSlugs: ["craigslist"],
          },
          state: "missing",
          source: "GSM",
          detail: "not seeded",
          evidence: { by: "store" },
        },
      ],
      {
        probes: new Map([
          [
            "bundle-internal",
            {
              kind: "ok",
              report: {
                protocol: 1,
                component: "bundle-internal",
                image: null,
                bootedAt: "2026-01-01T00:00:00.000Z",
                observedAt: "2026-01-01T00:00:00.000Z",
                keys: { FOO: { presence: "absent", reason: null } },
                paramKeys: { craigslist: ["FOO"] },
              },
            },
          ],
        ]),
      },
    );
    const report = buildReadiness({
      config: cfg,
      env: ENV,
      reading: { statuses: [status!], boot: [], storeDiagnosis: null },
    });

    const secrets = report.issues[0]!.secrets;
    expect(secrets).toHaveLength(2);
    const reference = secrets.find((x) => !x.managed)!;
    const managed = secrets.find((x) => x.managed)!;
    expect(reference.name).toBe("FOO");
    expect(managed.name).toBe("FOO");
    // The reference keeps both of its real routes.
    expect(reference.path).toBe("/strad/test/gateway/static/FOO");
    expect(reference.secretManagerName).toBe("strad-test-FOO");
    // The parameter has exactly one home, and neither of those is it.
    expect(managed.path).toBe("/strad/test/mcp/craigslist/static/FOO");
    expect(managed.secretManagerName).toBeUndefined();
  });
});

describe("readiness when the backend is down", () => {
  it("degrades to ready:false with `unknown`, NOT to a wall of 'not seeded'", async () => {
    // The one failure mode that would make this endpoint worse than nothing: a
    // store outage reported as "every credential is missing" would send someone
    // to reseed a fleet of perfectly good secrets.
    const angry: SecretProvider = {
      name: "angry",
      get: async () => {
        throw new Error("store unreachable");
      },
      invalidate: () => {},
    };
    const { url, close: shut } = await boot(STORE_CONFIG, angry, {});
    const body = (await (
      await fetch(`${url}/api/secrets/readiness`, {
        headers: { authorization: `Bearer ${TOKEN.plaintext}` },
      })
    ).json()) as ReadinessReport;
    expect(body.ready).toBe(false);
    expect(body.servers.states.unknown).toBe(3);
    expect(body.servers.states.missing).toBe(0);
    for (const issue of body.issues) {
      expect(issue.state).toBe("unknown");
      expect(issue.secrets[0]?.state).toBe("error");
      expect(issue.secrets[0]?.source).toBe(null);
    }
    shut();
  });
});

describe("readiness does not amplify store reads", () => {
  it("polls it four times and reads the store ONCE, saying how old the answer is", async () => {
    // Answering this endpoint costs a full index read plus a per-parameter
    // render pass. Performed per call, that makes a hard poller an amplifier
    // against Parameter Manager — so the pass is TTL'd, and the body declares
    // the staleness rather than presenting a cached verdict as a fresh one.
    let lists = 0;
    let renders = 0;
    const counting = {
      list: async (namespace: string) => {
        lists += 1;
        return [
          {
            path: `${namespace}ALPHA_TOKEN`,
            variable: "ALPHA_TOKEN",
            secret: true,
            hasValue: true,
            latestVersion: "v1",
          },
        ];
      },
      resolveDetailed: async () => {
        renders += 1;
        return { values: { ALPHA_TOKEN: "value" }, unrenderable: [] };
      },
    };

    const { url, close: shut } = await boot(
      STORE_CONFIG,
      new EnvSecretProvider(BAG),
      BAG,
      ENV,
      "core",
      counting,
    );

    let last: ReadinessReport | undefined;
    for (let i = 0; i < 4; i++) {
      last = (await (
        await fetch(`${url}/api/secrets/readiness`, {
          headers: { authorization: `Bearer ${TOKEN.plaintext}` },
        })
      ).json()) as ReadinessReport;
    }

    expect(lists).toBe(1);
    expect(renders).toBe(1);
    expect(last?.store.diagnosis?.indexRead).toBe(true);
    expect(last?.store.diagnosis?.renderRead).toBe(true);
    // Bounded rather than pinned to 0: this is a real clock over four real HTTP
    // round trips, and the claim under test is that the age is REPORTED and
    // inside the window, not that a loaded runner finishes in under a second.
    expect(last?.store.diagnosis?.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(last?.store.diagnosis?.ageSeconds).toBeLessThan(60);
    // The RESPONSE is still uncacheable: the rest of the body is read per call.
    shut();
  });

  it("reports no diagnosis at all when there is no store to diagnose", async () => {
    const { url, close: shut } = await boot(
      CONFIG,
      new EnvSecretProvider(BAG),
      BAG,
      ENV,
      "core",
      null,
    );
    const body = (await (
      await fetch(`${url}/api/secrets/readiness`, {
        headers: { authorization: `Bearer ${TOKEN.plaintext}` },
      })
    ).json()) as ReadinessReport;
    expect(body.store.diagnosis).toBe(null);
    shut();
  });
});

describe("readiness in bundle mode", () => {
  it("is not mounted — a bundle answers with strictly less information", async () => {
    // A `consoleEnv:` value lands on CORE under its declared key and nowhere
    // else, so a bundle asked this question would get it wrong. With a VALID
    // credential the answer is 404, so it unambiguously means "not mounted".
    const bundleEnv = { ...ENV, STRAD_BUNDLE: "bundle" };
    const { url, close: shut } = await boot(
      CONFIG,
      new EnvSecretProvider(BAG),
      BAG,
      bundleEnv,
      "bundle",
    );
    const res = await fetch(`${url}/api/secrets/readiness`, {
      headers: { authorization: `Bearer ${TOKEN.plaintext}` },
    });
    expect(res.status).toBe(404);
    shut();
  });
});

describe("readiness buckets servers by the console's badge", () => {
  // `issues` is what is known to be broken, and nothing else. A deferral and
  // an unchecked server each get a list of their own, so the JSON and the
  // roster's groups are the same servers under the same names.
  const cfg = parseConfig(`
version: 1
gateway: { name: strad, env: ${ENV_NAME} }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: broken
    kind: remote-http
    url: https://broken.example.com/mcp
    headers: { Authorization: "Bearer \${BROKEN_TOKEN}" }
    entitlements: [admin]
  - slug: parked
    kind: remote-http
    url: https://parked.example.com/mcp
    headers: { Authorization: "Bearer \${PARKED_TOKEN}" }
    entitlements: [admin]
    mayBeUnseeded: [PARKED_TOKEN]
  - slug: fine
    kind: remote-http
    url: https://fine.example.com/mcp
    headers: { Authorization: "Bearer \${FINE_TOKEN}" }
    entitlements: [admin]
`);
  const row = (name: string, slug: string, state: "missing" | "present") => ({
    requirement: {
      name,
      deliveries: ["gateway" as const],
      slugs: [slug],
      consoleKeys: [],
      paramsSlugs: [],
    },
    state,
    source: "GSM" as const,
    detail: "",
    evidence: { by: "store" as const },
  });
  const statuses = deriveServerStatuses(cfg, [
    row("BROKEN_TOKEN", "broken", "missing"),
    row("PARKED_TOKEN", "parked", "missing"),
    row("FINE_TOKEN", "fine", "present"),
  ]);
  const report = buildReadiness({
    config: cfg,
    env: ENV,
    reading: { statuses, boot: [], storeDiagnosis: null },
  });

  it("counts only the broken server as an issue", () => {
    expect(report.issues.map((i) => i.slug)).toEqual(["broken"]);
    expect(report.servers.issues).toBe(1);
  });

  it("files a mayBeUnseeded deferral under inactive", () => {
    expect(report.inactive.map((i) => i.slug)).toEqual(["parked"]);
    expect(report.inactive[0]!.state).toBe("unconfigured");
    expect(report.servers.inactive).toBe(1);
    expect(report.servers.unverified).toBe(0);
    expect(report.unverified).toEqual([]);
  });

  it("still holds ready:false while anything is short of READY", () => {
    expect(report.ready).toBe(false);
    expect(report.servers.ready).toBe(1);
  });
});
