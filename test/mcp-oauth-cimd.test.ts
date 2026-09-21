import { createServer, request as httpRequest, type Server } from "node:http";
import type { LookupAddress } from "node:dns";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CIMD_DEFAULT_TTL_MS,
  CIMD_MAX_TTL_MS,
  ClientMetadataResolver,
  clientIdUrlProblem,
  freshnessMs,
  guardedFetch,
  isMetadataClientId,
  isPublicAddress,
  MetadataFetchRefused,
  parseClientMetadata,
  type FetchedDocument,
} from "../src/auth/mcp-oauth/cimd.ts";
import { mcpOAuthKeysFromEnv } from "../src/auth/mcp-oauth/keys.ts";
import {
  isLoopbackRedirect,
  registerClient,
} from "../src/auth/mcp-oauth/clients.ts";

/**
 * Client id metadata documents, below the routes: the URL rules, the document
 * rules, the address check, the fetch's limits and the cache. The flow through
 * `/oauth/authorize` is in `test/mcp-oauth.e2e.test.ts`.
 */

const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CLAUDE,
    client_name: "Claude",
    redirect_uris: [CALLBACK],
    ...overrides,
  };
}

describe("which client ids are metadata-document URLs", () => {
  it("tells a URL from a sealed registration", () => {
    expect(isMetadataClientId(CLAUDE)).toBe(true);
    expect(isMetadataClientId("http://claude.ai/x")).toBe(true);
    // A sealed id is base64url plus a MAC: no colon, ever.
    const sealer = mcpOAuthKeysFromEnv({
      STRAD_OAUTH_KEY: "an-oauth-signing-key-of-sufficient-length",
    })!.client;
    const out = registerClient({ redirect_uris: [CALLBACK] }, sealer, "mcp");
    if (!out.ok) throw new Error("registration refused");
    expect(isMetadataClientId(out.response.client_id)).toBe(false);
  });

  it("applies the draft's URL rules", () => {
    expect(clientIdUrlProblem(CLAUDE)).toBeNull();
    expect(clientIdUrlProblem("https://example.com:8443/c.json")).toBeNull();
    expect(clientIdUrlProblem("https://example.com/c.json?v=1")).toBeNull();

    expect(clientIdUrlProblem("http://example.com/c.json")).toContain("https");
    expect(clientIdUrlProblem("https://example.com")).toContain("path");
    expect(clientIdUrlProblem("https://example.com/")).toContain("path");
    expect(clientIdUrlProblem("https://u:p@example.com/c")).toContain(
      "userinfo",
    );
    expect(clientIdUrlProblem("https://example.com/c#x")).toContain("fragment");
    expect(clientIdUrlProblem("https://example.com/a/../c")).toContain(
      ". or ..",
    );
    expect(clientIdUrlProblem("https://example.com/./c")).toContain(". or ..");
    // Spellings that would be a different client fetching the same document.
    expect(clientIdUrlProblem("https://Example.com/c")).toContain("normalized");
    expect(clientIdUrlProblem("https://example.com:443/c")).toContain(
      "normalized",
    );
    expect(
      clientIdUrlProblem(`https://example.com/${"a".repeat(1100)}`),
    ).toContain("at most");
    // A host the parser rewrites is named as not normalized, not blamed on the
    // path the rewrite happened to shift.
    expect(clientIdUrlProblem("https://0x08080808/c")).toContain("normalized");
  });

  it("refuses a URL that names a non-public address on its face", () => {
    for (const id of [
      "https://127.0.0.1/c",
      "https://10.1.2.3/c",
      "https://192.168.0.1/c",
      "https://169.254.169.254/latest",
      "https://[::1]/c",
      "https://[fd00::1]/c",
      "https://[::ffff:127.0.0.1]/c",
    ]) {
      expect(clientIdUrlProblem(id), id).toContain("private");
    }
    expect(clientIdUrlProblem("https://8.8.8.8/c")).toBeNull();
  });
});

describe("which redirects land on the human's own machine", () => {
  it.each([
    ["http://127.0.0.1:33418/", true],
    ["https://127.0.0.2/cb", true],
    ["http://localhost:9000/cb", true],
    ["https://app.localhost/cb", true],
    ["http://[::1]:9000/cb", true],
    ["https://claude.ai/api/mcp/auth_callback", false],
    ["https://localhost.example/cb", false],
    ["not a url", false],
  ])("%s → %s", (uri, expected) => {
    expect(isLoopbackRedirect(uri)).toBe(expected);
  });
});

