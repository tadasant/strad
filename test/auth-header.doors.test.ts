import { timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerToken, secretEquals } from "../src/auth/credential.ts";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { stateMatches } from "../src/auth/session.ts";
import { mintToken } from "../src/auth/tokens.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import {
  PARAM_ROUTE_PREFIX,
  STORE_REFRESH_ROUTE,
} from "../src/secrets/param-route.ts";
import { constantTimeEquals, PRESENCE_ROUTE } from "../src/secrets/presence.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";

/**
 * One way to read an `Authorization` header, and one way to compare what it
 * carries, on every door strad has.
 *
 * The doors are the public `/mcp` and the readiness route (a static token), the
 * console's `/ui` gate and `/console` (the bootstrap token, from a header), and
 * the internal token: a bundle's `/mcp` and `/_strad/presence` in the strad
 * image, and core's `/_strad/params` and `/_strad/store/refresh`. The host
 * image's mounts and presence route run the same vendored parse, and assert it
 * in `servers/bundle/host/test/`.
 *
 * Every door is asked the same five questions: its own right credential with
 * no scheme, with `Bearer`, with the scheme in another case, and under `Basic`,
 * and a wrong credential under `Bearer`. The scheme-less one must be refused
 * on every door. An optional scheme is what `replace` gives you by accident,
 * and a door that accepts a bare token while the door beside it refuses one is
 * an auth model nobody chose. The wrong credential is the question the parse
 * cannot answer, so it is the one that proves the COMPARE runs.
 */

describe("bearerToken", () => {
  it.each([
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["BEARER abc", "abc"],
    ["Bearer   abc  ", "abc"],
    // A space inside the credential is the credential's business; the compare
    // refuses it, the parse does not rewrite it.
    ["Bearer a b", "a b"],
  ])("reads %j as %j", (header, token) => {
    expect(bearerToken(header)).toBe(token);
  });

  it.each([
    [undefined],
    [""],
    // No scheme at all: the header IS a token, and it is still refused.
    ["abc"],
    ["strad_test_deadbeef_secret"],
    // A scheme and nothing after it.
    ["Bearer"],
    ["Bearer "],
    ["Bearer    "],
    // Another scheme, or something that only starts like this one.
    ["Basic abc"],
    ["Bearerabc"],
    ["Bearer\tabc"],
    [" Bearer abc"],
  ])("refuses %j", (header) => {
    expect(bearerToken(header)).toBeNull();
  });
});

/**
 * The comparator behind every door. One length guard written wrong here is
 * wrong on all of them at once, and silently — so it is asserted directly,
 * rather than trusted to whichever route happens to exercise it.
 */
