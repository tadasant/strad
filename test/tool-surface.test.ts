import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  checkToolSurface,
  formatFinding,
  parseObservedMounts,
  type ObservedSurface,
} from "../src/deploy/tool-surface.ts";

/**
 * The pre-deploy half of allow-list drift.
 *
 * The bug is a `tools: allow` entry naming a tool the upstream no longer offers.
 * It does not error: the list is exhaustive and fail-closed, so the entry matches
 * nothing and that slug serves one tool fewer, quietly, until somebody notices a
 * missing capability. The gateway does report it — after the deploy. These tests
 * are about the check that runs before one.
 *
 * Half of them are about what it must NOT say. A gate that fails a good PR
 * because a mount was behind a credential CI does not hold is a gate somebody
 * disables, and then the drift is undetected again with a green tick on top.
 */

const IMAGE = "ghcr.io/tadasant/strad-bundle:latest";

const GMAIL_TOOLS = [
  "list_email_conversations",
  "get_email_conversation",
  "search_email_conversations",
  "download_email_attachments",
  "list_draft_emails",
  "change_email_conversation",
  "upsert_draft_email",
  "delete_draft_email",
  "send_email",
];

function surface(
  mounts: ObservedSurface["mounts"],
  image = "ghcr.io/tadasant/strad-bundle:ci",
): ObservedSurface {
  return { image, mounts };
}

