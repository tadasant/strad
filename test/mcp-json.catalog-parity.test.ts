/**
 * The desugar, against the real catalog rather than against a fixture.
 *
 * `test/mcp-json.test.ts` proves the dialect's rules. This proves the one claim
 * those rules exist to support: that a `remote-http` server written in
 * SEP-2633's `mcp.json` and the SAME server written in strad's YAML interface
 * produce the IDENTICAL `ServerConfig`. Not equivalent — identical, field for
 * field, defaults included, because everything downstream of `parseConfig`
 * (the renderer, the entitlement check, the reachability monitor, the console)
 * reads that object and none of them knows a dialect exists.
 *
 * The inputs are the two configs this repo actually ships: `infra/strad.staging.yaml`
 * (the deployed catalog) and `strad.config.example.yaml` (the documented one).
 * Every `remote-http` entry in either is mechanically re-expressed as an
 * `mcpServers` entry, parsed back through the loader, and compared. A future
 * `remote-http` server added to either file is covered without anyone editing
 * this test — and a field added to `RemoteHttpServer` that the dialect cannot
 * carry fails it, which is the drift worth catching.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import type { RemoteHttpServer } from "../src/config/schema.ts";

const CONFIGS = ["../infra/strad.staging.yaml", "../strad.config.example.yaml"];

/**
 * Fields a `remote-http` entry can carry that the dialect deliberately does not.
 *
 * `oauthRefresh:` and `oauth:` stay in the YAML interface — binding either to
 * SEP-2633 would mean taking a position on the draft's contested `oauth` object.
 * An entry using one is skipped here rather than silently mis-asserted.
 */
const YAML_ONLY = ["oauth", "oauthRefresh"] as const;

const REMOTES: { file: string; server: RemoteHttpServer }[] = CONFIGS.flatMap(
  (file) =>
    parseConfig(
      readFileSync(new URL(file, import.meta.url), "utf8"),
      file,
    ).servers.flatMap((server) =>
      server.kind === "remote-http" &&
      YAML_ONLY.every((f) => server[f] === undefined)
        ? [{ file, server }]
        : [],
    ),
);

/** The same server, written as SEP-2633 would write it. */
function asMcpJson(server: RemoteHttpServer): unknown {
  const entry: Record<string, unknown> = {
    type: "streamable-http",
    url: server.url,
  };
  if (server.title !== undefined) entry.title = server.title;
  if (server.description !== undefined) entry.description = server.description;
  if (Object.keys(server.headers).length > 0) {
    // `${NAME}` -> `${env:NAME}`: the mechanical rewrite, in the direction the
    // dialect will undo. A header strad resolves has to survive the round trip.
    entry.headers = Object.fromEntries(
      Object.entries(server.headers).map(([k, v]) => [
        k,
        v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "${env:$1}"),
      ]),
    );
  }
  entry.strad = {
    entitlements: server.entitlements,
    enabled: server.enabled,
    timeoutMs: server.timeoutMs,
    ...(server.tools ? { tools: server.tools } : {}),
    ...(server.mayBeUnseeded.length > 0
      ? { mayBeUnseeded: server.mayBeUnseeded }
      : {}),
  };
  return entry;
}

const ROLES = `
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles:
  admin: { servers: ["*"] }
  agent: { servers: ["*"] }
  human: { servers: ["*"] }
`;

describe("the mcp.json dialect against the shipped catalogs", () => {
  it("finds the remote-http entries it is about", () => {
    // A guard on the guard: if the catalogs ever stop carrying one, this test
    // would pass vacuously and prove nothing.
    expect(REMOTES.length).toBeGreaterThan(0);
    expect(REMOTES.map((r) => r.server.slug)).toContain("deepwiki");
  });

  for (const { file, server } of REMOTES) {
    it(`round-trips ${server.slug} (${file}) through mcp.json unchanged`, () => {
      const raw = `${ROLES}\nmcpServers: ${JSON.stringify({
        [server.slug]: asMcpJson(server),
      })}\n`;
      const [desugared] = parseConfig(raw, `${file} as mcp.json`).servers;
      expect(desugared).toEqual(server);
    });
  }
});