describe("secretEquals", () => {
  it("is true for equal strings", () => {
    expect(secretEquals("token-value", "token-value")).toBe(true);
    expect(secretEquals("é", "é")).toBe(true);
  });

  it("is false for different strings of the same length", () => {
    expect(secretEquals("token-value", "token-valuf")).toBe(false);
    expect(secretEquals("aaaa", "aaab")).toBe(false);
    expect(secretEquals("baaa", "aaaa")).toBe(false);
  });

  it("is false, and does not throw, for different lengths in either order", () => {
    // `timingSafeEqual` throws on a length mismatch; the guard is what turns
    // that into a plain no.
    expect(() => secretEquals("short", "much-longer")).not.toThrow();
    expect(secretEquals("short", "much-longer")).toBe(false);
    expect(secretEquals("much-longer", "short")).toBe(false);
    // A prefix of the right value is the case a bad guard would let through.
    expect(secretEquals("token-valu", "token-value")).toBe(false);
    expect(secretEquals("token-value", "token-valu")).toBe(false);
  });

  it("compares utf-8 bytes, not UTF-16 code units", () => {
    // Equal `.length`, different byte lengths: a guard on `.length` would hand
    // `timingSafeEqual` two buffers of different sizes, and it would throw.
    expect("é".length).toBe("e".length);
    expect(() => secretEquals("é", "e")).not.toThrow();
    expect(secretEquals("é", "e")).toBe(false);
  });

  it("treats empty inputs by length, and leaves refusing them to the door", () => {
    expect(secretEquals("", "x")).toBe(false);
    expect(secretEquals("x", "")).toBe(false);
    // Two empty strings ARE equal. Every door refuses an empty presented or
    // expected credential before it compares, and `stateMatches` adds the one
    // guard on top that says two absent states are not a match.
    expect(secretEquals("", "")).toBe(true);
    expect(stateMatches("", "")).toBe(false);
    expect(stateMatches("", "x")).toBe(false);
    expect(stateMatches("state", "state")).toBe(true);
    expect(stateMatches("state", "statf")).toBe(false);
  });

  it("agrees with the vendored module's JS fallback on every case", () => {
    // The host image passes its own `node:crypto`, but the fallback is the
    // same framing and must give the same answers.
    const cases: [string, string][] = [
      ["a", "a"],
      ["a", "b"],
      ["short", "much-longer"],
      ["é", "e"],
      ["", ""],
      ["", "x"],
    ];
    for (const [a, b] of cases) {
      expect(constantTimeEquals(a, b), `${a} vs ${b}`).toBe(secretEquals(a, b));
      expect(constantTimeEquals(a, b, timingSafeEqual)).toBe(
        secretEquals(a, b),
      );
    }
  });
});

// --- every door, over HTTP ---------------------------------------------------

const CORE_CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
`);

const BUNDLE_CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle-api
servers:
  - slug: bundled
    kind: builtin
    module: "./servers/echo.js"
    bundle: bundle-api
    entitlements: [admin]
`);

const STATIC = mintToken({ env: "test", label: "admin", roles: ["admin"] });
const BOOTSTRAP = "bootstrap-token-value";
const INTERNAL = "internal-token-value";

let coreServer: Server;
let bundleServer: Server;
let coreUrl: string;
let bundleUrl: string;

function listen(app: ReturnType<typeof createApp>): Promise<[Server, string]> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      if (typeof address === "string" || !address) throw new Error("no port");
      resolve([server, `http://127.0.0.1:${address.port}`]);
    });
  });
}

beforeAll(async () => {
  const coreEnv: NodeJS.ProcessEnv = {
    STRAD_TOKENS: JSON.stringify([STATIC.record]),
    ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
    ALLOW_DEV_AUTH: "true",
    STRAD_INTERNAL_TOKEN: INTERNAL,
  };
  [coreServer, coreUrl] = await listen(
    createApp({
      config: CORE_CONFIG,
      registry: await Registry.build({
        config: CORE_CONFIG,
        secrets: sharedSecretProviders(new EnvSecretProvider({})),
        mode: "core",
        env: coreEnv,
      }),
      tokenStore: tokenStoreFromConfig(CORE_CONFIG, coreEnv),
      mode: "core",
      env: coreEnv,
    }),
  );

  const bundleEnv: NodeJS.ProcessEnv = { STRAD_INTERNAL_TOKEN: INTERNAL };
  [bundleServer, bundleUrl] = await listen(
    createApp({
      config: BUNDLE_CONFIG,
      registry: await Registry.build({
        config: BUNDLE_CONFIG,
        secrets: sharedSecretProviders(new EnvSecretProvider({})),
        mode: "bundle",
        bundleName: "bundle-api",
        env: bundleEnv,
      }),
      tokenStore: tokenStoreFromConfig(BUNDLE_CONFIG, bundleEnv),
      mode: "bundle",
      env: bundleEnv,
    }),
  );
});

afterAll(() => {
  coreServer?.close();
  bundleServer?.close();
});

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "doors", version: "1" },
  },
});

function mcp(base: () => string) {
  return (authorization: string) =>
    fetch(`${base()}/mcp`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: INITIALIZE,
    });
}

