import { test } from "vitest";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMCPServer } from "../src/index.js";
import type { SecretsStore } from "../src/config.js";
import { VIEWER_ACCOUNT } from "./fake-parameter-manager.js";

/**
 * THE CONSOLE LINK IS THE WHOLE POINT OF `open_secrets_manager`.
 *
 * The tool returns no value and does nothing to the store; all it produces is a
 * URL that lands a human on the console page the parameter lives on. So the URL
 * is the thing under test, and there are three ways it goes wrong — all silent,
 * all on a page that looks entirely correct:
 *
 *   1. The JOIN. `SECRETS_CONSOLE_URL` is free-form enough to carry a query
 *      string, a multi-store console selects its store with `?project=`, and a
 *      link joined with a bare `?` puts the rest of itself INSIDE that value —
 *      which the console reads as a stale bookmark and answers with its first
 *      store.
 *   2. The STORE. One container fronts N stores behind ONE `SECRETS_CONSOLE_URL`,
 *      so a link that leaves `?project=` to the operator's constant names the
 *      right store for at most one of the N. The path resolves to exactly one
 *      store, and that resolved answer is what the link carries.
 *   3. The KEYS THEMSELVES. A key the console does not read is discarded on
 *      arrival, and the human lands somewhere other than the prose around the
 *      link says they will. A `?param=` carrying the canonical path is exactly
 *      that — the console reads `project` and `ns` on `/ui/:server` and nothing
 *      else, so a parameter named there never arrives (#273). `the link carries
 *      no key the console does not read` below is the pin on it.
 *
 * Nothing here touches Parameter Manager: no store is reachable in this file,
 * and none is consulted. The capability lookup is injected for the same reason
 * it is elsewhere — the probe is a live HTTPS call.
 */

const NS = "/strad/staging/mcp/";
const PARAM = `${NS}remote-filesystem-tmp-public/static/REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY`;
const PROJECT = "test-project";

/** The other two stores of a multi-store server, and a path in each. */
const NS_A = "/strad/a/mcp/";
const NS_B = "/strad/b/mcp/";
const PARAM_A = `${NS_A}telegram-rw/static/TELEGRAM_SESSION`;
const PARAM_B = `${NS_B}telegram-rw/static/TELEGRAM_SESSION`;

/**
 * Every key `/ui/:server` reads, and the whole of it: `selectStore` takes
 * `req.query.project` and `selectNamespace` takes `req.query.ns`
 * (`src/ui/index.ts`). A sweep of `req.query` across `src/` turns up eight more
 * — `code`, `next`, `state` and `token` (the SSO round trip), `connected` and
 * `error` (the connector flash), `prefix`, and `servers` (which is `/mcp`'s
 * selection query, not a console page at all) — and not one of them is read by
 * the page this link opens. So the set below, not that sweep, is what a key on
 * this link has to be in; anything else is dropped on the floor.
 */
const PAGE_READS = ["ns", "project"];

const CAPS_NONE = {
  readSecretValues: false,
  writeParameters: false,
  writeSecretValues: false,
  deleteParameters: false,
  probed: true,
};

const store = (project: string, namespaces: string[]): SecretsStore => ({
  project,
  namespaces,
  account: VIEWER_ACCOUNT,
  viewerKeyVar: `SECRETS_KEY_${project.toUpperCase().replace(/-/g, "_")}`,
});

const ONE_STORE = [store(PROJECT, [NS])];
const TWO_STORES = [store("proj-a", [NS_A]), store("proj-b", [NS_B])];

/** A client over a server whose only interesting property is its `consoleUrl`. */
async function fixture(consoleUrl?: string, stores: SecretsStore[] = ONE_STORE) {
  const { server, registerHandlers } = createMCPServer({
    version: "0.0.0-test",
    config: { stores, consoleUrl },
    capabilities: () => Promise.resolve(CAPS_NONE),
  });
  await registerHandlers(server);

  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: () => client.close() };
}

/** The `url` an agent is handed, or the error text if the tool refused. */
async function link(
  consoleUrl: string | undefined,
  secret?: string,
  stores?: SecretsStore[],
) {
  const { client, close } = await fixture(consoleUrl, stores);
  const res = await client.callTool({
    name: "open_secrets_manager",
    arguments: secret === undefined ? {} : { secret },
  });
  await close();
  const text = (res as { content: { text: string }[] }).content[0].text;
  if (res.isError) return { url: undefined, error: true, text };
  const payload = JSON.parse(text) as {
    url?: string;
    project?: string;
    note?: string;
    instructions?: string;
  };
  return { ...payload, error: false, text };
}

