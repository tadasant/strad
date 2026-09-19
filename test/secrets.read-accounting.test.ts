import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import { createGcpParameterStore } from "../src/secrets/parameters/gcp.ts";
import {
  gatewayNamespace,
  staticNamespace,
} from "../src/secrets/parameters/namespace.ts";
import type { ParameterStore } from "../src/secrets/parameters/types.ts";
import { buildSecretProviders } from "../src/secrets/provider/index.ts";
import { readStoreDiagnosticsCached } from "../src/secrets/store-diagnostics.ts";

/**
 * What a running gateway costs the parameter store, counted.
 *
 * Parameter Manager bills two verbs — `GetParameterVersion` and
 * `RenderParameterVersion` — and lists neither `ListParameters` nor
 * `ListParameterVersions`. Production's August bill was ~3.2M of the billed
 * two, flat around the clock, because every namespace a process read had its
 * own timer and every refresh enumerated the whole project: cost scaled as
 * namespaces x parameters x (86400 / ttlSeconds) per day.
 *
 * This file measures the shape production actually has — 34 parameters, one
 * gateway namespace, six server namespaces, a `params: true` builtin and the
 * console's diagnosis — against the in-memory fake, with a transport that
 * classifies every request by verb. The numbers it asserts are the numbers
 * the PR that introduced one snapshot per process claims, and they are what
 * the docs quote. If the shape of a refresh changes, this file is where it
 * shows.
 *
 * Two other properties ride on the same snapshot and are checked here because
 * a wrong answer on either is a credential in the wrong mount:
 *
 *   - ISOLATION: a namespace sliced from the shared reading holds exactly the
 *     parameters under it — never a sibling's, never a prefix-sibling's.
 *   - VISIBILITY: a rotation made outside strad lands within the TTL and no
 *     later; one made through strad lands at once; a transient failure is not
 *     remembered for the length of the TTL.
 */

const ENV = "prod";
const GATEWAY_NS = gatewayNamespace(ENV);
const SLUGS = ["anki", "granola", "strad-fetch", "telegram-ro", "x", "gcs"];
const PARAMS_SLUG = "gcs";
const GATEWAY_NAMES = Array.from({ length: 10 }, (_, i) => `GATEWAY_${i}`);
const PER_SLUG_NAMES = ["TOKEN", "API_KEY", "CLIENT_ID", "CLIENT_SECRET"];

/** A clock the test moves by hand, so elapsed real time proves nothing. */
function clock() {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

interface Counts {
  listParameters: number;
  listVersions: number;
  getVersion: number;
  render: number;
}

/** The verb behind one Parameter Manager request, by its URL. */
function classify(url: string, counts: Counts): void {
  const path = url.split("?")[0]!;
  if (path.endsWith(":render")) counts.render += 1;
  else if (/\/versions\/[^/]+$/.test(path)) counts.getVersion += 1;
  else if (path.endsWith("/versions")) counts.listVersions += 1;
  else if (path.endsWith("/parameters")) counts.listParameters += 1;
}

/**
 * A store client over the fake's state that counts what it asks Parameter
 * Manager, with the snapshot TTL and clock the running gateway would have.
 */
function counting(
  gcp: FakeGcp,
  opts: {
    snapshotTtlMs: number;
    now: () => number;
    failRender?: () => boolean;
  },
) {
  const counts: Counts = {
    listParameters: 0,
    listVersions: 0,
    getVersion: 0,
    render: 0,
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
        classify(url, counts);
        // A socket that never answered: the one transient shape the client
        // does not retry, so the count here is one render per parameter.
        if (url.includes(":render") && opts.failRender?.()) {
          return Promise.reject(new TypeError("fetch failed"));
        }
      }
      return gcp.fetchImpl(input, init);
    },
    snapshotTtlMs: opts.snapshotTtlMs,
    now: opts.now,
  });
  const billed = () => counts.getVersion + counts.render;
  const snapshot = () => ({ ...counts });
  return { store, counts, billed, snapshot };
}

