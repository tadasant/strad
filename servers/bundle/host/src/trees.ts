import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The collapsed bundle is ONE image assembled from NINE existing npm projects —
 * bundle-api, bundle-google, onepassword, secrets, remote-filesystem, good-eggs,
 * fetchpet, pointsyeah, x-twitter — each of which is copied in, installed and built exactly
 * as its own image builds it, keeping its own `node_modules` and its own lockfile.
 *
 * WHY NOT ONE FLAT npm PROJECT. Because merging nine dependency trees into one
 * is how you find out, in production, that fetchpet pinned playwright-extra and
 * bundle-google pinned express 4 and someone's transitive zod moved. Each tree
 * stays byte-for-byte the tree its own CI already proves; this host just imports
 * across them. Node resolves each shared package's bare imports from ITS OWN
 * tree (module resolution walks up from the importing file), so nothing here
 * changes what any upstream server actually runs.
 *
 * The one thing that IS shared across trees is Chromium — see browser.ts. That
 * is deliberate: three browsers on one vCPU is the thing we are trying not to do.
 */

/** Where the Dockerfile lays the nine trees down. */
export const TREES_DIR = process.env.STRAD_TREES_DIR ?? "/app/trees";

export type TreeName =
  | "bundle-api"
  | "bundle-google"
  | "onepassword"
  | "secrets"
  | "remote-filesystem"
  | "good-eggs"
  | "fetchpet"
  | "pointsyeah"
  | "x-twitter";

export function treeDir(tree: TreeName): string {
  return join(TREES_DIR, tree);
}

/**
 * Import a built module out of one of the trees, by path.
 *
 * A path import (not a bare specifier) is what lets one process host packages
 * from nine unrelated `node_modules`: resolution of the module's OWN imports then
 * happens relative to where the file lives, which is inside its tree.
 */
export async function loadFromTree<T>(
  tree: TreeName,
  relativePath: string,
): Promise<T> {
  const url = pathToFileURL(join(treeDir(tree), relativePath)).href;
  return (await import(url)) as T;
}

/**
 * The MCP SDK *as that tree sees it*.
 *
 * Each tree's shared code registers handlers with Zod schemas from its own SDK
 * copy, so the `Server` those handlers are registered on — and the transport it
 * connects to — must come from that same copy. Resolving the SDK per tree keeps
 * every mount internally consistent, instead of relying on eight copies of the SDK
 * being structurally interchangeable (they usually are; "usually" is not a
 * property you want under a credentials manager).
 */
export interface TreeSdk {
  Server: new (
    info: { name: string; version: string },
    options: { capabilities: Record<string, unknown> },
  ) => McpServerLike;
  StreamableHTTPServerTransport: new (options: {
    sessionIdGenerator: (() => string) | undefined;
    onsessioninitialized?: (sessionId: string) => void;
  }) => TransportLike;
  isInitializeRequest: (body: unknown) => boolean;
}

export interface McpServerLike {
  connect(transport: TransportLike): Promise<void>;
  close(): Promise<void>;
}

export interface TransportLike {
  handleRequest(req: unknown, res: unknown, body?: unknown): Promise<void>;
  close(): Promise<void>;
  sessionId?: string;
  onclose?: () => void;
}

const sdkCache = new Map<TreeName, TreeSdk>();

export async function treeSdk(tree: TreeName): Promise<TreeSdk> {
  const cached = sdkCache.get(tree);
  if (cached) return cached;

  const require = createRequire(join(treeDir(tree), "package.json"));
  const load = async (subpath: string): Promise<Record<string, unknown>> => {
    const resolved = require.resolve(subpath);
    return (await import(pathToFileURL(resolved).href)) as Record<
      string,
      unknown
    >;
  };

  const serverMod = await load("@modelcontextprotocol/sdk/server/index.js");
  const httpMod = await load(
    "@modelcontextprotocol/sdk/server/streamableHttp.js",
  );
  const typesMod = await load("@modelcontextprotocol/sdk/types.js");

  const sdk: TreeSdk = {
    Server: serverMod.Server as TreeSdk["Server"],
    StreamableHTTPServerTransport:
      httpMod.StreamableHTTPServerTransport as TreeSdk["StreamableHTTPServerTransport"],
    isInitializeRequest: typesMod.isInitializeRequest as TreeSdk["isInitializeRequest"],
  };
  sdkCache.set(tree, sdk);
  return sdk;
}
