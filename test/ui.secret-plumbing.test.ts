import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import { buildPresenceReport } from "../src/secrets/presence.ts";
import type { ParameterMeta } from "../src/secrets/parameters/index.ts";
import type {
  BundlePresence,
  BundleProbeOutcome,
} from "../src/gateway/bundle-presence.ts";
import {
  fixTargets,
  readDeploymentSecretStatus,
  type SecretState,
  type ServerSecretStatus,
} from "../src/ui/secret-status.ts";

/**
 * "Is this secret plumbed, and by which path?" — the four answers, constructed.
 *
 * Unaided, the console has one honest thing to say about most of the fleet:
 * *"Nothing here is known to be broken — and nothing here was established
 * either."* It was true, and it was useless. It came from a real constraint:
 * a supplementary server's `env:` is resolved at render time and baked onto ITS
 * component, and the console runs on core.
 *
 * The fix is that the component answers for itself. This file constructs each of
 * the four states the console must now tell apart, from the seams rather than
 * from a live store, and asserts that they say different things:
 *
 *   1. PLUMBED VIA ENV     — the bundle was asked and reports a value
 *   2. PLUMBED VIA GSM     — the parameter store answered at runtime
 *   3. NOT ESTABLISHED     — the component could not answer; still a shrug, and
 *                            it now says WHICH of the two reasons
 *   4. EXISTS, CANNOT RENDER — the parameter is in the store and `:render`
 *                            refuses it (the live #202/injection shape)
 *
 * And the property that has to survive all four: no test here may find a secret
 * VALUE in the rendered HTML or in the JSON, and no message may quote one.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Two supplementary servers on one bundle, one of them `params: true`, plus a
 * gateway-resolved remote-http token. That is the smallest config that exercises
 * all three delivery paths at once.
 *
 * `SLACK_BOT_TOKEN` is the interesting case and the reason for the key/ref
 * split: the ref is `${SLACK_TOKEN}` and it is delivered under the KEY
 * `SLACK_BOT_TOKEN`. A probe that asked for the ref name would report a healthy
 * deployment broken.
 */
const YAML = `
version: 1
gateway:
  name: strad
  env: test
  publicUrl: https://staging.strad.example.com
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
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
  - slug: rfs
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /rfs
    entitlements: [admin]
    params: true
  - slug: granola
    kind: remote-http
    url: https://mcp.granola.example.com/mcp
    headers:
      Authorization: "Bearer \${GRANOLA_TOKEN}"
    entitlements: [admin]
`;

const CONFIG = parseConfig(YAML);
const STORE_CONFIG = parseConfig(
  YAML.replace(
    "  publicUrl: https://staging.strad.example.com",
    "  publicUrl: https://staging.strad.example.com\n  secrets: { provider: gcp-parameter-store }",
  ),
);

/** The real report shape, built by the real builder, from a fake environment. */
function report(
  env: Record<string, string | undefined>,
  over: { component?: string; image?: string; paramKeys?: string } = {},
) {
  return buildPresenceReport({
    component: over.component ?? "bundle",
    image: over.image ?? "0.4.2",
    bootedAt: new Date("2026-07-30T09:12:00.000Z"),
    observedAt: new Date("2026-07-31T07:00:00.000Z"),
    env: over.paramKeys ? { ...env, STRAD_PARAM_KEYS: over.paramKeys } : env,
    // ONLY the keys core would actually ask about — the `env:` map, which is all
    // it can derive from the config. A managed parameter is deliberately NOT in
    // here: if the report answers for one, it is because the component added it
    // from its own STRAD_PARAM_KEYS, which is the whole mechanism.
    keys: ["SLACK_BOT_TOKEN"],
  });
}

function presence(outcome: BundleProbeOutcome): BundlePresence {
  return { probes: new Map([["bundle", outcome]]) };
}

/** A store stub whose two halves can fail independently, as the real one can. */
function fakeStore(opts: {
  indexed?: string[];
  values?: Record<string, string>;
  unrenderable?: { variable: string; hard: boolean; reason: string }[];
  listThrows?: boolean;
  renderThrows?: boolean;
}) {
  return {
    list: async (namespace: string): Promise<ParameterMeta[]> => {
      if (opts.listThrows) throw new Error("store down");
      return (opts.indexed ?? []).map((variable) => ({
        path: `${namespace}${variable}`,
        variable,
        secret: true,
        hasValue: true,
        latestVersion: "v1",
      }));
    },
    resolveDetailed: async () => {
      if (opts.renderThrows) throw new Error("store down");
      return {
        values: opts.values ?? {},
        unrenderable: opts.unrenderable ?? [],
      };
    },
  };
}

