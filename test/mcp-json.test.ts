/**
 * `mcp.json` (draft SEP-2633) as an input dialect, end to end through the loader.
 *
 * Three things are asserted, and the first is the one the change stands or falls
 * on: THE EXISTING YAML INTERFACE IS UNCHANGED. A desugared entry has to be
 * byte-for-byte the `ServerConfig` the same server written in YAML produces —
 * not merely equivalent — because everything downstream (the renderer, the
 * entitlement check, the reachability monitor, the console) reads that object
 * and nothing downstream knows the dialect exists.
 *
 * Then: what the dialect refuses, which is most of SEP-2633. And: the
 * reachability cliff a single-principal file creates on a gateway, which is
 * reported rather than defaulted away.
 */
import { describe, expect, it } from "vitest";
import { parseConfig, parseConfigWithDialect } from "../src/config/load.ts";
import { suggestedSlug } from "../src/config/mcp-json.ts";
import { formatUnknownKey, unknownConfigKeys } from "../src/config/strict.ts";

const BASE = `
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
`;

/** The dialect form of a config, and the YAML form of the same servers. */
function withMcpServers(json: string): string {
  return `${BASE}\nmcpServers: ${json}\n`;
}

describe("mcp.json desugars into the existing schema", () => {
  it("produces exactly the ServerConfig the YAML interface produces", () => {
    // deepwiki, as it is written in infra/strad.staging.yaml today.
    const yaml = parseConfig(`${BASE}
servers:
  - slug: deepwiki
    kind: remote-http
    url: https://mcp.deepwiki.com/mcp
    entitlements: [admin]
`);
    const dialect = parseConfig(
      withMcpServers(`
  deepwiki:
    type: streamable-http
    url: https://mcp.deepwiki.com/mcp
    strad: { entitlements: [admin] }
`),
    );
    expect(dialect.servers).toEqual(yaml.servers);
  });

  it("carries headers, title and description across, rewriting ${env:NAME}", () => {
    const cfg = parseConfig(
      withMcpServers(`
  granola:
    title: Granola
    description: Meeting notes.
    type: streamable-http
    url: https://mcp.granola.ai/mcp
    headers:
      Authorization: "Bearer \${env:GRANOLA_TOKEN}"
    strad: { entitlements: [admin] }
`),
    );
    expect(cfg.servers[0]).toMatchObject({
      slug: "granola",
      kind: "remote-http",
      title: "Granola",
      description: "Meeting notes.",
      url: "https://mcp.granola.ai/mcp",
      headers: { Authorization: "Bearer ${GRANOLA_TOKEN}" },
      entitlements: ["admin"],
    });
  });

  it("appends to servers: rather than replacing them, so both dialects coexist", () => {
    const cfg = parseConfig(`${BASE}
servers:
  - { slug: echo, kind: builtin, module: echo, entitlements: [admin] }
mcpServers:
  deepwiki:
    type: streamable-http
    url: https://mcp.deepwiki.com/mcp
    strad: { entitlements: [admin] }
`);
    expect(cfg.servers.map((s) => s.slug)).toEqual(["echo", "deepwiki"]);
  });

  it("takes every gateway field the format has no slot for, under strad:", () => {
    const cfg = parseConfig(
      withMcpServers(`
  gmail-ro:
    type: streamable-http
    url: https://example.com/mcp
    strad:
      entitlements: [admin]
      enabled: false
      timeoutMs: 5000
      tools: { allow: [list_email_conversations] }
      mayBeUnseeded: [GMAIL_TOKEN]
`),
    );
    expect(cfg.servers[0]).toMatchObject({
      slug: "gmail-ro",
      enabled: false,
      timeoutMs: 5000,
      tools: { allow: ["list_email_conversations"] },
      mayBeUnseeded: ["GMAIL_TOKEN"],
    });
  });

  it("applies the schema's own defaults to everything strad: omits", () => {
    const cfg = parseConfig(
      withMcpServers(`
  deepwiki:
    type: streamable-http
    url: https://mcp.deepwiki.com/mcp
    strad: { entitlements: [admin] }
`),
    );
    expect(cfg.servers[0]).toMatchObject({
      enabled: true,
      timeoutMs: 120_000,
      mayBeUnseeded: [],
      headers: {},
    });
  });

  it("parses a whole mcp.json document, supplying the two rootless fields", () => {
    // A file that is just an mcp.json: no `version:`, no `auth:`. JSON is a
    // subset of YAML, so this is the literal file text.
    const cfg = parseConfig(
      JSON.stringify({
        mcpServers: {
          deepwiki: {
            type: "streamable-http",
            url: "https://mcp.deepwiki.com/mcp",
          },
        },
      }),
      "mcp.json",
    );
    expect(cfg.version).toBe(1);
    expect(cfg.servers.map((s) => s.slug)).toEqual(["deepwiki"]);
    // Fail closed, all the way down: no roles, and no entitlements.
    expect(cfg.roles).toEqual({});
    expect(cfg.servers[0]?.entitlements).toEqual([]);
  });

  it("takes roles: in a whole mcp.json, which is how an entitlement gets one", () => {
    // The escape hatch from the cliff, in one key and without leaving the file:
    // `roles:` is a strad root key, and adding it does not flip the document out
    // of whole-document mode — only `version:` does.
    const cfg = parseConfig(
      JSON.stringify({
        roles: { agent: { servers: ["deepwiki"] } },
        mcpServers: {
          deepwiki: {
            type: "streamable-http",
            url: "https://mcp.deepwiki.com/mcp",
            strad: { entitlements: ["agent"] },
          },
        },
      }),
      "mcp.json",
    );
    expect(cfg.servers[0]?.entitlements).toEqual(["agent"]);
    expect(cfg.roles.agent?.servers).toEqual(["deepwiki"]);
  });

  it("leaves a config with no mcpServers: on exactly the path it was on", () => {
    const { dialect } = parseConfigWithDialect(`${BASE}
servers:
  - { slug: echo, kind: builtin, module: echo, entitlements: [admin] }
`);
    expect(dialect.used).toBe(false);
    expect(dialect.notices).toEqual([]);
    expect(dialect.errors).toEqual([]);
  });
});