/** Production's shape: 34 parameters across the gateway and six servers. */
async function seedProdShape(gcp: FakeGcp): Promise<number> {
  let total = 0;
  for (const name of GATEWAY_NAMES) {
    await gcp.store.create({
      path: `${GATEWAY_NS}${name}`,
      secret: true,
      value: `gateway-${name}`,
    });
    total += 1;
  }
  for (const slug of SLUGS) {
    for (const name of PER_SLUG_NAMES) {
      await gcp.store.create({
        path: `${staticNamespace(ENV, slug)}${name}`,
        secret: name !== "CLIENT_ID",
        value: `${slug}-${name}`,
      });
      total += 1;
    }
  }
  return total;
}

const CONFIG = parseConfig(`
version: 1
auth:
  staticTokens: { enabled: true }
gateway:
  name: strad
  env: ${ENV}
  secrets:
    provider: gcp-parameter-store
    envFallback: false
`);

/**
 * The SCHEMA DEFAULTS, deliberately not spelled out above: what this file
 * measures is what a deployment that sets neither knob pays. A day and an hour
 * — the TTL is only the fallback for a write that did not refresh the gateway
 * (the console, the `secrets` MCP server and the "Re-read the store" button
 * all do), so it is paid once a day.
 */
const TTL = CONFIG.gateway.secrets.ttlSeconds * 1000;
const NEGATIVE_TTL = CONFIG.gateway.secrets.negativeTtlSeconds * 1000;
const MINUTE = 60_000;

/**
 * One reachability tick, as the gateway's readers see it.
 *
 * The poller probes every slug once a minute; each probe resolves that slug's
 * `${NAME}`s through its own provider (its namespace first, the gateway's
 * second). Core's own refs read the shared provider. A `params: true` builtin
 * resolves its namespace on every tool call. The console and the readiness
 * route ask the diagnosis for the gateway namespace. Every one of those was a
 * store read on its own timer before; all of them slice one reading now.
 */
async function tick(
  store: ParameterStore,
  providers: ReturnType<typeof buildSecretProviders>,
  now: () => number,
): Promise<void> {
  await providers.shared.get(GATEWAY_NAMES[0]!);
  for (const slug of SLUGS) {
    await providers.forServer(slug).get("TOKEN");
  }
  await store.resolve(staticNamespace(ENV, PARAMS_SLUG));
  await readStoreDiagnosticsCached({
    store,
    namespace: GATEWAY_NS,
    ttlMs: CONFIG.gateway.secrets.ttlSeconds * 1000,
    now,
  });
}