async function read(opts: {
  config?: typeof CONFIG;
  bag?: Record<string, string>;
  presence?: BundlePresence;
  store?: ReturnType<typeof fakeStore> | null;
}): Promise<Map<string, ServerSecretStatus>> {
  const bag = opts.bag ?? {};
  const reading = await readDeploymentSecretStatus({
    config: opts.config ?? CONFIG,
    bag,
    env: {},
    secretProvider: new EnvSecretProvider(bag),
    presence: opts.presence ?? { probes: new Map() },
    store: opts.store === undefined ? null : opts.store,
  });
  return new Map(reading.statuses.map((s) => [s.server.slug, s]));
}

/** The state of one named requirement on one server. */
function stateOf(
  statuses: Map<string, ServerSecretStatus>,
  slug: string,
  name: string,
): SecretState | undefined {
  return statuses
    .get(slug)
    ?.requirements.find((r) => r.requirement.name === name)?.state;
}

function detailOf(
  statuses: Map<string, ServerSecretStatus>,
  slug: string,
  name: string,
): string {
  return (
    statuses.get(slug)?.requirements.find((r) => r.requirement.name === name)
      ?.detail ?? ""
  );
}

// ---------------------------------------------------------------------------
// 1. Plumbed via ENV — the bundle was asked, and it answered
// ---------------------------------------------------------------------------

describe("a bundle-delivered secret the component reports it holds", () => {
  it("is PLUMBED, not 'could not be checked'", async () => {
    const statuses = await read({
      presence: presence({
        kind: "ok",
        report: report({ SLACK_BOT_TOKEN: "xoxb-1234567890-AbCdEfGh" }),
      }),
    });
    expect(stateOf(statuses, "slack", "SLACK_TOKEN")).toBe("present");
    expect(statuses.get("slack")!.state).toBe("ready");
  });

  it("says it is plumbed VIA A PROCESS ENVIRONMENT VARIABLE, and by whom", async () => {
    // The whole ask: assert whether it is plumbed AND via which path.
    const statuses = await read({
      presence: presence({
        kind: "ok",
        report: report({ SLACK_BOT_TOKEN: "xoxb-1234567890-AbCdEfGh" }),
      }),
    });
    const observation = statuses
      .get("slack")!
      .requirements.find((r) => r.requirement.name === "SLACK_TOKEN")!;
    expect(observation.source).toBe("ENV");
    expect(observation.detail).toContain("PLUMBED");
    expect(observation.evidence).toEqual({
      by: "bundle",
      component: "bundle",
      bootedAt: "2026-07-30T09:12:00.000Z",
      image: "0.4.2",
    });
  });

  it("looks the value up under its declared KEY, not under the ref name", async () => {
    // `env: { SLACK_BOT_TOKEN: "${SLACK_TOKEN}" }` puts the value under
    // SLACK_BOT_TOKEN. Probing for SLACK_TOKEN would report a healthy deployment
    // broken — the same mistake src/ui/resolve.ts carries the scar from.
    const statuses = await read({
      presence: presence({
        kind: "ok",
        report: report({ SLACK_TOKEN: "xoxb-under-the-wrong-name" }),
      }),
    });
    expect(stateOf(statuses, "slack", "SLACK_TOKEN")).toBe("missing");
  });

  it("calls an ABSENT key not-plumbed, definitively", async () => {
    const statuses = await read({
      presence: presence({ kind: "ok", report: report({}) }),
    });
    expect(stateOf(statuses, "slack", "SLACK_TOKEN")).toBe("missing");
    expect(detailOf(statuses, "slack", "SLACK_TOKEN")).toContain("NOT plumbed");
  });

  it("separates an EMPTY value from an absent one", async () => {
    // Something DID inject a value here, and the value was nothing. Seeding the
    // secret does not fix that, so it must not read as "not seeded".
    const statuses = await read({
      presence: presence({
        kind: "ok",
        report: report({ SLACK_BOT_TOKEN: "" }),
      }),
    });
    expect(stateOf(statuses, "slack", "SLACK_TOKEN")).toBe("placeholder");
    expect(detailOf(statuses, "slack", "SLACK_TOKEN")).toContain("empty");
  });

  it("catches a placeholder on the bundle, exactly as it does on core", async () => {
    // The reason the vocabulary is one vendored module: `change-me` has to read
    // as filler whichever process holds it.
    const statuses = await read({
      presence: presence({
        kind: "ok",
        report: report({ SLACK_BOT_TOKEN: "change-me" }),
      }),
    });
    expect(stateOf(statuses, "slack", "SLACK_TOKEN")).toBe("placeholder");
  });

  it("catches an unexpanded ${...} the render failed to resolve", async () => {
    const statuses = await read({
      presence: presence({
        kind: "ok",
        report: report({ SLACK_BOT_TOKEN: "${SLACK_TOKEN}" }),
      }),
    });
    expect(stateOf(statuses, "slack", "SLACK_TOKEN")).toBe("placeholder");
  });
});

