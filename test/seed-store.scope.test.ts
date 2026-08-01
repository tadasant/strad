import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSeedScope, SeedScopeError } from "../src/deploy/seed-scope.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  decodeEnvelope,
  encodeEnvelope,
  gatewayNamespace,
  gatewayParameterPath,
  parameterId,
} from "../src/secrets/parameters/namespace.ts";
import { RESOLVER_ENV } from "../src/secrets/parameters/resolver.ts";
import { serveFake, type ServedFake } from "./helpers/serve-fake.ts";

/**
 * Scoping a seeding run, at both altitudes: the membership rules as a pure
 * function, and the script as a real subprocess against a real (in-memory) store.
 *
 * The subprocess half is what proves the flags reach the WRITES. A scope that
 * decides the right set and then seeds everything anyway would pass every unit
 * test in the first describe block, so the assertions that matter most here are
 * about what is in the store after the run, not about what the run printed.
 */

const ENV = "test";
const NAMESPACE = gatewayNamespace(ENV);

/**
 * A config whose required set is small enough to name exhaustively and shaped
 * like a real one: a `${REF}`, a supplementary `env:` (which is NOT seeded), and
 * a `consoleEnv:` (which must never be).
 */
const CONFIG_YAML = `
version: 1
gateway:
  name: strad
  env: ${ENV}
  secrets:
    provider: gcp-parameter-store
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle-shop
servers:
  - slug: granola
    kind: remote-http
    url: https://mcp.granola.example.com/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${GRANOLA_TOKEN}"
  - slug: shop
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle-shop
    entitlements: [admin]
    env:
      SHOP_PASSWORD: "\${SHOP_PASSWORD}"
    consoleEnv:
      ADMIN_KEY: "\${SECRETS_ADMIN_KEY_JSON}"
`;

/**
 * The derived set for the config above, in the order the script sorts it: the
 * config's one `${REF}` plus the core boot keys. `SHOP_PASSWORD` is absent
 * because a supplementary `env:` is not seeded, and `SECRETS_ADMIN_KEY_JSON`
 * because a `consoleEnv:` name never is.
 */
const CANDIDATES = [
  "ADMIN_BOOTSTRAP_TOKEN",
  "CONSOLE_SESSION_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GRANOLA_TOKEN",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "SENTRY_DSN",
  "STRAD_INTERNAL_TOKEN",
  "STRAD_TOKENS",
];

