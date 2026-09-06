import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import type { BundleProbeOutcome } from "../src/gateway/bundle-presence.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { badgeFor, renderIndex } from "../src/ui/index-page.ts";
import {
  EnvSecretProvider,
  type SecretProvider,
} from "../src/secrets/provider/index.ts";
import {
  collectRequirements,
  deriveServerStatuses,
  fixTargets,
  observe,
  placeholderReason,
  secretLookup,
  SOURCE_TOOLTIP,
  storeProject,
  tally,
  type SecretObservation,
  type SecretRequirement,
  type ServerState,
} from "../src/ui/secret-status.ts";

/**
 * The secret roster, and the console index it lives on.
 *
 * The derivation is where the value is, so most of this file is about it rather
 * than about markup. Three properties carry it, and each of them is a way the
 * obvious implementation would have been wrong:
 *
 *   1. NOT VISIBLE HERE IS NOT MISSING. A supplementary image's `env:` is baked
 *      onto its own component; core cannot see it. A presence check that answered
 *      "not seeded" would paint a healthy 27-server fleet entirely red.
 *   2. A `consoleEnv:` VALUE IS FILED UNDER THE KEY, NOT THE REF NAME. Asking the
 *      provider for the ref name and believing the `null` is the exact bug
 *      `src/ui/resolve.ts` documents having shipped to production once.
 *   3. SEEDED IS NOT WORKING. A placeholder value is its own state, because that
 *      is what prod's `granola` actually is, and a page that called it healthy
 *      would be worse than no page.
 *
 * And one that is not about correctness but about trust: no test here may find a
 * secret VALUE in the rendered HTML, and no message this module produces may
 * quote one.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A config shaped like the real staging one, small enough to reason about:
 *   - a capability PAIR sharing one credential (the dedup case)
 *   - a supplementary server whose credential is bundle-scoped (the unobservable case)
 *   - a `consoleEnv:` ref whose value only ever appears under its KEY
 *   - a remote-http server with a placeholder token (the granola case)
 *   - a server with no secrets at all
 *   - a disabled server, whose secrets are required by nothing
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
      SLACK_BOT_TOKEN: "\${SLACK_BOT_TOKEN}"
  - slug: slack-readonly
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /slack
    entitlements: [admin]
    env:
      SLACK_BOT_TOKEN: "\${SLACK_BOT_TOKEN}"
    tools: { allow: [slack_get_channels] }
  - slug: gcs
    kind: supplementary-image
    title: Object store
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gcs
    entitlements: [admin]
    env:
      GCS_BUCKET: "demo-bucket"
      GCS_SERVICE_ACCOUNT_KEY_JSON: "\${GCS_KEY_JSON}"
    consoleEnv:
      GCS_SERVICE_ACCOUNT_KEY_JSON: "\${GCS_KEY_JSON}"
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "strad-secrets-somewhere"
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${SECRETS_VIEWER_KEY_JSON}"
    consoleEnv:
      SECRETS_PROJECT_ID: "strad-secrets-somewhere"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${SECRETS_ADMIN_KEY_JSON}"
  - slug: granola
    kind: remote-http
    url: https://mcp.granola.example.com/mcp
    description: 'A note mentioning \${NOT_A_REQUIREMENT} in prose.'
    headers:
      Authorization: "Bearer \${GRANOLA_TOKEN}"
    entitlements: [admin]
  - slug: google-flights
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /google-flights
    entitlements: [admin]
  - slug: params-server
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /params-server
    entitlements: [admin]
    params: true
    env:
      PARAMS_TOKEN: "\${PARAMS_TOKEN}"
  - slug: retired
    kind: remote-http
    url: https://retired.example.com/mcp
    enabled: false
    headers:
      Authorization: "Bearer \${RETIRED_ONLY_TOKEN}"
    entitlements: [admin]
`;

const CONFIG = parseConfig(YAML);
const STORE_CONFIG = parseConfig(
  YAML.replace(
    "  publicUrl: https://staging.strad.example.com",
    "  publicUrl: https://staging.strad.example.com\n  secrets: { provider: gcp-parameter-store }",
  ),
);

/** A lookup over a plain map, honouring the `null` = absent contract. */
function mapLookup(map: Record<string, string>) {
  return async (name: string) => map[name] ?? null;
}

const EMPTY_BAG: Record<string, string> = {};

