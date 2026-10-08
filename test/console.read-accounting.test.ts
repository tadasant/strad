import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import { createGcpParameterStore } from "../src/secrets/parameters/gcp.ts";
import {
  ParameterStoreError,
  type Capabilities,
} from "../src/secrets/parameters/index.ts";
import { renderSecrets } from "../src/ui/render.ts";
import { resolveServerView } from "../src/ui/resolve.ts";
import { revealPosture } from "../src/ui/reveal.ts";
import { CONSOLE_SNAPSHOT_TTL_MS } from "../src/ui/store-client.ts";

/**
 * What one load of `/ui/<secrets slug>` costs the parameter store, counted.
 *
 * The console's admin client read the store LIVE: every page load and every
 * action re-enumerated the whole project — a `ListParameterVersions` and a
 * `GetParameterVersion` per parameter, ten at a time. At production's size
 * that was a couple of hundred requests per click, which is what made the
 * console slow and what tripped Parameter Manager's per-minute quota into the
 * `429` that blanked the listing.
 *
 * Measured here against the in-memory fake, with the TTL and the clock the
 * console's client has (`storeFor`, `src/ui/store-client.ts`), at 120
 * parameters.
 */

const P = 120;
const NS = "/strad/prod/mcp/";

interface Counts {
  listParameters: number;
  listVersions: number;
  getVersion: number;
  other: number;
}

function classify(method: string, url: string, counts: Counts): void {
  const path = url.split("?")[0]!;
  if (method !== "GET") counts.other += 1;
  else if (/\/versions\/[^/:]+$/.test(path)) counts.getVersion += 1;
  else if (path.endsWith("/versions")) counts.listVersions += 1;
  else if (path.endsWith("/parameters")) counts.listParameters += 1;
  else counts.other += 1;
}