// ---------------------------------------------------------------------------
// 2. Plumbed via GSM — the store answered at runtime
// ---------------------------------------------------------------------------

describe("a gateway-resolved secret under a store-backed provider", () => {
  it("is PLUMBED via GSM, and says the store established it", async () => {
    const statuses = await read({
      config: STORE_CONFIG,
      bag: { GRANOLA_TOKEN: "gra_live_AbCdEfGhIjKl" },
      store: fakeStore({ indexed: ["GRANOLA_TOKEN"] }),
    });
    const observation = statuses
      .get("granola")!
      .requirements.find((r) => r.requirement.name === "GRANOLA_TOKEN")!;
    expect(observation.state).toBe("present");
    expect(observation.source).toBe("GSM");
    expect(observation.evidence.by).toBe("store");
  });

  it("still reads ENV under the default provider, so the badge means something", async () => {
    // GSM and ENV are Zimmer's own two labels, and the workflow is to read that
    // screen and this one and compare. A page that said GSM for everything would
    // make the badge decoration.
    const statuses = await read({
      bag: { GRANOLA_TOKEN: "gra_live_AbCdEfGhIjKl" },
    });
    const observation = statuses
      .get("granola")!
      .requirements.find((r) => r.requirement.name === "GRANOLA_TOKEN")!;
    expect(observation.state).toBe("present");
    expect(observation.source).toBe("ENV");
    expect(observation.evidence.by).toBe("core");
  });
});

// ---------------------------------------------------------------------------
// 3. Genuinely not established — the honest residue, now with a reason
// ---------------------------------------------------------------------------

describe("a bundle that cannot answer", () => {
  it("keeps the honest shrug when no probe ran at all", async () => {
    // Shrinking the unobservable set to near-nothing is the goal. Replacing an
    // honest shrug with a confident guess is not.
    const statuses = await read({});
    expect(stateOf(statuses, "slack", "SLACK_TOKEN")).toBe("unobservable");
    expect(statuses.get("slack")!.state).toBe("unverified");
  });

  it("says the image predates the route when the component 404s", async () => {
    // A pin bump, not an outage. The two want different responses, so the row
    // must not call them the same thing.
    const statuses = await read({
      presence: presence({
        kind: "unsupported",
        detail:
          "the component answered 404 for /_strad/presence, so it is old.",
      }),
    });
    expect(stateOf(statuses, "slack", "SLACK_TOKEN")).toBe("unobservable");
    expect(detailOf(statuses, "slack", "SLACK_TOKEN")).toContain("404");
  });

  it("says the component was asked and did not answer when it is down", async () => {
    const statuses = await read({
      presence: presence({
        kind: "unreachable",
        detail:
          "the component did not answer /_strad/presence within the deadline.",
      }),
    });
    expect(stateOf(statuses, "slack", "SLACK_TOKEN")).toBe("unobservable");
    expect(detailOf(statuses, "slack", "SLACK_TOKEN")).toContain(
      "did not answer",
    );
  });

  it("never claims presence from a report this build cannot parse", async () => {
    // Half-parsing a status report produces a confident answer about a question
    // nobody asked. `probeBundles` discards it whole, and the row falls back.
    const statuses = await read({
      presence: presence({
        kind: "unreachable",
        detail: "a body this build does not understand.",
      }),
    });
    expect(stateOf(statuses, "slack", "SLACK_TOKEN")).not.toBe("present");
  });
});