/** The `?project=` a link carries, parsed back out of it. */
function projectOn(url: string): string | null {
  return new URL(url, "https://strad.tadasant.com").searchParams.get("project");
}

/** The query keys a link carries, in sorted order. */
function keysOn(url: string): string[] {
  return [
    ...new Set(new URL(url, "https://strad.tadasant.com").searchParams.keys()),
  ].sort();
}

/** What `list_managed_namespaces` publishes as the console's address. */
async function advertised(consoleUrl?: string) {
  const { client, close } = await fixture(consoleUrl);
  const res = await client.callTool({
    name: "list_managed_namespaces",
    arguments: {},
  });
  await close();
  return JSON.parse((res as { content: { text: string }[] }).content[0].text)
    .consoleUrl as string | undefined;
}

test("the tool writes no key the page it opens does not read", async () => {
  // THE DEFECT (#273). A `?param=` on this link is read by no handler in
  // `src/ui/`, so it lands the human on the store's parameter list with the
  // parameter silently dropped, under prose describing a landing on the
  // parameter itself. What is pinned is the set of keys the HELPER ADDS —
  // `SECRETS_CONSOLE_URL` is free-form config and an operator's own keys ride
  // along untouched, which is the test below this one — so the subset is taken
  // against what the configured URL already carried.
  const cases: [string, string | undefined, SecretsStore[]][] = [
    ["https://strad.tadasant.com/ui/secrets", PARAM, ONE_STORE],
    ["https://strad.tadasant.com/ui/secrets", undefined, ONE_STORE],
    ["https://strad.tadasant.com/ui/secrets#top", PARAM, ONE_STORE],
    ["https://strad.tadasant.com/ui/secrets///", PARAM, ONE_STORE],
    ["https://strad.tadasant.com/ui/secrets", "TELEGRAM_SESSION", TWO_STORES],
    ["https://strad.tadasant.com/ui/secrets", PARAM_B, TWO_STORES],
    // A configured query string is the shape a multi-store console is deployed
    // with, and it is the one where "what did the helper add" is a real question.
    ["https://strad.tadasant.com/ui/secrets?project=proj-a", PARAM_B, TWO_STORES],
    [
      `https://strad.tadasant.com/ui/secrets?project=proj-a&ns=${encodeURIComponent(NS_A)}`,
      PARAM_B,
      TWO_STORES,
    ],
    // The unparseable branch splices its own query, so it is a second
    // implementation of the same rule and gets the same pin.
    ["/ui/secrets", PARAM, ONE_STORE],
    ["/ui/secrets?project=zimmer-secrets-prod", PARAM, ONE_STORE],
    ["not a url at all", PARAM, ONE_STORE],
  ];
  for (const [configured, secret, stores] of cases) {
    const { url } = await link(configured, secret, stores);
    const carried = new Set(keysOn(configured));
    const added = keysOn(url!).filter((k) => !carried.has(k));
    assert.ok(
      !added.includes("param"),
      `${configured} + ${secret} added a param key: ${url}`,
    );
    for (const key of added) {
      assert.ok(
        PAGE_READS.includes(key),
        `${configured} + ${secret} added "${key}", which /ui/:server never reads: ${url}`,
      );
    }
  }
});

test("the instructions send the human to a list and tell the agent to name the row", async () => {
  // The other half of the retraction: dropping the key without correcting the
  // prose would leave the same false promise, just unenforceable.
  const { instructions } = await link(
    "https://strad.tadasant.com/ui/secrets",
    PARAM,
  );
  assert.match(instructions!, /parameter list/);
  assert.match(instructions!, /find the row by name/);
  // And it says, in the agent's own message, which parameter it meant — the
  // thing the URL cannot carry.
  assert.ok(instructions!.includes(PARAM), instructions);

  // Called bare there is no parameter to name, and the sentence still reads.
  const bare = await link("https://strad.tadasant.com/ui/secrets", undefined);
  assert.match(bare.instructions!, /parameter list/);
  assert.ok(!bare.instructions!.includes("does not select"), bare.instructions);
});