function clock() {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A console-shaped client over the fake, counting what it asks for. */
function consoleClient(
  gcp: FakeGcp,
  opts: { now: () => number; failGet?: (url: string) => boolean },
) {
  const counts: Counts = {
    listParameters: 0,
    listVersions: 0,
    getVersion: 0,
    other: 0,
  };
  const store = createGcpParameterStore({
    projectId: gcp.endpoints.projectId,
    location: gcp.endpoints.location,
    account: JSON.parse(gcp.endpoints.keyJson) as {
      client_email: string;
      private_key: string;
    },
    pmApiBase: gcp.endpoints.pmApiBase,
    smApiBase: gcp.endpoints.smApiBase,
    tokenUrl: gcp.endpoints.tokenUrl,
    fetchImpl: (input, init) => {
      const url = String(input);
      if (url.startsWith(gcp.endpoints.pmApiBase)) {
        classify(init?.method ?? "GET", url, counts);
        if (opts.failGet?.(url)) {
          return Promise.resolve(
            new Response("{}", {
              status: 429,
              statusText: "Too Many Requests",
            }),
          );
        }
      }
      return gcp.fetchImpl(input, init);
    },
    // No retries: the throttled read below must fail on the first answer, or
    // the test spends the default budget's backoff sleeping.
    retry: { attempts: 1 },
    snapshotTtlMs: CONSOLE_SNAPSHOT_TTL_MS,
    now: opts.now,
  });
  const take = (): Counts => {
    const out = { ...counts };
    counts.listParameters = 0;
    counts.listVersions = 0;
    counts.getVersion = 0;
    counts.other = 0;
    return out;
  };
  return { store, take };
}

async function seed(gcp: FakeGcp): Promise<void> {
  for (let i = 0; i < P; i++) {
    await gcp.store.create({
      path: `${NS}server-${i % 12}/static/VAR_${i}`,
      secret: i % 3 !== 0,
      value: `value-${i}`,
    });
  }
}

const NOTHING: Counts = {
  listParameters: 0,
  listVersions: 0,
  getVersion: 0,
  other: 0,
};

describe("the console's admin client: what a page load costs", () => {
  it("reads the store once, then serves page loads and namespace switches from the reading", async () => {
    const gcp = createFakeGcp();
    await seed(gcp);
    const t = clock();
    const { store, take } = consoleClient(gcp, { now: t.now });

    // The first load enumerates: the `ListParameters` listing (one page here —
    // the fake does not paginate; production's ~130 parameters are two), then
    // one version listing and one version read per parameter.
    const first = await store.listDetailed!(NS);
    expect(first.parameters).toHaveLength(P);
    expect(take()).toEqual({
      listParameters: 1,
      listVersions: P,
      getVersion: P,
      other: 0,
    });

    // Every load after it, inside the TTL, is free — including a switch to a
    // narrower namespace, which slices the same reading.
    await store.listDetailed!(NS);
    await store.listDetailed!(`${NS}server-3/static/`);
    await store.list(NS);
    expect(take()).toEqual(NOTHING);
  });

  it("re-reads past the TTL without re-reading an unchanged version", async () => {
    const gcp = createFakeGcp();
    await seed(gcp);
    const t = clock();
    const { store, take } = consoleClient(gcp, { now: t.now });
    await store.listDetailed!(NS);
    take();

    t.advance(CONSOLE_SNAPSHOT_TTL_MS + 1);
    // Changed outside this client: only this one is read again.
    await gcp.store.rotate(`${NS}server-0/static/VAR_0`, "rotated");
    const again = await store.listDetailed!(NS);
    expect(again.parameters).toHaveLength(P);
    expect(take()).toEqual({
      listParameters: 1,
      listVersions: P,
      getVersion: 1,
      other: 0,
    });
    expect(
      again.parameters.find((p) => p.path === `${NS}server-0/static/VAR_0`)
        ?.latestVersion,
    ).toBe("v2");
  });

  it("a write through the client re-reads the one parameter it touched, not the project", async () => {
    const gcp = createFakeGcp();
    await seed(gcp);
    const t = clock();
    const { store, take } = consoleClient(gcp, { now: t.now });
    await store.listDetailed!(NS);
    take();

    await store.setNote(`${NS}server-1/static/VAR_1`, "a note");
    take(); // the write's own reads and POST
    const afterNote = await store.listDetailed!(NS);
    expect(take()).toEqual({
      listParameters: 0,
      listVersions: 1,
      getVersion: 1,
      other: 0,
    });
    expect(
      afterNote.parameters.find((p) => p.path === `${NS}server-1/static/VAR_1`)
        ?.note,
    ).toBe("a note");

    await store.create({
      path: `${NS}server-1/static/NEW`,
      secret: false,
      value: "x",
    });
    await store.destroy(`${NS}server-2/static/VAR_2`);
    take();
    const afterBoth = await store.listDetailed!(NS);
    expect(take().listParameters).toBe(0);
    const paths = afterBoth.parameters.map((p) => p.path);
    expect(paths).toContain(`${NS}server-1/static/NEW`);
    expect(paths).not.toContain(`${NS}server-2/static/VAR_2`);
    expect(paths).toHaveLength(P);
  });

  it("a parameter deleted and re-created under the same path is not served from the envelope cache", async () => {
    const gcp = createFakeGcp();
    const path = `${NS}server-0/static/SAME`;
    await gcp.store.create({ path, secret: false, value: "a", note: "old" });
    const t = clock();
    const { store } = consoleClient(gcp, { now: t.now });
    expect((await store.listDetailed!(NS)).parameters[0]?.note).toBe("old");

    // Outside this client, so its reading is not patched: both are `v1`.
    await gcp.store.destroy(path);
    await gcp.store.create({ path, secret: true, value: "b", note: "new" });
    t.advance(CONSOLE_SNAPSHOT_TTL_MS + 1);
    const [meta] = (await store.listDetailed!(NS)).parameters;
    expect(meta?.latestVersion).toBe("v1");
    expect(meta?.note).toBe("new");
    expect(meta?.secret).toBe(true);
  });
});

describe("one unreadable parameter", () => {
  const BAD = "strad-prod-mcp-server-5-static-var-5";

  it("is named beside the rest, and fails only the strict list()", async () => {
    const gcp = createFakeGcp();
    await seed(gcp);
    const t = clock();
    let throttled = true;
    const { store, take } = consoleClient(gcp, {
      now: t.now,
      failGet: (url) =>
        throttled && url.split("?")[0]!.endsWith(`/parameters/${BAD}/versions`),
    });

    const listing = await store.listDetailed!(NS);
    expect(listing.parameters).toHaveLength(P - 1);
    expect(listing.unreadable.map((u) => u.id)).toEqual([BAD]);
    const [failure] = listing.unreadable;
    expect(failure?.error).toBeInstanceOf(ParameterStoreError);
    expect((failure?.error as ParameterStoreError).status).toBe(429);

    // The resolver's contract is unchanged: a parameter nobody could read may
    // be one a child needs, so the strict read throws its error.
    await expect(store.list(NS)).rejects.toMatchObject({ status: 429 });

    // A namespace the unreadable id cannot belong to is not told about it.
    expect(
      (await store.listDetailed!("/strad/prod/other/")).unreadable,
    ).toEqual([]);

    // Not held: the next read tries again, and only the version that never
    // came back costs a `GetParameterVersion`.
    throttled = false;
    take();
    const healed = await store.listDetailed!(NS);
    expect(healed.parameters).toHaveLength(P);
    expect(healed.unreadable).toEqual([]);
    expect(take()).toEqual({
      listParameters: 1,
      listVersions: P,
      getVersion: 1,
      other: 0,
    });
  });
});

describe("the secrets page", () => {
  const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: prod }
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    consoleEnv:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${NS}"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
`);
  const SECRETS = {
    ADMIN_KEY: JSON.stringify({
      client_email: "admin@demo.iam.gserviceaccount.com",
      private_key:
        "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
    }),
  };
  const CAPS: Capabilities = {
    readSecretValues: true,
    writeParameters: true,
    writeSecretValues: true,
    deleteParameters: true,
    probed: true,
  };

  function page(extra: {
    unreadable?: { id: string; reason: string }[];
    listFailure?: string;
  }): string {
    const view = resolveServerView(CONFIG, "secrets", SECRETS);
    if (view.kind !== "secrets") throw new Error(`view is ${view.kind}`);
    return renderSecrets({
      view,
      store: view.stores[0]!,
      config: CONFIG,
      parameters: [
        {
          path: `${NS}telegram-rw/static/TELEGRAM_API_ID`,
          variable: "TELEGRAM_API_ID",
          secret: false,
          hasValue: true,
          latestVersion: "v1",
        },
      ],
      namespace: NS,
      resolver: true,
      reveal: revealPosture(true, CAPS),
      revealNonSecret: revealPosture(true, CAPS, false),
      siblingPages: [],
      ...extra,
    });
  }

  it("shows the rows it read and names the one it could not", () => {
    const html = page({
      unreadable: [
        {
          id: "strad-prod-mcp-telegram-rw-static-telegram-api-hash",
          reason: "GET … failed: 429 Too Many Requests",
        },
      ],
    });
    expect(html).toContain("TELEGRAM_API_ID");
    expect(html).toContain("1 parameter in this project could not be read");
    expect(html).toContain(
      "strad-prod-mcp-telegram-rw-static-telegram-api-hash",
    );
    expect(html).not.toContain("No parameters in this namespace yet");
  });

  it("an unread namespace is not an empty one", () => {
    const view = page({ listFailure: "The store did not answer in time." });
    expect(view).toContain("Could not read this namespace");
    expect(view).not.toContain("No parameters in this namespace yet");
  });
});