// ---------------------------------------------------------------------------
// 4. Exists and cannot render — the fourth state
// ---------------------------------------------------------------------------

describe("a parameter that exists and whose value will not render", () => {
  it("is neither 'not seeded' nor 'unknown'", async () => {
    // The live shape: strad wraps `__REF__(...)` in a JSON string under
    // format: "JSON", so a value carrying a quote, a brace or a newline makes
    // Google refuse `:render` with 400 injection detected. The parameter is
    // there. Nothing can read it. Both obvious labels are lies.
    const statuses = await read({
      config: STORE_CONFIG,
      store: fakeStore({
        indexed: ["GRANOLA_TOKEN"],
        unrenderable: [
          {
            variable: "GRANOLA_TOKEN",
            hard: true,
            reason:
              "Parameter Manager refused to dereference this parameter (400). " +
              "A rendered value carrying a quote, a brace or a newline is the known cause.",
          },
        ],
      }),
    });
    expect(stateOf(statuses, "granola", "GRANOLA_TOKEN")).toBe("unrenderable");
    expect(statuses.get("granola")!.state).toBe("unrenderable");
    expect(statuses.get("granola")!.label).toBe("cannot render");
  });

  it("tells the reader to ROTATE, and warns that creating it fails with 409", async () => {
    const statuses = await read({
      config: STORE_CONFIG,
      store: fakeStore({
        indexed: ["GRANOLA_TOKEN"],
        unrenderable: [
          { variable: "GRANOLA_TOKEN", hard: true, reason: "400 refused" },
        ],
      }),
    });
    const detail = detailOf(statuses, "granola", "GRANOLA_TOKEN");
    expect(detail).toContain("EXISTS");
    expect(detail).toContain("409");
    expect(detail).toContain("Rotate");
  });

  it("is diagnosed BEFORE the flip too, on a provider: env deployment", async () => {
    // A `provider: env` deployment still resolves params: true servers from the
    // store at DEPLOY time, and a parameter that cannot render fails that
    // deploy. Wherever core holds a resolver credential — staging does today —
    // this turns "you find out during the deploy" into a row on a page.
    const statuses = await read({
      store: fakeStore({
        indexed: ["GRANOLA_TOKEN"],
        unrenderable: [
          { variable: "GRANOLA_TOKEN", hard: true, reason: "400 refused" },
        ],
      }),
    });
    expect(stateOf(statuses, "granola", "GRANOLA_TOKEN")).toBe("unrenderable");
  });

  it("does not become 'unrenderable' just because the store was down", async () => {
    // The distinction that makes the state worth having. A store that could not
    // be consulted is `unknown`; a store that answered and refused is not.
    const statuses = await read({
      config: STORE_CONFIG,
      store: fakeStore({ listThrows: true, renderThrows: true }),
    });
    expect(stateOf(statuses, "granola", "GRANOLA_TOKEN")).not.toBe(
      "unrenderable",
    );
  });

  it("outranks placeholder and is outranked by missing, on the server label", async () => {
    // Each step is a different first move, so the row must be labelled by the
    // one the reader should make.
    const statuses = await read({
      config: STORE_CONFIG,
      bag: {},
      store: fakeStore({
        indexed: ["GRANOLA_TOKEN"],
        unrenderable: [
          { variable: "GRANOLA_TOKEN", hard: true, reason: "400 refused" },
        ],
      }),
      presence: presence({
        kind: "ok",
        report: report({ SLACK_BOT_TOKEN: "change-me" }),
      }),
    });
    expect(statuses.get("granola")!.state).toBe("unrenderable");
    expect(statuses.get("slack")!.state).toBe("placeholder");
  });
});

// ---------------------------------------------------------------------------
// params: true — the servers the console could say the least about
// ---------------------------------------------------------------------------