interface Door {
  door: string;
  /** The credential this door takes, right in every byte. */
  credential: string;
  ask: (authorization: string) => Promise<Response>;
  /** What the door answers once the credential has been accepted. */
  admitted: number;
}

const DOORS: Door[] = [
  {
    door: "core /mcp",
    credential: STATIC.plaintext,
    ask: mcp(() => coreUrl),
    admitted: 200,
  },
  {
    door: "core /api/secrets/readiness",
    credential: STATIC.plaintext,
    ask: (authorization) =>
      fetch(`${coreUrl}/api/secrets/readiness`, { headers: { authorization } }),
    admitted: 200,
  },
  {
    door: "core /console (bootstrap token, header path)",
    credential: BOOTSTRAP,
    ask: (authorization) =>
      fetch(`${coreUrl}/console`, {
        headers: { authorization },
        redirect: "manual",
      }),
    admitted: 200,
  },
  {
    door: "core /ui (bootstrap token, header path)",
    credential: BOOTSTRAP,
    ask: (authorization) =>
      fetch(`${coreUrl}/ui`, {
        headers: { authorization },
        redirect: "manual",
      }),
    admitted: 200,
  },
  {
    door: `core ${PARAM_ROUTE_PREFIX}`,
    credential: INTERNAL,
    ask: (authorization) =>
      fetch(`${coreUrl}${PARAM_ROUTE_PREFIX}/echo/NOT_WRITABLE`, {
        headers: { authorization },
      }),
    // Past the gate, and refused by the `paramsWritable:` allowlist — a
    // different refusal from the gate's, reachable only once the token is in.
    admitted: 403,
  },
  {
    door: `core ${STORE_REFRESH_ROUTE}`,
    credential: INTERNAL,
    ask: (authorization) =>
      fetch(`${coreUrl}${STORE_REFRESH_ROUTE}`, {
        method: "POST",
        headers: { authorization },
      }),
    admitted: 200,
  },
  {
    door: "bundle /mcp (strad image)",
    credential: INTERNAL,
    ask: mcp(() => bundleUrl),
    admitted: 200,
  },
  {
    door: `bundle ${PRESENCE_ROUTE} (strad image)`,
    credential: INTERNAL,
    ask: (authorization) =>
      fetch(`${bundleUrl}${PRESENCE_ROUTE}`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ keys: ["SLACK_BOT_TOKEN"] }),
      }),
    admitted: 200,
  },
];

describe.each(DOORS)("$door", ({ credential, ask, admitted }) => {
  it("refuses a scheme-less Authorization header carrying the right credential", async () => {
    const res = await ask(credential);
    expect(res.status).toBe(401);
  });

  it("admits `Bearer <credential>`", async () => {
    const res = await ask(`Bearer ${credential}`);
    expect(res.status).toBe(admitted);
  });

  it("admits the scheme in any case", async () => {
    const res = await ask(`bEaReR ${credential}`);
    expect(res.status).toBe(admitted);
  });

  it("refuses the right credential under another scheme", async () => {
    const res = await ask(`Basic ${credential}`);
    expect(res.status).toBe(401);
  });

  it("refuses a wrong credential under the right scheme", async () => {
    // One byte longer: the shape a length guard written wrong lets through.
    const res = await ask(`Bearer ${credential}x`);
    expect(res.status).toBe(401);
  });
});

// --- and no door grows its own ------------------------------------------------

/**
 * The door tests above cover the doors that exist. A new one written from
 * memory reaches for `header.replace(/^Bearer\s+/i, "")`, a `"Bearer "`
 * prefix check, or a local `timingSafeEqual` wrapper, and none of those would
 * be caught by a test of a route it did not know about. So the source is read
 * too, in both trees that serve a door.
 *
 * What this cannot see is a door that compares with `===`; a scan for that
 * would flag every string comparison in the gateway. The door table above is
 * the check for that, one door at a time.
 */