describe("mcp.json — the reachability cliff is reported, not defaulted away", () => {
  it("attaches a server with no entitlements and says so by name", () => {
    const { config, dialect } = parseConfigWithDialect(
      withMcpServers(`
  deepwiki:
    type: streamable-http
    url: https://mcp.deepwiki.com/mcp
`),
    );
    expect(config.servers[0]?.entitlements).toEqual([]);
    expect(dialect.notices).toHaveLength(1);
    expect(dialect.notices[0]?.slug).toBe("deepwiki");
    expect(dialect.notices[0]?.message).toMatch(/no principal can reach it/);
    // Both halves of the two-way agreement are named, because naming one is
    // how an operator ends up with a role that grants nothing.
    expect(dialect.notices[0]?.message).toMatch(/entitlements/);
    expect(dialect.notices[0]?.message).toMatch(/roles:/);
  });

  it("says nothing once the entry declares an entitlement", () => {
    const { dialect } = parseConfigWithDialect(
      withMcpServers(`
  deepwiki:
    type: streamable-http
    url: https://mcp.deepwiki.com/mcp
    strad: { entitlements: [admin] }
`),
    );
    expect(dialect.notices).toEqual([]);
  });

  it("treats an explicitly empty entitlements list as the same cliff", () => {
    const { dialect } = parseConfigWithDialect(
      withMcpServers(`
  deepwiki:
    type: streamable-http
    url: https://mcp.deepwiki.com/mcp
    strad: { entitlements: [] }
`),
    );
    expect(dialect.notices).toHaveLength(1);
  });
});

describe("mcp.json — the slug charset mismatch", () => {
  const refuse = (json: string, pattern: RegExp): void => {
    expect(() => parseConfig(withMcpServers(json))).toThrow(pattern);
  };

  it("refuses a legal SEP name that is not a legal strad slug", () => {
    // `^[a-zA-Z0-9_\[\]-]+$` allows all three of these; strad's slug allows none.
    for (const name of ["My_Server", "UPPER", "srv[0]"]) {
      refuse(
        `\n  ${JSON.stringify(name)}:\n    type: streamable-http\n    url: https://e.com/mcp\n`,
        /not a legal strad slug/,
      );
    }
  });

  it("never transliterates silently, and says why", () => {
    // Two distinct, legal SEP names folding to one slug is the failure: a slug
    // prefixes every tool name and names this server's variables on the box.
    expect(suggestedSlug("My_Server")).toBe("my-server");
    expect(suggestedSlug("my-server")).toBe("my-server");
    refuse(
      `\n  My_Server:\n    type: streamable-http\n    url: https://e.com/mcp\n`,
      /strad: \{ slug: my-server \}/,
    );
  });

  it("takes an explicit slug override, which is the documented way across", () => {
    const cfg = parseConfig(
      withMcpServers(`
  My_Server:
    type: streamable-http
    url: https://e.com/mcp
    strad: { slug: my-server, entitlements: [admin] }
`),
    );
    expect(cfg.servers[0]?.slug).toBe("my-server");
  });

  it("refuses a key that is not even a legal mcp.json server name", () => {
    refuse(
      `\n  "not.a.name":\n    type: streamable-http\n    url: https://e.com/mcp\n`,
      /not a legal mcp\.json server name/,
    );
  });

  it("refuses an override that is not a legal slug", () => {
    refuse(
      `\n  ok:\n    type: streamable-http\n    url: https://e.com/mcp\n    strad: { slug: "Bad_Slug" }\n`,
      /slug must be lowercase/,
    );
  });

  it("lets superRefine catch a slug the dialect duplicates", () => {
    expect(() =>
      parseConfig(`${BASE}
servers:
  - { slug: deepwiki, kind: remote-http, url: "https://e.com/mcp", entitlements: [admin] }
mcpServers:
  deepwiki:
    type: streamable-http
    url: https://mcp.deepwiki.com/mcp
`),
    ).toThrow(/duplicate server slug: deepwiki/);
  });
});