test("the link names the store the path resolved to", async () => {
  // The console picks its store from `?project=`. A path-only console URL names
  // no store at all, and the console then falls back to whichever store it lists
  // first — right by coincidence, if at all.
  const { url, project } = await link(
    "https://staging.strad.tadasant.com/ui/secrets",
    PARAM,
  );
  assert.equal(
    url,
    `https://staging.strad.tadasant.com/ui/secrets?project=${PROJECT}`,
  );
  // And the resolved store is reported to the agent as well as spliced into the
  // link, so "which project is this in" is answerable without parsing a URL.
  assert.equal(project, PROJECT);
});

test("a path in store B beats a `?project=A` the operator hardcoded", async () => {
  // THE DEFECT. One container, two stores, ONE `SECRETS_CONSOLE_URL` — so the
  // constant in that variable is right for at most one of them, and every
  // parameter in the other one silently opens on the wrong project.
  const configured = "https://strad.tadasant.com/ui/secrets?project=proj-a";

  const b = await link(configured, PARAM_B, TWO_STORES);
  assert.equal(projectOn(b.url!), "proj-b");
  assert.equal(b.project, "proj-b");
  // Replaced, never duplicated: Express reads a repeated `project=` as an array,
  // which `selectStoreStrict` refuses — the first-store fallback all over again.
  assert.deepEqual(new URL(b.url!).searchParams.getAll("project"), ["proj-b"]);

  // The store the constant happened to name is not a special case: it is
  // resolved from the path exactly like the other one.
  const a = await link(configured, PARAM_A, TWO_STORES);
  assert.equal(projectOn(a.url!), "proj-a");
  assert.equal(a.project, "proj-a");
});

test("a path no store claims leaves the configured link alone, and says so", async () => {
  // `secret` is documented as a canonical path OR a bare variable name, so an
  // argument that resolves to no store is ordinary input — not an error. The
  // tool reads nothing, so there is nothing to refuse: the link is still worth
  // handing over, it just cannot name a store.
  const { url, project, note, error } = await link(
    "https://strad.tadasant.com/ui/secrets?project=proj-a",
    "TELEGRAM_SESSION",
    TWO_STORES,
  );
  assert.equal(error, false);
  assert.equal(url, "https://strad.tadasant.com/ui/secrets?project=proj-a");
  assert.equal(project, undefined);
  assert.match(note!, /cannot name a store/);
  // The note names the namespaces, so the agent can fix the argument itself.
  assert.match(note!, /"\/strad\/a\/mcp\/" \(proj-a\)/);

  // A path in no namespace at all gets the same treatment — this tool never
  // refuses one, because refusing would cost a human the console link.
  const outside = await link(
    "https://strad.tadasant.com/ui/secrets",
    "/strad/tokens/SOMETHING",
    TWO_STORES,
  );
  assert.equal(outside.error, false);
  assert.equal(projectOn(outside.url!), null);
  assert.equal(outside.project, undefined);
  assert.match(outside.note!, /cannot name a store/);
});

test("a single-store server names its store too", async () => {
  // Not a multi-store-only fix. The console's `consoleStores:` is configured
  // separately from this server's `mcpStores:`, so a single-store MCP server can
  // front a console listing four — and the no-`?project=` fallback then lands on
  // whichever of the four is declared first.
  const { url, project, note } = await link(
    "https://strad.tadasant.com/ui/secrets",
    PARAM,
    ONE_STORE,
  );
  assert.equal(projectOn(url!), PROJECT);
  assert.equal(project, PROJECT);
  assert.equal(note, undefined);
});

test("a console URL that already carries a query string joins with '&'", async () => {
  // A bare `?` join yields
  //   .../ui/secrets?view=list?project=test-project
  // whose one `view` value is `list?project=test-project` — and the `project`
  // the tool resolved never reaches the console at all, so it falls back to its
  // first store and the human reads the wrong page.
  const { url } = await link(
    "https://strad.tadasant.com/ui/secrets?view=list",
    PARAM,
  );
  assert.equal(
    url,
    `https://strad.tadasant.com/ui/secrets?view=list&project=${PROJECT}`,
  );

  // Not just "an ampersand appears somewhere": the two parameters have to parse
  // back to what they mean, which is the property the concatenation broke.
  const parsed = new URL(url!).searchParams;
  assert.equal(parsed.get("view"), "list");
  assert.equal(parsed.get("project"), PROJECT);
});

