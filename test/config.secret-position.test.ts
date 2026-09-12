import { describe, expect, it } from "vitest";
import { parseConfig, parseYamlDocument } from "../src/config/load.ts";
import { EMPTY_OVERLAY, withUpsert } from "../src/config/overlay.ts";
import { RuntimeConfig } from "../src/config/runtime.ts";
import {
  LiteralCredential,
  assertSecretsByReference,
  changedUpserts,
  isCredentialReference,
} from "../src/config/secret-position.ts";
import { MemoryConfigStore } from "../src/config/store.ts";

/**
 * The third bound on what a RUNTIME write may reach: it may NAME a credential
 * and may not carry one.
 *
 * The two that came before it are in `test/connectors.isolation.test.ts` — a
 * runtime-authored entry reads only its own namespace, and a runtime write
 * cannot move access control the deploy authorised. This one is about the
 * document rather than about resolution: `/strad/{env}/gateway/config/SERVERS`
 * is a NON-SECRET parameter (`src/config/store.ts` creates it with
 * `secret: false`), so a literal saved through either door is a credential at
 * rest in the clear, handed back by every read of the roster.
 *
 * Nothing here asserts on a value's SHAPE. The rule is that a credential
 * position holds a reference, not that strad can recognise a secret — the
 * tests below pin both halves of that, including the literal that is obviously
 * harmless and is refused anyway.
 */

const SECRET = "sk-live-do-not-store-me";

const BASE_YAML = `
version: 1
gateway:
  name: strad
  env: test
  secrets: { provider: env }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: declared
    kind: remote-http
    url: https://declared.example.com/mcp
    headers:
      Authorization: "Bearer \${DECLARED_TOKEN}"
    entitlements: [admin]
`;

function runtimeOn(doc: unknown, overlay = EMPTY_OVERLAY): RuntimeConfig {
  return new RuntimeConfig({
    baseDocument: doc,
    config: parseConfig(JSON.stringify(doc)),
    overlay,
    store: new MemoryConfigStore(overlay),
    rebuild: () => Promise.resolve(),
    env: {},
  });
}

const BASE_DOC = parseYamlDocument(BASE_YAML);

describe("what counts as naming a credential", () => {
  it("accepts a bare ref and a scheme in front of one", () => {
    expect(isCredentialReference("${GRANOLA_TOKEN}")).toBe(true);
    expect(isCredentialReference("Bearer ${GRANOLA_TOKEN}")).toBe(true);
    expect(isCredentialReference("Basic ${ANKI_KEY}")).toBe(true);
    // RFC 7235 makes auth-scheme case-insensitive, and upstreams spell it every
    // way there is.
    expect(isCredentialReference("bearer ${T}")).toBe(true);
    expect(isCredentialReference("TOKEN ${T}")).toBe(true);
  });

  it("refuses anything with a value in it", () => {
    expect(isCredentialReference(SECRET)).toBe(false);
    expect(isCredentialReference(`Bearer ${SECRET}`)).toBe(false);
    // A ref is not a licence for the rest of the string: the scheme vocabulary
    // is closed precisely so that "everything except the ref" is a fixed set.
    expect(isCredentialReference("sk-${SUFFIX}")).toBe(false);
    expect(isCredentialReference("${A}${B}")).toBe(false);
    expect(isCredentialReference("${A} ${B}")).toBe(false);
    expect(isCredentialReference("Custom ${T}")).toBe(false);
    expect(isCredentialReference("Bearer ${T} extra")).toBe(false);
    // `${env:T}` is the mcp.json input dialect, rewritten at document load and
    // never a thing the roster itself holds. Untranslated, it is a literal.
    expect(isCredentialReference("${env:T}")).toBe(false);
  });

  it("refuses a value that is not a string at all", () => {
    expect(isCredentialReference(undefined)).toBe(false);
    expect(isCredentialReference(42)).toBe(false);
    expect(isCredentialReference({ $: "T" })).toBe(false);
  });
});