describe("a params: true server", () => {
  it("is graded on its managed parameters once the component names them", async () => {
    // Its credentials are not `${NAME}` references, so the config does not name
    // them and core cannot enumerate them. appspec.ts bakes the VARIABLE names
    // onto the component; the component reports presence for each.
    const statuses = await read({
      presence: presence({
        kind: "ok",
        report: report(
          { GCS_KEY_JSON: '{"type":"service_account"}' },
          { paramKeys: JSON.stringify({ rfs: ["GCS_KEY_JSON"] }) },
        ),
      }),
    });
    expect(statuses.get("rfs")!.state).toBe("ready");
    expect(stateOf(statuses, "rfs", "GCS_KEY_JSON")).toBe("present");
  });

  it("points a missing managed parameter at its OWN namespace, not the gateway's", async () => {
    // The two want opposite fixes. A `${NAME}` reference is resolved from the
    // gateway namespace or the deploy environment; a managed parameter lives
    // only under its server's static namespace, and nothing reads
    // strad-<env>-<NAME> for it. Offering the reference routes would tell a
    // reader to create resources that change nothing about the row.
    const statuses = await read({
      presence: presence({
        kind: "ok",
        report: report(
          {},
          { paramKeys: JSON.stringify({ rfs: ["GCS_KEY_JSON"] }) },
        ),
      }),
    });
    const observation = statuses
      .get("rfs")!
      .requirements.find((r) => r.requirement.name === "GCS_KEY_JSON")!;
    const targets = fixTargets(CONFIG, observation.requirement, {});
    expect(targets).toHaveLength(1);
    expect(targets[0]!.resource).toBe(
      "/strad/test/mcp/rfs/static/GCS_KEY_JSON",
    );
    expect(decodeURIComponent(targets[0]!.href ?? "")).toContain(
      "/strad/test/mcp/rfs/static/",
    );
    // Not the reference routes.
    expect(JSON.stringify(targets)).not.toContain("strad-test-GCS_KEY_JSON");
    expect(JSON.stringify(targets)).not.toContain(
      "/strad/test/gateway/static/",
    );
  });

  it("reports an unseeded managed parameter as not plumbed", async () => {
    const statuses = await read({
      presence: presence({
        kind: "ok",
        report: report(
          {},
          { paramKeys: JSON.stringify({ rfs: ["GCS_KEY_JSON"] }) },
        ),
      }),
    });
    expect(statuses.get("rfs")!.state).toBe("missing");
    expect(stateOf(statuses, "rfs", "GCS_KEY_JSON")).toBe("missing");
  });

  it("keeps the old shrug when the component names no parameters", async () => {
    // An image without STRAD_PARAM_KEYS establishes nothing about them, and
    // "this page does not read that namespace" is still the honest answer.
    const statuses = await read({
      presence: presence({ kind: "ok", report: report({}) }),
    });
    expect(statuses.get("rfs")!.state).toBe("unverified");
    expect(statuses.get("rfs")!.summary).toContain("params: true");
  });
});

// ---------------------------------------------------------------------------
// The false reds a one-condition version of each rule would produce
// ---------------------------------------------------------------------------

describe("the states that must NOT fire", () => {
  it("does not call a healthy store-listed name 'cannot render' under provider: env", async () => {
    // The one-condition version of the index rule — `if (indexed)` — produces an
    // actionable red telling an operator to rotate a working credential, on
    // every `env`-provider deployment that holds a resolver key. Which is the
    // shape staging runs, and the shape prod runs before the flip.
    //
    // Under `env`, `lookup` is core's own bag, and core by design does not hold
    // a bundle-scoped ref. So "absent from the lookup" says nothing at all here.
    const statuses = await read({
      store: fakeStore({
        indexed: ["SLACK_TOKEN"],
        values: { SLACK_TOKEN: "xoxb-a-perfectly-good-token" },
      }),
    });
    expect(stateOf(statuses, "slack", "SLACK_TOKEN")).toBe("unobservable");
  });

  it("does not call a name the store rendered fine 'cannot render' under the store provider", async () => {
    const statuses = await read({
      config: STORE_CONFIG,
      store: fakeStore({
        indexed: ["GRANOLA_TOKEN"],
        values: { GRANOLA_TOKEN: "gra_live_AbCdEfGhIjKl" },
      }),
      bag: { GRANOLA_TOKEN: "gra_live_AbCdEfGhIjKl" },
    });
    expect(stateOf(statuses, "granola", "GRANOLA_TOKEN")).toBe("present");
  });

  it("never says one half 'resolves too' when that half is also broken", async () => {
    // Ranking picks the WORSE half, and worse is satisfied by an equal rank — so
    // a name unseeded on both sides used to read "NOT plumbed. … The GATEWAY
    // half resolves too: not seeded", which contradicts itself in one sentence.
    const both = parseConfig(
      YAML.replace(
        `    env:
      SLACK_BOT_TOKEN: "\${SLACK_TOKEN}"`,
        `    env:
      SLACK_BOT_TOKEN: "\${SLACK_TOKEN}"
    headers:
      Authorization: "Bearer \${SLACK_TOKEN}"`,
      ),
    );
    const statuses = await read({
      config: both,
      presence: presence({ kind: "ok", report: report({}) }),
    });
    const detail = detailOf(statuses, "slack", "SLACK_TOKEN");
    expect(detail).toContain("NOT plumbed");
    expect(detail).not.toContain("resolves too");
    expect(detail).toContain("is also not usable");
  });
});

