import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { renderAppSpec } from "../src/deploy/appspec.ts";

/**
 * ONE CONSOLE PAGE, N PARAMETER STORES — the fences around the admin credential.
 *
 * `consoleStores:` puts several GCP projects behind one `/ui/<slug>` page, each
 * with its own admin service-account key. "Its OWN" is the property the field
 * exists for, and this file owns the config half of it:
 *
 *   1. Two entries may not NAME one `adminKeyVar`, and an `adminKeyVar` may not
 *      be a key — or a `${REF}` — that any server's `env:` carries. Both are
 *      hard errors, because both are inexpressible-or-broken.
 *   2. Two entries whose DIFFERENT names carry ONE `${REF}` is the same identity
 *      on two projects, and it is a WARNING. Sometimes it is right (prod and
 *      staging of one product); sometimes it crosses a system boundary. A human
 *      decides, and before this they were not told there was anything to decide.
 *   3. Two entries may not claim one parameter PATH. That one is an error, like
 *      its `mcpStores:` twin: the console would otherwise write a credential
 *      into whichever project was declared first.
 *   4. A `SECRETS_PROJECT_ID` left over from the single-store shape outvotes the
 *      list that replaced it in `storeProject()`, so the index and the store
 *      page would name different projects. A warning.
 */

const SECRETS = {
  SECRETS_ADMIN_KEY_JSON: key("strad-admin@strad-secrets-prod"),
  ZIMMER_SECRETS_ADMIN_KEY_JSON: key("zimmer-admin@zimmer-secrets-prod"),
  SECRETS_VIEWER_KEY_JSON: key("viewer@strad-secrets-prod"),
  // Not a credential — a project id written as a ref, which is the shape the
  // last case below asserts is not compared.
  SOME_PROJECT: "strad-secrets-prod",
};

function key(email: string): string {
  return JSON.stringify({
    client_email: `${email}.iam.gserviceaccount.com`,
    private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  });
}

/**
 * The shape production runs: two projects, two admin credentials, one page.
 *
 * Written as a builder rather than a constant because every case below is this
 * config with ONE line moved — which is exactly how the defect was reported.
 */
function config(opts: {
  /** `consoleEnv:` entries, verbatim. */
  consoleEnv?: Record<string, string>;
  /** `consoleStores:` entries, verbatim. */
  stores?: { project: string; namespaces: string[]; adminKeyVar: string }[];
  /** Extra `env:` entries on the same server. */
  env?: Record<string, string>;
}): string {
  const consoleEnv = opts.consoleEnv ?? {
    SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY_JSON}",
    ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON:
      "${ZIMMER_SECRETS_ADMIN_KEY_JSON}",
  };
  const stores = opts.stores ?? [
    {
      project: "strad-secrets-prod",
      namespaces: ["/strad/prod/mcp/"],
      adminKeyVar: "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
    },
    {
      project: "zimmer-secrets-prod",
      namespaces: ["/zimmer/production/mcp/"],
      adminKeyVar: "ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
    },
  ];
  const line = (indent: string, kv: Record<string, string>) =>
    Object.entries(kv)
      .map(([k, v]) => `${indent}${k}: ${JSON.stringify(v)}`)
      .join("\n");

  return `
version: 1
gateway: { name: strad, env: prod }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
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
${line("      ", { SECRETS_CONSOLE_URL: "https://strad.example/ui/secrets", ...(opts.env ?? {}) })}
    consoleEnv:
${line("      ", consoleEnv)}
    consoleStores:
${stores
  .map(
    (s) =>
      `      - project: ${s.project}\n` +
      `        namespaces: [${s.namespaces.join(", ")}]\n` +
      `        adminKeyVar: ${s.adminKeyVar}`,
  )
  .join("\n")}
`;
}

