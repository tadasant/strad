import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";
import {
  DEFAULT_PARAM_REFRESH_SECONDS,
  MIN_PARAM_REFRESH_SECONDS,
  PARAM_REFRESH_ENV,
  PARAM_REFRESH_SECONDS_ENV,
  paramRefreshSeconds,
  parseParamRefreshPlan,
} from "../src/secrets/param-route.ts";

/**
 * `paramsRefresh:` — the config gate, and what the renderer bakes for it.
 *
 * The schema bounds what a name may be, for exactly the reason `paramsWritable:`
 * does: core composes a store path out of the CONFIG's strings and never out of
 * a URL, so a name that is not a legal variable would compose a path pointing
 * somewhere else. The renderer's half is the manifest — the container never sees
 * strad's config, so the only way it can know which variables it may re-read is
 * for the render to bake the names on.
 */

const IMAGE = {
  registry_type: "GHCR" as const,
  registry: "tadasant",
  repository: "strad",
  tag: "latest",
};

function config(server: string, gateway = "{ name: strad, env: staging }") {
  return `
version: 1
gateway: ${gateway}
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
servers:
${server}`;
}

const FETCH = (extra: string, gateway?: string) =>
  config(
    `  - slug: strad-fetch
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /strad-fetch
    entitlements: [admin]
${extra}`,
    gateway,
  );

describe("the paramsRefresh schema rule", () => {
  it("accepts a legal variable alongside params: true", () => {
    const cfg = parseConfig(
      FETCH("    params: true\n    paramsRefresh: [BRIGHTDATA_API_KEY]\n"),
    );
    const server = cfg.servers[0]!;
    expect(
      server.kind === "supplementary-image" && server.paramsRefresh,
    ).toEqual(["BRIGHTDATA_API_KEY"]);
  });

  it("defaults to an empty list, so nothing refreshes by omission", () => {
    // THE WHOLE DEFAULT-OFF CLAIM. Prod runs 40+ slugs; a change in secret
    // resolution that switched itself on would touch all of them.
    const cfg = parseConfig(FETCH("    params: true\n"));
    const server = cfg.servers[0]!;
    expect(
      server.kind === "supplementary-image" && server.paramsRefresh,
    ).toEqual([]);
  });

  it("refuses paramsRefresh without params: true", () => {
    // Without that flag the namespace is not this server's environment at all,
    // so re-reading it would keep a value nothing injected current — the same
    // silent no-op the writable rule refuses, arrived at from the read side.
    expect(() =>
      parseConfig(FETCH("    paramsRefresh: [BRIGHTDATA_API_KEY]\n")),
    ).toThrow(/paramsRefresh: but not params: true/);
  });

  it("refuses a name that is not a legal environment variable", () => {
    for (const bad of ["nested/name", "2_LEADING_DIGIT", "has-a-dash"]) {
      expect(() =>
        parseConfig(FETCH(`    params: true\n    paramsRefresh: ["${bad}"]\n`)),
      ).toThrow(/not a legal environment variable name/);
    }
  });

  it("refuses two entries that differ only in case", () => {
    // A parameter path folds case before it hashes, so those are ONE parameter
    // under two variable names: one would resolve and the other 404 forever.
    expect(() =>
      parseConfig(
        FETCH(
          "    params: true\n    paramsRefresh: [BRIGHTDATA_API_KEY, brightdata_api_key]\n",
        ),
      ),
    ).toThrow(/ONE parameter under two variable names/);
  });

  it("names the offending list, not the other one", () => {
    // The two lists share a rule set; a message that said "paramsWritable" for a
    // paramsRefresh typo would send an operator to the wrong line of the config.
    expect(() =>
      parseConfig(FETCH("    params: true\n    paramsRefresh: [bad-name]\n")),
    ).toThrow(/under paramsRefresh:/);
    expect(() =>
      parseConfig(FETCH("    params: true\n    paramsWritable: [bad-name]\n")),
    ).toThrow(/under paramsWritable:/);
  });

  it("still enforces the paramsWritable rules it shares", () => {
    // The refactor that merged the two loops must not have dropped the original.
    expect(() => parseConfig(FETCH("    paramsWritable: [X_TOKEN]\n"))).toThrow(
      /paramsWritable: but not params: true/,
    );
  });
});