test("a key this tool does not own is the operator's, and passes through", async () => {
  // `SECRETS_CONSOLE_URL` is free-form deployment config. The only key written
  // here is `project`, and the only one dropped is an `ns` that override
  // orphans — so a `?param=` an operator wrote is left exactly as they wrote it.
  // It is inert either way (the console does not read it), and rewriting a key
  // this function does not own would be the coupling #273 was about, in the
  // other direction.
  const { url } = await link(
    "https://strad.tadasant.com/ui/secrets?param=%2Fstale%2FOLD&view=a%2Fb",
    PARAM,
  );
  const parsed = new URL(url!).searchParams;
  assert.deepEqual(parsed.getAll("param"), ["/stale/OLD"]);
  assert.equal(parsed.get("view"), "a/b");
  assert.deepEqual(parsed.getAll("project"), [PROJECT]);
});

test("with no parameter the link is the console URL, query string intact", async () => {
  // No parameter is no path, so there is nothing to resolve and nothing to
  // relabel: an operator's `?project=` is the only answer available, and it
  // stands.
  assert.equal(
    (await link("https://strad.tadasant.com/ui/secrets", undefined)).url,
    "https://strad.tadasant.com/ui/secrets",
  );
  assert.equal(
    (await link("https://strad.tadasant.com/ui/secrets?project=prod", undefined)).url,
    "https://strad.tadasant.com/ui/secrets?project=prod",
  );
  // The same helper answers `list_managed_namespaces`, which advertises the
  // console without a parameter.
  assert.equal(
    await advertised("https://strad.tadasant.com/ui/secrets?project=prod"),
    "https://strad.tadasant.com/ui/secrets?project=prod",
  );
});

test("the trailing slash is stripped from the PATH, not from the string", async () => {
  assert.equal(
    (await link("https://strad.tadasant.com/ui/secrets///", PARAM)).url,
    `https://strad.tadasant.com/ui/secrets?project=${PROJECT}`,
  );
  // A `?` or a `#` can follow the path, and the last character of a query value
  // or a hash route is not a trailing slash to eat. (The value under test is a
  // key we neither write nor drop; `project` is asserted above.)
  const q = await link("https://strad.tadasant.com/ui/secrets?view=prod/", PARAM);
  assert.equal(new URL(q.url!).searchParams.get("view"), "prod/");
});

test("a `ns` the overridden project orphans is dropped", async () => {
  // `ns` is the console's namespace selector and a namespace belongs to exactly
  // one store, so rewriting `project` from A to B leaves an `ns` B does not
  // manage — and `selectNamespace` takes free text unless the store sets
  // `namespacesStrict`, so the console would list store A's namespace under
  // store B. An empty table on a page that looks entirely correct: the same
  // failure as the wrong store, one query key over.
  const stale = await link(
    `https://strad.tadasant.com/ui/secrets?project=proj-a&ns=${encodeURIComponent(NS_A)}`,
    PARAM_B,
    TWO_STORES,
  );
  const parsed = new URL(stale.url!).searchParams;
  assert.equal(parsed.get("project"), "proj-b");
  assert.equal(parsed.get("ns"), null);

  // Kept when the resolved store really does manage it — dropping it there
  // would throw away a usable default for nothing.
  const good = await link(
    `https://strad.tadasant.com/ui/secrets?project=proj-a&ns=${encodeURIComponent(NS_B)}`,
    PARAM_B,
    TWO_STORES,
  );
  assert.equal(new URL(good.url!).searchParams.get("ns"), NS_B);

  // And with no store resolved there is no override, so there is nothing to
  // orphan: the operator's pair stands as written.
  const unresolved = await link(
    `https://strad.tadasant.com/ui/secrets?project=proj-a&ns=${encodeURIComponent(NS_A)}`,
    "TELEGRAM_SESSION",
    TWO_STORES,
  );
  const kept = new URL(unresolved.url!).searchParams;
  assert.equal(kept.get("project"), "proj-a");
  assert.equal(kept.get("ns"), NS_A);

  // The unparseable branch drops it too — it is the branch a relative console
  // URL takes, and a relative URL is what carries a hand-written query.
  const relative = await link(
    `/ui/secrets?project=proj-a&ns=${encodeURIComponent(NS_A)}`,
    PARAM_B,
    TWO_STORES,
  );
  const rel = new URL(relative.url!, "https://strad.tadasant.com").searchParams;
  assert.equal(rel.get("project"), "proj-b");
  assert.equal(rel.get("ns"), null);
});

