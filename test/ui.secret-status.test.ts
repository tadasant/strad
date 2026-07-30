import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
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
  SOURCE_TOOLTIP,
  storeProject,
  tally,
  type SecretRequirement,
} from "../src/ui/secret-status.ts";

/**
 * The Secrets Console.
 *
 * The derivation is where the value is, so most of this file is about it rather
 * than about markup. Three properties carry the page, and each of them is a way
 * the obvious implementation would have been wrong:
 *
 *   1. NOT VISIBLE HERE IS NOT MISSING. A supplementary image's `env:` is baked
 *      onto its own component; core cannot see it. A presence check that answered
 *      "not seeded" would paint a healthy 26-server fleet entirely red.
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
    // window of that body, and on a cold cache snapshot.ts re-throws it raw. A
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
      },
      {
        requirement: requirement("B"),
        state: "missing" as const,
        source: "GSM" as const,
        detail: "",
      },
      {
        requirement: requirement("C"),
        state: "placeholder" as const,
        source: "ENV" as const,
        detail: "",
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
  it("names the Secret Manager secret, the project and a paste-ready command", () => {
    const req = requirement("SLACK_BOT_TOKEN", { deliveries: ["bundle"] });
    const [first] = fixTargets(CONFIG, req, {});
    expect(first!.resource).toBe("strad-test-SLACK_BOT_TOKEN");
    expect(first!.project).toBe("strad-secrets-somewhere");
    expect(first!.commands.join("\n")).toContain(
      "gcloud secrets create strad-test-SLACK_BOT_TOKEN --project strad-secrets-somewhere",
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
// GET /secrets
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
    secrets: provider,
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
    secretProvider: provider,
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
  html = await (await fetch(`${baseUrl}/secrets`, { headers: AUTH })).text();
});

afterAll(() => server?.close());

describe("GET /secrets gate", () => {
  it("401s an anonymous request and leaks no secret NAME", async () => {
    const res = await fetch(`${baseUrl}/secrets`, { redirect: "manual" });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("Sign in required");
    for (const name of ["SLACK_BOT_TOKEN", "GRANOLA_TOKEN", "granola"]) {
      expect(body).not.toContain(name);
    }
  });

  it("is the SAME gate as /ui — not a softer door", async () => {
    const [mine, ui] = await Promise.all([
      fetch(`${baseUrl}/secrets`, { redirect: "manual" }),
      fetch(`${baseUrl}/ui`, { redirect: "manual" }),
    ]);
    expect(mine.status).toBe(ui.status);
  });
});

describe("GET /secrets", () => {
  it("serves HTML to a signed-in human", async () => {
    const res = await fetch(`${baseUrl}/secrets`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("<title>Secrets Console · strad</title>");
  });

  it("lists EVERY enabled server, healthy ones included", () => {
    // The roster is the feature: "slack is fine, granola is not" is the answer,
    // and a page listing only failures cannot give it.
    // Asserted on each server's own rendered slug/name element. A bare
    // toContain("secrets") passes on page chrome alone — "Secrets Console",
    // "no secrets", href="/ui/secrets" — with the server absent. Caught by the
    // fresh-eyes review.
    for (const slug of [
      "slack",
      "slack-readonly",
      "granola",
      "google-flights",
      "params-server",
    ]) {
      expect(html).toContain(`<span class="sec-name">${slug}</span>`);
    }
    // `gcs` is the one entry with a `title:`, so its slug renders in the
    // sec-slug code tag beside the title rather than as the heading.
    expect(html).toContain('<span class="sec-name">Object store</span>');
    expect(html).toContain('<code class="sec-slug">gcs</code>');
    expect(html).toContain('<span class="sec-name">secrets</span>');
    expect(html).toContain('<span class="panel-note">7 enabled</span>');
    expect(html).not.toContain("retired");
  });

  it("shows the placeholder server as needing attention, not as ready", () => {
    // GRANOLA_TOKEN resolves to "change-me": seeded, and evidently not working.
    expect(html).toContain("check value");
    expect(html).toContain("${GRANOLA_TOKEN}");
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
    expect(section).toContain(">present<");
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
    const res = await fetch(`${url}/secrets`, { headers: AUTH });
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
    const body = await (
      await fetch(`${url}/secrets`, { headers: AUTH })
    ).text();
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
    const body = await (
      await fetch(`${url}/secrets`, { headers: AUTH })
    ).text();
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
    const body = await (
      await fetch(`${url}/secrets`, { headers: AUTH })
    ).text();
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
      secrets: new EnvSecretProvider(SECRETS),
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

describe("the fourth console card on /", () => {
  it("links the Secrets Console from the landing page", async () => {
    const body = await (await fetch(`${baseUrl}/`, { headers: AUTH })).text();
    expect(body).toContain('href="/secrets"');
    expect(body).toContain("Secrets Console");
    // Still four, not three: the existing three must not have been displaced.
    for (const href of ['href="/ui"', 'href="/console"', 'href="/healthz"']) {
      expect(body).toContain(href);
    }
  });
});