describe("no door parses or compares a credential by hand", () => {
  const ROOTS = ["src", "servers/bundle/host/src"];

  /** Where the one parse and the one comparator live, in each tree. */
  const OWNERS = new Set([
    "src/secrets/presence.ts",
    "servers/bundle/host/src/presence.ts",
  ]);

  /**
   * The names a request's `Authorization` header may be handed to. Every one
   * reads it with `bearerToken`; a file that reads the header and names none
   * of them is reading it some other way.
   */
  const GATES =
    /\b(?:bearerToken|authenticateMcp|authorizePresence|presenceResponse|requireInternalToken|internalAuthRefusal)\b/;

  const sources = ROOTS.flatMap((root) =>
    readdirSync(root, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => {
        const path = join(root, name);
        return [path, readFileSync(path, "utf8")] as const;
      }),
  );
  const others = sources.filter(([path]) => !OWNERS.has(path));

  it("reads the trees it claims to", () => {
    expect(sources.length).toBeGreaterThan(50);
    for (const owner of OWNERS) {
      expect(
        sources.some(([path]) => path === owner),
        owner,
      ).toBe(true);
    }
  });

  it("hands every Authorization header it reads to a gate", () => {
    const readers = others.filter(([, text]) =>
      /headers\.authorization\b|\.get\(\s*["']authorization["']\s*\)/i.test(
        text,
      ),
    );
    // Sanity: the scan finds the doors it is about.
    expect(readers.map(([path]) => path)).toContain("src/gateway/router.ts");
    expect(readers.map(([path]) => path)).toContain(
      "servers/bundle/host/src/internal-auth.ts",
    );
    const offenders = readers
      .filter(([, text]) => !GATES.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("matches the Bearer scheme nowhere but the owner", () => {
    const offenders = others
      .filter(
        ([, text]) =>
          // An anchored regex, or a quoted `"bearer"` / `"Bearer "` to compare
          // or prefix-match against. `Bearer ${token}` in a template literal —
          // a header strad SENDS — is neither, and neither are the two places
          // the word is a value rather than a pattern. `token_type: "Bearer"`
          // is RFC 6749 §5.1's field on the token endpoint's response
          // (src/http/oauth.ts): strad naming the scheme it just issued a
          // credential for. `CREDENTIAL_SCHEMES` (src/config/secret-position.ts)
          // is the vocabulary a CONFIG value may name in front of a `${NAME}`
          // ref — what a roster entry is allowed to say strad should SEND, not
          // anything an arriving header is compared against.
          //
          // Both are stripped by their own name rather than exempted by file,
          // so a second quoted `"Bearer"` in either module is still caught.
          /\/\^\s*bearer/i.test(text) ||
          /["']bearer ?["']/i.test(withoutSpokenSchemes(text)),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  /** The two places the scheme is a word strad SPEAKS, and only those two. */
  function withoutSpokenSchemes(text: string): string {
    return text
      .replace(/token_type:\s*["']Bearer["']/g, "token_type: <>")
      .replace(/CREDENTIAL_SCHEMES = \[[^\]]*\]/g, "CREDENTIAL_SCHEMES = <>");
  }

  it("calls timingSafeEqual nowhere but the owner, and the session MAC", () => {
    const calls = (text: string) =>
      [...text.matchAll(/\btimingSafeEqual\s*\(/g)].length;
    const counts = Object.fromEntries(
      others
        .map(([path, text]) => [path, calls(text)] as const)
        .filter(([, n]) => n > 0),
    );
    // `Sealer.unseal` compares two decoded MACs — bytes, not a presented
    // credential string — and is length-guarded on the line above. It is the
    // one call outside the owner, and pinned to one so a second in the same
    // file is not waved through with it.
    expect(counts).toEqual({ "src/auth/session.ts": 1 });
  });
});
