import { expect } from "vitest";
import type { SecretsStore, ServerView } from "../../src/ui/resolve.ts";

/**
 * The ONE store of a single-store secrets view.
 *
 * Most of this suite predates `consoleStores:` and asserts about a config that
 * declares exactly one store, where "the view's project" and "the store's
 * project" are the same sentence. This narrows a `ServerView` to that store and
 * FAILS if the view has any other number, so a test that says "single-store"
 * keeps meaning it — the multi-store cases assert on `view.stores` directly.
 */
export function onlyStore(view: ServerView): SecretsStore {
  expect(view.kind).toBe("secrets");
  if (view.kind !== "secrets") throw new Error("not a secrets view");
  expect(view.stores).toHaveLength(1);
  const store = view.stores[0];
  if (!store) throw new Error("no store on this secrets view");
  return store;
}