describe("what one refresh costs the store, at production's shape", () => {
  it("with no shared reading, every namespace enumerates the project: the old bill", async () => {
    const gcp = createFakeGcp();
    const total = await seedProdShape(gcp);
    expect(total).toBe(34);

    const c = clock();
    // `snapshotTtlMs: 0` is the client the running gateway held before: every
    // `resolve()` a fresh enumeration, however many namespaces asked.
    const { store, counts, billed } = counting(gcp, {
      snapshotTtlMs: 0,
      now: c.now,
    });
    const providers = buildSecretProviders({
      config: CONFIG,
      env: {},
      resolver: store,
    });

    await tick(store, providers, c.now);

    // Sixteen enumerations for one tick: the shared provider, six per-server
    // providers that are TWO LAYERS EACH since the `oauth` kind (a miss in
    // `{slug}/oauth/` falls through to `{slug}/static/`), the builtin's
    // parameters, and the diagnosis's list AND render pass. Each one reads a
    // version of all 34 parameters.
    //
    // The extra six are the price of the second kind in the configuration the
    // gateway NO LONGER RUNS — `snapshotTtlMs: 0`, an enumeration per namespace.
    // The test below is the one that describes production, and there the second
    // layer is free: it slices the same reading, and `listParameters` is still 1.
    expect(counts.listParameters).toBe(16);
    expect(counts.getVersion).toBe(16 * total);
    // Plus the renders each namespace actually needed.
    expect(counts.render).toBe(
      GATEWAY_NAMES.length * 2 + // shared provider, and the diagnosis
        SLUGS.length * PER_SLUG_NAMES.length + // six per-server providers
        PER_SLUG_NAMES.length, // the builtin's parameters, again
    );
    expect(billed()).toBe(592);
    // At the 60s TTL production ran, the poller re-drove this every minute:
    // 592 x 1440 = 852,480 billed reads a day from ONE core process, before
    // the two bundle processes and any real traffic.
    expect(billed() * 1440).toBe(852_480);
  });

  it("with one reading per process, a refresh costs 2 x P and the namespaces are free", async () => {
    const gcp = createFakeGcp();
    const total = await seedProdShape(gcp);

    const c = clock();
    const { store, counts, billed, snapshot } = counting(gcp, {
      snapshotTtlMs: TTL,
      now: c.now,
    });
    const providers = buildSecretProviders({
      config: CONFIG,
      env: {},
      resolver: store,
    });

    // The first tick is the cold read: ONE enumeration of the project, and one
    // render of each parameter the tick's namespaces hold — every parameter,
    // at this shape, and each exactly once. The builtin's namespace and the
    // diagnosis's are namespaces already rendered, so they cost nothing.
    await tick(store, providers, c.now);
    expect(counts.listParameters).toBe(1);
    expect(counts.getVersion).toBe(total);
    expect(counts.render).toBe(total);
    expect(billed()).toBe(2 * total);
    expect(billed()).toBe(68);

    // Every tick inside the TTL is memory — a whole day of the poller asking
    // once a minute. The poller's cadence does not decide the read rate; the
    // TTL does.
    const afterCold = snapshot();
    for (let minute = 1; minute < TTL / MINUTE; minute += 1) {
      c.advance(MINUTE);
      await tick(store, providers, c.now);
    }
    expect(snapshot()).toEqual(afterCold);

    // Past the TTL, one more full refresh — and no more than one, however many
    // namespaces ask in the same minute.
    c.advance(MINUTE);
    await tick(store, providers, c.now);
    expect(counts.listParameters).toBe(2);
    expect(billed()).toBe(2 * 68);

    // One refresh a day at the default TTL: 68 billed reads, against the
    // 558,720 the same tick cost at a minute's TTL with one reading per
    // namespace, and 1,632 at an hour's. Inside Parameter Manager's monthly
    // free allowance of 10,000 access operations for the whole month.
    expect(TTL).toBe(24 * 60 * MINUTE);
    expect(68 * 30).toBeLessThan(10_000);
  });
});

describe("a namespace sliced from the shared reading holds exactly its own parameters", () => {
  it("hands each server its own values and never a sibling's", async () => {
    const gcp = createFakeGcp();
    await seedProdShape(gcp);
    const c = clock();
    const { store } = counting(gcp, { snapshotTtlMs: TTL, now: c.now });
    const providers = buildSecretProviders({
      config: CONFIG,
      env: {},
      resolver: store,
    });

    for (const slug of SLUGS) {
      expect(await providers.forServer(slug).get("TOKEN")).toBe(
        `${slug}-TOKEN`,
      );
    }
    // The gateway namespace holds no server's name, and no server namespace
    // holds a gateway name — through the same one reading.
    expect(await store.resolve(GATEWAY_NS)).toEqual(
      Object.fromEntries(GATEWAY_NAMES.map((n) => [n, `gateway-${n}`])),
    );
    expect(await store.resolve(staticNamespace(ENV, "anki"))).toEqual({
      TOKEN: "anki-TOKEN",
      API_KEY: "anki-API_KEY",
      CLIENT_ID: "anki-CLIENT_ID",
      CLIENT_SECRET: "anki-CLIENT_SECRET",
    });
    // A slug nobody seeded has an empty slice, and falls through to the
    // gateway's — not to a neighbour's.
    expect(await providers.forServer("nobody").get("TOKEN")).toBeNull();
    expect(await providers.forServer("nobody").get(GATEWAY_NAMES[3]!)).toBe(
      `gateway-${GATEWAY_NAMES[3]}`,
    );
  });

  it("does not let a slug that is a prefix of another slug see its parameters", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({
      path: `${staticNamespace(ENV, "x")}TOKEN`,
      secret: true,
      value: "x-token",
    });
    await gcp.store.create({
      path: `${staticNamespace(ENV, "x-twitter")}TOKEN`,
      secret: true,
      value: "x-twitter-token",
    });
    const c = clock();
    const { store } = counting(gcp, { snapshotTtlMs: TTL, now: c.now });

    expect(await store.resolve(staticNamespace(ENV, "x"))).toEqual({
      TOKEN: "x-token",
    });
    expect(await store.resolve(staticNamespace(ENV, "x-twitter"))).toEqual({
      TOKEN: "x-twitter-token",
    });
    expect(await store.list(staticNamespace(ENV, "x"))).toHaveLength(1);
  });
});