/** What `parseConfig` — and therefore `check-config` — refuses. */
function problems(yaml: string): string[] {
  try {
    parseConfig(yaml, "test.yaml");
    return [];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

/** What `renderAppSpec` — and therefore `check-config` — merely says. */
function warnings(yaml: string): string[] {
  const found: string[] = [];
  renderAppSpec({
    config: parseConfig(yaml, "test.yaml"),
    appName: "strad-test",
    region: "nyc",
    image: { registry_type: "GHCR", repository: "strad", tag: "test" },
    env: [],
    secrets: SECRETS,
    onWarning: (m) => found.push(m),
  });
  return found;
}

/** Only the warnings about a shared admin credential. */
function sharedCredentialWarnings(yaml: string): string[] {
  return warnings(yaml).filter((m) => m.includes("admin credential from"));
}

describe("consoleStores: one admin credential behind two stores", () => {
  it("warns when two adminKeyVar NAMES carry the same ${REF}", () => {
    // The issue's repro, exactly: Zimmer's production store keeps its own
    // consoleEnv: key and is pointed at strad's credential.
    const found = sharedCredentialWarnings(
      config({
        consoleEnv: {
          SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY_JSON}",
          ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON:
            "${SECRETS_ADMIN_KEY_JSON}",
        },
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("strad-secrets-prod");
    expect(found[0]).toContain("zimmer-secrets-prod");
    expect(found[0]).toContain("${SECRETS_ADMIN_KEY_JSON}");
    expect(found[0]).toContain("ONE service account reaches 2 projects");
  });

  it("still PARSES that config — this is visibility, not refusal", () => {
    // The distinction is the whole design. A hard error here would reject the
    // prod/staging shape below, which is deployed today.
    expect(
      problems(
        config({
          consoleEnv: {
            SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY_JSON}",
            ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON:
              "${SECRETS_ADMIN_KEY_JSON}",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("warns — and does not refuse — the legitimate prod/staging shape", () => {
    // One service account granted on both strad projects on purpose. This is
    // `tadasant-internal`'s real config; a ban would red the gate in front of a
    // push-triggered prod deploy.
    const prodAndStaging = config({
      consoleEnv: {
        SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY_JSON}",
        STAGING_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON:
          "${SECRETS_ADMIN_KEY_JSON}",
      },
      stores: [
        {
          project: "strad-secrets-prod",
          namespaces: ["/strad/prod/mcp/"],
          adminKeyVar: "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
        },
        {
          project: "strad-secrets-staging",
          namespaces: ["/strad/staging/mcp/"],
          adminKeyVar: "STAGING_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
        },
      ],
    });
    expect(problems(prodAndStaging)).toEqual([]);
    const found = sharedCredentialWarnings(prodAndStaging);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("strad-secrets-staging");
    // The message hands the judgement to the reader rather than making it.
    expect(found[0]).toContain("right when the projects are one system");
  });

  it("says nothing when each store has its own ${REF}", () => {
    expect(sharedCredentialWarnings(config({}))).toEqual([]);
  });

  it("names every project sharing one ref, not just the first pair", () => {
    const three = config({
      consoleEnv: {
        A_ADMIN_KEY: "${SECRETS_ADMIN_KEY_JSON}",
        B_ADMIN_KEY: "${SECRETS_ADMIN_KEY_JSON}",
        C_ADMIN_KEY: "${SECRETS_ADMIN_KEY_JSON}",
      },
      stores: [
        {
          project: "proj-a",
          namespaces: ["/a/"],
          adminKeyVar: "A_ADMIN_KEY",
        },
        {
          project: "proj-b",
          namespaces: ["/b/"],
          adminKeyVar: "B_ADMIN_KEY",
        },
        {
          project: "proj-c",
          namespaces: ["/c/"],
          adminKeyVar: "C_ADMIN_KEY",
        },
      ],
    });
    const found = sharedCredentialWarnings(three);
    // ONE line for the ref, naming all three — not three pairwise lines.
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("ONE service account reaches 3 projects");
    for (const p of ["proj-a", "proj-b", "proj-c"]) {
      expect(found[0]).toContain(p);
    }
  });

  it("says nothing for a DISABLED server", () => {
    const disabled = config({
      consoleEnv: {
        SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY_JSON}",
        ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON:
          "${SECRETS_ADMIN_KEY_JSON}",
      },
    }).replace(
      "    kind: supplementary-image",
      "    enabled: false\n    kind: supplementary-image",
    );
    expect(sharedCredentialWarnings(disabled)).toEqual([]);
  });
});

describe("consoleStores: the checks that stay hard errors", () => {
  it("still refuses two stores naming ONE adminKeyVar", () => {
    const [message] = problems(
      config({
        consoleEnv: {
          SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY_JSON}",
        },
        stores: [
          {
            project: "strad-secrets-prod",
            namespaces: ["/strad/prod/mcp/"],
            adminKeyVar: "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
          },
          {
            project: "zimmer-secrets-prod",
            namespaces: ["/zimmer/production/mcp/"],
            adminKeyVar: "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
          },
        ],
      }),
    );
    expect(message).toContain("both ");
    expect(message).toContain("name adminKeyVar");
    expect(message).toContain("one service account would reach both projects");
  });

  it("still refuses an adminKeyVar whose ${REF} any server's env: carries", () => {
    const [message] = problems(
      config({ env: { GOOGLE_CREDS_JSON: "${SECRETS_ADMIN_KEY_JSON}" } }),
    );
    expect(message).toContain("resolves its admin credential from");
    expect(message).toContain("declares that same reference under env:");
  });

  it("still refuses an adminKeyVar that is not a consoleEnv: key", () => {
    const [message] = problems(
      config({
        stores: [
          {
            project: "strad-secrets-prod",
            namespaces: ["/strad/prod/mcp/"],
            adminKeyVar: "TYPOED_ADMIN_KEY",
          },
        ],
      }),
    );
    expect(message).toContain("not declared");
    expect(message).toContain("consoleEnv:");
  });
});

describe("consoleStores: two stores may not claim one path", () => {
  it("refuses overlapping namespaces, like its mcpStores: twin", () => {
    const [message] = problems(
      config({
        stores: [
          {
            project: "strad-secrets-prod",
            namespaces: ["/strad/"],
            adminKeyVar: "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
          },
          {
            project: "zimmer-secrets-prod",
            namespaces: ["/strad/prod/mcp/"],
            adminKeyVar:
              "ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
          },
        ],
      }),
    );
    // Without this, `storeForPath` refuses the path at WRITE time — a console
    // write failing on a deployment that rendered and deployed clean.
    expect(message).toContain("overlap under consoleStores:");
    expect(message).toContain("could address either store");
    expect(message).toContain("storeForPath");
  });

  it("allows a store to repeat a prefix of its OWN namespaces", () => {
    // Same project, so no path is ambiguous: nothing selects between them.
    expect(
      problems(
        config({
          stores: [
            {
              project: "strad-secrets-prod",
              namespaces: ["/strad/prod/mcp/", "/strad/prod/mcp/deep/"],
              adminKeyVar: "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
            },
            {
              project: "zimmer-secrets-prod",
              namespaces: ["/zimmer/production/mcp/"],
              adminKeyVar:
                "ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("allows sibling namespaces that merely share a parent", () => {
    expect(
      problems(
        config({
          stores: [
            {
              project: "strad-secrets-prod",
              namespaces: ["/strad/prod/"],
              adminKeyVar: "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
            },
            {
              project: "zimmer-secrets-prod",
              namespaces: ["/strad/staging/"],
              adminKeyVar:
                "ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON",
            },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe("consoleStores: a leftover SECRETS_PROJECT_ID", () => {
  /** Only the warnings about the index/page project disagreement. */
  function found(yaml: string): string[] {
    return warnings(yaml).filter((m) => m.includes("SECRETS_PROJECT_ID names"));
  }

  it("warns when consoleEnv: names a project other than the default store", () => {
    const stale = config({
      consoleEnv: {
        SECRETS_PROJECT_ID: "zimmer-secrets-prod",
        SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY_JSON}",
        ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON:
          "${ZIMMER_SECRETS_ADMIN_KEY_JSON}",
      },
    });
    const messages = found(stale);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(
      'consoleEnv: SECRETS_PROJECT_ID names "zimmer-secrets-prod"',
    );
    expect(messages[0]).toContain(
      'consoleStores: defaults to "strad-secrets-prod"',
    );
    expect(messages[0]).toContain("lists");
    // It still parses: mid-migration a config may legitimately carry both.
    expect(problems(stale)).toEqual([]);
  });

  it("says so differently when the name matches no store at all", () => {
    const messages = found(
      config({
        consoleEnv: {
          SECRETS_PROJECT_ID: "some-retired-project",
          SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY_JSON}",
          ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON:
            "${ZIMMER_SECRETS_ADMIN_KEY_JSON}",
        },
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("does not list");
  });

  it("reads env: too, which storeProject() falls through to", () => {
    const messages = found(
      config({ env: { SECRETS_PROJECT_ID: "zimmer-secrets-prod" } }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("env: SECRETS_PROJECT_ID");
  });

  it("says nothing when it agrees with the default store", () => {
    expect(
      found(
        config({
          consoleEnv: {
            SECRETS_PROJECT_ID: "strad-secrets-prod",
            SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY_JSON}",
            ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON:
              "${ZIMMER_SECRETS_ADMIN_KEY_JSON}",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("says nothing when it is a ${REF} it cannot compare", () => {
    expect(
      found(
        config({
          consoleEnv: {
            SECRETS_PROJECT_ID: "${SOME_PROJECT}",
            SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${SECRETS_ADMIN_KEY_JSON}",
            ZIMMER_SECRETS_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON:
              "${ZIMMER_SECRETS_ADMIN_KEY_JSON}",
          },
        }),
      ),
    ).toEqual([]);
  });
});