describe("resolveSeedScope", () => {
  it("is a no-op with neither flag, and says the run was not scoped", () => {
    const scope = resolveSeedScope({ candidates: CANDIDATES });
    expect(scope.wanted).toStrictEqual(CANDIDATES);
    expect(scope.outOfScope).toStrictEqual([]);
    expect(scope.scopedBy).toBeNull();
  });

  it("--only narrows to the named set and reports the rest as held back", () => {
    const scope = resolveSeedScope({
      candidates: CANDIDATES,
      only: ["STRAD_TOKENS", "GRANOLA_TOKEN"],
    });
    // Candidate order, not command-line order: the log reads as a subset of the
    // roster it is a subset of.
    expect(scope.wanted).toStrictEqual(["GRANOLA_TOKEN", "STRAD_TOKENS"]);
    expect(scope.outOfScope).toStrictEqual([
      "ADMIN_BOOTSTRAP_TOKEN",
      "CONSOLE_SESSION_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "SENTRY_DSN",
      "STRAD_INTERNAL_TOKEN",
    ]);
    expect(scope.scopedBy).toBe("--only");
  });

  it("--exclude drops the named set and keeps the rest", () => {
    const scope = resolveSeedScope({
      candidates: CANDIDATES,
      exclude: ["STRAD_TOKENS"],
    });
    expect(scope.wanted).not.toContain("STRAD_TOKENS");
    expect(scope.wanted).toHaveLength(CANDIDATES.length - 1);
    expect(scope.outOfScope).toStrictEqual(["STRAD_TOKENS"]);
    expect(scope.scopedBy).toBe("--exclude");
  });

  it("refuses the two flags together", () => {
    expect(() =>
      resolveSeedScope({
        candidates: CANDIDATES,
        only: ["STRAD_TOKENS"],
        exclude: ["GRANOLA_TOKEN"],
      }),
    ).toThrow(/mutually exclusive/);
  });

  /**
   * The asymmetry, stated twice because it is the one design decision here
   * someone would reasonably expect to go the other way.
   */
  it("fails on an --only name the config does not seed", () => {
    expect(() =>
      resolveSeedScope({ candidates: CANDIDATES, only: ["NOPE"] }),
    ).toThrow(/--only NOPE: this config does not seed that name/);
  });

  it("only NOTES an --exclude name the config does not seed", () => {
    const scope = resolveSeedScope({
      candidates: CANDIDATES,
      exclude: ["NOPE"],
    });
    expect(scope.wanted).toStrictEqual(CANDIDATES);
    expect(scope.notes).toStrictEqual([
      "not a name this config seeds, nothing to exclude: NOPE",
    ]);
    // Nothing was narrowed, so the run is not a scoped one.
    expect(scope.scopedBy).toBeNull();
  });

  it("says WHY when --only names a consoleEnv: name", () => {
    expect(() =>
      resolveSeedScope({
        candidates: CANDIDATES,
        only: ["SECRETS_ADMIN_KEY_JSON"],
        consoleOnly: ["SECRETS_ADMIN_KEY_JSON"],
      }),
    ).toThrow(/consoleEnv: name.*never hold it/s);
  });

  it("refuses a --set the scope would drop, under either flag", () => {
    expect(() =>
      resolveSeedScope({
        candidates: [...CANDIDATES, "CANARY"],
        only: ["STRAD_TOKENS"],
        overrides: ["CANARY"],
      }),
    ).toThrow(/--set CANARY is excluded by the scope: --only does not list it/);

    expect(() =>
      resolveSeedScope({
        candidates: [...CANDIDATES, "CANARY"],
        exclude: ["CANARY"],
        overrides: ["CANARY"],
      }),
    ).toThrow(/--set CANARY is excluded by the scope: --exclude names it/);
  });

  it("allows a --set the scope keeps", () => {
    const scope = resolveSeedScope({
      candidates: [...CANDIDATES, "CANARY"],
      only: ["CANARY"],
      overrides: ["CANARY"],
    });
    expect(scope.wanted).toStrictEqual(["CANARY"]);
  });

  it("throws SeedScopeError, so the CLI can map it to exit 2", () => {
    expect(() =>
      resolveSeedScope({ candidates: CANDIDATES, only: ["NOPE"] }),
    ).toThrow(SeedScopeError);
  });

  it("tolerates a repeated name rather than counting it twice", () => {
    const scope = resolveSeedScope({
      candidates: CANDIDATES,
      only: ["STRAD_TOKENS", "STRAD_TOKENS"],
    });
    expect(scope.wanted).toStrictEqual(["STRAD_TOKENS"]);
  });

  /**
   * `seed_except: "A, B"` is the natural spelling in a dispatch text box and
   * arrives here comma-split as `["A", " B"]`. Untrimmed, ` B` matches nothing —
   * and because an unmatched `--exclude` is only a note, the run would SEED the
   * name the operator asked to hold back and mention it in one line.
   */
  it("trims a name, so whitespace cannot silently un-exclude it", () => {
    const scope = resolveSeedScope({
      candidates: CANDIDATES,
      exclude: [" STRAD_TOKENS "],
    });
    expect(scope.wanted).not.toContain("STRAD_TOKENS");
    expect(scope.outOfScope).toStrictEqual(["STRAD_TOKENS"]);
    expect(scope.notes).toStrictEqual([]);
  });

  it("trims under --only too", () => {
    const scope = resolveSeedScope({
      candidates: CANDIDATES,
      only: ["\tSTRAD_TOKENS"],
    });
    expect(scope.wanted).toStrictEqual(["STRAD_TOKENS"]);
  });

  it("names the actual mistake for a stray comma, not a phantom empty name", () => {
    expect(() =>
      resolveSeedScope({ candidates: CANDIDATES, only: ["STRAD_TOKENS", ""] }),
    ).toThrow(/--only was given an empty name — check for a stray comma/);
    expect(() =>
      resolveSeedScope({ candidates: CANDIDATES, exclude: [""] }),
    ).toThrow(/--exclude was given an empty name/);
  });

  it("does not blame --exclude for an override when no scope was passed", () => {
    // Unreachable from the CLI, which derives candidates from the overrides —
    // but this is an exported module, and a message naming a flag the caller
    // never passed is a lie about their own invocation.
    const scope = resolveSeedScope({
      candidates: CANDIDATES,
      overrides: ["NOT_A_CANDIDATE"],
    });
    expect(scope.wanted).toStrictEqual(CANDIDATES);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * A FRESH store per test, not one shared across the file. These tests assert
 * about what the namespace holds after a run, so a store carrying the previous
 * test's writes would make "already seeded" the outcome and quietly turn a
 * write assertion into a no-op — which is how the first draft of this file
 * passed a test that had written nothing.
 */
let fake: ReturnType<typeof createFakeGcp>;
let served: ServedFake;

beforeEach(async () => {
  fake = createFakeGcp();
  served = await serveFake(fake);
});

afterEach(async () => {
  await served?.close();
});

const run = promisify(execFile);

/** Values distinctive enough that a leak assertion cannot false-alarm. */
const VALUES: Record<string, string> = {
  ADMIN_BOOTSTRAP_TOKEN: "seed-canary-bootstrap-4b1c",
  CONSOLE_SESSION_SECRET: "seed-canary-session-4b1c",
  GRANOLA_TOKEN: "seed-canary-granola-4b1c",
  STRAD_INTERNAL_TOKEN: "seed-canary-internal-4b1c",
  // The value the whole encoding question is about: a JSON array of token
  // records, structural from end to end. It is here so the subprocess exercises
  // the shape `SEEDING.md` claimed could not be seeded, on the real write path.
  STRAD_TOKENS: JSON.stringify([
    {
      pubid: "aaaaaaaa",
      label: "zimmer",
      role: "zimmer",
      hash: "x".repeat(64),
    },
    {
      pubid: "bbbbbbbb",
      label: "console",
      role: "admin",
      hash: "y".repeat(64),
    },
  ]),
  SECRETS_ADMIN_KEY_JSON: "seed-canary-admin-4b1c",
  SHOP_PASSWORD: "seed-canary-shop-4b1c",
};

async function seed(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "strad-seed-scope-"));
  const cfg = join(dir, "cfg.yaml");
  writeFileSync(cfg, CONFIG_YAML);
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        "--experimental-transform-types",
        "scripts/seed-store.ts",
        "--config",
        cfg,
        ...args,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          ...VALUES,
          // `STRAD_PARAMS_PROJECT_ID` is BOTH halves' project: the seeder reads
          // it as the admin store's and `resolverFromEnv` as the resolver's, so
          // it is named once, via the resolver constant, rather than twice with
          // a chance of drifting apart.
          [RESOLVER_ENV.projectId]: fake.endpoints.projectId,
          STRAD_STORE_ADMIN_KEY_JSON: fake.endpoints.keyJson,
          // The resolver half, for the read-back. Same fake, same endpoints.
          [RESOLVER_ENV.keyJson]: fake.endpoints.keyJson,
          [RESOLVER_ENV.location]: fake.endpoints.location,
          [RESOLVER_ENV.pmApiBase]: `${served.base}/pm`,
          [RESOLVER_ENV.smApiBase]: `${served.base}/sm`,
          [RESOLVER_ENV.tokenUrl]: `${served.base}/token`,
          ...env,
        },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

/** What the namespace actually holds, asked of the store rather than the log. */
async function namesInStore(): Promise<string[]> {
  const metas = await fake.store.list(NAMESPACE);
  return metas
    .filter((m) => m.hasValue)
    .map((m) => m.variable)
    .sort();
}

describe("scripts/seed-store.ts --only / --exclude", () => {
  it("refuses both flags at once, as exit 2, with no store credential at all", async () => {
    // No STRAD_PARAMS_PROJECT_ID and no admin key: "called wrong" must not be
    // masked by "no credential", or the caller is sent to fix the wrong thing.
    const r = await seed(
      ["--only", "STRAD_TOKENS", "--exclude", "GRANOLA_TOKEN"],
      {
        STRAD_PARAMS_PROJECT_ID: "",
        STRAD_STORE_ADMIN_KEY_JSON: "",
      },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("mutually exclusive");
  });

  it("refuses an --only name the config does not seed, as exit 2", async () => {
    const r = await seed(["--only", "SHOP_PASSWORD"]);
    expect(r.code).toBe(2);
    // A supplementary env: name is a real name in the config and still not a
    // name this script seeds — the likeliest honest mistake, so it is the case
    // under test rather than a nonsense string.
    expect(r.stderr).toContain("does not seed that name");
  });

  it("stays dry-run by default, writing nothing even when scoped", async () => {
    const r = await seed(["--only", "GRANOLA_TOKEN"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dry run, nothing written");
    expect(await namesInStore()).toStrictEqual([]);
  });

  it("reports the scope in the header so a narrowed run cannot read as a whole one", async () => {
    const r = await seed(["--only", "GRANOLA_TOKEN"]);
    expect(r.stdout).toContain(`1 of ${CANDIDATES.length} name(s)`);
    expect(r.stdout).toContain("SCOPED by --only");
    expect(r.stdout).toContain("held back by the scope — NOT SEEDED");
  });

  it("says nothing about a scope when there is none", async () => {
    const r = await seed([]);
    expect(r.stdout).toContain(
      `${CANDIDATES.length} name(s) the gateway reads`,
    );
    expect(r.stdout).not.toContain("SCOPED by");
    expect(r.stdout).not.toContain("held back by the scope");
  });

  it("--commit --only writes ONLY the named names", async () => {
    const r = await seed([
      "--commit",
      "--only",
      "STRAD_TOKENS",
      "--only",
      "GRANOLA_TOKEN",
    ]);
    expect(r.code).toBe(0);
    expect(await namesInStore()).toStrictEqual([
      "GRANOLA_TOKEN",
      "STRAD_TOKENS",
    ]);
  });

  it("round-trips the structural STRAD_TOKENS value through :render", async () => {
    // The read-back is the script's own verify step, which resolves the
    // namespace and compares by digest. It passing is the end-to-end statement
    // that an 802-byte-shaped, quote-packed JSON array seeds AND renders.
    const r = await seed(["--commit", "--only", "STRAD_TOKENS"]);
    expect(r.stdout).toContain("read back byte-identical through :render");
    expect(r.stdout).not.toContain("DID NOT ROUND-TRIP");
    expect((await fake.store.resolve(NAMESPACE)).STRAD_TOKENS).toBe(
      VALUES.STRAD_TOKENS,
    );
    // And no value reached the log, in any mode.
    expect(r.stdout).not.toContain(VALUES.STRAD_TOKENS);
  });

  it("--commit --exclude writes everything else", async () => {
    const r = await seed(["--commit", "--exclude", "STRAD_TOKENS"]);
    expect(r.code).toBe(0);
    const names = await namesInStore();
    expect(names).not.toContain("STRAD_TOKENS");
    expect(names).toContain("ADMIN_BOOTSTRAP_TOKEN");
    expect(names).toContain("CONSOLE_SESSION_SECRET");
    expect(names).toContain("STRAD_INTERNAL_TOKEN");
  });

  it("does not scope --delete, which is explicit by construction", async () => {
    // Put GRANOLA_TOKEN in the store, then ask for a run scoped to a DIFFERENT
    // name that also deletes it. A scope that leaked into --delete would leave
    // it there.
    await fake.store.create({
      path: gatewayParameterPath(ENV, "GRANOLA_TOKEN"),
      secret: true,
      value: VALUES.GRANOLA_TOKEN!,
    });
    expect(await namesInStore()).toContain("GRANOLA_TOKEN");

    const r = await seed([
      "--commit",
      "--only",
      "STRAD_TOKENS",
      "--delete",
      "GRANOLA_TOKEN",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("deleted GRANOLA_TOKEN");
    expect(await namesInStore()).toStrictEqual(["STRAD_TOKENS"]);
  });

  it("never seeds a consoleEnv: name, scoped or not", async () => {
    const r = await seed(["--only", "SECRETS_ADMIN_KEY_JSON"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("consoleEnv:");
    expect(await namesInStore()).not.toContain("SECRETS_ADMIN_KEY_JSON");
  });

  it("exits 3 — not 2 — when the arguments are fine and the credential is not", async () => {
    // The mirror of the both-broken case above, and the reason it is here: the
    // scope check moved AHEAD of the credential lookup, which is exactly the
    // edit that could invert these two exit codes.
    const r = await seed(["--only", "STRAD_TOKENS"], {
      STRAD_STORE_ADMIN_KEY_JSON: "",
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("no store credential");
  });

  it("reports an --only name the environment has no value for, and exits 1", async () => {
    // A DERIVED name with no value is a documented skip; a name the caller typed
    // is not. Without this the likeliest cutover mistake — a seed_names dispatch
    // against a job missing the value — printed "seeded" over an empty run.
    const r = await seed(["--commit", "--only", "GRANOLA_TOKEN"], {
      GRANOLA_TOKEN: "",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--only named 1 name(s) with no value");
    expect(r.stderr).toContain("GRANOLA_TOKEN");
    expect(await namesInStore()).toStrictEqual([]);
  });

  it("fails a DRY RUN the same way, since that is what a dry run is for", async () => {
    const r = await seed(["--only", "GRANOLA_TOKEN"], { GRANOLA_TOKEN: "" });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("dry run, nothing written, 1 problem(s)");
  });

  it("still skips a DERIVED name with no value, without failing", async () => {
    const r = await seed(["--commit"], { GRANOLA_TOKEN: "" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no value in the environment — SKIPPED");
    expect(await namesInStore()).not.toContain("GRANOLA_TOKEN");
  });

  it("prints an unmatched --exclude note to stdout", async () => {
    const r = await seed(["--exclude", "NOPE"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "not a name this config seeds, nothing to exclude: NOPE",
    );
  });

  it("verifies the namespace even when the run wrote nothing", async () => {
    await seed(["--commit", "--only", "STRAD_TOKENS"]);
    // Second run: the name is already seeded, so nothing is written — and the
    // read-back must still happen, because "does this namespace render" is the
    // question a re-run is asking.
    const r = await seed(["--commit", "--only", "STRAD_TOKENS"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already seeded");
    expect(r.stdout).toContain("verify: nothing written this run");
    expect(r.stdout).toContain("renders");
  });
});

/**
 * Poison a namespace the way the two live routes do: a parameter whose bytes are
 * raw (an envelope with no `encoding`, written by a pre-encoding image) and whose
 * value is structural, so `:render` refuses it — permanently, and for the whole
 * namespace (`HACKS.md` #36).
 */
async function seedUnrenderable(
  gcp: ReturnType<typeof createFakeGcp>,
  path: string,
): Promise<void> {
  const id = parameterId(path);
  await gcp.store.create({ path, secret: true, value: "placeholder" });
  gcp.secrets.get(id)!.push('{"raw":"structural"}');
  const param = gcp.parameters.get(id)!;
  const latest = param.versions[param.versions.length - 1]!;
  const env = decodeEnvelope(Buffer.from(latest.data, "base64").toString());
  delete env.encoding;
  latest.data = Buffer.from(encodeEnvelope(env), "utf8").toString("base64");
}

describe("the read-back is NOT scoped, and that is the point", () => {
  it("fails a scoped run whose own names round-trip, on a name it never touched", async () => {
    await seedUnrenderable(
      fake,
      gatewayParameterPath(ENV, "STRAD_INTERNAL_TOKEN"),
    );

    const r = await seed(["--commit", "--only", "STRAD_TOKENS"]);

    // The scoped write itself succeeded...
    expect(r.stdout).toContain("created STRAD_TOKENS");
    // ...and the run still fails, because the gateway this namespace serves
    // would come up with nothing. Scoping the verify to the scoped write would
    // have reported green on exactly the state --only exists to work around.
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("could not render");
    expect(r.stderr).toContain("resolves to nothing");
  });
});

describe("the encoding, on the path a fresh seed actually takes", () => {
  /**
   * `SEEDING.md` in tadasant-internal says a quote-bearing value "cannot render
   * today" and tells the operator to "seed the flat values and hold the
   * structural ones". That guidance predates the base64url encoding
   * (`HACKS.md` #33). This is the claim restated as an assertion so that if it
   * ever becomes true again, a test says so.
   *
   * The value here is prod-shaped rather than token-shaped: ~802 bytes with 88
   * double-quotes, the exact dimensions the doc cites.
   */
  const PROD_SHAPED = (() => {
    // 11 records x 8 quotes = 88 quotes. The last record's `hash` is then padded
    // out to bring the whole array to 802 bytes, which changes the length
    // without changing the quote count — the two dimensions the doc cites are
    // set independently on purpose.
    const records = Array.from({ length: 11 }, (_, i) => ({
      pubid: `id${String(i).padStart(6, "0")}`,
      hash: "z".repeat(24),
    }));
    const json = JSON.stringify(records);
    const pad = 802 - Buffer.byteLength(json, "utf8");
    // The tail is `"}]`; reopen it, add the padding, close it again.
    return pad > 0 ? `${json.slice(0, -3)}${"z".repeat(pad)}"}]` : json;
  })();

  it("is 802 bytes with 88 double-quotes, like the value in the runbook", () => {
    expect(Buffer.byteLength(PROD_SHAPED, "utf8")).toBe(802);
    expect(PROD_SHAPED.split('"').length - 1).toBe(88);
  });

  it("seeds and renders anyway, through create() and the read-back", async () => {
    const local = createFakeGcp();
    const path = gatewayParameterPath(ENV, "STRAD_TOKENS_PROD_SHAPED");
    await local.store.create({ path, secret: true, value: PROD_SHAPED });
    expect(
      (await local.store.resolve(gatewayNamespace(ENV)))
        .STRAD_TOKENS_PROD_SHAPED,
    ).toBe(PROD_SHAPED);
  });

  it("also renders after a rotate, which is the path an existing name takes", async () => {
    const local = createFakeGcp();
    const path = gatewayParameterPath(ENV, "STRAD_TOKENS_PROD_SHAPED");
    await local.store.create({ path, secret: true, value: "flat-start" });
    await local.store.rotate(path, PROD_SHAPED);
    expect(await local.store.reveal(path)).toBe(PROD_SHAPED);
  });
});
