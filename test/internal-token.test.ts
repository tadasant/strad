import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  componentToken,
  internalCaller,
  internalComponents,
} from "../src/auth/internal-token.ts";
import { internalHeaders } from "../src/gateway/registry.ts";

/**
 * Per-component internal tokens (HACKS.md #63): the derivation, and core's
 * reading of a presented token back into the component it was issued to.
 *
 * The route-level proof — a component reaching its own slug and refused on
 * another's — is in test/param-route.test.ts and test/bundle.test.ts, through
 * the real handlers. This file holds the primitives those rest on.
 */

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
  - name: bundle
  - name: bundle-zimmer-secrets
  - name: bundle-echo
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
  - slug: bundled
    kind: builtin
    module: "./servers/echo.js"
    bundle: bundle-echo
    entitlements: [admin]
  - slug: slack
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:0.1.0
    bundle: bundle
    path: /slack
    entitlements: [admin]
  - slug: zimmer-secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:0.1.0
    bundle: bundle-zimmer-secrets
    path: /secrets
    entitlements: [admin]
  - slug: deepwiki
    kind: remote-http
    url: https://mcp.deepwiki.com/mcp
    entitlements: [admin]
`);

const ROOT = "the-root-core-holds";
const env = { STRAD_INTERNAL_TOKEN: ROOT };
const bearer = (token: string) => `Bearer ${token}`;

describe("componentToken", () => {
  it("is deterministic, so a re-render does not diff the spec", () => {
    expect(componentToken(ROOT, "bundle")).toBe(componentToken(ROOT, "bundle"));
  });

  it("differs per component and per root, and is never the root", () => {
    const tokens = [
      componentToken(ROOT, "bundle"),
      componentToken(ROOT, "bundle-zimmer-secrets"),
      componentToken("another-root", "bundle"),
    ];
    expect(new Set(tokens).size).toBe(3);
    expect(tokens).not.toContain(ROOT);
    // 32 bytes of HMAC, base64url: a bearer-safe string of fixed length.
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("internalComponents", () => {
  it("names every non-core component the config does, and nothing else", () => {
    // Not `core`, and not a remote-http server, which has no component.
    expect(internalComponents(CONFIG)).toEqual([
      "bundle",
      "bundle-echo",
      "bundle-zimmer-secrets",
    ]);
  });
});

describe("internalCaller", () => {
  it("reads each component's own token back to that component", () => {
    for (const component of internalComponents(CONFIG)) {
      expect(
        internalCaller(bearer(componentToken(ROOT, component)), CONFIG, env),
      ).toEqual({ ok: true, component });
    }
  });

  it("refuses the ROOT: no component holds it", () => {
    expect(internalCaller(bearer(ROOT), CONFIG, env)).toEqual({
      ok: false,
      status: 401,
      error: "invalid internal token",
    });
  });

  it("refuses a token for a component this config does not have", () => {
    expect(
      internalCaller(bearer(componentToken(ROOT, "bundle-gone")), CONFIG, env),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses a token derived from a different root", () => {
    expect(
      internalCaller(
        bearer(componentToken("stale-root", "bundle")),
        CONFIG,
        env,
      ),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses a missing or scheme-less header", () => {
    expect(internalCaller(undefined, CONFIG, env)).toMatchObject({
      status: 401,
    });
    expect(
      internalCaller(componentToken(ROOT, "bundle"), CONFIG, env),
    ).toMatchObject({ status: 401 });
  });

  it("fails CLOSED with 503 when core holds no root", () => {
    expect(
      internalCaller(bearer(componentToken(ROOT, "bundle")), CONFIG, {}),
    ).toEqual({
      ok: false,
      status: 503,
      error: "internal token not configured",
    });
  });
});

describe("internalHeaders — what core presents", () => {
  it("presents each component its own token, and never the root", () => {
    const a = internalHeaders(env, "bundle");
    const b = internalHeaders(env, "bundle-zimmer-secrets");
    expect(a.authorization).toBe(bearer(componentToken(ROOT, "bundle")));
    expect(b.authorization).toBe(
      bearer(componentToken(ROOT, "bundle-zimmer-secrets")),
    );
    expect(a.authorization).not.toBe(b.authorization);
    expect(JSON.stringify([a, b])).not.toContain(ROOT);
  });

  it("sends no header when core holds no root, as it always has", () => {
    expect(internalHeaders({}, "bundle")).toEqual({});
  });
});
