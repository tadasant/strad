import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * `treeSdk` is the reason one process can host fifteen unrelated npm trees: it
 * resolves the MCP SDK *as one tree sees it*, out of that tree's own
 * `node_modules`, and memoises the answer.
 *
 * Neither half is observable from a booted container — `smoke.mjs` sees the same
 * mount set whether the cache works or not, and a cross-tree SDK mix-up shows up
 * as a Zod error inside somebody else's handler. So this stands up two FAKE
 * trees on disk, each with its own `@modelcontextprotocol/sdk`, and asks which
 * one came back.
 *
 * No network, no container, no real SDK: the files below are the smallest thing
 * `createRequire().resolve()` and a path `import()` will accept.
 */

const TREES = mkdtempSync(join(tmpdir(), "strad-bundle-host-trees-"));

function fakeTree(name: string): void {
  const dir = join(TREES, name);
  const sdk = join(dir, "node_modules", "@modelcontextprotocol", "sdk");
  mkdirSync(join(sdk, "server"), { recursive: true });
  mkdirSync(join(dir, "shared", "build"), { recursive: true });

  // No `exports` field: subpath resolution is then plain file resolution, which
  // is all the host's `require.resolve` of a deep path needs.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `fake-${name}`, version: "0.0.0", type: "module" }),
  );
  writeFileSync(
    join(sdk, "package.json"),
    JSON.stringify({
      name: "@modelcontextprotocol/sdk",
      version: "0.0.0",
      type: "module",
    }),
  );
  // Each fake SDK stamps the tree it came from, so a mix-up is visible.
  writeFileSync(
    join(sdk, "server", "index.js"),
    `export class Server { static tree = ${JSON.stringify(name)}; }\n`,
  );
  writeFileSync(
    join(sdk, "server", "streamableHttp.js"),
    `export class StreamableHTTPServerTransport { static tree = ${JSON.stringify(name)}; }\n`,
  );
  writeFileSync(
    join(sdk, "types.js"),
    `export function isInitializeRequest(body) { return body?.method === "initialize"; }\n` +
      `isInitializeRequest.tree = ${JSON.stringify(name)};\n`,
  );
  writeFileSync(
    join(dir, "shared", "build", "index.js"),
    `export const createMCPServer = () => ({ tree: ${JSON.stringify(name)} });\n`,
  );
}

fakeTree("telegram");
fakeTree("secrets");

// `TREES_DIR` is read once, at module load. Set it before the import, and import
// dynamically so the assignment is not hoisted past it.
const PRIOR_TREES_DIR = process.env.STRAD_TREES_DIR;
process.env.STRAD_TREES_DIR = TREES;
const { loadFromTree, treeDir, treeSdk, TREES_DIR } = await import(
  "../src/trees.js"
);

afterAll(() => {
  // Both halves, and not only for tidiness: this file writes a PROCESS-wide
  // variable and then deletes what it points at, so a sibling file sharing the
  // process (vitest isolates by default, and that is a config away from not
  // being true) would resolve against a directory that no longer exists and
  // report a MODULE_NOT_FOUND that reads as a product bug.
  if (PRIOR_TREES_DIR === undefined) delete process.env.STRAD_TREES_DIR;
  else process.env.STRAD_TREES_DIR = PRIOR_TREES_DIR;
  rmSync(TREES, { recursive: true, force: true });
});

describe("where the trees are", () => {
  it("honours STRAD_TREES_DIR, which is what makes any of this testable", () => {
    expect(TREES_DIR).toBe(TREES);
    expect(treeDir("telegram")).toBe(join(TREES, "telegram"));
  });

  it("imports a built module out of a tree by path", async () => {
    const mod = await loadFromTree<{ createMCPServer: () => { tree: string } }>(
      "telegram",
      "shared/build/index.js",
    );

    expect(mod.createMCPServer().tree).toBe("telegram");
  });
});

describe("treeSdk", () => {
  it("resolves the SDK out of the asking tree's OWN node_modules", async () => {
    const telegram = await treeSdk("telegram");
    const secrets = await treeSdk("secrets");

    expect((telegram.Server as unknown as { tree: string }).tree).toBe(
      "telegram",
    );
    expect((secrets.Server as unknown as { tree: string }).tree).toBe("secrets");
  });

  it("hands back all three of the pieces a mount needs", async () => {
    const sdk = await treeSdk("telegram");

    expect(typeof sdk.Server).toBe("function");
    expect(typeof sdk.StreamableHTTPServerTransport).toBe("function");
    expect(sdk.isInitializeRequest({ method: "initialize" })).toBe(true);
    expect(sdk.isInitializeRequest({ method: "tools/list" })).toBe(false);
  });

  it("keeps two trees' SDKs apart — the whole reason it is per tree", async () => {
    const telegram = await treeSdk("telegram");
    const secrets = await treeSdk("secrets");

    expect(telegram).not.toBe(secrets);
    expect(telegram.Server).not.toBe(secrets.Server);
    expect(telegram.isInitializeRequest).not.toBe(secrets.isInitializeRequest);
  });

  it("returns the SAME object on a second ask, rather than rebuilding it", async () => {
    // Every request through `statelessHandler` calls this, so an unmemoised
    // version would re-resolve three module specifiers per MCP call.
    expect(await treeSdk("telegram")).toBe(await treeSdk("telegram"));
  });

  it("caches nothing when a tree's SDK is only half there", async () => {
    // The cache is written LAST, after all three specifiers resolve. A tree that
    // is mid-copy (or whose SDK moved) must therefore fail and stay failable —
    // a negative entry would outlive the condition for the life of the process.
    const half = join(TREES, "grafana");
    const sdk = join(half, "node_modules", "@modelcontextprotocol", "sdk");
    fakeTree("grafana");
    rmSync(join(sdk, "types.js"));

    await expect(treeSdk("grafana")).rejects.toThrow();

    writeFileSync(
      join(sdk, "types.js"),
      `export function isInitializeRequest(body) { return body?.method === "initialize"; }\n`,
    );
    expect(typeof (await treeSdk("grafana")).isInitializeRequest).toBe(
      "function",
    );
  });

  it("does not touch the tree again once cached", async () => {
    // The strongest available proof that the cache is a cache: delete the tree's
    // `node_modules` out from under it. An uncached lookup would now throw
    // MODULE_NOT_FOUND; a cached one cannot notice.
    const cached = await treeSdk("secrets");
    rmSync(join(TREES, "secrets", "node_modules"), { recursive: true });

    expect(await treeSdk("secrets")).toBe(cached);

    // The control, so the assertion above is not vacuous: an IDENTICAL tree,
    // built the same way and given the same deletion but never asked for
    // before, does not resolve. The difference between the two is the cache.
    fakeTree("fetchpet");
    rmSync(join(TREES, "fetchpet", "node_modules"), { recursive: true });
    await expect(treeSdk("fetchpet")).rejects.toThrow();
  });
});
