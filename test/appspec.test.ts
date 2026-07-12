import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { collectSecretRefs } from "../src/deploy/appspec.ts";

describe("collectSecretRefs", () => {
  it("finds ${NAME} refs in a remote-http server's headers", () => {
    const cfg = parseConfig(`
version: 1
gateway: { name: strad, env: prod }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: granola
    kind: remote-http
    url: https://mcp.granola.ai/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${GRANOLA_TOKEN}"
`);
    expect(collectSecretRefs(cfg)).toEqual(["GRANOLA_TOKEN"]);
  });

  it("finds ${NAME} refs in a builtin's options", () => {
    const cfg = parseConfig(`
version: 1
gateway: { name: strad, env: prod }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
    options:
      apiKey: "\${ECHO_API_KEY}"
`);
    expect(collectSecretRefs(cfg)).toEqual(["ECHO_API_KEY"]);
  });

  it("EXCLUDES supplementary-image env — those are scoped per-bundle elsewhere", () => {
    const cfg = parseConfig(`
version: 1
gateway: { name: strad, env: prod }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle-x
servers:
  - slug: sup
    kind: supplementary-image
    image: ghcr.io/o/a:latest
    bundle: bundle-x
    entitlements: [admin]
    env:
      A_TOKEN: "\${SCOPED_ONLY}"
  - slug: remote
    kind: remote-http
    url: https://example.com/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${BROADCAST}"
`);
    // Only the remote-http ref is broadcast; SCOPED_ONLY is left to the bundle path.
    expect(collectSecretRefs(cfg)).toEqual(["BROADCAST"]);
  });

  it("returns nothing for a ref-free config (the default / staging shape)", () => {
    const cfg = parseConfig(`
version: 1
gateway: { name: strad, env: staging }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
servers:
  - slug: deepwiki
    kind: remote-http
    url: https://mcp.deepwiki.com/mcp
    entitlements: [admin]
`);
    expect(collectSecretRefs(cfg)).toEqual([]);
  });
});