describe("the positions a runtime write may not carry a value in", () => {
  it("refuses a literal header, and names the header without quoting it", () => {
    const entry = {
      slug: "leaky",
      kind: "remote-http",
      url: "https://api.example.com/mcp",
      headers: { Authorization: `Bearer ${SECRET}` },
    };
    expect(() => assertSecretsByReference(entry)).toThrow(LiteralCredential);
    try {
      assertSecretsByReference(entry);
      expect.unreachable("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("Authorization:");
      // The message is rendered into an HTML console page and returned over
      // /mcp. Echoing the value back would undo the refusal.
      expect(message).not.toContain(SECRET);
    }
  });

  it("refuses a literal that is not a secret, and says why it does not guess", () => {
    // `Notion-Version: 2022-06-28` is harmless and is refused anyway. A rule
    // that let it through would be a rule about what a secret LOOKS like, and
    // the next value shaped like a date would be a credential.
    expect(() =>
      assertSecretsByReference({
        slug: "notion",
        kind: "remote-http",
        url: "https://mcp.notion.com/mcp",
        headers: { "Notion-Version": "2022-06-28" },
      }),
    ).toThrow(/cannot tell the two apart/);
  });

  it("accepts the shape every entry in this repo already uses", () => {
    expect(() =>
      assertSecretsByReference({
        slug: "anki",
        kind: "local-tunnel",
        url: "https://anki.example.trycloudflare.com/",
        headers: {
          "CF-Access-Client-Id": "${ANKI_CF_ACCESS_CLIENT_ID}",
          "CF-Access-Client-Secret": "${ANKI_CF_ACCESS_CLIENT_SECRET}",
          Authorization: "Bearer ${ANKI_MCP_API_KEY}",
        },
      }),
    ).not.toThrow();
  });

  it("refuses userinfo in a url and leaves the rest of the url alone", () => {
    expect(() =>
      assertSecretsByReference({
        slug: "u",
        kind: "remote-http",
        url: `https://tadas:${SECRET}@api.example.com/mcp`,
      }),
    ).toThrow(/userinfo/);
    expect(() =>
      assertSecretsByReference({
        slug: "u",
        kind: "remote-http",
        url: "https://api.example.com/mcp?k=${API_KEY}",
      }),
    ).not.toThrow();
    // Not this module's job to decide whether a `url:` is well-formed: the
    // schema owns that, and answering it from here would be the wrong error
    // from the wrong place.
    expect(() =>
      assertSecretsByReference({ slug: "u", kind: "remote-http", url: "nope" }),
    ).not.toThrow();
  });

  it("refuses a literal oauthRefresh grant", () => {
    const base = {
      slug: "g",
      kind: "remote-http",
      url: "https://api.example.com/mcp",
    };
    expect(() =>
      assertSecretsByReference({
        ...base,
        oauthRefresh: {
          tokenUrl: "https://api.example.com/token",
          clientId: "public-client",
          refreshToken: SECRET,
        },
      }),
    ).toThrow(/oauthRefresh.refreshToken/);
    expect(() =>
      assertSecretsByReference({
        ...base,
        oauthRefresh: {
          tokenUrl: "https://api.example.com/token",
          clientId: "public-client",
          clientSecret: `Bearer \${OK}`,
          refreshToken: "${OK}",
        },
      }),
    ).toThrow(/oauthRefresh.clientSecret/);
    expect(() =>
      assertSecretsByReference({
        ...base,
        oauthRefresh: {
          tokenUrl: "https://api.example.com/token",
          clientId: "public-client",
          clientSecret: "${CLIENT_SECRET}",
          refreshToken: "${REFRESH_TOKEN}",
        },
      }),
    ).not.toThrow();
  });

  it("says nothing about a builtin's options, which it does not cover", () => {
    // Stated as a test rather than only as a comment: `options:` is an untyped
    // bag whose ordinary contents are non-secret literals, so a ref-only rule
    // there would refuse the normal case. Named in the limitations page.
    expect(() =>
      assertSecretsByReference({
        slug: "echo",
        kind: "builtin",
        module: "./servers/echo.js",
        options: { greeting: "hello" },
      }),
    ).not.toThrow();
  });
});

describe("both write routes into the store", () => {
  it("refuses a create that carries a value", () => {
    expect(() =>
      runtimeOn(BASE_DOC).assertAcceptable({
        slug: "leaky",
        kind: "remote-http",
        url: "https://api.example.com/mcp",
        headers: { Authorization: `Bearer ${SECRET}` },
        entitlements: ["admin"],
      }),
    ).toThrow(LiteralCredential);
  });

  it("refuses an edit that turns a ref into a value", () => {
    const runtime = runtimeOn(BASE_DOC);
    const before = {
      slug: "declared",
      kind: "remote-http",
      url: "https://declared.example.com/mcp",
      headers: { Authorization: "Bearer ${DECLARED_TOKEN}" },
      entitlements: ["admin"],
    };
    expect(() =>
      runtime.assertAcceptable(
        { ...before, headers: { Authorization: `Bearer ${SECRET}` } },
        before,
      ),
    ).toThrow(LiteralCredential);
    expect(() =>
      runtime.assertAcceptable({ ...before, title: "Declared" }, before),
    ).not.toThrow();
  });

  it("refuses a TOGGLE that would copy a checked-in value into the store", async () => {
    // The route no composed-entry check can see. `set_connector_enabled` and
    // the console's toggle button re-upsert an entry read straight out of the
    // merged document, so a literal a deploy put in the file would be moved
    // into the overlay by a button that only meant to disable something.
    const doc = parseYamlDocument(
      BASE_YAML.replace(
        'Authorization: "Bearer ${DECLARED_TOKEN}"',
        `Authorization: "Bearer ${SECRET}"`,
      ),
    );
    const runtime = runtimeOn(doc);
    const declared = (doc as { servers: Record<string, unknown>[] })
      .servers[0]!;
    const next = withUpsert(
      runtime.overlay(),
      { ...declared, enabled: false },
      { fileSlugs: runtime.fileSlugs() },
    );

    await expect(runtime.apply(next)).rejects.toThrow(LiteralCredential);
    // Nothing was written, and nothing was adopted: the process is still
    // serving exactly what it was serving.
    expect(runtime.overlay().revision).toBe(0);
    expect(await runtime.store!.read()).toStrictEqual(EMPTY_OVERLAY);
  });

  it("does not wedge a roster that already holds one", async () => {
    // A literal already in the stored overlay is still SERVED — boot and poll
    // stay lenient on purpose. What must not happen is every later write being
    // refused because of it, which would make one old entry freeze the roster.
    const stale = withUpsert(
      EMPTY_OVERLAY,
      {
        slug: "legacy",
        kind: "remote-http",
        url: "https://legacy.example.com/mcp",
        headers: { Authorization: `Bearer ${SECRET}` },
        entitlements: ["admin"],
      },
      { fileSlugs: new Set(["declared"]) },
    );
    const runtime = runtimeOn(BASE_DOC, stale);

    const unrelated = withUpsert(
      runtime.overlay(),
      {
        slug: "fresh",
        kind: "remote-http",
        url: "https://fresh.example.com/mcp",
        headers: { Authorization: "Bearer ${FRESH_TOKEN}" },
        entitlements: ["admin"],
      },
      { fileSlugs: runtime.fileSlugs() },
    );
    await expect(runtime.apply(unrelated)).resolves.toBeUndefined();

    // And the entry carrying it is refused on the next write that touches it,
    // which is where a human can act on it.
    const touched = withUpsert(
      runtime.overlay(),
      {
        slug: "legacy",
        kind: "remote-http",
        url: "https://legacy.example.com/mcp",
        headers: { Authorization: `Bearer ${SECRET}` },
        entitlements: ["admin"],
        title: "Legacy",
      },
      { fileSlugs: runtime.fileSlugs() },
    );
    await expect(runtime.apply(touched)).rejects.toThrow(LiteralCredential);
  });
});

describe("a rename is judged like any other write", () => {
  it("refuses a rename that carries a value, however it is spelled", async () => {
    // `withUpsert` with a `previousSlug` is a removal plus an upsert under a NEW
    // slug, so `changedUpserts` sees a slug it has never held — which is the
    // property that keeps a rename from slipping past the apply-level check.
    const runtime = runtimeOn(BASE_DOC);
    const next = withUpsert(
      runtime.overlay(),
      {
        slug: "declared-renamed",
        kind: "remote-http",
        url: "https://declared.example.com/mcp",
        headers: { Authorization: `Bearer ${SECRET}` },
        entitlements: ["admin"],
      },
      { previousSlug: "declared", fileSlugs: runtime.fileSlugs() },
    );
    await expect(runtime.apply(next)).rejects.toThrow(LiteralCredential);
    expect(runtime.overlay().revision).toBe(0);
  });
});

describe("changedUpserts", () => {
  it("is keyed on slug and compares the whole entry", () => {
    const a = { slug: "a", title: "one" };
    const b = { slug: "b", title: "two" };
    expect(changedUpserts([a, b], [a, b])).toStrictEqual([]);
    expect(changedUpserts([a], [a, b])).toStrictEqual([b]);
    expect(changedUpserts([a, b], [a, { ...b, title: "three" }])).toStrictEqual(
      [{ slug: "b", title: "three" }],
    );
  });
});