test("the project lands before a fragment, not inside it", async () => {
  // Concatenated, the query landed after the `#` — inside the fragment, which
  // never reaches the server at all.
  const { url } = await link("https://strad.tadasant.com/ui/secrets#top", PARAM);
  assert.equal(
    url,
    `https://strad.tadasant.com/ui/secrets?project=${PROJECT}#top`,
  );
  assert.equal(new URL(url!).searchParams.get("project"), PROJECT);
});

test("an unparseable console URL yields a link, not a thrown tool call", async () => {
  // `SECRETS_CONSOLE_URL` is free-form deployment config and `new URL()` throws
  // on anything without a scheme — including `/ui/secrets`, which is a usable
  // link for a human already on the host. Rejecting it here would turn a
  // cosmetic defect into a broken tool, so the fallback assembles the query by
  // hand — with the SAME key and the same replace-not-duplicate rule.
  const relative = await link("/ui/secrets", PARAM);
  assert.equal(relative.error, false);
  assert.equal(relative.url, `/ui/secrets?project=${PROJECT}`);

  const nonsense = await link("not a url at all", PARAM);
  assert.equal(nonsense.error, false);
  assert.equal(nonsense.url, `not a url at all?project=${PROJECT}`);

  assert.equal((await link("/ui/secrets", undefined)).url, "/ui/secrets");
  assert.equal(await advertised("/ui/secrets"), "/ui/secrets");

  // AND IT MUST NOT REPRODUCE THE DEFECT IT FELL BACK FROM. A relative value
  // carrying a query string is the relative spelling of the very URL this file
  // is about, and it is the one the URL parser cannot help with — including the
  // hardcoded `project=` the resolved store has to override IN PLACE, because a
  // second `project=` reaches the console as an array and selects nothing.
  const relativeWithQuery = await link(
    "/ui/secrets?project=zimmer-secrets-prod",
    PARAM,
  );
  assert.equal(relativeWithQuery.url, `/ui/secrets?project=${PROJECT}`);
  const parsed = new URL(relativeWithQuery.url!, "https://strad.tadasant.com")
    .searchParams;
  assert.deepEqual(parsed.getAll("project"), [PROJECT]);

  // A fragment on an unparseable value is still a fragment: the query goes
  // BEFORE it, or it never reaches the console.
  const fragment = await link("/ui/secrets#top", PARAM);
  assert.equal(fragment.url, `/ui/secrets?project=${PROJECT}#top`);

  // The structure is read in the order a URL has it, so a `?` INSIDE a fragment
  // is not a query — appending to it would put the key somewhere the console
  // never sees, which is the fragment defect the parsed branch already avoids.
  const questionInFragment = await link("/ui/secrets#top?x=1", PARAM);
  assert.equal(
    questionInFragment.url,
    `/ui/secrets?project=${PROJECT}#top?x=1`,
  );

  // The trailing-slash strip is the PATH's here too, and a bare `?` carries no
  // query to preserve.
  assert.equal(
    (await link("/ui/secrets/?project=stale", PARAM)).url,
    `/ui/secrets?project=${PROJECT}`,
  );
  assert.equal(
    (await link("/ui/secrets?", PARAM)).url,
    `/ui/secrets?project=${PROJECT}`,
  );
  assert.equal((await link("/ui/secrets?", undefined)).url, "/ui/secrets");

  // A key we do not write keeps its value through the round trip, `/` and all.
  const other = await link("/ui/secrets?view=a/b", PARAM);
  assert.equal(
    new URL(other.url!, "https://strad.tadasant.com").searchParams.get("view"),
    "a/b",
  );
});

test("with no argument there is no store to report and nothing to explain", async () => {
  // The `project` and `note` fields are answers to a question nobody asked when
  // the tool is called bare, and a `note` on a call that did nothing wrong would
  // read as a fault.
  const { url, project, note } = await link(
    "https://strad.tadasant.com/ui/secrets?project=proj-a",
    undefined,
    TWO_STORES,
  );
  assert.equal(url, "https://strad.tadasant.com/ui/secrets?project=proj-a");
  assert.equal(project, undefined);
  assert.equal(note, undefined);
});

test("no console URL at all is the one case with no link", async () => {
  const { error, text } = await link(undefined, PARAM);
  assert.equal(error, true);
  assert.match(text, /SECRETS_CONSOLE_URL/);
  assert.equal(await advertised(undefined), undefined);
});