describe("mcp.json — what has no analog is refused by name", () => {
  const refuse = (json: string, pattern: RegExp): void => {
    expect(() => parseConfig(withMcpServers(json))).toThrow(pattern);
  };

  it("refuses type: stdio and names the two kinds that are not expressible", () => {
    refuse(
      `\n  github:\n    type: stdio\n    command: npx\n    args: ["-y", "pkg@1.0.0"]\n`,
      /supplementary-image/,
    );
  });

  it("refuses type: sse — strad proxies Streamable HTTP only", () => {
    refuse(
      `\n  monitoring:\n    type: sse\n    url: https://e.com/sse\n`,
      /Streamable HTTP only/,
    );
  });

  it("refuses a transport the SEP does not define either", () => {
    refuse(
      `\n  x:\n    type: http\n    url: https://e.com/mcp\n`,
      /not a SEP-2633 transport/,
    );
  });

  it("refuses the oauth object, because the draft is renegotiating it", () => {
    refuse(
      `\n  linear:\n    type: streamable-http\n    url: https://mcp.linear.app/mcp\n    oauth: { clientId: abc }\n`,
      /SEP-2742/,
    );
  });

  it("refuses command/args/env on a remote entry, as the SEP itself does", () => {
    refuse(
      `\n  x:\n    type: streamable-http\n    url: https://e.com/mcp\n    env: { A: b }\n`,
      /forbids `env` on a remote entry/,
    );
  });

  it("refuses a remote entry with no url", () => {
    refuse(`\n  x:\n    type: streamable-http\n`, /requires a url/);
  });

  it("refuses an interpolation in title or description", () => {
    // strad resolves references in url and headers only, so one here would
    // ship as the literal text `${NAME}`.
    refuse(
      `\n  x:\n    type: streamable-http\n    url: https://e.com/mcp\n    title: "\${env:NAME}"\n`,
      /would ship as literal/,
    );
  });

  it("enforces the SEP's own caps on title and description", () => {
    refuse(
      `\n  x:\n    type: streamable-http\n    url: https://e.com/mcp\n    title: "${"a".repeat(101)}"\n`,
      /mcpServers\.x\.title/,
    );
  });

  it("reports every refusal at once, never just the first", () => {
    try {
      parseConfig(
        withMcpServers(`
  a:
    type: sse
    url: https://e.com/sse
  b:
    type: stdio
    command: npx
`),
      );
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/mcpServers\.a\.type/);
      expect(message).toMatch(/mcpServers\.b\.type/);
    }
  });

  it("refuses a mcpServers: that is not a map", () => {
    expect(() => parseConfig(`${BASE}\nmcpServers: [a, b]\n`)).toThrow(
      /map of server names/,
    );
  });
});

describe("mcp.json — the strict check still sees an unknown key", () => {
  const unknowns = (raw: string): string[] => {
    const { config } = parseConfigWithDialect(raw);
    return unknownConfigKeys(raw, config).map(formatUnknownKey);
  };

  it("reports an unknown key inside an mcpServers entry, at the key it was written under", () => {
    // The diff cannot see it — the desugar rebuilds the entry from a fixed set
    // of fields — so the dialect reports it from where the entry still exists.
    expect(
      unknowns(
        withMcpServers(`
  x:
    type: streamable-http
    url: https://e.com/mcp
    timeout: 5
`),
      ),
    ).toEqual(["mcpServers.x.timeout"]);
  });

  it("reports an unknown key inside the strad: extension, with a suggestion", () => {
    expect(
      unknowns(
        withMcpServers(`
  x:
    type: streamable-http
    url: https://e.com/mcp
    strad: { entitlement: [admin] }
`),
      ),
    ).toEqual([
      'mcpServers.x.strad.entitlement (did you mean "entitlements"?)',
    ]);
  });

  it("still reports an unknown key in the YAML half of the same document", () => {
    // The regression this guards: the desugar changes the length of `servers:`,
    // and the walk is index-wise — a mismatch there silently stops the check.
    expect(
      unknowns(`${BASE}
servers:
  - { slug: echo, kind: builtin, module: echo, entitlements: [admin], consoleEnvs: {} }
mcpServers:
  deepwiki:
    type: streamable-http
    url: https://mcp.deepwiki.com/mcp
`),
    ).toEqual(["servers[0].consoleEnvs"]);
  });

  it("finds nothing in a clean dialect document", () => {
    expect(
      unknowns(
        withMcpServers(`
  deepwiki:
    type: streamable-http
    url: https://mcp.deepwiki.com/mcp
    strad: { entitlements: [admin] }
`),
      ),
    ).toEqual([]);
  });
});