describe("gateway.secrets.paramRefreshSeconds", () => {
  it("defaults to 300", () => {
    expect(parseConfig(FETCH("")).gateway.secrets.paramRefreshSeconds).toBe(
      300,
    );
  });

  it("refuses a value under the floor", () => {
    // The poll's cost is paid whether or not anybody uses the credential, and
    // Parameter Manager has already 429'd three consecutive production deploys.
    expect(() =>
      parseConfig(
        FETCH(
          "",
          "{ name: strad, env: staging, secrets: { paramRefreshSeconds: 5 } }",
        ),
      ),
    ).toThrow();
  });

  it("accepts the floor itself", () => {
    expect(
      parseConfig(
        FETCH(
          "",
          "{ name: strad, env: staging, secrets: { paramRefreshSeconds: 30 } }",
        ),
      ).gateway.secrets.paramRefreshSeconds,
    ).toBe(MIN_PARAM_REFRESH_SECONDS);
  });
});

describe("what the renderer bakes onto the component", () => {
  const render = (yaml: string) =>
    renderAppSpec({
      config: parseConfig(yaml),
      appName: "strad",
      region: "nyc",
      image: IMAGE,
      env: [],
    });

  const envOf = (yaml: string) => {
    const bundle = render(yaml).services.find((s) => s.name === "bundle")!;
    return Object.fromEntries((bundle.envs ?? []).map((e) => [e.key, e]));
  };

  it("bakes the names and the interval as GENERAL vars", () => {
    const envs = envOf(
      FETCH(
        "    params: true\n    paramsRefresh: [BRIGHTDATA_API_KEY, FIRECRAWL_API_KEY]\n",
      ),
    );
    // NAMES ONLY, and so not a secret: every one of them is already in the
    // store, in the console and in the spec beside it.
    expect(envs[PARAM_REFRESH_ENV]!.type).toBe("GENERAL");
    expect(JSON.parse(envs[PARAM_REFRESH_ENV]!.value)).toEqual({
      "strad-fetch": ["BRIGHTDATA_API_KEY", "FIRECRAWL_API_KEY"],
    });
    expect(envs[PARAM_REFRESH_SECONDS_ENV]!.value).toBe("300");
  });

  it("carries the configured interval", () => {
    const envs = envOf(
      FETCH(
        "    params: true\n    paramsRefresh: [BRIGHTDATA_API_KEY]\n",
        "{ name: strad, env: staging, secrets: { paramRefreshSeconds: 900 } }",
      ),
    );
    expect(envs[PARAM_REFRESH_SECONDS_ENV]!.value).toBe("900");
  });

  it("omits both vars entirely when no server opted in", () => {
    // A spec diff should only move when the thing it describes moves. This is
    // also the proof that the default path renders byte-identically to before.
    const envs = envOf(FETCH("    params: true\n"));
    expect(envs[PARAM_REFRESH_ENV]).toBeUndefined();
    expect(envs[PARAM_REFRESH_SECONDS_ENV]).toBeUndefined();
  });

  it("takes the names from the CONFIG, not from what the store holds", () => {
    // A name a human listed but has not seeded yet has no resolved value to
    // bake. It must still be on the manifest: the first poll after somebody
    // seeds it is what puts it on the container, which is how "seed a credential
    // after the deploy" stops needing a redeploy as well as "rotate one".
    const envs = envOf(
      FETCH("    params: true\n    paramsRefresh: [NEVER_SEEDED_KEY]\n"),
    );
    expect(JSON.parse(envs[PARAM_REFRESH_ENV]!.value)).toEqual({
      "strad-fetch": ["NEVER_SEEDED_KEY"],
    });
    // ...and nothing was baked for it, because there is nothing to bake.
    expect(envs.NEVER_SEEDED_KEY).toBeUndefined();
  });

  it("unions the servers on one bundle", () => {
    const envs = envOf(
      config(`  - slug: strad-fetch
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /strad-fetch
    entitlements: [admin]
    params: true
    paramsRefresh: [BRIGHTDATA_API_KEY]
  - slug: telegram-ro
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /telegram-ro
    entitlements: [admin]
    params: true
    paramsRefresh: [TELEGRAM_STRING_SESSION]
`),
    );
    expect(JSON.parse(envs[PARAM_REFRESH_ENV]!.value)).toEqual({
      "strad-fetch": ["BRIGHTDATA_API_KEY"],
      "telegram-ro": ["TELEGRAM_STRING_SESSION"],
    });
  });

  it("ignores a disabled server", () => {
    // A disabled server contributes no component at all, so there is nowhere for
    // the manifest to land — which is the point: nothing on this deployment
    // re-reads a parameter for a slug that is not running.
    const spec = render(
      FETCH(
        "    enabled: false\n    params: true\n    paramsRefresh: [BRIGHTDATA_API_KEY]\n",
      ),
    );
    const everyEnv = spec.services.flatMap((s) => s.envs ?? []);
    expect(everyEnv.map((e) => e.key)).not.toContain(PARAM_REFRESH_ENV);
  });
});

