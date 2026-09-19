import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { componentToken } from "../src/auth/internal-token.ts";

import { parseConfig } from "../src/config/load.ts";
import { bundleUrlEnvName, Registry } from "../src/gateway/registry.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import { sharedSecretProviders } from "../src/secrets/provider/index.ts";

/**
 * Core -> `supplementary-image`, the half of the internal-token seam that had
 * never been wired.
 *
 * A strad-image bundle has been authenticated since it was written
 * (`test/bundle.test.ts`, `authenticateInternal` in src/gateway/router.ts). A
 * `supplementary-image` component was NOT: the adapter sent whatever `headers:`
 * the config declared and nothing else, so the `strad-bundle` host — which holds
 * the credential of every server it mounts — was reached with no Authorization
 * header at all, and stood on `internal_ports: [8080]` alone. HACKS.md #13.
 *
 * The assertion is what the UPSTREAM RECEIVES, from a socket, rather than what
 * the endpoint thunk returns: the failure this guards is open, and a header that
 * is built and then dropped somewhere between `endpoint()` and `fetch` looks
 * identical to a fix from inside the registry.
 */

/** The ROOT core holds; the component is presented its own token from it. */
const INTERNAL = "internal-shared-secret";
const OWN = componentToken(INTERNAL, "bundle");

/** Records the headers of every request, and answers nothing useful. */
function recorder(): {
  server: Server;
  received: { path: string; authorization?: string }[];
  ready: Promise<number>;
} {
  const received: { path: string; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    received.push({
      path: req.url ?? "",
      authorization: req.headers.authorization,
    });
    // Enough of a streamable-HTTP answer that the SDK client fails fast rather
    // than hanging; the test never gets past the header.
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "recorded" }));
  });
  const ready = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
  });
  return { server, received, ready };
}

function configFor(headers: string): ReturnType<typeof parseConfig> {
  return parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: supplementary
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /gmail
    entitlements: [admin]
${headers}
`);
}

let upstream: ReturnType<typeof recorder>;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  upstream = recorder();
  const port = await upstream.ready;
  env = {
    STRAD_INTERNAL_TOKEN: INTERNAL,
    [bundleUrlEnvName("bundle")]: `http://127.0.0.1:${port}`,
  };
});

afterAll(() => {
  upstream.server.close();
});

async function reach(config: ReturnType<typeof parseConfig>, e = env) {
  const registry = await Registry.build({
    config,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env: e,
  });
  const adapter = registry.get("supplementary");
  if (!adapter) throw new Error("no adapter");
  // The upstream answers 401 to everything, so this always throws. What it
  // leaves behind is the request the recorder saw.
  await adapter.listTools().catch(() => undefined);
  await adapter.close().catch(() => undefined);
  return upstream.received.at(-1);
}

describe("core -> a supplementary-image component", () => {
  it("presents the internal token, with no `headers:` entry in the config", async () => {
    const seen = await reach(configFor(""));
    expect(seen?.path).toBe("/gmail");
    expect(seen?.authorization).toBe(`Bearer ${OWN}`);
  });

  it("sends exactly one Authorization header, not two spellings of it", async () => {
    const seen = await reach(configFor(""));
    // `fetch` folds a record into `Headers` by APPENDING, so `Authorization`
    // and `authorization` both present would arrive comma-joined and parse as
    // neither.
    expect(seen?.authorization).not.toContain(",");
  });

  it("leaves a configured Authorization alone — that one names an upstream's credential", async () => {
    const seen = await reach(
      configFor('    headers:\n      Authorization: "Token third-party"'),
    );
    expect(seen?.authorization).toBe("Token third-party");
  });

  it("still sends other configured headers alongside the internal token", async () => {
    const seen = await reach(configFor('    headers:\n      X-Trace: "abc"'));
    expect(seen?.authorization).toBe(`Bearer ${OWN}`);
  });

  // Not a fail-closed on this side: the REFUSAL belongs to the bundle host,
  // which answers 503 when it holds no token. Core omitting the header when it
  // holds none is the same thing `internalHeaders` has always done for a
  // strad-image bundle, and it keeps `npm run dev` — which has no token and no
  // bundle — from throwing at boot.
  it("omits the header entirely when core holds no token", async () => {
    const seen = await reach(configFor(""), {
      [bundleUrlEnvName("bundle")]: env[bundleUrlEnvName("bundle")],
    });
    expect(seen?.authorization).toBeUndefined();
  });
});