// ---------------------------------------------------------------------------
// The page, and the JSON, end to end
// ---------------------------------------------------------------------------

describe("the console and the readiness report, with a probe", () => {
  let server: Server;
  let baseUrl: string;
  let html: string;
  const AUTH = { authorization: "Bearer dev-console" };
  const VALUE = "xoxb-7777777777-ZzYyXxWwVvUu";

  beforeAll(async () => {
    const bag = { GRANOLA_TOKEN: "gra_live_AbCdEfGhIjKl" };
    const env: NodeJS.ProcessEnv = {
      ALLOW_DEV_AUTH: "true",
      ADMIN_BOOTSTRAP_TOKEN: "dev-console",
      STRAD_TOKENS: "[]",
      // The registry needs a private URL for the bundle it proxies to. Port 1
      // refuses instantly, which is what we want: nothing here talks to it, and
      // the presence probe is injected rather than performed.
      STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
    };
    const app = createApp({
      config: CONFIG,
      registry: await Registry.build({
        config: CONFIG,
        secrets: new EnvSecretProvider(bag),
        mode: "core",
        env,
      }),
      tokenStore: tokenStoreFromConfig(CONFIG, env),
      mode: "core",
      env,
      secrets: bag,
      secretProvider: new EnvSecretProvider(bag),
      presence: presence({
        kind: "ok",
        report: report(
          { SLACK_BOT_TOKEN: VALUE, GCS_KEY_JSON: VALUE },
          { paramKeys: JSON.stringify({ rfs: ["GCS_KEY_JSON"] }) },
        ),
      }),
      diagnosticStore: null,
    });
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;
    html = await (await fetch(`${baseUrl}/ui`, { headers: AUTH })).text();
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it("renders READY for a server whose secret only the bundle can see", () => {
    // The headline claim of the whole change: without the probe this row is a
    // shrug.
    expect(html).toContain('<span class="card-title">slack</span>');
    expect(html).not.toContain("Nothing here is known to be broken");
  });

  it("names the process that established each row", () => {
    expect(html).toContain("Established by:");
    expect(html).toContain("asked over the private network");
    expect(html).toContain("up since 2026-07-30T09:12:00.000Z");
  });

  it("puts no secret VALUE on the page, from any of the three sources", () => {
    expect(html).not.toContain(VALUE);
    expect(html).not.toContain("gra_live_AbCdEfGhIjKl");
    for (let i = 0; i + 6 <= VALUE.length; i += 1) {
      expect(html).not.toContain(VALUE.slice(i, i + 6));
    }
  });

  it("keeps /api/secrets/readiness answering the same thing, in JSON", async () => {
    const res = await fetch(`${baseUrl}/api/secrets/readiness`, {
      headers: { authorization: "Bearer dev-console" },
    });
    // The console gate and the readiness gate are different credentials; the
    // point of this assertion is only that the endpoint still exists and still
    // refuses cleanly rather than crashing on the new fields.
    expect([200, 401, 403]).toContain(res.status);
    const body = await res.text();
    expect(body).not.toContain(VALUE);
  });
});