describe("a refreshable name may not shadow a sibling's variable", () => {
  // THE HOLE THIS CLOSES. The existing shadow check (see appspec.ts) walks the
  // parameters the render RESOLVED, and for an ordinary `params: true` server
  // that is enough — an unseeded name reaches no container. A refreshable name
  // is different: it is a name the component may acquire LATER, when a human
  // seeds it, written under the same bare name the renderer would have used. So
  // a collision must be caught at render time even though there is no value yet,
  // or the credential of the sibling that owns that bare name gets silently
  // overwritten minutes after somebody clicks "create" in the console — long
  // after any deploy anyone would think to correlate it with.
  const twoServers = (refreshName: string) =>
    config(`  - slug: strad-fetch
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /strad-fetch
    entitlements: [admin]
    params: true
    paramsRefresh: [${refreshName}]
  - slug: slack
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /slack
    entitlements: [admin]
    env:
      SLACK_BOT_TOKEN: "a-literal-slack-token"
`);

  const render = (yaml: string) =>
    renderAppSpec({
      config: parseConfig(yaml),
      appName: "strad",
      region: "nyc",
      image: IMAGE,
      env: [],
    });

  it("refuses to render when the name is another server's on the same bundle", () => {
    expect(() => render(twoServers("SLACK_BOT_TOKEN"))).toThrow(
      /SLACK_BOT_TOKEN is contributed by more than one server/,
    );
  });

  it("renders fine when the refreshable name collides with nothing", () => {
    expect(() => render(twoServers("BRIGHTDATA_API_KEY"))).not.toThrow();
  });

  it("still lets a server shadow its OWN env: key with its own refreshable name", () => {
    // The documented migration path off a hand-written `${REF}` is a server
    // overriding itself, and it stays a deliberate single-server decision.
    expect(() =>
      render(
        FETCH(
          `    params: true
    paramsRefresh: [BRIGHTDATA_API_KEY]
    env:
      BRIGHTDATA_API_KEY: "the-value-this-config-was-written-with"
`,
        ),
      ),
    ).not.toThrow();
  });
});

describe("reading the manifest back, in the container", () => {
  // The container is handed this by a renderer it cannot verify, so every shape
  // is checked again here. A plan it cannot read is not a boot failure: it
  // refreshes nothing and keeps the values the deploy baked.
  it("round-trips what the renderer wrote", () => {
    expect(
      parseParamRefreshPlan({
        [PARAM_REFRESH_ENV]: JSON.stringify({
          "strad-fetch": ["BRIGHTDATA_API_KEY"],
        }),
      }),
    ).toEqual([{ slug: "strad-fetch", variables: ["BRIGHTDATA_API_KEY"] }]);
  });

  it("is empty when the variable is absent", () => {
    expect(parseParamRefreshPlan({})).toEqual([]);
  });

  for (const [label, raw] of [
    ["malformed JSON", "{not json"],
    ["an array", "[]"],
    ["a scalar", '"BRIGHTDATA_API_KEY"'],
  ] as const) {
    it(`refreshes nothing given ${label}`, () => {
      expect(parseParamRefreshPlan({ [PARAM_REFRESH_ENV]: raw })).toEqual([]);
    });
  }

  it("drops a slug or a variable that is not a legal name", () => {
    expect(
      parseParamRefreshPlan({
        [PARAM_REFRESH_ENV]: JSON.stringify({
          "../escape": ["A"],
          "strad-fetch": ["A", "nested/name", 7],
          "no-vars": [],
        }),
      }),
    ).toEqual([{ slug: "strad-fetch", variables: ["A"] }]);
  });

  it("clamps the interval to the floor, whatever the environment says", () => {
    // The schema's floor refuses the CONFIG; this one refuses the ENVIRONMENT,
    // which a component can be given by something other than this renderer.
    expect(paramRefreshSeconds({ [PARAM_REFRESH_SECONDS_ENV]: "1" })).toBe(
      MIN_PARAM_REFRESH_SECONDS,
    );
    expect(paramRefreshSeconds({ [PARAM_REFRESH_SECONDS_ENV]: "-9000" })).toBe(
      MIN_PARAM_REFRESH_SECONDS,
    );
    expect(
      paramRefreshSeconds({ [PARAM_REFRESH_SECONDS_ENV]: "nonsense" }),
    ).toBe(DEFAULT_PARAM_REFRESH_SECONDS);
    expect(paramRefreshSeconds({})).toBe(DEFAULT_PARAM_REFRESH_SECONDS);
    expect(paramRefreshSeconds({ [PARAM_REFRESH_SECONDS_ENV]: "900" })).toBe(
      900,
    );
  });
});