function requirement(
  name: string,
  over: Partial<SecretRequirement> = {},
): SecretRequirement {
  return {
    name,
    deliveries: ["gateway"],
    slugs: [],
    consoleKeys: [],
    paramsSlugs: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// collectRequirements
// ---------------------------------------------------------------------------

describe("collectRequirements", () => {
  const reqs = collectRequirements(CONFIG);
  const byName = new Map(reqs.map((r) => [r.name, r]));

  it("deduplicates a secret shared across capability variants", () => {
    // slack and slack-readonly declare SLACK_BOT_TOKEN identically, on purpose.
    // One unseeded secret shared by two variants is ONE problem.
    const names = reqs.filter((r) => r.name === "SLACK_BOT_TOKEN");
    expect(names).toHaveLength(1);
    expect(names[0]!.slugs).toEqual(["slack", "slack-readonly"]);
  });

  it("ignores a DISABLED server's secrets entirely", () => {
    // The gateway does not mount it and render-spec skips it, so nothing
    // requires the secret and reporting it missing would invent a problem.
    expect(byName.has("RETIRED_ONLY_TOKEN")).toBe(false);
  });

  it("does not invent a requirement from a description", () => {
    // Only url/headers can carry a ref on a remote-http server. A `${...}` in
    // free-form prose is not a credential the gateway resolves.
    expect(byName.has("NOT_A_REQUIREMENT")).toBe(false);
    expect(byName.has("GRANOLA_TOKEN")).toBe(true);
  });

  it("scopes a supplementary env: ref to the bundle", () => {
    expect(byName.get("SLACK_BOT_TOKEN")!.deliveries).toEqual(["bundle"]);
  });

  it("scopes a remote-http header ref to the gateway", () => {
    expect(byName.get("GRANOLA_TOKEN")!.deliveries).toEqual(["gateway"]);
  });

  it("records a consoleEnv: ref with the KEY it lands under on core", () => {
    // The rendered spec carries the value under the key, never under the ref
    // name — so the key is the only thing there is to look for.
    const admin = byName.get("SECRETS_ADMIN_KEY_JSON")!;
    expect(admin.deliveries).toEqual(["console"]);
    expect(admin.consoleKeys).toEqual([
      "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
    ]);
  });

  it("unions both deliveries for a name declared under env: AND consoleEnv:", () => {
    const key = byName.get("GCS_KEY_JSON")!;
    expect(key.deliveries).toEqual(["console", "bundle"]);
    expect(key.consoleKeys).toEqual(["GCS_SERVICE_ACCOUNT_KEY_JSON"]);
  });

  it("notes which params: true servers could home the value", () => {
    expect(byName.get("PARAMS_TOKEN")!.paramsSlugs).toEqual(["params-server"]);
    expect(byName.get("SLACK_BOT_TOKEN")!.paramsSlugs).toEqual([]);
  });

  it("does not treat a literal env value as a secret reference", () => {
    // GCS_BUCKET: "demo-bucket" and SECRETS_PROJECT_ID are plain config.
    expect(byName.has("GCS_BUCKET")).toBe(false);
    expect(byName.has("SECRETS_PROJECT_ID")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// placeholderReason
// ---------------------------------------------------------------------------

describe("placeholderReason", () => {
  const FILLER = [
    "placeholder",
    "PLACEHOLDER",
    "change-me",
    "changeme",
    "  change_me  ",
    "replace-me",
    "TODO",
    "tbd",
    "unset",
    "none",
    "n/a",
    "example",
    "dummy",
    "xxx",
    "",
    "   ",
    "${GRANOLA_TOKEN}",
    "a-real-looking-placeholder-token",
    "paste-your-token-here-<your-token>",
  ];

  it.each(FILLER)("flags %j as not a credential", (value) => {
    expect(placeholderReason(value)).not.toBeNull();
  });

  const REAL = [
    "xoxb-1234567890-0987654321-AbCdEfGhIjKlMnOpQrStUvWx",
    "tskey-api-abCDef1CNTRL-3xampl3",
    '{"client_email":"svc@p.iam.gserviceaccount.com","private_key":"-----BEGIN"}',
    "ops_eyJzaWduSW5BZGRyZXNzIjoibXkub25lcGFzc3dvcmQuY29tIn0",
    "gho_16C7e42F292c6912E7710c838347Ae178B4a",
  ];

  it.each(REAL)("does not flag a real-looking credential %j", (value) => {
    expect(placeholderReason(value)).toBeNull();
  });

  it("NEVER echoes the value it inspected", () => {
    // The whole point: if the check is wrong, the wrong answer must not have
    // printed the secret. A reason that quoted the value would do exactly that.
    for (const value of [...FILLER, ...REAL]) {
      const reason = placeholderReason(value);
      if (reason === null) continue;
      const trimmed = value.trim();
      if (trimmed.length >= 3) expect(reason).not.toContain(trimmed);
    }
  });
});

// ---------------------------------------------------------------------------
// observe — the four states, and the two that are easy to get wrong
// ---------------------------------------------------------------------------

describe("observe", () => {
  it("reports a resolvable gateway secret as present", async () => {
    const [o] = await observe([requirement("GRANOLA_TOKEN")], {
      config: CONFIG,
      lookup: mapLookup({ GRANOLA_TOKEN: "gr-live-abc123def456" }),
      bag: EMPTY_BAG,
    });
    expect(o!.state).toBe("present");
    // Honest about what presence proves.
    expect(o!.detail).toContain("does not call");
  });

  it("reports a resolvable but PLACEHOLDER value as its own state", async () => {
    // Prod's granola: the gateway boots, lists every other server, and granola's
    // upstream 401s in isolation. Presence alone would call this healthy.
    const [o] = await observe([requirement("GRANOLA_TOKEN")], {
      config: CONFIG,
      lookup: mapLookup({ GRANOLA_TOKEN: "change-me" }),
      bag: EMPTY_BAG,
    });
    expect(o!.state).toBe("placeholder");
    expect(o!.detail).not.toContain("change-me");
  });

  it("asks the referencing server's OWN namespace before calling it missing", async () => {
    // THE FALSE RED THIS PREVENTS. A credential filed under
    // /strad/{env}/mcp/{slug}/static/ is what the gateway actually resolves, so
    // a name-only lookup would paint the row red on a deployment where the
    // server works — and send the reader to seed a second copy in the shared
    // namespace, which is the shape this is moving away from.
    const lookup = secretLookup(EMPTY_BAG, {
      shared: { get: async () => null },
      forServer: (slug: string) => ({
        get: async (name: string) =>
          slug === "anki" && name === "ANKI_MCP_API_KEY"
            ? "live-anki-key-abc123def456"
            : null,
      }),
    });

    const [seeded] = await observe(
      [requirement("ANKI_MCP_API_KEY", { slugs: ["anki"] })],
      { config: CONFIG, lookup, bag: EMPTY_BAG },
    );
    expect(seeded!.state).toBe("present");

    // ...and a slug that holds nothing still reports missing, naming both the
    // shared path and its own, so the reader knows which one to create.
    const [absent] = await observe(
      [requirement("OTHER_TOKEN", { slugs: ["other"] })],
      { config: STORE_CONFIG, lookup, bag: EMPTY_BAG },
    );
    expect(absent!.state).toBe("missing");
    expect(absent!.detail).toContain("/strad/test/gateway/static/OTHER_TOKEN");
    expect(absent!.detail).toContain(
      "/strad/test/mcp/other/static/OTHER_TOKEN",
    );
  });

  it("calls a name MISSING when only SOME referencing servers hold it", async () => {
    // The console must agree with the deploy gate. `coveredPerServer` is
    // all-or-nothing per name: the unseeded server falls through to the shared
    // namespace, which does not have it either, so it throws on every request.
    // A green row here would say the opposite of what the deploy is about to do.
    const lookup = secretLookup(EMPTY_BAG, {
      shared: { get: async () => null },
      forServer: (slug: string) => ({
        get: async (name: string) =>
          slug === "seeded" && name === "SHARED_TOKEN"
            ? "live-token-abc123def456"
            : null,
      }),
    });

    const [both] = await observe(
      [requirement("SHARED_TOKEN", { slugs: ["seeded", "unseeded"] })],
      { config: STORE_CONFIG, lookup, bag: EMPTY_BAG },
    );
    expect(both!.state).toBe("missing");

    // ...and present once the other one holds it too.
    const [alone] = await observe(
      [requirement("SHARED_TOKEN", { slugs: ["seeded"] })],
      { config: STORE_CONFIG, lookup, bag: EMPTY_BAG },
    );
    expect(alone!.state).toBe("present");
  });

  it("settles a row from the shared layer without reading any per-server namespace", async () => {
    // Cost, not correctness — but the cost is what made this worth writing.
    // Every per-server provider holds its own namespace snapshot and resolving
    // one enumerates the whole project, and `observe()` fans out over every
    // requirement at once. Asking layer 1 first turned a single readiness poll
    // into one full enumeration per referencing slug. A hit on the shared layer
    // already means every referencing server resolves the name, so there is
    // nothing left to ask.
    const asked: string[] = [];
    const lookup = secretLookup(EMPTY_BAG, {
      shared: { get: async () => "live-shared-abc123def456" },
      forServer: (slug: string) => {
        asked.push(slug);
        return { get: async () => "live-shared-abc123def456" };
      },
    });

    const [o] = await observe(
      [requirement("GRANOLA_TOKEN", { slugs: ["a", "b", "c"] })],
      { config: STORE_CONFIG, lookup, bag: EMPTY_BAG },
    );
    expect(o!.state).toBe("present");
    expect(asked).toEqual([]);
  });

  it("reports an absent gateway secret as missing", async () => {
    const [o] = await observe([requirement("GRANOLA_TOKEN")], {
      config: CONFIG,
      lookup: mapLookup({}),
      bag: EMPTY_BAG,
    });
    expect(o!.state).toBe("missing");
  });

  it("reports a bundle-scoped secret as UNOBSERVABLE, not missing", async () => {
    // THE regression this whole module is shaped around. Under the `env`
    // provider a supplementary image's env: is baked onto its own component and
    // never broadcast to core, so core's inability to see it says nothing.
    const [o] = await observe(
      [requirement("SLACK_BOT_TOKEN", { deliveries: ["bundle"] })],
      { config: CONFIG, lookup: mapLookup({}), bag: EMPTY_BAG },
    );
    expect(o!.state).toBe("unobservable");
    expect(o!.detail).toContain("fails the render");
  });

  it("reports the SAME bundle secret as missing on a store-backed deployment", async () => {
    // The store holds the deploy-time source of truth for a bundle ref too, so
    // here the absence is real — and this is the pre-deploy discoverability win.
    const [o] = await observe(
      [requirement("SLACK_BOT_TOKEN", { deliveries: ["bundle"] })],
      { config: STORE_CONFIG, lookup: mapLookup({}), bag: EMPTY_BAG },
    );
    expect(o!.state).toBe("missing");
    expect(o!.detail).toContain("/strad/test/gateway/static/SLACK_BOT_TOKEN");
  });

  it("finds a consoleEnv: value under its KEY, not its ref name", async () => {
    // The production bug src/ui/resolve.ts documents: a rendered spec carries
    // SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON=<value> on core and never injects
    // the ref name anywhere, so asking the provider for the ref name and
    // believing the null reported a missing credential that was right there.
    const req = requirement("SECRETS_ADMIN_KEY_JSON", {
      deliveries: ["console"],
      consoleKeys: ["SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON"],
    });
    const [o] = await observe([req], {
      config: CONFIG,
      lookup: mapLookup({}), // the ref name resolves NOWHERE, as designed
      bag: {
        SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON:
          '{"client_email":"admin@p.iam.gserviceaccount.com"}',
      },
    });
    expect(o!.state).toBe("present");
    expect(o!.detail).toContain("SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON");
  });

  it("does NOT let a store hit satisfy a consoleEnv: ref — that is a false green", async () => {
    // Caught in inline review. `render-spec` resolves consoleEnv: from the deploy
    // ENVIRONMENT and refuses to read it from the store, because filing the
    // console's store-admin credential inside the store would let the weaker
    // resolver credential read the stronger one. So on a store-backed deployment
    // a provider hit on the ref NAME proves nothing about what core can read:
    // someone seeding /strad/test/gateway/static/SECRETS_ADMIN_KEY_JSON would turn
    // this row green while /ui/secrets stayed dead.
    const req = requirement("SECRETS_ADMIN_KEY_JSON", {
      deliveries: ["console"],
      consoleKeys: ["SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON"],
    });
    const [o] = await observe([req], {
      config: STORE_CONFIG,
      // The store HAS it under the ref name...
      lookup: mapLookup({ SECRETS_ADMIN_KEY_JSON: '{"client_email":"a@b"}' }),
      // ...and core's environment does not, which is what actually decides.
      bag: EMPTY_BAG,
    });
    expect(o!.state).toBe("missing");
    expect(o!.detail).toContain("a value in the store does not fix this");
  });

  it("accepts a consoleEnv: ref spelled directly in core's environment (the dev shape)", async () => {
    // `npm run dev` sets the ref name in .env and resolve.ts resolves the ref
    // against the boot bag, so this spelling is legitimate — from the BAG, which
    // is what core can actually read, not from the store.
    const req = requirement("SECRETS_ADMIN_KEY_JSON", {
      deliveries: ["console"],
      consoleKeys: ["SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON"],
    });
    const [o] = await observe([req], {
      config: CONFIG,
      lookup: mapLookup({}),
      bag: { SECRETS_ADMIN_KEY_JSON: '{"client_email":"a@b"}' },
    });
    expect(o!.state).toBe("present");
    expect(o!.source).toBe("ENV");
  });

  it("reports the CONSOLE half of a bundle+console name, rather than hiding it as unverified", async () => {
    // Also caught in inline review. `gcs` declares one name under BOTH env: and
    // consoleEnv:. With the key absent from core, /ui/gcs is broken — and the
    // earlier ordering reported `unobservable` for the whole row, because the
    // bundle half cannot be checked. Under-reporting a definite miss is the wrong
    // direction, so the console half wins and the detail says which half it is.
    const req = requirement("GCS_KEY_JSON", {
      deliveries: ["console", "bundle"],
      consoleKeys: ["GCS_SERVICE_ACCOUNT_KEY_JSON"],
    });
    const [o] = await observe([req], {
      config: CONFIG,
      lookup: mapLookup({}),
      bag: EMPTY_BAG,
    });
    expect(o!.state).toBe("missing");
    expect(o!.detail).toContain("This row is about the console half");
  });

  it("NEVER renders a backend error body — a SyntaxError window is a secret leak", async () => {
    // THE leak the fresh-eyes review caught. A store read ends in JSON.parse over
    // a `:render`ed payload, which is the dereferenced secret in plaintext. A
    // corrupted envelope throws a SyntaxError whose message embeds a ~30-char
    // window of that body, and on a cold view view.ts re-throws it raw. A
    // 200-char cap does not help — the window sits well inside it. Only reducing
    // a non-ParameterStoreError to its CLASS NAME does.
    const secret = "SUPERSECRETTOKENVALUE1234567890";
    let thrown: unknown;
    try {
      // The shape gcp.ts -> decodeEnvelope -> JSON.parse actually hits on a
      // corrupted `:render` payload, whose `value` is the dereferenced secret.
      JSON.parse(`{"path":"/p","secret":true,"value":@"${secret}"}`);
    } catch (err) {
      thrown = err;
    }
    // Node's "Unexpected token" form embeds a window of the body it choked on.
    // It is a PARTIAL leak — a prefix of the value — which is still a leak, and
    // it sits well inside any 200-char cap.
    expect(String((thrown as Error).message)).toContain("SUPERSEC");
    const [o] = await observe([requirement("X_TOKEN")], {
      config: STORE_CONFIG,
      lookup: async () => {
        throw thrown;
      },
      bag: EMPTY_BAG,
    });
    expect(o!.state).toBe("error");
    expect(o!.detail).not.toContain(secret);
    expect(o!.detail).not.toContain("SUPERSEC");
    expect(o!.detail).toContain("SyntaxError");
  });

  it("summarises a TIMEOUT by class too, not just a throw", async () => {
    // The deadline and the throw are two exits from the same read, and after
    // the deadline wrapper moved into `src/util/deadline.ts` they are two
    // exits from the same `catch` here. Asserting the timeout one keeps the
    // defence covering both: a future wrapper that resolved a sentinel of its
    // own instead of rejecting would take this row past `errorSummary`
    // entirely, and this test is what would notice.
    const [o] = await observe([requirement("X_TOKEN")], {
      config: STORE_CONFIG,
      lookup: () =>
        new Promise(() => {
          /* never settles */
        }),
      bag: EMPTY_BAG,
      timeoutMs: 20,
    });
    expect(o!.state).toBe("error");
    // A class name, and nothing the wrapper wrote in its message — the name of
    // the secret is in that message, and this row is the one surface on the
    // page that prints text from outside it.
    expect(o!.detail).toContain("Detail: Error");
    expect(o!.detail).not.toContain("did not answer within");
    expect(o!.detail).not.toContain("X_TOKEN");
  });

  it("passes a ParameterStoreError message through, since it is known value-free", async () => {
    // gcp.ts builds it from method + resource with the query and `:verb`
    // stripped, so it is the one backend message worth showing an operator.
    class ParameterStoreError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "ParameterStoreError";
      }
    }
    const [o] = await observe([requirement("X_TOKEN")], {
      config: STORE_CONFIG,
      lookup: async () => {
        throw new ParameterStoreError(
          "GET /v1/projects/p/parameters failed: 503",
        );
      },
      bag: EMPTY_BAG,
    });
    expect(o!.detail).toContain("503");
  });

  it("reports a consoleEnv: ref absent under BOTH spellings as missing", async () => {
    const req = requirement("SECRETS_ADMIN_KEY_JSON", {
      deliveries: ["console"],
      consoleKeys: ["SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON"],
    });
    const [o] = await observe([req], {
      config: CONFIG,
      lookup: mapLookup({}),
      bag: EMPTY_BAG,
    });
    expect(o!.state).toBe("missing");
    expect(o!.detail).toContain("never from the");
  });

  it("distinguishes a BACKEND FAILURE from an absent secret", async () => {
    // Collapsing these would turn a store outage into a wall of red "not
    // seeded" and send someone rotating secrets that were never gone.
    const [o] = await observe([requirement("GRANOLA_TOKEN")], {
      config: STORE_CONFIG,
      lookup: async () => {
        throw new Error("parameter store unreachable: 503");
      },
      bag: EMPTY_BAG,
    });
    expect(o!.state).toBe("error");
    expect(o!.detail).toContain("NOT absent");
  });

  it("degrades ONE hanging name to error without hanging the others", async () => {
    const reqs = [
      requirement("SLOW_TOKEN"),
      requirement("FAST_TOKEN"),
      requirement("OTHER_TOKEN"),
    ];
    const started = Date.now();
    const out = await observe(reqs, {
      config: CONFIG,
      lookup: (name) =>
        name === "SLOW_TOKEN"
          ? new Promise(() => {
              /* never settles */
            })
          : Promise.resolve("gr-live-abc123def456"),
      bag: EMPTY_BAG,
      timeoutMs: 30,
    });
    expect(out.map((o) => o.state)).toEqual(["error", "present", "present"]);
    // Concurrent, so the whole page costs one timeout rather than one per name.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// The secret-source badge
// ---------------------------------------------------------------------------

describe("the GSM / ENV source badge", () => {
  it("uses exactly the two labels Zimmer's Connectors page uses", () => {
    // The workflow is to read Zimmer's Connectors screen and this one and
    // compare. A divergent spelling — "secret-manager", "gcp", "process env" —
    // defeats the badge, so the labels and their expansions are asserted rather
    // than left to drift.
    expect(SOURCE_TOOLTIP).toEqual({
      GSM: "Google Secret Manager",
      ENV: "Process environment",
    });
  });

  it("is ENV when the value comes out of this process's environment", async () => {
    const [o] = await observe([requirement("GRANOLA_TOKEN")], {
      config: CONFIG,
      lookup: mapLookup({ GRANOLA_TOKEN: "gr-live-abc123def456" }),
      bag: EMPTY_BAG,
    });
    expect(o!.source).toBe("ENV");
  });

  it("is GSM when a store-backed deployment resolves it from the store", async () => {
    const [o] = await observe([requirement("GRANOLA_TOKEN")], {
      config: STORE_CONFIG,
      lookup: mapLookup({ GRANOLA_TOKEN: "gr-live-abc123def456" }),
      bag: EMPTY_BAG,
    });
    expect(o!.source).toBe("GSM");
  });

  it("is ENV for a consoleEnv: name even on a store-backed deployment", async () => {
    // consoleEnv: is read from the deploy environment only and never from the
    // store, because it carries the console's store-admin credential.
    const req = requirement("SECRETS_ADMIN_KEY_JSON", {
      deliveries: ["console"],
      consoleKeys: ["SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON"],
    });
    const [o] = await observe([req], {
      config: STORE_CONFIG,
      lookup: mapLookup({}),
      bag: { SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: '{"client_email":"a@b"}' },
    });
    expect(o!.state).toBe("present");
    expect(o!.source).toBe("ENV");
  });

  it("is GSM on a not-seeded row, naming where the value has to go", async () => {
    const [o] = await observe([requirement("NOTION_TOKEN")], {
      config: CONFIG,
      lookup: mapLookup({}),
      bag: EMPTY_BAG,
    });
    expect(o!.state).toBe("missing");
    expect(o!.source).toBe("GSM");
  });

  it("is GSM for a bundle-scoped value core cannot see, because GSM still holds it", async () => {
    const [o] = await observe(
      [requirement("SLACK_BOT_TOKEN", { deliveries: ["bundle"] })],
      { config: CONFIG, lookup: mapLookup({}), bag: EMPTY_BAG },
    );
    expect(o!.state).toBe("unobservable");
    expect(o!.source).toBe("GSM");
  });

  it("carries NO source when the backend could not be consulted", async () => {
    // Naming a store for a value whose backend is down would be the same class of
    // lie as reporting it "not seeded".
    const [o] = await observe([requirement("GRANOLA_TOKEN")], {
      config: STORE_CONFIG,
      lookup: async () => {
        throw new Error("store unreachable");
      },
      bag: EMPTY_BAG,
    });
    expect(o!.state).toBe("error");
    expect(o!.source).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveServerStatuses
// ---------------------------------------------------------------------------

describe("deriveServerStatuses", () => {
  /** Observe the whole config against one bag, the way the route does. */
  async function statuses(
    config = CONFIG,
    values: Record<string, string> = {},
    bag: Record<string, string> = {},
  ) {
    const observations = await observe(collectRequirements(config), {
      config,
      lookup: mapLookup(values),
      bag,
    });
    return new Map(
      deriveServerStatuses(config, observations).map((s) => [s.server.slug, s]),
    );
  }

  it("marks a server with NO refs as no-secrets, not as ready", async () => {
    const s = (await statuses()).get("google-flights")!;
    expect(s.state).toBe("no-secrets");
    expect(s.requirements).toHaveLength(0);
  });

  it("omits disabled servers from the roster", async () => {
    expect((await statuses()).has("retired")).toBe(false);
  });

  it("is ready only when every requirement resolves", async () => {
    const s = await statuses(CONFIG, {
      SLACK_BOT_TOKEN: "xoxb-1234567890-AbCdEfGhIjKl",
      GRANOLA_TOKEN: "gr-live-abc123def456",
      GCS_KEY_JSON: '{"client_email":"a@b.iam.gserviceaccount.com"}',
      SECRETS_VIEWER_KEY_JSON: '{"client_email":"v@b.iam.gserviceaccount.com"}',
      SECRETS_ADMIN_KEY_JSON: '{"client_email":"a@b.iam.gserviceaccount.com"}',
      PARAMS_TOKEN: "pt-live-9f8e7d6c5b4a",
    });
    expect(s.get("slack")!.state).toBe("ready");
    expect(s.get("granola")!.state).toBe("ready");
    // Ready never claims the credential works.
    expect(s.get("slack")!.summary).toContain("not verified");
  });

  it("ranks missing above placeholder above error above unverified", async () => {
    const observations = [
      {
        requirement: requirement("A"),
        state: "unobservable" as const,
        source: "GSM" as const,
        detail: "",
        evidence: { by: "none" as const },
      },
      {
        requirement: requirement("B"),
        state: "missing" as const,
        source: "GSM" as const,
        detail: "",
        evidence: { by: "none" as const },
      },
      {
        requirement: requirement("C"),
        state: "placeholder" as const,
        source: "ENV" as const,
        detail: "",
        evidence: { by: "core" as const },
      },
    ];
    const cfg = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: multi
    kind: remote-http
    url: "https://x.example.com/\${A}"
    headers: { Authorization: "Bearer \${B}", X-Other: "\${C}" }
    entitlements: [admin]
`);
    const [s] = deriveServerStatuses(cfg, observations);
    expect(s!.state).toBe("missing");
    expect(s!.summary).toContain("B");
    expect(s!.summary).not.toContain("C");
  });

  it("surfaces a placeholder as check-value, not as ready", async () => {
    const s = await statuses(CONFIG, {
      GRANOLA_TOKEN: "placeholder",
      SLACK_BOT_TOKEN: "xoxb-1234567890-AbCdEfGhIjKl",
    });
    expect(s.get("granola")!.state).toBe("placeholder");
    expect(s.get("granola")!.label).toBe("check value");
  });

  it("reports a bundle-only server as unverified when nothing is visible", async () => {
    const s = await statuses();
    expect(s.get("slack")!.state).toBe("unverified");
    expect(s.get("slack-readonly")!.state).toBe("unverified");
  });

  it("tallies the roster for the header", async () => {
    const s = [...(await statuses()).values()];
    const counts = tally(s);
    expect(
      counts.ready + counts["no-secrets"] + counts.unverified + counts.missing,
    ).toBe(s.length);
    expect(counts["no-secrets"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// fixTargets — the whole point of the page
// ---------------------------------------------------------------------------

describe("fixTargets", () => {
  it("names the Secret Manager secret and a recipe whose project is the reader's", () => {
    const req = requirement("SLACK_BOT_TOKEN", { deliveries: ["bundle"] });
    const [first] = fixTargets(CONFIG, req, {});
    expect(first!.resource).toBe("strad-test-SLACK_BOT_TOKEN");
    expect(first!.project).toBeNull();
    expect(first!.commands.join("\n")).toContain(
      'gcloud secrets create strad-test-SLACK_BOT_TOKEN --project "$DEPLOY_SECRETS_PROJECT" --replication-policy automatic',
    );
    expect(first!.commands.join("\n")).toContain(
      'printf %s "$VALUE" | gcloud secrets versions add strad-test-SLACK_BOT_TOKEN --project "$DEPLOY_SECRETS_PROJECT" --data-file=-',
    );
  });

  it("names the canonical parameter path, and links the console that can write it", () => {
    const req = requirement("SLACK_BOT_TOKEN", { deliveries: ["bundle"] });
    const store = fixTargets(CONFIG, req, {}).find((t) =>
      t.resource.startsWith("/strad/"),
    )!;
    expect(store.resource).toBe("/strad/test/gateway/static/SLACK_BOT_TOKEN");
    expect(store.href).toBe(
      "/ui/secrets?ns=%2Fstrad%2Ftest%2Fgateway%2Fstatic%2F",
    );
  });

  it("puts the STORE first on a store-backed deployment, and the bake first otherwise", () => {
    const req = requirement("SLACK_BOT_TOKEN", { deliveries: ["bundle"] });
    expect(fixTargets(STORE_CONFIG, req, {})[0]!.resource).toBe(
      "/strad/test/gateway/static/SLACK_BOT_TOKEN",
    );
    expect(fixTargets(CONFIG, req, {})[0]!.resource).toBe(
      "strad-test-SLACK_BOT_TOKEN",
    );
  });

  it("offers a params: true namespace LAST, labelled as not a fix for this row", () => {
    // It used to be offered FIRST, under a heading reading "most likely route
    // first" — and it does not resolve a ${NAME} REFERENCE at all: render-spec
    // looks a referenced name up in the gateway namespace then the environment
    // and exits 1 if neither has it, before resolveServerParams runs. So the
    // first thing a reader was told to do left the deploy failing identically.
    const req = requirement("PARAMS_TOKEN", {
      deliveries: ["bundle"],
      paramsSlugs: ["params-server"],
    });
    const targets = fixTargets(CONFIG, req, {});
    const last = targets[targets.length - 1]!;
    expect(last.resource).toBe(
      "/strad/test/mcp/params-server/static/PARAMS_TOKEN",
    );
    expect(last.detail).toContain("NOT a fix for this row");
    // ...and an actual fix is offered ahead of it.
    expect(targets[0]!.resource).toBe("strad-test-PARAMS_TOKEN");
  });

  it("words the per-server route by DELIVERY, not by namespace", () => {
    // When a value takes effect is decided by how it is delivered. A gateway ref
    // is read on the request path; a supplementary env: ref is baked at render
    // time whichever namespace it came out of. Promising "no redeploy" for the
    // second would be a promise the route does not keep.
    const runtime = fixTargets(
      STORE_CONFIG,
      requirement("ANKI_MCP_API_KEY", {
        deliveries: ["gateway"],
        slugs: ["anki"],
      }),
      {},
    )[0]!;
    expect(runtime.resource).toBe(
      "/strad/test/mcp/anki/static/ANKI_MCP_API_KEY",
    );
    expect(runtime.detail).toContain("no redeploy");

    const baked = fixTargets(
      STORE_CONFIG,
      requirement("SHOP_PASSWORD", { deliveries: ["bundle"], slugs: ["shop"] }),
      {},
    )[0]!;
    expect(baked.resource).toBe("/strad/test/mcp/shop/static/SHOP_PASSWORD");
    expect(baked.detail).toContain("NEXT DEPLOY");
    expect(baked.detail).not.toContain("no redeploy");
  });

  it("says a multi-server name needs EVERY referencing server to resolve it", () => {
    const targets = fixTargets(
      STORE_CONFIG,
      requirement("SHARED_TOKEN", {
        deliveries: ["gateway"],
        slugs: ["one", "two"],
      }),
      {},
    );
    expect(targets[0]!.detail).toContain("EVERY one of them");
  });

  it("routes a consoleEnv-only name to the deploy environment, never the store", () => {
    // Filing the console's admin credential inside the store would let the
    // weaker resolver credential read the stronger one.
    const req = requirement("SECRETS_ADMIN_KEY_JSON", {
      deliveries: ["console"],
      consoleKeys: ["SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON"],
    });
    const targets = fixTargets(STORE_CONFIG, req, {});
    expect(targets).toHaveLength(1);
    expect(targets[0]!.resource).toBe("strad-test-SECRETS_ADMIN_KEY_JSON");
    expect(targets[0]!.detail).toContain("never from the parameter store");
  });
});

// ---------------------------------------------------------------------------
// The `strad-<env>-*` recipe, on a deployment whose two projects differ
// ---------------------------------------------------------------------------

/**
 * The arrangement `infra/strad.staging.yaml` INSTRUCTS, in miniature.
 *
 * The parameter store is `strad-params-test` and it is deliberately not the
 * IAM boundary: strad's own `strad-test-*` secrets live somewhere else, so that
 * the store's viewer and admin cannot reach them. WHERE else is a deploy-
 * environment fact — `GCP_PROJECT_ID` in the deploy workflow — and no fixture
 * can supply it, because the running gateway is not told it either. That is the
 * whole point: every project id reachable from here is the wrong one.
 */
const SPLIT = parseConfig(`
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: gcp-parameter-store }
auth: { staticTokens: { enabled: true } }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "strad-params-test"
      SECRETS_NAMESPACES: "/strad/test/mcp/"
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${SECRETS_VIEWER_KEY_JSON}"
    consoleEnv:
      SECRETS_PROJECT_ID: "strad-params-test"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${SECRETS_ADMIN_KEY_JSON}"
`);

/** Every project id this process could possibly reach, and none of them is it. */
const RESOLVER_ENV_SPLIT = { STRAD_PARAMS_PROJECT_ID: "strad-resolver-test" };

describe("the Secret Manager recipe when the two projects differ", () => {
  const smRoute = (req: SecretRequirement, env: NodeJS.ProcessEnv = {}) => {
    const target = fixTargets(SPLIT, req, env).find(
      (t) => t.resource === "strad-test-SHOP_PASSWORD",
    );
    expect(target).toBeDefined();
    return target!;
  };

  it("names no project on the baked route, and prints none in the command", () => {
    // THE DEFECT THIS CLOSES. `<P>` is not `storeProject()` — that answers
    // "which GCP project holds the PARAMETER store", and a paste against it
    // SUCCEEDS, seeding the name where the deploy will never look for it.
    const baked = smRoute(
      requirement("SHOP_PASSWORD", { deliveries: ["bundle"] }),
    );
    expect(baked.project).toBeNull();
    const printed = baked.commands.join("\n");
    expect(printed).not.toContain("strad-params-test");
    expect(printed).not.toContain("strad-secrets-test");
    expect(printed).toContain("export DEPLOY_SECRETS_PROJECT=");
    expect(printed).toContain(
      'gcloud secrets create strad-test-SHOP_PASSWORD --project "$DEPLOY_SECRETS_PROJECT"',
    );
    expect(baked.detail).toContain("GCP_PROJECT_ID");
    expect(baked.detail).toContain("NOT that store's project");
  });

  it("does the same on the consoleEnv-only route, which is the other call site", () => {
    // Secret-Manager-only by construction: `consoleEnv:` is read from the deploy
    // environment and never from the store, so this route is the one that most
    // obviously belongs to the deploy's project and least obviously to the
    // store's.
    const target = fixTargets(
      SPLIT,
      requirement("SECRETS_ADMIN_KEY_JSON", {
        deliveries: ["console"],
        consoleKeys: ["SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON"],
      }),
      {},
    );
    expect(target).toHaveLength(1);
    expect(target[0]!.resource).toBe("strad-test-SECRETS_ADMIN_KEY_JSON");
    expect(target[0]!.project).toBeNull();
    expect(target[0]!.commands.join("\n")).not.toContain("strad-params-test");
    expect(target[0]!.commands.join("\n")).toContain(
      '--project "$DEPLOY_SECRETS_PROJECT"',
    );
    expect(target[0]!.detail).toContain("NOT that store's project");
  });

  it("does not reach for the RESOLVER's project either", () => {
    // `storeProject()` prefers `STRAD_PARAMS_PROJECT_ID` over everything the
    // config declares, and it is still the parameter store's — a third wrong
    // answer, not a better one.
    const printed = smRoute(
      requirement("SHOP_PASSWORD", { deliveries: ["bundle"] }),
      RESOLVER_ENV_SPLIT,
    ).commands.join("\n");
    expect(printed).not.toContain("strad-resolver-test");
  });

  it("still answers the PARAMETER path from the store that owns it", () => {
    // Untouched by this: a parameter path IS answered from the config, because
    // the store that covers the namespace declared its own project and the
    // resolver reads that same declaration.
    const path = fixTargets(
      SPLIT,
      requirement("SHOP_PASSWORD", {
        deliveries: ["gateway"],
        slugs: ["shop"],
      }),
      {},
    ).find((t) => t.resource.startsWith("/strad/"));
    expect(path!.project).toBe("strad-params-test");
  });

  it("refuses to quote a malformed secret name into a shell command", () => {
    // `gateway.env` is free-form YAML and it is half of the interpolated name.
    const hostile = parseConfig(`
version: 1
gateway: { name: strad, env: "test; rm -rf /" }
auth: { staticTokens: { enabled: true } }
servers: []
`);
    const printed = fixTargets(
      hostile,
      requirement("SHOP_PASSWORD", { deliveries: ["bundle"] }),
      {},
    )
      .find((t) => t.resource.startsWith("strad-"))!
      .commands.join("\n");
    expect(printed).toContain("No paste-ready command");
    expect(printed).not.toContain("gcloud secrets create");
    // The rejected name is not echoed either: it is the thing that failed the
    // shape test, so a newline in it would end the `#` and start a command.
    expect(printed).not.toContain("rm -rf");
  });
});

describe("storeProject", () => {
  it("prefers the resolver's own project id", () => {
    expect(
      storeProject(CONFIG, { STRAD_PARAMS_PROJECT_ID: "from-resolver" })
        .project,
    ).toBe("from-resolver");
  });

  it("falls back to the config's declared SECRETS_PROJECT_ID", () => {
    const out = storeProject(CONFIG, {});
    expect(out).toEqual({ project: "strad-secrets-somewhere", guessed: false });
  });

  it("only guesses the convention when the config declares nothing", () => {
    const bare = parseConfig(`
version: 1
gateway: { name: strad, env: prod }
auth: { staticTokens: { enabled: true } }
servers: []
`);
    expect(storeProject(bare, {})).toEqual({
      project: "strad-secrets-prod",
      guessed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// GET /ui — the console index
// ---------------------------------------------------------------------------

const BOOTSTRAP = "bootstrap-secret-xyz";
const AUTH = { authorization: `Bearer ${BOOTSTRAP}` };

/** Every value the page must never print. */
const SECRETS: Record<string, string> = {
  SLACK_BOT_TOKEN: "xoxb-000-111-SlackTokenValueNeverShown",
  GCS_SERVICE_ACCOUNT_KEY_JSON:
    '{"client_email":"svc@demo.iam.gserviceaccount.com","private_key":"GcsPrivateKeyNeverShown"}',
  SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON:
    '{"client_email":"admin@demo.iam.gserviceaccount.com","private_key":"AdminKeyNeverShown"}',
  GRANOLA_TOKEN: "change-me",
  STRAD_TOKENS: "[]",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_INTERNAL_TOKEN: "InternalTokenValueNeverShown",
};

const ENV: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

let server: Server;
let baseUrl: string;
let html: string;

async function boot(
  config: typeof CONFIG,
  provider: SecretProvider,
  bag: Record<string, string>,
): Promise<{ url: string; close: () => void }> {
  const registry = await Registry.build({
    config,
    secrets: sharedSecretProviders(provider),
    mode: "core",
    env: ENV,
  });
  const app = createApp({
    config,
    registry,
    tokenStore: tokenStoreFromConfig(config, ENV),
    mode: "core",
    env: ENV,
    secrets: bag,
    secretProvider: sharedSecretProviders(provider),
  });
  const s = app.listen(0);
  await new Promise<void>((r) => s.on("listening", () => r()));
  const addr = s.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  return { url: `http://127.0.0.1:${addr.port}`, close: () => s.close() };
}

beforeAll(async () => {
  const booted = await boot(CONFIG, new EnvSecretProvider(SECRETS), SECRETS);
  baseUrl = booted.url;
  server = { close: booted.close } as unknown as Server;
  html = await (await fetch(`${baseUrl}/ui`, { headers: AUTH })).text();
});

afterAll(() => server?.close());

describe("GET /ui gate", () => {
  it("401s an anonymous request and leaks no secret NAME", async () => {
    const res = await fetch(`${baseUrl}/ui`, { redirect: "manual" });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("Sign in required");
    for (const name of ["SLACK_BOT_TOKEN", "GRANOLA_TOKEN", "granola"]) {
      expect(body).not.toContain(name);
    }
  });

  it("gates the retired /secrets URL too, rather than redirecting anonymously", async () => {
    // The redirect sits BEHIND the gate. An open redirect to a gated page is not
    // a leak, but a door that answers differently to an anonymous caller is one
    // fewer thing to have to reason about.
    const res = await fetch(`${baseUrl}/secrets`, { redirect: "manual" });
    expect(res.status).toBe(401);
  });
});

describe("GET /secrets", () => {
  it("redirects to the index that absorbed it", async () => {
    // The roster was a destination of its own and is not one any more. The URL
    // was published — bookmarks, the AIR catalog, the docs — so it redirects
    // rather than 404s: a page whose content simply moved teaches nobody
    // anything by disappearing.
    const res = await fetch(`${baseUrl}/secrets`, {
      headers: AUTH,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ui");
  });
});

describe("GET /ui", () => {
  it("serves HTML to a signed-in human", async () => {
    const res = await fetch(`${baseUrl}/ui`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("<title>Servers · strad</title>");
  });

  it("lists EVERY server, healthy ones included", () => {
    // The roster is the feature: "slack is fine, granola is not" is the answer,
    // and a page listing only failures cannot give it.
    //
    // Asserted on each entry's own rendered title element. A bare
    // toContain("secrets") passes on page chrome alone — "no secrets",
    // href="/ui/secrets" — with the server absent. Caught by an earlier
    // fresh-eyes review, and the reason these are element assertions.
    for (const slug of [
      "slack",
      "slack-readonly",
      "granola",
      "google-flights",
      "params-server",
    ]) {
      expect(html).toContain(`<span class="card-title">${slug}</span>`);
    }
    // `gcs` and `secrets` have console views, so their titles are links.
    expect(html).toContain(">Object store</a>");
    expect(html).toContain('<code class="card-slug">gcs</code>');
    expect(html).toContain(">secrets</a>");
    expect(html).toContain('<span class="stat-l">enabled servers</span>');
    // A disabled server is still on the INDEX — /ui always listed every
    // configured server — but it carries no badge. It is the secret ROSTER that
    // omits it, because strad does not mount it.
    expect(html).toContain('<span class="chip chip-off">disabled</span>');
  });

  it("shows the placeholder server as ISSUE, not as READY", () => {
    // GRANOLA_TOKEN resolves to "change-me": seeded, and evidently not working.
    const at = html.indexOf(`data-fix-open="fix-granola"`);
    expect(at).toBeGreaterThan(-1);
    expect(html).toContain("${GRANOLA_TOKEN}");
    expect(html).toContain(
      '<span class="chip chip-warnish chip-route">placeholder</span>',
    );
  });

  it("names the exact GCP paths to fix it", () => {
    expect(html).toContain("strad-test-GRANOLA_TOKEN");
    expect(html).toContain("/strad/test/gateway/static/GRANOLA_TOKEN");
    expect(html).toContain("strad-secrets-somewhere");
    expect(html).toContain("gcloud secrets versions add");
  });

  it("finds the consoleEnv: admin credential under its KEY", () => {
    // The `secrets` server must NOT report a missing admin credential when the
    // value is in core's environment under the declared key.
    expect(html).not.toContain("SECRETS_ADMIN_KEY_JSON is not");
    const at = html.indexOf("${SECRETS_ADMIN_KEY_JSON}");
    expect(at).toBeGreaterThan(-1);
    const section = html.slice(at, at + 400);
    expect(section).toContain(">plumbed<");
    expect(section).not.toContain("not seeded");
  });

  it("renders a MIXED GSM / ENV source badge set, with the tooltips", () => {
    // A single-source page does not demonstrate the badge. This fixture has both:
    // values resolving from the process environment (ENV) alongside a
    // bundle-scoped one core cannot see and a not-seeded one (both GSM).
    expect(html).toContain('title="Google Secret Manager">GSM<');
    expect(html).toContain('title="Process environment">ENV<');
    const gsm = html.split('title="Google Secret Manager"').length - 1;
    const env = html.split('title="Process environment"').length - 1;
    expect(gsm).toBeGreaterThan(0);
    expect(env).toBeGreaterThan(0);

    // The rendered badge SET is exactly the two labels, and nothing else — a
    // third store would be a claim strad cannot back. Asserted on the markup the
    // badge actually emits rather than on a bare word, because the help guide
    // mentions Zimmer's `Rails Credentials` in prose to explain why it is absent
    // here, and a loose not.toContain would fail on that and prove nothing.
    const badges = [
      ...html.matchAll(/class="chip chip-src [^"]*"[^>]*>([^<]+)</g),
    ]
      .map((m) => m[1])
      .filter((v): v is string => v !== undefined);
    expect(badges.length).toBeGreaterThan(1);
    expect([...new Set(badges)].sort()).toEqual(["ENV", "GSM"]);
  });

  it("says a bundle-scoped secret is not visible here, rather than missing", () => {
    // Asserted on the CHIP, not on the words. The Help guide explains every state
    // in prose and is rendered on every request, so a bare
    // toContain("not visible here") passes with zero rows in that state — it was
    // written that way first, and caught in self-review.
    expect(html).toContain(
      '<span class="chip chip-plain chip-route">not visible here</span>',
    );
    // And the row it belongs to is a bundle-scoped secret, not something else.
    // PARAMS_TOKEN is declared only under a supplementary server's env: and is
    // absent from the bag, which is exactly the unobservable case.
    const at = html.indexOf("${PARAMS_TOKEN}");
    expect(at).toBeGreaterThan(-1);
    expect(html.slice(at, at + 600)).toContain("not visible here");
  });

  it("lists the gateway's own boot keys, and marks the optional ones optional", () => {
    // Every boot key is on the page, in a row of its own.
    for (const key of [
      "STRAD_TOKENS",
      "STRAD_INTERNAL_TOKEN",
      "ADMIN_BOOTSTRAP_TOKEN",
      "GOOGLE_CLIENT_ID",
      "CONSOLE_SESSION_SECRET",
    ]) {
      expect(html).toContain(`<span class="row-name">${key}</span>`);
    }
    // The two the deployment cannot work without carry `required`; the rest read
    // as optional rather than as a fault, since a deployment with no console
    // genuinely has no GOOGLE_CLIENT_SECRET.
    const required =
      html.split('<span class="chip chip-warnish">required</span>').length - 1;
    expect(required).toBe(2);
    expect(html).toContain(
      '<span class="chip chip-plain chip-route">not set · optional</span>',
    );
    // An absent OPTIONAL key must NOT be dressed as a problem.
    const at = html.indexOf('<span class="row-name">GOOGLE_CLIENT_ID</span>');
    expect(html.slice(at, at + 400)).not.toContain("not seeded");
  });

  it("leaks NO secret value", () => {
    for (const value of Object.values(SECRETS)) {
      // "[]" and "change-me" are too short/generic to assert usefully; every
      // real credential shape must be absent.
      if (value.length < 12) continue;
      expect(html).not.toContain(value);
    }
    expect(html).not.toContain("NeverShown");
  });

  it("does not print a placeholder value even while flagging it", () => {
    // The check read "change-me". A reason that quoted it would print a secret
    // in every case where the check was wrong.
    expect(html).not.toContain(">change-me<");
    expect(html).not.toContain("is change-me");
  });

  it("renders the page even when the provider throws for every name", async () => {
    // One sick backend must not take the page down — the states go unknown and
    // the roster still renders.
    const angry: SecretProvider = {
      name: "angry",
      get: async () => {
        throw new Error("store unreachable");
      },
      invalidate: () => {},
    };
    const { url, close } = await boot(STORE_CONFIG, angry, {});
    const res = await fetch(`${url}/ui`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("granola");
    // Assert the CHIP, not the word: GUIDE renders "<b>unknown</b> — the secret
    // backend could not be consulted" on every request, so toContain("unknown")
    // cannot fail. Caught by the fresh-eyes review.
    expect(body).toContain(
      '<span class="chip chip-warnish chip-route">unknown</span>',
    );
    expect(body).toContain("Status unknown, not absent");
    // ...and the banner must never read as a clean bill of health.
    expect(body).not.toContain("Every server&#39;s secrets resolve");
    close();
  });

  it("NEVER prints a clean bill of health when rows could not be checked", async () => {
    // The second blocker the fresh-eyes review caught. The banner was two-way and
    // keyed on `isActionable`, which is missing||placeholder — so `unknown` and
    // `unverified` counted as zero problems and a TOTAL STORE OUTAGE printed
    // "Every server's secrets resolve" across the top while every row below
    // correctly read `unknown`. The rows were honest; the headline was not, and
    // the headline is the part someone reads.
    const gatewayOnly = parseConfig(`
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: gcp-parameter-store }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: granola
    kind: remote-http
    url: https://x.example.com/mcp
    headers: { Authorization: "Bearer \${GRANOLA_TOKEN}" }
    entitlements: [admin]
`);
    const angry: SecretProvider = {
      name: "angry",
      get: async () => {
        throw new Error("store unreachable");
      },
      invalidate: () => {},
    };
    const { url, close } = await boot(gatewayOnly, angry, {});
    const body = await (await fetch(`${url}/ui`, { headers: AUTH })).text();
    expect(body).toContain("could not be checked");
    expect(body).toContain("That is not the same as healthy");
    expect(body).not.toContain("Every server&#39;s secrets resolve");
    close();
  });

  it("does not call a params: true server 'no secrets' when its credentials are managed", async () => {
    // Live on the real staging config: remote-filesystem-tmp-public sets
    // params: true and carries its GCS client email and private key as MANAGED
    // PARAMETERS, not ${NAME} refs — so it produced zero requirements and the
    // page reported it had nothing to seed. This page does not read that
    // namespace, so the honest answer is "not checked", not "nothing to check".
    const managed = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles: { admin: { servers: ["*"] } }
bundles: [{ name: bundle }]
servers:
  - slug: rfs
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /rfs
    entitlements: [admin]
    params: true
    env:
      RFS_GCS_BUCKET: "a-literal-bucket"
`);
    const { url, close } = await boot(managed, new EnvSecretProvider({}), {});
    const body = await (await fetch(`${url}/ui`, { headers: AUTH })).text();
    expect(body).not.toContain(
      '<span class="chip chip-plain chip-route">no secrets</span>',
    );
    expect(body).toContain("managed parameters");
    expect(body).toContain("/strad/test/mcp/rfs/static/");
    close();
  });

  it("escapes config-supplied strings", async () => {
    const hostile = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: hostile
    kind: remote-http
    url: https://x.example.com/mcp
    title: "<script>alert(1)</script>"
    headers: { Authorization: "Bearer \${HOSTILE_TOKEN}" }
    entitlements: [admin]
`);
    const { url, close } = await boot(hostile, new EnvSecretProvider({}), {});
    const body = await (await fetch(`${url}/ui`, { headers: AUTH })).text();
    expect(body).not.toContain("<script>alert");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    close();
  });
});

describe("GET /secrets in bundle mode", () => {
  it("is not mounted — a bundle component has no console at all", async () => {
    // The bundle image also serves an MCP server on the path `/secrets` inside
    // its own container. That is a different component with no console mounted,
    // and this asserts the two cannot be confused: with a VALID credential the
    // answer is 404, so it unambiguously means "not mounted" rather than "gated".
    const bundleEnv = { ...ENV, STRAD_BUNDLE: "bundle" };
    const registry = await Registry.build({
      config: CONFIG,
      secrets: sharedSecretProviders(new EnvSecretProvider(SECRETS)),
      mode: "bundle",
      env: bundleEnv,
    });
    const app = createApp({
      config: CONFIG,
      registry,
      tokenStore: tokenStoreFromConfig(CONFIG, bundleEnv),
      mode: "bundle",
      env: bundleEnv,
      secrets: SECRETS,
    });
    const s = app.listen(0);
    await new Promise<void>((r) => s.on("listening", () => r()));
    const addr = s.address();
    if (typeof addr === "string" || !addr) throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${addr.port}/secrets`, {
      headers: AUTH,
      redirect: "manual",
    });
    expect(res.status).toBe(404);
    s.close();
  });
});

// ---------------------------------------------------------------------------
// The scope behind a zero-requirement ISSUE entry
// ---------------------------------------------------------------------------

/**
 * A `params: true` server produces NO requirement rows when nothing manifested
 * its parameters, and the popout behind its `ISSUE` badge is built entirely from
 * `status.unobservable`. Every sentence in that panel is a claim about a
 * component, so each probe outcome has to map to the right one — a panel that
 * says "redeploy" where the answer is "seed it" is worse than the dead control
 * it replaced.
 */
describe("deriveServerStatuses — the unobservable scope", () => {
  const cfg = (extra = "") =>
    parseConfig(`
version: 1
gateway: { name: strad, env: test }
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
${extra}`);

  const report = (paramKeys: Record<string, string[]> | null) => ({
    protocol: 1,
    component: "bundle-internal",
    image: null,
    bootedAt: "2026-01-01T00:00:00.000Z",
    observedAt: "2026-01-01T00:00:00.000Z",
    keys: {},
    paramKeys,
  });

  const scopeFor = (probe?: BundleProbeOutcome) => {
    const presence = probe
      ? { probes: new Map([["bundle-internal", probe]]) }
      : undefined;
    const [s] = deriveServerStatuses(cfg(), [], presence);
    expect(s!.state).toBe("unverified");
    expect(s!.requirements).toHaveLength(0);
    return s!.unobservable;
  };

  it("is `unwired` when no private URL was bound", () => {
    const scope = scopeFor({ kind: "unwired" });
    expect(scope?.reason).toBe("unwired");
    expect(scope?.component).toBe("bundle-internal");
    expect(scope?.namespace).toBe("/strad/test/mcp/craigslist/static/");
    expect(scope?.detail).toContain("PRIVATE_URL");
  });

  it("is `unsupported` — a pin bump, explicitly not an outage", () => {
    const scope = scopeFor({ kind: "unsupported", detail: "404" });
    expect(scope?.reason).toBe("unsupported");
    expect(scope?.detail).toContain("PIN BUMP");
    expect(scope?.detail).toContain("up and serving");
  });

  it("is `unreachable`, and carries the probe's own diagnosis", () => {
    const scope = scopeFor({
      kind: "unreachable",
      detail: "REFUSED the token",
    });
    expect(scope?.reason).toBe("unreachable");
    expect(scope?.detail).toContain("REFUSED the token");
  });

  it("distinguishes a component that manifested NOTHING from one that listed none HERE", () => {
    // The distinction that matters, because the two want opposite first moves.
    // No manifest at all — a stale spec — must never tell anyone to seed.
    for (const paramKeys of [null, { other: ["OTHER_KEY"] }]) {
      const scope = scopeFor({ kind: "ok", report: report(paramKeys) });
      expect(scope?.reason).toBe("unmanifested");
      expect(scope?.detail).toContain("Redeploy");
      expect(scope?.detail).toContain("do NOT seed");
    }
    // An empty list FOR THIS SLUG is the store being empty, and that one does.
    const scope = scopeFor({ kind: "ok", report: report({ craigslist: [] }) });
    expect(scope?.reason).toBe("silent");
    expect(scope?.detail).toContain("nothing is seeded");
    expect(scope?.detail).not.toContain("Redeploy");
  });

  it("treats a bundle that was never probed as unwired, not as an answer", () => {
    expect(scopeFor(undefined)?.reason).toBe("unwired");
  });

  it("is ABSENT for a `params: true` builtin, whose params core resolves itself", () => {
    // The panel's every sentence is about a component core is not. A builtin's
    // bundle defaults to `core`, its managed parameters are resolved in-process
    // through the resolver TTL, and there is no ${core.PRIVATE_URL} to bind and
    // no container to redeploy — so a scope here would be confidently wrong.
    const builtin = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles: []
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
    params: true
`);
    const [s] = deriveServerStatuses(builtin, []);
    expect(s!.state).toBe("unverified");
    expect(s!.requirements).toHaveLength(0);
    expect(s!.unobservable).toBeUndefined();
  });
});

describe("deriveServerStatuses — a managed namespace nobody checked", () => {
  // THE MIXED SHAPE, and the false green it used to earn.
  //
  // A `params: true` server whose component named no parameters produces no
  // requirements OF ITS OWN. When it declares nothing else, the zero-row branch
  // says so and the badge reads ISSUE. When it also declares one ordinary
  // `${NAME}` that resolves, the entry used to be graded on THAT alone —
  // `requirements.length === 1`, worst `present`, badge READY — while the
  // credentials the server actually runs on had been checked by nothing.
  const cfg = (env = "") =>
    parseConfig(`
version: 1
gateway: { name: strad, env: test }
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
${env}`);

  const MIXED = `    env: { SOME_KEY: "\${SOME_REF}" }`;

  const observation = (
    state: SecretObservation["state"],
  ): SecretObservation => ({
    requirement: requirement("SOME_REF", { deliveries: ["bundle"] }),
    state,
    source: "ENV",
    detail: "",
    evidence: { by: "none" },
  });

  const unreachable = {
    probes: new Map<string, BundleProbeOutcome>([
      ["bundle-internal", { kind: "unreachable", detail: "ECONNREFUSED" }],
    ]),
  };

  it("demotes the entry instead of reading READY off an unrelated name", () => {
    const [s] = deriveServerStatuses(
      cfg(MIXED),
      [observation("present")],
      unreachable,
    );
    expect(s!.state).toBe("unverified");
    expect(badgeFor(s!.state)).toBe("ISSUE");
    // The resolving name is still shown — it IS plumbed, and "the other one
    // resolves" is part of the answer to "what do I do about this".
    expect(s!.requirements).toHaveLength(1);
    expect(s!.requirements[0]!.state).toBe("present");
    // And the panel now says which namespace went unchecked, which is the whole
    // of what a READY entry's popout never mentioned.
    expect(s!.summary).toContain("/strad/test/mcp/craigslist/static/");
    expect(s!.unobservable?.reason).toBe("unreachable");
  });

  it("still says ISSUE when the server declares nothing else", () => {
    // The zero-row shape, unchanged: the branch that was already honest stays
    // the branch that answers.
    const [s] = deriveServerStatuses(cfg(), [], unreachable);
    expect(s!.state).toBe("unverified");
    expect(badgeFor(s!.state)).toBe("ISSUE");
    expect(s!.requirements).toHaveLength(0);
    expect(s!.unobservable?.reason).toBe("unreachable");
  });

  it("does not bury worse news: an unseeded name still labels the row", () => {
    // `unobservable` ranks below every piece of bad news, so the gap demotes a
    // green and never overwrites a red. A row labelled "unverified" when a name
    // is flatly unseeded would be a lie of omission in the other direction.
    const [s] = deriveServerStatuses(
      cfg(MIXED),
      [observation("missing")],
      unreachable,
    );
    expect(s!.state).toBe("missing");
    expect(s!.summary).toContain("SOME_REF");
    // The gap is still reported — it is true, and the panel has room for it.
    expect(s!.unobservable?.reason).toBe("unreachable");
  });

  it("stays READY when the component DID manifest the parameters", () => {
    // No over-demotion: the component answered, named this slug's parameters,
    // and reports a value for each. That is an observation, so the entry is
    // graded on it like anything else.
    const presence = {
      probes: new Map<string, BundleProbeOutcome>([
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
              keys: {
                CRAIGSLIST_TOKEN: {
                  presence: "present" as const,
                  reason: null,
                },
              },
              paramKeys: { craigslist: ["CRAIGSLIST_TOKEN"] },
            },
          },
        ],
      ]),
    };
    const [s] = deriveServerStatuses(
      cfg(MIXED),
      [observation("present")],
      presence,
    );
    expect(s!.state).toBe("ready");
    expect(badgeFor(s!.state)).toBe("READY");
    expect(s!.requirements).toHaveLength(2);
    expect(s!.unobservable).toBeUndefined();
  });

  it("leaves a server WITHOUT `params: true` alone", () => {
    // The demotion is keyed off the managed namespace, not off the probe. A
    // server that declares no parameters has no namespace to go unchecked.
    const plain = parseConfig(`
version: 1
gateway: { name: strad, env: test }
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
    env: { SOME_KEY: "\${SOME_REF}" }
`);
    const [s] = deriveServerStatuses(
      plain,
      [observation("present")],
      unreachable,
    );
    expect(s!.state).toBe("ready");
    expect(s!.unobservable).toBeUndefined();
  });

  it("demotes a `params: true` BUILTIN too, with no scope behind it", () => {
    // The shape `infra/strad.staging.yaml` actually ships: `echo`, `params:
    // true`, and one `${STRAD_ENV}` in `options:`. Core never probes itself, so
    // the gap is permanent and the demotion is the honest answer — the same one
    // the zero-row branch has always given a bare `params: true` builtin.
    //
    // No scope: `unobservableScope` refuses to build one for a builtin, whose
    // parameters core resolves itself. That is #264, and it is a floor.
    const builtin = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles: []
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
    params: true
    options:
      greeting: "\${SOME_REF}"
`);
    const [s] = deriveServerStatuses(builtin, [observation("present")]);
    expect(s!.state).toBe("unverified");
    expect(badgeFor(s!.state)).toBe("ISSUE");
    expect(s!.requirements).toHaveLength(1);
    expect(s!.unobservable).toBeUndefined();
    // NOT "that is not what this server runs on": `optionsFor` merges the
    // parameters OVER the resolved options, so the reference IS part of it.
    expect(s!.summary).toContain("not all of what it needs");
    expect(s!.summary).not.toContain("not what this server runs on");
  });

  it("leaves the label to the worse state, whatever kind of bad news it is", () => {
    // The demotion is a floor under `present`, not a re-ranking. Every state
    // that outranks `unobservable` must still label the row.
    const cases: [SecretObservation["state"], ServerState][] = [
      ["placeholder", "placeholder"],
      ["unrenderable", "unrenderable"],
      ["error", "unknown"],
      // A requirement that is ITSELF unobservable ranks EQUAL, not below — the
      // guard is `<`, so the row's own summary answers rather than the gap's.
      ["unobservable", "unverified"],
    ];
    for (const [state, expected] of cases) {
      const [s] = deriveServerStatuses(
        cfg(MIXED),
        [observation(state)],
        unreachable,
      );
      expect(s!.state, `worst=${state}`).toBe(expected);
      expect(s!.summary, `worst=${state}`).toContain("SOME_REF");
      expect(s!.unobservable?.reason, `worst=${state}`).toBe("unreachable");
    }
  });

  it("keeps a `mayBeUnseeded` waiver reading as a deferral, not as a gap", () => {
    // `unconfigured` is a plan somebody has not finished and `unverified` is a
    // question nobody answered. `missing` outranks the gap, so the waiver still
    // decides the label.
    const waived = parseConfig(`
version: 1
gateway: { name: strad, env: test }
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
    mayBeUnseeded: [SOME_REF]
    env: { SOME_KEY: "\${SOME_REF}" }
`);
    const [s] = deriveServerStatuses(
      waived,
      [observation("missing")],
      unreachable,
    );
    expect(s!.state).toBe("unconfigured");
  });

  it("renders the namespace panel BELOW the rows, on an entry that has some", () => {
    // The popout is the whole remedy for the false green: a `READY` entry's
    // popout mentioned the namespace nowhere. Asserted against the MARKUP,
    // because the field being set is not the same as the block being emitted.
    const config = cfg(MIXED);
    const [status] = deriveServerStatuses(
      config,
      [observation("present")],
      unreachable,
    );
    const html = renderIndex({
      config,
      statuses: [status!],
      principal: {
        kind: "system-token",
        id: "t",
        label: "t",
        roles: ["admin"],
      },
      env: {},
      boot: [],
    });
    const dialog = html.slice(html.indexOf('<dialog class="fixdlg"'));
    // The requirement row is keyed off the `${NAME}` chip, the panel off the
    // component chip only `unobservableBlock` emits — not off the namespace
    // string, which the summary above both of them also names.
    const row = dialog.indexOf('<code class="sec-var">');
    const panel = dialog.indexOf('<code class="sec-component">');
    expect(row).toBeGreaterThan(-1);
    expect(panel).toBeGreaterThan(row);
    expect(dialog).toContain("not visible here");
    expect(dialog).toContain("/strad/test/mcp/craigslist/static/");
    // And the headline does not claim nothing was established, directly over a
    // row saying this gateway process established it.
    expect(dialog).not.toContain("nothing here was established either");
  });

  it("says nothing false about a BUILTIN, whose namespace core DOES read", () => {
    // The trap this test exists for. A `params: true` builtin gets no panel, so
    // the headline and the summary are the whole of its popout — and both must
    // stay narrow. `optionsFor` resolves that namespace in THIS process, per
    // tool call, so "nothing could read it" would be flatly false about the one
    // server most likely to render this line.
    const builtin = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles: []
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
    params: true
    options:
      greeting: "\${SOME_REF}"
`);
    const [status] = deriveServerStatuses(builtin, [observation("present")]);
    const html = renderIndex({
      config: builtin,
      statuses: [status!],
      principal: {
        kind: "system-token",
        id: "t",
        label: "t",
        roles: ["admin"],
      },
      env: {},
      boot: [],
    });
    const dialog = html.slice(html.indexOf('<dialog class="fixdlg"'));
    expect(dialog).toContain("THIS PAGE does not");
    expect(dialog).not.toContain("nothing here could read");
    expect(dialog).not.toContain("nothing here was established either");
    // No panel — `unobservableScope` builds none for a builtin — so the badge
    // still opens on the requirement rows rather than on an empty dialog.
    expect(dialog).not.toContain('<code class="sec-component">');
    expect(dialog).toContain('<code class="sec-var">');
    expect(dialog).toContain("/strad/test/mcp/echo/static/");
  });
});

describe("deriveServerStatuses — a managed parameter that shares a name", () => {
  // TWO CLAIMS ABOUT ONE NAME, AND ONE OF THEM USED TO BE DISCARDED (#280).
  //
  // A `params: true` server declares `${FOO}` and its component manifests a
  // managed parameter also called `FOO`. Those are not the same claim: the
  // reference row says this deployment can resolve a value out of the gateway
  // namespace, and the component's row says whether the running container holds
  // a variable of that name. One `seen` set shared between the two passes let
  // the reference row claim the name and dropped the component's report, so the
  // entry read READY over a component saying it holds nothing.
  const cfg = parseConfig(`
version: 1
gateway: { name: strad, env: test }
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

  /** The `${FOO}` reference, as the store answered for it. */
  const ref = (state: SecretObservation["state"]): SecretObservation => ({
    requirement: requirement("FOO", {
      deliveries: ["bundle"],
      slugs: ["craigslist"],
      paramsSlugs: ["craigslist"],
    }),
    state,
    source: "GSM",
    detail: "",
    evidence: { by: "store" },
  });

  /** The component, manifesting `FOO` as a managed parameter of this slug. */
  const manifesting = (presence: "present" | "absent") => ({
    probes: new Map<string, BundleProbeOutcome>([
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
            keys: { FOO: { presence, reason: null } },
            paramKeys: { craigslist: ["FOO"] },
          },
        },
      ],
    ]),
  });

  it("does not read READY when the component contradicts the resolving ref", () => {
    // The costly direction, and the one this whole entry exists for: the store
    // resolves `${FOO}`, the component reports no `FOO` at all, and the badge
    // used to be green off the first of those.
    const [s] = deriveServerStatuses(
      cfg,
      [ref("present")],
      manifesting("absent"),
    );
    expect(s!.state).toBe("missing");
    expect(badgeFor(s!.state)).toBe("ISSUE");
    // BOTH rows survive: the resolving reference is still true and still shown.
    expect(s!.requirements).toHaveLength(2);
    expect(s!.requirements.map((r) => r.state).sort()).toEqual([
      "missing",
      "present",
    ]);
    expect(s!.requirements.filter((r) => r.requirement.managed)).toHaveLength(
      1,
    );
    // TWO requirements, and the bad one says which claim it is. Two values at
    // two paths is what a reader is being told to seed, and "FOO, FOO" would
    // read as the page repeating itself.
    expect(s!.summary).toBe(
      "1 of 2 required secrets not seeded: FOO (managed parameter).",
    );
  });

  it("ranks the contradiction the other way round too", () => {
    // The mirror: the component holds a value and the reference the deploy
    // renders from does not resolve. A precedence that trusted the container
    // would have discarded this one, which is why neither side gets one.
    const [s] = deriveServerStatuses(
      cfg,
      [ref("missing")],
      manifesting("present"),
    );
    expect(s!.state).toBe("missing");
    expect(s!.requirements).toHaveLength(2);
  });

  it("does NOT over-demote when both sources agree the value is there", () => {
    // The guard against the fix becoming its own false red: two agreeing
    // observations are still two `present` rows, and the entry is READY.
    const [s] = deriveServerStatuses(
      cfg,
      [ref("present")],
      manifesting("present"),
    );
    expect(s!.state).toBe("ready");
    expect(badgeFor(s!.state)).toBe("READY");
    expect(s!.requirements).toHaveLength(2);
    expect(s!.unobservable).toBeUndefined();
    // Two requirements, because there are two values: the reference resolved
    // from the gateway namespace and the parameter under this server's own.
    expect(s!.summary).toContain("All 2 required secrets resolve");
  });

  it("keeps a `mayBeUnseeded` waiver off the component's report", () => {
    // A WAIVER IS ABOUT A `${NAME}`. `mayBeUnseeded:` is validated against the
    // names a server REFERENCES, so a waived name can only ever collide with a
    // managed parameter — and every clause of the `unconfigured` sentence would
    // be false about that row: nothing was deferred, no TTL activates it, and it
    // lands at the next deploy rather than on write. Relabelling it a deferral
    // would also sort it BELOW real absences in /api/secrets/readiness.
    const waived = parseConfig(`
version: 1
gateway: { name: strad, env: test }
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
    mayBeUnseeded: [FOO]
    env: { SOME_KEY: "\${FOO}" }
`);
    const [s] = deriveServerStatuses(
      waived,
      [ref("present")],
      manifesting("absent"),
    );
    expect(s!.state).toBe("missing");
    expect(s!.summary).toContain("FOO (managed parameter)");
    expect(s!.summary).not.toContain("mayBeUnseeded");
  });

  it("counts the two claims apart from an unrelated name", () => {
    // The count is of CLAIMS, and it has to stay one: a name whose reference
    // resolves must not be swept into "N of N not seeded" by its managed
    // namesake, and the name that IS unseeded on both counts must say so twice.
    const two = parseConfig(`
version: 1
gateway: { name: strad, env: test }
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
    env: { SOME_KEY: "\${FOO}", OTHER_KEY: "\${BAR}" }
`);
    const bar: SecretObservation = {
      requirement: requirement("BAR", {
        deliveries: ["bundle"],
        slugs: ["craigslist"],
      }),
      state: "missing",
      source: "GSM",
      detail: "",
      evidence: { by: "store" },
    };
    const [s] = deriveServerStatuses(
      two,
      [ref("present"), bar],
      manifesting("absent"),
    );
    expect(s!.state).toBe("missing");
    expect(s!.requirements).toHaveLength(3);
    // THREE requirements, TWO of them outstanding — and `${FOO}`, which
    // demonstrably resolves, is not one of them.
    expect(s!.summary).toBe(
      "2 of 3 required secrets not seeded: BAR, FOO (managed parameter).",
    );
  });

  it("sends the two rows to two different resources when both are unseeded", () => {
    // The load-bearing claim behind rendering both: they are seeded in two
    // different places. The reference is a gateway-namespace name with a Secret
    // Manager route; the managed parameter lives only under this server's static
    // namespace and has neither.
    const [status] = deriveServerStatuses(
      cfg,
      [ref("missing")],
      manifesting("absent"),
    );
    const html = renderIndex({
      config: cfg,
      statuses: [status!],
      principal: {
        kind: "system-token",
        id: "t",
        label: "t",
        roles: ["admin"],
      },
      env: {},
      boot: [],
    });
    const dialog = html.slice(html.indexOf('<dialog class="fixdlg"'));
    expect(dialog).toContain("/strad/test/mcp/craigslist/static/FOO");
    expect(dialog).toContain("strad-test-FOO");
    expect(status!.summary).toBe(
      "2 of 2 required secrets not seeded: FOO, FOO (managed parameter).",
    );
  });

  it("tells the two rows apart in the popout", () => {
    // Two rows under one name are only useful if a reader can see WHICH claim
    // each one is making. The reference renders as `${FOO}`; the managed
    // parameter renders as the variable it is, with a chip saying so.
    const [status] = deriveServerStatuses(
      cfg,
      [ref("present")],
      manifesting("absent"),
    );
    const html = renderIndex({
      config: cfg,
      statuses: [status!],
      principal: {
        kind: "system-token",
        id: "t",
        label: "t",
        roles: ["admin"],
      },
      env: {},
      boot: [],
    });
    const dialog = html.slice(html.indexOf('<dialog class="fixdlg"'));
    expect(dialog).toContain('<code class="sec-var">${FOO}</code>');
    expect(dialog).toContain('<code class="sec-var">FOO</code>');
    expect(dialog).toContain("managed parameter");
    // Worst first: the component's bad news is the row a reader hits first.
    expect(dialog.indexOf('<code class="sec-var">FOO</code>')).toBeLessThan(
      dialog.indexOf('<code class="sec-var">${FOO}</code>'),
    );
    // And it is guided to the namespace that actually holds it, not to the
    // gateway namespace a `${NAME}` would be seeded in.
    expect(dialog).toContain("/strad/test/mcp/craigslist/static/FOO");
  });
});

describe("the console cards on /", () => {
  it("offers ONE console card, not a second one for the secrets", async () => {
    const body = await (await fetch(`${baseUrl}/`, { headers: AUTH })).text();
    // The roster is on /ui now, so a second card pointing at /secrets would be
    // a second door onto the same page.
    expect(body).not.toContain('href="/secrets"');
    expect(body).toContain('href="/ui"');
    expect(body).toContain("whether the secrets it needs are seeded");
    // The other two must not have been displaced.
    for (const href of ['href="/console"', 'href="/healthz"']) {
      expect(body).toContain(href);
    }
  });
});