function config(servers: string): ReturnType<typeof parseConfig> {
  return parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
  - name: bundle-internal
servers:
${servers}
`);
}

const GMAIL_RO = `  - slug: gmail-ro
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle
    path: /gmail
    entitlements: [admin]
    tools:
      allow:
        - list_email_conversations
        - get_email_conversation
`;

describe("checkToolSurface", () => {
  it("passes an allow list whose every entry the mount serves", () => {
    const result = checkToolSurface(
      config(GMAIL_RO),
      surface({ "/gmail": { tools: GMAIL_TOOLS } }),
    );

    expect(result.findings).toEqual([]);
    expect(result.checked).toEqual([
      { slug: "gmail-ro", mount: "/gmail", entries: 2 },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("catches the typo, and names the slug, the entry and the near miss", () => {
    // One character. This is the whole bug: it parses, it renders, it deploys,
    // and gmail-ro serves one tool fewer than its config says it does.
    const typo = GMAIL_RO.replace(
      "- list_email_conversations",
      "- list_email_conversation",
    );
    const result = checkToolSurface(
      config(typo),
      surface({ "/gmail": { tools: GMAIL_TOOLS } }),
    );

    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding).toMatchObject({
      slug: "gmail-ro",
      mount: "/gmail",
      kind: "allow",
      entry: "list_email_conversation",
      nearest: "list_email_conversations",
    });
    expect(formatFinding(finding!)).toBe(
      'server "gmail-ro": tools.allow names "list_email_conversation", which ' +
        '/gmail does not serve. Did you mean "list_email_conversations"?',
    );
  });

  it("catches a rename — an entry that used to be a tool and no longer is", () => {
    // PR #84 renamed every remote-filesystem tool but `list_files`. A config
    // naming the old ones filters the surface down to almost nothing.
    const result = checkToolSurface(
      config(`  - slug: rfs-ro
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle
    path: /remote-filesystem-tmp-public
    entitlements: [admin]
    tools:
      allow:
        - list_files
        - get_file
`),
      surface({
        "/remote-filesystem-tmp-public": {
          tools: ["list_files", "download_file", "upload_file"],
        },
      }),
    );

    expect(result.findings.map((f) => f.entry)).toEqual(["get_file"]);
    // Nothing served is within a few edits of `get_file`, so it suggests nothing
    // rather than confidently pointing at the wrong tool.
    expect(result.findings[0]?.nearest).toBeUndefined();
    expect(formatFinding(result.findings[0]!)).toContain(
      "The 3 tool(s) it does serve are listed above.",
    );
  });

  it("checks deny entries too — a deny that matches nothing subtracts nothing", () => {
    const result = checkToolSurface(
      config(`  - slug: gmail-rw
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle
    path: /gmail
    entitlements: [admin]
    tools:
      deny:
        - send_mail
`),
      surface({ "/gmail": { tools: GMAIL_TOOLS } }),
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: "deny",
      entry: "send_mail",
      nearest: "send_email",
    });
  });

  it("reports every offending entry, not the first one", () => {
    const result = checkToolSurface(
      config(
        GMAIL_RO.replace(
          "- list_email_conversations",
          "- list_conversations",
        ).replace("- get_email_conversation", "- get_conversation"),
      ),
      surface({ "/gmail": { tools: GMAIL_TOOLS } }),
    );

    expect(result.findings.map((f) => f.entry)).toEqual([
      "list_conversations",
      "get_conversation",
    ]);
  });

  it("says nothing about a server with no tools: block", () => {
    const result = checkToolSurface(
      config(`  - slug: gmail-rw-external
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle
    path: /gmail
    entitlements: [admin]
`),
      surface({ "/gmail": { tools: GMAIL_TOOLS } }),
    );

    // Neither checked nor skipped: there is no entry that could be wrong, and
    // counting it as covered would inflate what this check claims.
    expect(result).toEqual({ checked: [], skipped: [], findings: [] });
  });

  // The tag CI really builds is per-run, so it carries dashes — which also
  // proves the last-colon split that finds the tag is not confused by them.
  it("ignores the TAG, so CI's :ci-<run> checks a config's :latest", () => {
    const result = checkToolSurface(
      config(GMAIL_RO),
      surface(
        { "/gmail": { tools: GMAIL_TOOLS } },
        "ghcr.io/tadasant/strad-bundle:ci-17235891044-1",
      ),
    );
    expect(result.checked).toHaveLength(1);
  });
});

// =============================================================================
// What it refuses to fail on — the anti-flake half
// =============================================================================

describe("checkToolSurface skips, loudly, what it cannot enumerate", () => {
  it("skips a remote-http server: nothing here can list its tools", () => {
    const result = checkToolSurface(
      config(`  - slug: deepwiki
    kind: remote-http
    url: https://mcp.deepwiki.com/mcp
    entitlements: [admin]
    tools:
      allow: [ask_question]
`),
      surface({ "/gmail": { tools: GMAIL_TOOLS } }),
    );

    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual([
      {
        slug: "deepwiki",
        reason: expect.stringContaining(
          "kind: remote-http",
        ) as unknown as string,
      },
    ]);
  });

  it("skips a server on another image, even when the path collides", () => {
    const result = checkToolSurface(
      config(`  - slug: elsewhere
    kind: supplementary-image
    image: ghcr.io/tadasant/some-other-server:latest
    bundle: bundle
    path: /gmail
    entitlements: [admin]
    tools:
      allow: [not_a_gmail_tool]
`),
      surface({ "/gmail": { tools: GMAIL_TOOLS } }),
    );

    expect(result.findings).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("some-other-server");
  });

  it("skips another ORG's image of the same name — a repository is not an identity", () => {
    // `ghcr.io/someone-else/strad-bundle` shares a repository name with the image
    // CI booted and is not it. Matching on the name alone would hand a stranger's
    // config this bundle's tool names and call the difference a typo.
    const result = checkToolSurface(
      config(`  - slug: impostor
    kind: supplementary-image
    image: ghcr.io/someone-else/strad-bundle:latest
    bundle: bundle
    path: /gmail
    entitlements: [admin]
    tools:
      allow: [not_a_gmail_tool]
`),
      surface({ "/gmail": { tools: GMAIL_TOOLS } }),
    );

    expect(result.findings).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("someone-else");
  });

  it("skips a slug whose mount this run did not boot, and says which it did", () => {
    const result = checkToolSurface(
      config(GMAIL_RO),
      surface({ "/slack": { tools: ["slack_get_channels"] } }),
    );

    expect(result.findings).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("mounts nothing at /gmail");
    expect(result.skipped[0]?.reason).toContain("/slack");
  });

  it("skips a mount that would not list, carrying the error", () => {
    const result = checkToolSurface(
      config(GMAIL_RO),
      surface({ "/gmail": { error: "connect ECONNREFUSED" } }),
    );

    expect(result.findings).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("connect ECONNREFUSED");
  });

  it("skips a PARTIAL surface — a floor is not evidence of a typo", () => {
    // The one that decides whether this check survives. `secrets` derives its
    // surface from a capability probe that fails closed without a credential, so
    // in CI it lists the read-only floor. An allow entry naming a write tool is
    // correct config and would look exactly like a typo here.
    const result = checkToolSurface(
      config(`  - slug: secrets-rw
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    tools:
      allow:
        - list_parameters
        - create_parameter
`),
      surface({
        "/secrets": {
          tools: ["list_parameters"],
          partial: "surface comes from a capability PROBE",
        },
      }),
    );

    expect(result.findings).toEqual([]);
    expect(result.checked).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("partial surface");
    expect(result.skipped[0]?.reason).toContain("capability PROBE");
  });
});

// =============================================================================
// The observer's document
// =============================================================================

describe("parseObservedMounts", () => {
  it("reads what smoke.mjs --json writes", () => {
    expect(
      parseObservedMounts({
        version: "1.2.3",
        mounts: {
          "/gmail": { tools: ["send_email"] },
          "/secrets": { tools: ["list_parameters"], partial: "probe" },
          "/fetchpet": { error: "boom" },
        },
      }),
    ).toEqual({
      "/gmail": { tools: ["send_email"] },
      "/secrets": { tools: ["list_parameters"], partial: "probe" },
      "/fetchpet": { error: "boom" },
    });
  });

  it("throws on a document with no mounts — that would check nothing and pass", () => {
    expect(() => parseObservedMounts({ mounts: {} })).toThrow(/no mounts/);
    expect(() => parseObservedMounts({ version: "1" })).toThrow(/mounts/);
    expect(() => parseObservedMounts("[]")).toThrow(/JSON object/);
  });

  it("throws on a mount whose tool list is not a list of names", () => {
    expect(() =>
      parseObservedMounts({ mounts: { "/gmail": { tools: [1, 2] } } }),
    ).toThrow(/array of names/);
  });
});

// =============================================================================
// The real staging config, against the real shape of the check
// =============================================================================

describe("infra/strad.staging.yaml", () => {
  const CONFIG = parseConfig(
    readFileSync("infra/strad.staging.yaml", "utf8"),
    "infra/strad.staging.yaml",
  );

  it("every allow-carrying slug is a bundle mount CI can enumerate", () => {
    // The coverage claim, asserted rather than assumed. A tenth allow-list added
    // on a remote-http server or on a mount whose surface CI cannot show in full
    // would be SKIPPED by the check above — correctly, and silently as far as
    // this repo's tests go. This is where that becomes a deliberate act.
    const partial = new Set([
      "/secrets",
      "/gcs",
      "/good-eggs",
      "/fetchpet",
      "/pointsyeah",
    ]);

    const covered = CONFIG.servers
      .filter((s) => s.tools)
      .map((s) => {
        expect(s.kind).toBe("supplementary-image");
        const server = s as Extract<typeof s, { kind: "supplementary-image" }>;
        expect(server.image).toContain("strad-bundle");
        expect(partial.has(server.path)).toBe(false);
        return `${server.slug} -> ${server.path}`;
      });

    expect(covered).toEqual([
      "slack-readonly -> /slack",
      "tailscale-readonly -> /tailscale",
      "monarch-money-readonly -> /monarch-money",
      "gmail-ro -> /gmail",
      "gmail-rw -> /gmail",
      "google-docs-ro -> /google-docs",
      "google-docs-rw -> /google-docs",
      "google-calendar-ro -> /google-calendar",
      "onepassword-ro -> /onepassword",
      "messenger-tadas -> /messenger",
      "telegram-ro -> /telegram",
      "bill-spend-ro -> /bill-spend",
      "digitalocean-tadasant-ro -> /digitalocean",
      "hetzner-pulse-ro -> /hetzner",
    ]);
  });

  it("no allow list repeats an entry", () => {
    // A duplicate is invisible to the length assertions in staging-config.test.ts
    // — it makes a 5-tool tier read as 5 while allowing 4 — and invisible to the
    // name check, which is a set comparison.
    for (const server of CONFIG.servers) {
      const allow = server.tools?.allow;
      if (!allow) continue;
      expect(new Set(allow).size, `${server.slug} repeats an allow entry`).toBe(
        allow.length,
      );
    }
  });
});

describe("checkToolSurface — flow-through grants", () => {
  // The source runs on ANOTHER image, and does not need to be observed: a
  // grant names the TARGET's tools, so it is checked against the target mount.
  const cfg = (tools: string) =>
    config(`  - slug: showcase
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle-internal:latest
    bundle: bundle-internal
    path: /showcase
    entitlements: [admin]
    reaches:
      - slug: gmail-rw
        tools: [${tools}]
  - slug: gmail-rw
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle
    path: /gmail
    entitlements: [admin]
    reachableFrom: [showcase]
`);

  it("finds a grant tool the target does not serve, and names the near miss", () => {
    const result = checkToolSurface(
      cfg("list_email_conversations, send_emails"),
      surface({ "/gmail": { tools: GMAIL_TOOLS } }),
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        slug: "showcase",
        kind: "reach",
        entry: "send_emails",
        nearest: "send_email",
      }),
    ]);
    expect(formatFinding(result.findings[0]!)).toContain(
      'a reaches: grant names "send_emails"',
    );
  });

  it("passes a grant whose every tool the target serves", () => {
    const result = checkToolSurface(
      cfg("list_email_conversations"),
      surface({ "/gmail": { tools: GMAIL_TOOLS } }),
    );
    expect(result.findings).toEqual([]);
    expect(result.checked).toContainEqual({
      slug: "showcase → gmail-rw",
      mount: "/gmail",
      entries: 1,
    });
  });
});