describe("what a rotation costs, and when it lands", () => {
  it("a rotation made outside strad lands within the TTL and not before", async () => {
    const gcp = createFakeGcp();
    await seedProdShape(gcp);
    const c = clock();
    const { store, billed } = counting(gcp, {
      snapshotTtlMs: TTL,
      now: c.now,
    });
    const providers = buildSecretProviders({
      config: CONFIG,
      env: {},
      resolver: store,
    });
    const anki = providers.forServer("anki");
    expect(await anki.get("TOKEN")).toBe("anki-TOKEN");
    const afterCold = billed();

    // `gcloud`, the seed script, another deployment: a write nobody told this
    // process about.
    await gcp.another().rotate(`${staticNamespace(ENV, "anki")}TOKEN`, "v2");

    c.advance(TTL - 1);
    expect(await anki.get("TOKEN")).toBe("anki-TOKEN");
    expect(billed()).toBe(afterCold);

    c.advance(1);
    expect(await anki.get("TOKEN")).toBe("v2");
    expect(billed()).toBeGreaterThan(afterCold);
  });

  it("a write through strad lands at once, on every provider, with no clock movement", async () => {
    const gcp = createFakeGcp();
    await seedProdShape(gcp);
    const c = clock();
    const { store } = counting(gcp, { snapshotTtlMs: TTL, now: c.now });
    const providers = buildSecretProviders({
      config: CONFIG,
      env: {},
      resolver: store,
    });
    expect(await providers.forServer("anki").get("TOKEN")).toBe("anki-TOKEN");
    expect(await providers.shared.get("GATEWAY_0")).toBe("gateway-GATEWAY_0");

    // The console writes through the ADMIN client — a different instance with
    // a different credential — and then calls invalidate() on the providers.
    // That is the whole path; the fake's admin client stands in for it.
    await gcp.another().rotate(`${staticNamespace(ENV, "anki")}TOKEN`, "v2");
    await gcp.another().rotate(`${GATEWAY_NS}GATEWAY_0`, "g2");
    providers.invalidate();

    expect(await providers.forServer("anki").get("TOKEN")).toBe("v2");
    expect(await providers.shared.get("GATEWAY_0")).toBe("g2");
    // And the builtin's parameters and the diagnosis read the same reading.
    expect(await store.resolve(staticNamespace(ENV, "anki"))).toMatchObject({
      TOKEN: "v2",
    });
  });

  it("a write through the same client drops its own reading", async () => {
    const gcp = createFakeGcp({ snapshotTtlMs: TTL });
    await seedProdShape(gcp);
    expect(await gcp.store.resolve(GATEWAY_NS)).toMatchObject({
      GATEWAY_0: "gateway-GATEWAY_0",
    });
    await gcp.store.rotate(`${GATEWAY_NS}GATEWAY_0`, "g2");
    expect(await gcp.store.resolve(GATEWAY_NS)).toMatchObject({
      GATEWAY_0: "g2",
    });
  });

  it("a name added outside strad is found within negativeTtlSeconds, at one re-read", async () => {
    const gcp = createFakeGcp();
    await seedProdShape(gcp);
    const c = clock();
    const { store, counts } = counting(gcp, {
      snapshotTtlMs: TTL,
      now: c.now,
    });
    const providers = buildSecretProviders({
      config: CONFIG,
      env: {},
      resolver: store,
    });

    // Referenced ahead of being seeded — the `mayBeUnseeded` shape.
    expect(await providers.shared.get("LATER")).toBeNull();
    expect(counts.listParameters).toBe(1);

    await gcp.another().create({
      path: `${GATEWAY_NS}LATER`,
      secret: true,
      value: "seeded",
    });

    // Inside the negative TTL — an hour, by default — the miss is not chased:
    // the reading is younger than that, and the poller asking once a minute
    // must not re-read the project once a minute.
    expect(NEGATIVE_TTL).toBe(60 * MINUTE);
    for (let minute = 1; minute < NEGATIVE_TTL / MINUTE; minute += 1) {
      c.advance(MINUTE);
      expect(await providers.shared.get("LATER")).toBeNull();
    }
    expect(counts.listParameters).toBe(1);

    // Past it: one re-read, and the name is there.
    c.advance(MINUTE);
    expect(await providers.shared.get("LATER")).toBe("seeded");
    expect(counts.listParameters).toBe(2);
  });

  it("a transient render failure is served through, not remembered for the TTL", async () => {
    const gcp = createFakeGcp();
    await seedProdShape(gcp);
    const c = clock();
    let failing = false;
    const { store, counts } = counting(gcp, {
      snapshotTtlMs: TTL,
      now: c.now,
      failRender: () => failing,
    });

    // The first render pass meets a dead socket on every parameter. The namespace
    // fails loudly — a child must not start on half an environment — but the
    // enumeration underneath it is fine and is kept.
    failing = true;
    await expect(store.resolve(GATEWAY_NS)).rejects.toThrow(
      /could not be rendered/,
    );
    expect(counts.listParameters).toBe(1);

    // The store recovers. With no clock movement, the next read renders again
    // rather than serving the failure it saw for the rest of the TTL — and it
    // does not enumerate again to do so.
    failing = false;
    expect(await store.resolve(GATEWAY_NS)).toMatchObject({
      GATEWAY_0: "gateway-GATEWAY_0",
    });
    expect(counts.listParameters).toBe(1);
    expect(counts.render).toBe(2 * GATEWAY_NAMES.length);

    // And a namespace that rendered cleanly IS remembered.
    const renders = counts.render;
    await store.resolve(GATEWAY_NS);
    expect(counts.render).toBe(renders);
  });

  it("the console's diagnosis reports the age of the reading it was answered from", async () => {
    const gcp = createFakeGcp();
    await seedProdShape(gcp);
    const c = clock();
    const { store, counts } = counting(gcp, {
      snapshotTtlMs: TTL,
      now: c.now,
    });
    const providers = buildSecretProviders({
      config: CONFIG,
      env: {},
      resolver: store,
    });
    await providers.shared.get("GATEWAY_0"); // the reading is taken here
    c.advance(50 * 60_000);

    // A diagnosis pass that runs NOW is answered from a fifty-minute-old
    // reading, and says so — rather than claiming the store was just asked.
    const before = counts.listParameters;
    const diagnosis = await readStoreDiagnosticsCached({
      store,
      namespace: GATEWAY_NS,
      ttlMs: TTL,
      now: c.now,
    });
    expect(diagnosis.indexRead && diagnosis.renderRead).toBe(true);
    expect(diagnosis.ageMs).toBe(50 * 60_000);
    expect(counts.listParameters).toBe(before);
    expect(diagnosis.rendered.has("GATEWAY_0")).toBe(true);
  });
});