describe("which addresses are public", () => {
  it.each([
    ["127.0.0.1", false],
    ["10.0.0.1", false],
    ["172.16.5.4", false],
    ["172.32.0.1", true],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["198.18.0.1", false],
    ["8.8.8.8", true],
    ["104.18.0.1", true],
    ["::1", false],
    ["::", false],
    ["fe80::1", false],
    ["fc00::1", false],
    ["fd12:3456::1", false],
    ["ff02::1", false],
    ["64:ff9b::7f00:1", false],
    ["2002:7f00:1::1", false],
    ["2001:db8::1", false],
    ["2001::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:7f00:1", false],
    ["::ffff:8.8.8.8", true],
    ["2606:4700::6810:84e5", true],
    ["2a00:1450:4001::200e", true],
    ["not-an-ip", false],
  ])("%s → %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe("what a document must say", () => {
  it("accepts claude.ai's document, grants strad does not serve included", () => {
    const out = parseClientMetadata(
      CLAUDE,
      doc({
        client_uri: "https://claude.ai",
        grant_types: [
          "authorization_code",
          "refresh_token",
          "urn:ietf:params:oauth:grant-type:jwt-bearer",
        ],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    );
    expect(out).toEqual({
      ok: true,
      client: {
        clientId: CLAUDE,
        host: "claude.ai",
        name: "Claude",
        uris: [CALLBACK],
      },
    });
  });

  it("refuses a document whose client_id is not its URL", () => {
    for (const id of [
      "https://claude.ai/other",
      `${CLAUDE}/`,
      CLAUDE.toUpperCase(),
      undefined,
    ]) {
      const out = parseClientMetadata(CLAUDE, doc({ client_id: id }));
      expect(out.ok).toBe(false);
      expect(!out.ok && out.description).toContain("does not match");
    }
  });

  it("refuses bad redirect URIs", () => {
    for (const uris of [
      undefined,
      [],
      ["http://claude.ai/cb"],
      ["https://claude.ai/cb#frag"],
      ["https://a@b.example/cb"],
      ["relative/cb"],
      [42],
      Array.from({ length: 33 }, (_, i) => `https://c.example/${i}`),
    ]) {
      const out = parseClientMetadata(CLAUDE, doc({ redirect_uris: uris }));
      expect(out.ok, JSON.stringify(uris)).toBe(false);
    }
    // A loopback listener is a legal redirect URI, as for DCR.
    expect(
      parseClientMetadata(
        CLAUDE,
        doc({ redirect_uris: ["http://127.0.0.1:33418/"] }),
      ).ok,
    ).toBe(true);
  });

  it("refuses a shared secret, and any auth method but none", () => {
    expect(parseClientMetadata(CLAUDE, doc({ client_secret: "s" })).ok).toBe(
      false,
    );
    for (const method of [
      "client_secret_basic",
      "client_secret_post",
      "client_secret_jwt",
      "private_key_jwt",
    ]) {
      const out = parseClientMetadata(
        CLAUDE,
        doc({ token_endpoint_auth_method: method }),
      );
      expect(out.ok, method).toBe(false);
    }
  });

  it("truncates a long name on characters, not UTF-16 units", () => {
    const out = parseClientMetadata(
      CLAUDE,
      doc({ client_name: `${"a".repeat(127)}😀😀` }),
    );
    expect(out.ok && out.client.name).toBe(`${"a".repeat(127)}😀`);
  });

  it("refuses a client that does not do the authorization-code flow", () => {
    expect(
      parseClientMetadata(CLAUDE, doc({ grant_types: ["client_credentials"] }))
        .ok,
    ).toBe(false);
    expect(
      parseClientMetadata(CLAUDE, doc({ response_types: ["token"] })).ok,
    ).toBe(false);
  });

  it("refuses what is not an object", () => {
    for (const body of [null, [], "x", 1]) {
      expect(parseClientMetadata(CLAUDE, body).ok).toBe(false);
    }
  });
});

describe("the guarded fetch", () => {
  // A plain-HTTP document server on loopback, reached through the real fetch
  // with `http.request` as its transport and the address check opened for it.
  // Everything else — the size cap, the deadline, the redirect rule — is the
  // code that runs in production.
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/big") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ pad: "x".repeat(10_000) }));
      } else if (req.url === "/slow") {
        res.setHeader("content-type", "application/json");
        res.write("{");
        // never finishes
      } else if (req.url === "/redirect") {
        res.statusCode = 302;
        res.setHeader("location", "http://169.254.169.254/latest");
        res.end();
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const open = { addressAllowed: () => true, request: httpRequest };

  it("reads a small document", async () => {
    const got = await guardedFetch(new URL(`${origin}/ok`), open);
    expect(got.status).toBe(200);
    expect(JSON.parse(got.body.toString())).toEqual({ ok: true });
  });

  it("stops reading past the size cap", async () => {
    await expect(
      guardedFetch(new URL(`${origin}/big`), open),
    ).rejects.toMatchObject({ reason: "client_metadata_unreachable" });
  });

  it("gives up at the deadline", async () => {
    await expect(
      guardedFetch(new URL(`${origin}/slow`), { ...open, timeoutMs: 200 }),
    ).rejects.toThrow(/did not arrive/);
  });

  it("does not follow a redirect", async () => {
    const got = await guardedFetch(new URL(`${origin}/redirect`), open);
    expect(got.status).toBe(302);
  });

  it("refuses the loopback server itself under the default address rule", async () => {
    await expect(
      guardedFetch(new URL(`${origin}/ok`), { request: httpRequest }),
    ).rejects.toMatchObject({ reason: "client_metadata_blocked" });
  });

  /** A resolver that answers every name with these addresses. */
  function resolvingTo(addresses: string[]) {
    const list: LookupAddress[] = addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
    return ((
      _host: string,
      _opts: unknown,
      cb: (e: null, a: LookupAddress[]) => void,
    ) => cb(null, list)) as never;
  }

  it("refuses a name that resolves to a private address, before connecting", async () => {
    await expect(
      guardedFetch(new URL("https://docs.example/c.json"), {
        lookup: resolvingTo(["10.0.0.5"]),
      }),
    ).rejects.toMatchObject({ reason: "client_metadata_blocked" });
  });

  it("refuses a name with one public and one private address (rebinding)", async () => {
    await expect(
      guardedFetch(new URL("https://docs.example/c.json"), {
        lookup: resolvingTo(["93.184.216.34", "169.254.169.254"]),
      }),
    ).rejects.toMatchObject({ reason: "client_metadata_blocked" });
  });

  it("dials the address it vetted, not a second lookup's", async () => {
    // The name resolves ONLY to the loopback server's address, and the address
    // rule admits exactly that one — so a successful read proves the socket
    // used the vetted answer.
    const port = (server.address() as AddressInfo).port;
    const got = await guardedFetch(new URL(`http://docs.example:${port}/ok`), {
      request: httpRequest,
      lookup: resolvingTo(["127.0.0.1"]),
      addressAllowed: (a) => a === "127.0.0.1",
    });
    expect(got.status).toBe(200);
  });
});

describe("the resolver", () => {
  function answering(responses: Array<FetchedDocument | Error>): {
    fetch: (url: URL) => Promise<FetchedDocument>;
    calls: () => number;
  } {
    let calls = 0;
    return {
      fetch: async () => {
        const next = responses[Math.min(calls, responses.length - 1)];
        calls++;
        if (next instanceof Error) throw next;
        return next as FetchedDocument;
      },
      calls: () => calls,
    };
  }

  function ok(
    body: unknown,
    headers: Record<string, string> = {},
  ): FetchedDocument {
    return {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
      body: Buffer.from(JSON.stringify(body)),
    };
  }

  it("caches a good document for its max-age, and refetches after", async () => {
    let now = 1_000_000;
    const net = answering([ok(doc(), { "cache-control": "max-age=60" })]);
    const resolver = new ClientMetadataResolver({
      fetch: net.fetch,
      now: () => now,
    });
    expect((await resolver.resolve(CLAUDE)).ok).toBe(true);
    expect((await resolver.resolve(CLAUDE)).ok).toBe(true);
    expect(net.calls()).toBe(1);
    now += 61_000;
    await resolver.resolve(CLAUDE);
    expect(net.calls()).toBe(2);
  });

  it("does not cache no-store, an error, or an invalid document", async () => {
    for (const first of [
      ok(doc(), { "cache-control": "no-store" }),
      new MetadataFetchRefused("client_metadata_unreachable", "down"),
      ok(doc({ client_id: "https://other.example/x" })),
      { status: 404, headers: {}, body: Buffer.from("") },
    ]) {
      const net = answering([first, ok(doc())]);
      const resolver = new ClientMetadataResolver({ fetch: net.fetch });
      await resolver.resolve(CLAUDE);
      await resolver.resolve(CLAUDE);
      expect(net.calls()).toBe(2);
    }
  });

  it("shares one fetch between concurrent authorizations", async () => {
    const net = answering([ok(doc())]);
    const resolver = new ClientMetadataResolver({ fetch: net.fetch });
    const all = await Promise.all([
      resolver.resolve(CLAUDE),
      resolver.resolve(CLAUDE),
      resolver.resolve(CLAUDE),
    ]);
    expect(all.every((o) => o.ok)).toBe(true);
    expect(net.calls()).toBe(1);
  });

  it("refuses a redirect, a non-200, a non-JSON type and a non-JSON body", async () => {
    const cases: Array<[FetchedDocument, string]> = [
      [
        {
          status: 302,
          headers: { location: "https://x" },
          body: Buffer.from(""),
        },
        "redirect",
      ],
      [{ status: 500, headers: {}, body: Buffer.from("") }, "500"],
      [
        {
          status: 200,
          headers: { "content-type": "text/html" },
          body: Buffer.from(JSON.stringify(doc())),
        },
        "JSON",
      ],
      [
        {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from("{nope"),
        },
        "valid JSON",
      ],
    ];
    for (const [answer, words] of cases) {
      const resolver = new ClientMetadataResolver({
        fetch: answering([answer]).fetch,
      });
      const out = await resolver.resolve(CLAUDE);
      expect(out.ok).toBe(false);
      expect(!out.ok && out.description).toContain(words);
    }
  });

  it("accepts an application/…+json content type with parameters", async () => {
    const resolver = new ClientMetadataResolver({
      fetch: answering([
        {
          status: 200,
          headers: { "content-type": "application/client+json; charset=utf-8" },
          body: Buffer.from(JSON.stringify(doc())),
        },
      ]).fetch,
    });
    expect((await resolver.resolve(CLAUDE)).ok).toBe(true);
  });

  it("reports an unexpected fetch failure as unreachable, never as a throw", async () => {
    const resolver = new ClientMetadataResolver({
      fetch: answering([new TypeError("socket hang up")]).fetch,
    });
    await expect(resolver.resolve(CLAUDE)).resolves.toMatchObject({
      ok: false,
      reason: "client_metadata_unreachable",
    });
  });

  it("refuses a fetch past the concurrency ceiling, whatever the URL", async () => {
    // A fetch that never answers until released: the tarpit case.
    const release: Array<() => void> = [];
    let calls = 0;
    const resolver = new ClientMetadataResolver({
      maxConcurrent: 2,
      fetch: (url) => {
        calls++;
        return new Promise<FetchedDocument>((done) =>
          release.push(() =>
            done({
              status: 200,
              headers: { "content-type": "application/json" },
              body: Buffer.from(JSON.stringify(doc({ client_id: url.href }))),
            }),
          ),
        );
      },
    });
    const a = resolver.resolve(`${CLAUDE}?n=1`);
    const b = resolver.resolve(`${CLAUDE}?n=2`);
    const refused = await resolver.resolve(`${CLAUDE}?n=3`);
    expect(refused).toMatchObject({
      ok: false,
      reason: "client_metadata_unreachable",
    });
    expect(!refused.ok && refused.description).toContain("too many");
    expect(calls).toBe(2);

    for (const r of release) r();
    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(true);
    // The slots come back once the fetches finish.
    const later = resolver.resolve(`${CLAUDE}?n=4`);
    release[2]?.();
    expect((await later).ok).toBe(true);
  });

  it("never fetches a URL that fails the shape rules", async () => {
    const net = answering([ok(doc())]);
    const resolver = new ClientMetadataResolver({ fetch: net.fetch });
    const out = await resolver.resolve("https://127.0.0.1/c.json");
    expect(out).toMatchObject({ ok: false, reason: "client_id_invalid" });
    expect(net.calls()).toBe(0);
  });
});

describe("freshness", () => {
  it("reads Cache-Control within bounds", () => {
    expect(freshnessMs({})).toBe(CIMD_DEFAULT_TTL_MS);
    expect(freshnessMs({ "cache-control": "public, max-age=300" })).toBe(
      300_000,
    );
    expect(freshnessMs({ "cache-control": "max-age=999999" })).toBe(
      CIMD_MAX_TTL_MS,
    );
    expect(
      freshnessMs({ "cache-control": "no-store,no-cache,max-age=0" }),
    ).toBe(0);
    expect(freshnessMs({ "cache-control": "no-cache" })).toBe(0);
    expect(freshnessMs({ "cache-control": "max-age=0" })).toBe(0);
    // Malformed means stale (RFC 9111 §4.2.1), not "unspecified".
    expect(freshnessMs({ "cache-control": "max-age=-1" })).toBe(0);
    expect(freshnessMs({ "cache-control": "max-age=soon" })).toBe(0);
    expect(freshnessMs({ "cache-control": "public" })).toBe(
      CIMD_DEFAULT_TTL_MS,
    );
  });
});
